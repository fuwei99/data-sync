const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const express = require('express');
const crypto = require('crypto');

// 修正导入方式，使用require而非import
let fetch;
try {
    // 尝试使用ESM风格导入
    import('node-fetch').then(module => {
        fetch = module.default;
    }).catch(() => {
        // 备用：使用CommonJS风格导入
        fetch = require('node-fetch');
    });
} catch (error) {
    console.error('无法导入node-fetch:', error);
    // 备用实现
    fetch = async (url, options) => {
        const https = require('https');
        const http = require('http');
        
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            const req = client.request(url, options, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    resolve({
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        status: res.statusCode,
                        json: async () => JSON.parse(data)
                    });
                });
            });
            
            req.on('error', reject);
            
            if (options && options.body) {
                req.write(options.body);
            }
            
            req.end();
        });
    };
}

const execPromise = util.promisify(exec);

// 插件信息
const info = {
    id: 'data-sync',
    name: 'Data Sync',
    description: 'A plugin to synchronize SillyTavern data with GitHub repositories.',
};

// 配置文件路径
const CONFIG_PATH = path.join(__dirname, 'config.json');
// 数据目录路径
const DATA_DIR = path.join(process.cwd(), 'data');

// GitHub OAuth 配置
// 注意：实际使用时需要在 GitHub 创建一个 OAuth 应用并获取这些值
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || 'your_github_client_id';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || 'your_github_client_secret';
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || 'http://localhost:8000/api/plugins/data-sync/oauth-callback';
const OAUTH_STATE = crypto.randomBytes(16).toString('hex'); // 随机生成的状态值，用于防止CSRF攻击

// 默认配置
const DEFAULT_CONFIG = {
    repo_url: '',
    sync_interval: 0, // 0表示不定时同步
    last_sync: null,
    auto_sync: false,
    github_token: '', // GitHub 访问令牌
    is_authorized: false, // OAuth 授权状态
};

// 定时任务引用，用于停止任务
let syncInterval = null;

// 读取配置
async function readConfig() {
    try {
        const data = await fs.readFile(CONFIG_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        // 如果配置文件不存在，创建默认配置
        await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
        return { ...DEFAULT_CONFIG };
    }
}

// 保存配置
async function saveConfig(config) {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// 设置 GitHub Token
async function setGitHubToken(token) {
    try {
        const config = await readConfig();
        config.github_token = token;
        config.is_authorized = true;
        await saveConfig(config);
        return { success: true };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

// GitHub OAuth 身份验证
async function githubOAuth(code) {
    try {
        // 交换授权码获取访问令牌
        const response = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                client_id: GITHUB_CLIENT_ID,
                client_secret: GITHUB_CLIENT_SECRET,
                code: code,
                redirect_uri: OAUTH_REDIRECT_URI
            })
        });

        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error_description || 'Authorization failed');
        }
        
        if (data.access_token) {
            // 验证令牌，获取用户信息
            const userResponse = await fetch('https://api.github.com/user', {
                headers: {
                    'Authorization': `token ${data.access_token}`
                }
            });
            
            const userData = await userResponse.json();
            
            if (userResponse.ok) {
                // 保存令牌到配置
                await setGitHubToken(data.access_token);
                return { success: true, username: userData.login };
            } else {
                throw new Error('Failed to get user info');
            }
        } else {
            throw new Error('No access token received');
        }
    } catch (error) {
        console.error('GitHub OAuth error:', error);
        return { success: false, message: error.message };
    }
}

// 执行git命令
async function runGitCommand(command, cwd = DATA_DIR) {
    let config = {};
    let originalRepoUrl = '';
    let tokenUrl = '';
    let temporarilySetUrl = false;

    try {
        config = await readConfig();
        const token = config.github_token;
        originalRepoUrl = config.repo_url;

        // Special handling for push/pull/fetch with HTTPS token
        if (token && originalRepoUrl && originalRepoUrl.startsWith('https://') && (command.startsWith('git push') || command.startsWith('git pull') || command.startsWith('git fetch'))) {
            if (!originalRepoUrl.includes('@github.com')) { // Avoid double injection
                tokenUrl = originalRepoUrl.replace('https://', `https://x-access-token:${token}@`);
                
                // --- BEGIN Authentication Change ---
                console.log(`[data-sync] Temporarily setting remote origin URL with token for command: ${command}`);
                const setUrlResult = await execPromise(`git remote set-url origin ${tokenUrl}`, { cwd });
                console.log('[data-sync] set-url (with token) stdout:', setUrlResult.stdout);
                console.log('[data-sync] set-url (with token) stderr:', setUrlResult.stderr); // Log potential warnings
                temporarilySetUrl = true;
                // No need to modify the command itself anymore
                // --- END Authentication Change ---
            }
        }

        // For clone, we still need to modify the command URL if applicable
        if (token && originalRepoUrl && originalRepoUrl.startsWith('https://') && command.startsWith('git clone')) {
             if (!originalRepoUrl.includes('@github.com')) {
                 tokenUrl = originalRepoUrl.replace('https://', `https://x-access-token:${token}@`);
                 // Replace the original URL in the clone command string
                 command = command.replace(originalRepoUrl, tokenUrl);
             }
        }

        // Log the command that will be executed
        console.log(`[data-sync] Attempting to execute command: ${command}`); // Command might be modified for clone

        const { stdout, stderr } = await execPromise(command, { cwd });
        
        // If we temporarily set the URL, revert it now (after successful command)
        if (temporarilySetUrl) {
             console.log(`[data-sync] Reverting remote origin URL to original: ${originalRepoUrl}`);
             await execPromise(`git remote set-url origin ${originalRepoUrl}`, { cwd });
             temporarilySetUrl = false; // Mark as reverted
         }

        return { success: true, stdout, stderr };

    } catch (error) {
        console.error(`Git command failed: ${command}\nError: ${error.message}\nStdout: ${error.stdout}\nStderr: ${error.stderr}`);
        
        // If we temporarily set the URL and the command failed, STILL try to revert it
        if (temporarilySetUrl) {
             try {
                 console.warn(`[data-sync] Command failed, attempting to revert remote origin URL to original: ${originalRepoUrl}`);
                 await execPromise(`git remote set-url origin ${originalRepoUrl}`, { cwd });
                 temporarilySetUrl = false; // Mark as reverted
             } catch (revertError) {
                 console.error(`[data-sync] Failed to revert remote URL after command failure: ${revertError.message}`);
                 // Log this error but proceed with returning the original error
             }
         }

        return { 
            success: false, 
            error: error.message,
            stdout: error.stdout || '',
            stderr: error.stderr || ''
        };
    } finally {
         // Final safety check: Ensure URL is reverted if something unexpected happened
         if (temporarilySetUrl) {
             try {
                 console.warn(`[data-sync] Final check: Reverting remote origin URL in finally block: ${originalRepoUrl}`);
                 await execPromise(`git remote set-url origin ${originalRepoUrl}`, { cwd });
             } catch (finalRevertError) {
                 console.error(`[data-sync] Failed to revert remote URL in finally block: ${finalRevertError.message}`);
             }
         }
     }
}

// 检查git是否已初始化
async function isGitInitialized() {
    const result = await runGitCommand('git rev-parse --is-inside-work-tree');
    return result.success && result.stdout.trim() === 'true';
}

// 初始化git仓库
async function initGitRepo() {
    // 检查是否已经初始化 (this check will fail initially, which is okay)
    const isInitializedResult = await runGitCommand('git rev-parse --is-inside-work-tree');
    if (isInitializedResult.success && isInitializedResult.stdout.trim() === 'true') {
        return { success: true, message: 'Git repository already initialized in data directory' };
    }
    console.log('[data-sync] Attempting to initialize Git repository in:', DATA_DIR); // Add detailed log

    // 尝试初始化仓库，并显式捕获错误
    let initResult;
    try {
        // Directly use execPromise to capture details on error
        console.log(`[data-sync] Executing: git init in ${DATA_DIR}`);
        const { stdout, stderr } = await execPromise('git init', { cwd: DATA_DIR });
        console.log('[data-sync] git init stdout:', stdout);
        console.log('[data-sync] git init stderr:', stderr); // Log success stderr (might contain warnings)
         initResult = { success: true, stdout, stderr, message: 'Git repository initialized successfully' };
    } catch (error) {
        console.error(`[data-sync] Explicit git init failed in ${DATA_DIR}. Error: ${error.message}`); // Log error message
        console.error('[data-sync] git init stdout on error:', error.stdout); // Log stdout from error object
        console.error('[data-sync] git init stderr on error:', error.stderr); // Log stderr from error object
        initResult = {
             success: false,
             message: 'Failed to initialize git repository',
             error: error.message,
             stdout: error.stdout || '',
             stderr: error.stderr || ''
         };
    }

    // 返回结果
    return initResult;
}

// 配置远程仓库
async function configureRemote(repoUrl) {
    // 检查当前远程仓库
    const remoteResult = await runGitCommand('git remote -v');
    
    if (remoteResult.success && remoteResult.stdout.includes('origin')) {
        // 如果已经有origin，更新它
        const updateResult = await runGitCommand(`git remote set-url origin ${repoUrl}`);
        if (!updateResult.success) {
            return { success: false, message: 'Failed to update remote URL', details: updateResult };
        }
    } else {
        // 否则添加origin
        const addResult = await runGitCommand(`git remote add origin ${repoUrl}`);
        if (!addResult.success) {
            return { success: false, message: 'Failed to add remote', details: addResult };
        }
    }

    return { success: true, message: 'Remote repository configured successfully' };
}

// 执行同步（上传）
async function syncToRemote() {
    // 获取状态
    const statusResult = await runGitCommand('git status --porcelain');
    if (!statusResult.success) {
        return { success: false, message: 'Failed to get git status', details: statusResult };
    }

    // 如果没有变更，不需要提交
    if (!statusResult.stdout.trim()) {
        return { success: true, message: 'No changes to commit' };
    }

    // 添加所有文件
    const addResult = await runGitCommand('git add .');
    if (!addResult.success) {
        return { success: false, message: 'Failed to add files', details: addResult };
    }

    // 提交更改
    const commitResult = await runGitCommand('git commit -m "Sync data from SillyTavern"');
    if (!commitResult.success) {
        return { success: false, message: 'Failed to commit changes', details: commitResult };
    }

    // 获取当前分支名
    const branchResult = await runGitCommand('git branch --show-current');
    const branch = branchResult.success ? branchResult.stdout.trim() : 'main';

    // 推送到远程
    const pushResult = await runGitCommand(`git push -u origin ${branch}`);
    if (!pushResult.success) {
        return { success: false, message: 'Failed to push to remote', details: pushResult };
    }

    return { success: true, message: 'Successfully synced to remote' };
}

// 从远程同步（下载） - 使用 reset --hard 强制覆盖本地
async function syncFromRemote() {
    // 获取当前分支名
    const branchResult = await runGitCommand('git branch --show-current');
    const branch = branchResult.success ? branchResult.stdout.trim() : 'main';

    console.log(`[data-sync] Fetching remote origin/${branch}`);
    const fetchCommand = `git fetch origin ${branch}`;
    const fetchResult = await runGitCommand(fetchCommand);
    if (!fetchResult.success) {
        // Fetch失败通常是连接/认证问题，之前的错误处理可能已包含这些
        return { success: false, message: 'Failed to fetch from remote', details: fetchResult };
    }
    console.log(`[data-sync] Resetting local branch to origin/${branch} --hard`);
    const resetCommand = `git reset --hard origin/${branch}`;
    const resetResult = await runGitCommand(resetCommand);
    if (!resetResult.success) {
        return { success: false, message: 'Failed to reset local branch to remote state', details: resetResult };
    }

    // 清理未跟踪的文件和目录 (可选但推荐，确保本地完全干净)
    console.log(`[data-sync] Cleaning untracked files and directories (-fdx)`);
    const cleanCommand = `git clean -fdx`; 
    const cleanResult = await runGitCommand(cleanCommand);
     if (!cleanResult.success) {
         // Clean 失败通常不严重，但记录一下
         console.warn(`[data-sync] Failed to clean untracked files after reset: ${cleanResult.stderr || cleanResult.error}`);
         // 即使 clean 失败，reset 成功了也算成功
         // return { success: false, message: 'Failed to clean untracked files after reset', details: cleanResult };
     }

    return { success: true, message: 'Successfully forced local state to match remote' };
}

// 获取git状态
async function getGitStatus() {
    const isInitializedResult = await runGitCommand('git rev-parse --is-inside-work-tree');
    const isInitialized = isInitializedResult.success && isInitializedResult.stdout.trim() === 'true';
    
    let changes = [];
    if (isInitialized) {
        const statusResult = await runGitCommand('git status --porcelain');
        // Check for success before processing stdout
        if (statusResult.success && typeof statusResult.stdout === 'string') { 
            changes = statusResult.stdout.trim().split('\n').filter(line => line.trim() !== '');
        } else if (!statusResult.success) {
            // Log error if getting status failed on an initialized repo
            console.error('Failed to get git status porcelain:', statusResult.stderr || statusResult.error);
            // You might want to throw an error or return a specific status indicating failure
            throw new Error(`获取详细Git状态失败: ${statusResult.stderr || statusResult.error}`);
        }
    }
    return { initialized: isInitialized, changes: changes };
}

// 开始定时同步
function startAutoSync(interval) {
    // 先停止现有的定时任务
    stopAutoSync();
    
    if (interval <= 0) {
        return;
    }
    
    // 设置新的定时任务
    const intervalMs = interval * 60 * 1000; // 转换为毫秒
    console.log(`[data-sync] Setting up auto-sync every ${interval} minutes (${intervalMs}ms)`);
    
    syncInterval = setInterval(async () => {
        console.log('[data-sync] Auto-sync triggered');
        let pullSuccess = false;
        try {
            // 1. 先尝试 Pull
            console.log('[data-sync] Auto-sync: Attempting pull...');
            const pullResult = await syncFromRemote(); // Uses pull internally now

            if (pullResult.success) {
                console.log('[data-sync] Auto-sync: Pull successful');
                pullSuccess = true;
            } else {
                // 检查 Pull 失败是否因为合并冲突
                const stderr = pullResult.stderr || pullResult.error || '';
                if (stderr.toLowerCase().includes('merge conflict') || stderr.toLowerCase().includes('automatic merge failed')) {
                    console.warn('[data-sync] Auto-sync: Pull failed due to merge conflict. Aborting merge attempt...');
                    try {
                        const abortResult = await runGitCommand('git merge --abort');
                        if (abortResult.success) {
                            console.log('[data-sync] Auto-sync: Merge aborted successfully.');
                        } else {
                            console.error('[data-sync] Auto-sync: Failed to abort merge after conflict:', abortResult.stderr || abortResult.error);
                            // If abort fails, maybe try reset? Or just log and skip push.
                            // console.warn('[data-sync] Auto-sync: Attempting git reset --hard HEAD as fallback...');
                            // await runGitCommand('git reset --hard HEAD'); 
                        }
                    } catch (abortError) {
                        console.error('[data-sync] Auto-sync: Error occurred while trying to abort merge:', abortError);
                    }
                    // 即使 abort 失败，也跳过 push
                    console.log('[data-sync] Auto-sync: Skipping push due to merge conflict during pull.');
                } else {
                    // 其他 Pull 失败原因 (网络, 认证等)
                    console.error('[data-sync] Auto-sync: Pull failed (non-conflict):', pullResult.message, pullResult.details || stderr);
                    console.log('[data-sync] Auto-sync: Skipping push due to non-conflict pull error.');
                }
                 // Pull 失败，不进行 Push
                 pullSuccess = false;
            }

            // 2. 如果 Pull 成功，再尝试 Push
            if (pullSuccess) {
                console.log('[data-sync] Auto-sync: Attempting push...');
                const pushResult = await syncToRemote();
                if (pushResult.success) {
                    console.log('[data-sync] Auto-sync: Push successful');
                    // 更新最后同步时间
                    const config = await readConfig();
                    config.last_sync = new Date().toISOString();
                    await saveConfig(config);
                } else {
                    console.error('[data-sync] Auto-sync: Push failed:', pushResult.message, pushResult.details || pushResult.stderr);
                }
            }
        } catch (error) {
            console.error('[data-sync] Auto-sync: General error during cycle:', error);
        }
    }, intervalMs);
}

// 停止定时同步
function stopAutoSync() {
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
        console.log('Auto-sync stopped');
    }
}

/**
 * 初始化插件
 * @param {import('express').Router} router Express router
 */
async function init(router) {
    console.log('Data Sync plugin initializing...');

    // 提供静态文件 - 路径修正
    router.use('/ui/static', express.static(path.join(__dirname, 'public')));

    // 确保解析JSON请求体
    router.use(express.json());

    // UI页面 - 保持不变
    router.get('/ui', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    // API端点 - 获取配置 - 路径保持 /config
    router.get('/config', async (req, res) => {
        try {
            const config = await readConfig();
            // 返回安全的配置信息（不包含完整token）
            const safeConfig = {
                repoUrl: config.repo_url || '',
                branch: config.branch || 'main', // Add branch here if missing before
                autoSync: !!config.auto_sync,
                syncInterval: config.sync_interval || 60,
                lastSync: config.last_sync || null,
                hasToken: !!config.github_token,
                isAuthorized: !!config.is_authorized, // Use is_authorized from config
                username: config.username || null // Include username if available
            };
            res.json(safeConfig); // 直接返回对象，前端不再需要 response.config
        } catch (error) {
            console.error('获取配置错误:', error);
            res.status(500).json({ message: '获取配置失败: ' + error.message });
        }
    });

    // API端点 - 保存配置 - 路径保持 /config
    router.post('/config', async (req, res) => {
        try {
            console.log('接收到配置保存请求:', req.body);
            const { repoUrl, branch, autoSync, syncInterval } = req.body;
            const currentConfig = await readConfig();
            
            // 构建新的配置对象，只更新允许用户修改的字段
            const newConfig = {
                 ...currentConfig, // 保留其他字段，如 token, is_authorized, username
                 repo_url: repoUrl,
                 branch: branch || 'main', // 添加 branch 保存
                 auto_sync: !!autoSync,
                 sync_interval: parseInt(syncInterval, 10) || 0 // 确保是数字
             };
            
            await saveConfig(newConfig);
            console.log('配置已保存');

            // 如果提供了仓库URL，则尝试配置远程仓库
            // 初始化应由用户手动触发，不在此处自动执行
            if (newConfig.repo_url) {
                if (await isGitInitialized()) { // 仅在已初始化时配置远程
                    const configResult = await configureRemote(newConfig.repo_url);
                    if (!configResult.success) {
                        console.error('配置远程仓库失败:', configResult);
                        // 不阻止配置保存成功，但返回可能的错误信息
                        return res.json({ success: true, message: '配置已保存，但配置远程仓库失败', error: configResult.message });
                    }
                }
            }
            
            // 根据新配置启动或停止自动同步
            if (newConfig.auto_sync && newConfig.sync_interval > 0) {
                startAutoSync(newConfig.sync_interval);
            } else {
                stopAutoSync();
            }

            res.json({ success: true, message: '配置保存成功' });
        } catch (error) {
            console.error('保存配置错误:', error);
            res.status(500).json({ message: '保存配置失败: ' + error.message });
        }
    });

    // API端点 - 获取Git状态 - 路径修正
    router.get('/git/status', async (req, res) => {
        try {
            const status = await getGitStatus();
            res.json(status); // getGitStatus 应该返回前端需要的格式
        } catch (error) {
            console.error('获取Git状态错误:', error);
            // 如果仓库未初始化，返回特定状态而不是500错误
            if (error.message && error.message.includes('not a git repository')) {
                 res.json({ initialized: false, changes: [] });
            } else {
                 res.status(500).json({ message: '获取Git状态失败: ' + error.message });
            }
        }
    });

    // API端点 - 初始化Git仓库 - 路径修正
    router.post('/git/init', async (req, res) => {
        try {
            console.log('收到初始化仓库请求');
            const result = await initGitRepo();
            
            if (result.success) {
                const config = await readConfig();
                if (config.repo_url) {
                    const configResult = await configureRemote(config.repo_url);
                    if (!configResult.success) {
                        console.warn('初始化成功，但配置远程仓库失败:', configResult.message);
                        // 返回成功，但附带警告信息
                        return res.json({ success: true, message: '仓库初始化成功，但配置远程仓库失败', warning: configResult.message });
                    }
                }
            }
            
            res.json(result); // 返回 { success: true/false, message: '...' }
        } catch (error) {
            console.error('初始化仓库错误:', error);
            res.status(500).json({ message: '初始化仓库失败: ' + error.message });
        }
    });

    // API端点 - 同步到远程（上传） - 路径修正
    router.post('/git/sync/push', async (req, res) => {
        try {
            console.log('收到同步到远程请求 (手动)');
            const result = await syncToRemote(); // Uses add, commit, push

            if (result.success) {
                const config = await readConfig();
                config.last_sync = new Date().toISOString();
                await saveConfig(config);
                res.json({ success: true, message: '同步到远程成功' });
            } else {
                const stderr = result.stderr || result.error || '';
                let userMessage = result.message || '同步到远程失败';

                 // **关键修改：检测 Non-fast-forward 错误并返回特定错误**
                if (stderr.toLowerCase().includes('non-fast-forward') || stderr.toLowerCase().includes('updates were rejected')) {
                    userMessage = '推送失败：远程仓库包含本地没有的更新。请先 Pull 或选择强制推送。';
                    console.warn('[data-sync] Manual Push failed due to non-fast-forward');
                     // 返回 409 Conflict 状态码和特定错误类型
                     return res.status(409).json({ error: 'non_fast_forward', message: userMessage });
                }
                // 其他错误处理... (保持之前的认证错误等判断)
                else if (stderr.toLowerCase().includes('authentication failed') || stderr.toLowerCase().includes('could not read username') || stderr.toLowerCase().includes('permission denied') || stderr.toLowerCase().includes('repository not found')) {
                     userMessage = 'GitHub认证失败或仓库地址错误。请检查Token权限、仓库URL或重新设置Token。';
                     console.error('Push failed due to potential auth/repo issue:', stderr);
                     return res.status(401).json({ message: userMessage });
                }
                // 返回通用错误
                res.status(400).json({ message: userMessage, details: result.details || stderr });
            }
        } catch (error) {
            console.error('同步到远程错误 (手动):', error);
            res.status(500).json({ message: '同步到远程时发生内部错误: ' + error.message });
        }
    });

    // API端点 - 从远程同步（下载） - 路径修正
    router.post('/git/sync/pull', async (req, res) => {
        try {
            console.log('收到从远程同步请求 (手动)');
            const result = await syncFromRemote(); // syncFromRemote now uses pull

            if (result.success) {
                const config = await readConfig();
                config.last_sync = new Date().toISOString();
                await saveConfig(config);
                 res.json({ success: true, message: '从远程同步成功' });
            } else {
                const stderr = result.stderr || result.error || '';
                let userMessage = result.message || '从远程同步失败';

                 // **关键修改：检测合并冲突并返回特定错误**
                 if (stderr.toLowerCase().includes('merge conflict') || stderr.toLowerCase().includes('automatic merge failed')) {
                     userMessage = '合并冲突！请选择解决方案或手动处理。';
                      console.warn('[data-sync] Manual Pull resulted in merge conflict');
                      // 返回 409 Conflict 状态码和特定错误类型
                      return res.status(409).json({ error: 'merge_conflict', message: userMessage });
                 }
                 // 其他错误处理... (保持之前的认证错误等判断)
                 else if (stderr.toLowerCase().includes('authentication failed') || stderr.toLowerCase().includes('could not read username') || stderr.toLowerCase().includes('permission denied') || stderr.toLowerCase().includes('repository not found')) {
                     userMessage = 'GitHub认证失败或仓库地址错误。请检查Token权限、仓库URL或重新设置Token。';
                     console.error('Pull failed due to potential auth/repo issue:', stderr);
                     return res.status(401).json({ message: userMessage });
                 }
                 // 返回通用错误
                res.status(400).json({ message: userMessage, details: result.details || stderr });
            }
        } catch (error) {
            console.error('从远程同步错误 (手动):', error);
            res.status(500).json({ message: '从远程同步时发生内部错误: ' + error.message });
        }
    });

    // API端点 - 设置 GitHub Token - 路径修正
    router.post('/auth/token', async (req, res) => {
        try {
            console.log('收到设置Token请求');
            const { token } = req.body;
            if (!token || typeof token !== 'string') {
                return res.status(400).json({ message: 'Token无效或缺失' });
            }
            
            // 验证 token 有效性 (简单验证，实际可能需要更复杂逻辑)
            console.log('验证Token有效性...');
            const validationResponse = await fetch('https://api.github.com/user', {
                headers: { 'Authorization': `token ${token}` }
            });
            
            if (validationResponse.ok) {
                const userData = await validationResponse.json();
                console.log('Token验证成功，保存Token');
                const config = await readConfig();
                config.github_token = token;
                config.is_authorized = true; // 通过Token设置也视为授权
                config.username = userData.login || null; // 保存用户名
                await saveConfig(config);
                res.json({ success: true, message: 'Token保存成功' });
            } else {
                const errorBody = await validationResponse.text();
                console.error('无效的GitHub token:', validationResponse.status, errorBody);
                res.status(401).json({ message: 'GitHub Token无效或权限不足' });
            }
        } catch (error) {
            console.error('设置GitHub Token错误:', error);
             // 区分网络错误和其他错误
             const message = error.message.includes('fetch') ? '无法连接到GitHub验证Token' : '设置Token时发生内部错误';
             res.status(500).json({ message: `${message}: ${error.message}` });
        }
    });

    // API端点 - 获取授权状态 - 新增
    router.get('/auth/status', async (req, res) => {
        try {
            const config = await readConfig();
            res.json({
                authorized: !!config.is_authorized,
                username: config.username || null
            });
        } catch (error) {
            console.error('获取授权状态错误:', error);
            res.status(500).json({ message: '获取授权状态失败: ' + error.message });
        }
    });

    // API端点 - GitHub OAuth 开始授权 - 新增
    router.get('/auth/github/authorize', (req, res) => {
        const state = crypto.randomBytes(16).toString('hex');
        // 存储 state 到 session 或临时存储，用于后续验证
        // 示例：直接重定向，实际应用需要更安全的状态管理
        const authUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${OAUTH_REDIRECT_URI}&scope=repo&state=${state}`;
        console.log('Redirecting to GitHub for authorization:', authUrl);
        res.redirect(authUrl);
    });

    // API端点 - GitHub OAuth 回调处理 - 新增
    router.post('/auth/github/callback', async (req, res) => {
        const { code, state } = req.body;
        console.log(`Received OAuth callback: code=${code}, state=${state}`);
        
        // 实际应用中需要验证 state 的有效性
        // if (state !== storedState) { return res.status(403).json({ message: 'Invalid state' }); }
        
        if (!code) {
            return res.status(400).json({ message: 'Authorization code is missing' });
        }
        
        try {
            const result = await githubOAuth(code);
            if (result.success) {
                console.log('GitHub OAuth successful, username:', result.username);
                // OAuth 成功后，可以重定向回插件 UI 或返回成功信息
                // res.redirect('/api/plugins/data-sync/ui?oauth=success'); 
                res.json({ success: true, message: 'GitHub授权成功' });
            } else {
                console.error('GitHub OAuth failed:', result.message);
                // res.redirect('/api/plugins/data-sync/ui?oauth=failed');
                res.status(400).json({ success: false, message: result.message || 'GitHub授权失败' });
            }
        } catch (error) {
            console.error('处理OAuth回调时发生错误:', error);
            res.status(500).json({ message: '处理GitHub回调时发生内部错误: ' + error.message });
        }
    });

    // 插件加载时，根据配置启动自动同步（如果需要）
    const initialConfig = await readConfig();
    if (initialConfig.auto_sync && initialConfig.sync_interval > 0) {
        startAutoSync(initialConfig.sync_interval);
    }

    console.log('Data Sync plugin initialized successfully.');
}

// 插件退出函数
async function exit() {
    console.log('Data Sync plugin exiting...');
    // 清理操作 - 停止定时任务
    stopAutoSync();
    return Promise.resolve();
}

// 导出插件
module.exports = {
    info,
    init,
    exit
}; 