// 数据同步前端脚本
document.addEventListener('DOMContentLoaded', function() {
    // 初始化Bootstrap组件 (假设 window.bootstrap 已由主应用或CDN加载)
    // No explicit initialization needed here if components are initialized via data attributes
    
    // 初始化界面元素
    initUI();
    
    // 绑定按钮事件
    bindEventListeners();
    
    // 加载配置
    loadConfig();
    
    // 检查Git状态
    checkGitStatus();
    
    // 检查GitHub授权状态
    checkAuthStatus();
});

// CSRF令牌
let csrfToken = '';

// 获取CSRF令牌
function getCSRFToken() {
    const metaTag = document.querySelector('meta[name="csrf-token"]');
    if (metaTag instanceof HTMLMetaElement) { 
        const tokenFromMeta = metaTag.getAttribute('content');
        if (tokenFromMeta) {
            csrfToken = tokenFromMeta;
            return Promise.resolve(csrfToken);
        }
    }
    
    // Fetch from the main application's endpoint
    return fetch('/csrf-token') // Correct endpoint
        .then(response => {
            if (!response.ok) {
                throw new Error(`获取CSRF令牌失败: ${response.status}`);
            }
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                return response.json();
            } else {
                throw new Error('CSRF令牌响应不是有效的JSON');
            }
        })
        .then(data => {
            if (data && data.token && typeof data.token === 'string') { 
                csrfToken = data.token;
                let metaTagToUpdate = document.querySelector('meta[name="csrf-token"]');
                if (!metaTagToUpdate) {
                    metaTagToUpdate = document.createElement('meta');
                    if (metaTagToUpdate instanceof HTMLMetaElement) {
                         metaTagToUpdate.name = "csrf-token";
                         if (document.head) {
                             document.head.appendChild(metaTagToUpdate);
                         } else {
                             console.error('Cannot find document head to append CSRF meta tag');
                             throw new Error('Document head not found'); 
                         }
                    } else {
                         throw new Error('Failed to create meta tag element');
                    }
                }
                if (metaTagToUpdate instanceof HTMLMetaElement) {
                    metaTagToUpdate.setAttribute('content', csrfToken);
                }
                return csrfToken;
            } else {
                throw new Error('无法从响应中解析CSRF令牌或令牌格式无效');
            }
        })
        .catch(error => {
            console.error('获取CSRF令牌时出错:', error);
            csrfToken = ''; 
            throw error; 
        });
}

// API请求函数
// data parameter is expected to be an object for POST/PUT/PATCH, or null/undefined otherwise.
async function apiRequest(endpoint, method = 'GET', data = null) { 
    try {
        if (!csrfToken) {
             await getCSRFToken();
        }
        if (!csrfToken) {
            throw new Error('CSRF Token is still empty after fetch attempt');
        }
    } catch (error) {
        console.error('无法获取CSRF令牌，请求中止:', error);
        showToast('错误', '无法获取安全令牌，请刷新页面重试', 'danger');
        throw error instanceof Error ? error : new Error('CSRF Token acquisition failed');
    }
    
    const options = {
        method: method,
        headers: {
            'X-CSRF-Token': csrfToken
        },
        // 'same-origin' is the most common and secure default for credentials
        credentials: 'same-origin'
    };
    
    if (data && typeof data === 'object' && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(data);
    }
    
    let response;
    try {
        response = await fetch(`/api/plugins/data-sync${endpoint}`, options);
    } catch (networkError) {
        console.error('网络请求错误:', networkError);
        showToast('错误', '网络连接失败，请检查您的网络', 'danger');
        throw networkError;
    }
    
    if (!response.ok) {
        let errorText = `请求失败，状态码: ${response.status}`;
        try {
             const bodyText = await response.text();
             try {
                 const errorJson = JSON.parse(bodyText);
                 if (errorJson && errorJson.message) {
                     errorText = `请求失败 (${response.status}): ${errorJson.message}`; // Include status in message
                 } else if (bodyText) {
                     errorText = `请求失败 (${response.status}): ${bodyText}`; // Include status in message
                 }
             } catch(parseError) {
                 if (bodyText) { 
                    errorText = `请求失败 (${response.status}): ${bodyText}`; // Include status in message
                 }
             }
        } catch(readError) { 
             console.warn('读取错误响应体失败:', readError);
        }
        const apiError = new Error(errorText); // Error message now contains status
        showToast('错误', errorText, 'danger'); 
        throw apiError; 
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
        const text = await response.text();
        try {
            return text ? JSON.parse(text) : {}; 
        } catch (parseError) {
            console.error('无法解析JSON响应:', parseError, '响应体:', text);
            showToast('错误', '收到无效的服务器响应', 'danger');
            throw new Error('无效的JSON响应');
        }
    } else if (response.status === 204) { 
        return {}; 
    }
    
    try {
         return await response.text();
    } catch (readError) {
        console.error('无法读取响应文本:', readError);
        showToast('错误', '无法读取服务器响应', 'danger');
        throw new Error('无法读取响应');
    }
}

// 初始化UI
function initUI() {
    const autoSyncCheckbox = document.getElementById('auto_sync');
    const syncIntervalContainer = document.getElementById('sync_interval_container');
    
    if (autoSyncCheckbox instanceof HTMLInputElement && syncIntervalContainer instanceof HTMLElement) {
        syncIntervalContainer.style.display = autoSyncCheckbox.checked ? 'block' : 'none'; 
        autoSyncCheckbox.addEventListener('change', function() {
            syncIntervalContainer.style.display = this.checked ? 'block' : 'none';
        });
    } else {
        console.warn('自动同步复选框或间隔容器未找到');
    }
    
    const toggleTokenBtn = document.getElementById('toggle_token_visibility');
    const tokenInput = document.getElementById('github_token_input');
    
    if (toggleTokenBtn instanceof HTMLButtonElement && tokenInput instanceof HTMLInputElement) {
        toggleTokenBtn.addEventListener('click', function() {
            const currentType = tokenInput.getAttribute('type');
            const newType = currentType === 'password' ? 'text' : 'password';
            tokenInput.setAttribute('type', newType);
            const iconElement = this.querySelector('i'); 
            if (iconElement instanceof HTMLElement) { 
                 iconElement.className = newType === 'password' ? 'bi bi-eye' : 'bi bi-eye-slash';
            }
        });
    } else {
        console.warn('令牌可见性切换按钮或输入框未找到');
    }
}

// 绑定事件监听器
function bindEventListeners() {
    const bindClick = (id, handler) => {
        const element = document.getElementById(id);
        if (element instanceof HTMLElement) { 
            element.addEventListener('click', handler);
        } else {
            console.warn(`无法绑定点击事件: 未找到ID为 '${id}' 的元素`);
        }
    };

    bindClick('save_config_btn', saveConfig);
    bindClick('init_repo_btn', initRepo);
    bindClick('sync_to_remote_btn', syncToRemote);
    bindClick('sync_from_remote_btn', syncFromRemote);
    bindClick('authorize_btn', authorizeGitHub);
    bindClick('set_token_btn', setGitHubToken);
    
    checkOAuthCallback();
}

// 加载配置
async function loadConfig() {
    try {
        showSpinner('git_status', true, true); 
        const config = await apiRequest('/config');
        
        const repoUrlInput = document.getElementById('repo_url');
        const branchInput = document.getElementById('branch');
        const autoSyncCheckbox = document.getElementById('auto_sync');
        const syncIntervalContainer = document.getElementById('sync_interval_container');
        const syncIntervalInput = document.getElementById('sync_interval');
        const lastSyncTimeElement = document.getElementById('last_sync_time');

        if (config && typeof config === 'object' && // Ensure config is an object
            repoUrlInput instanceof HTMLInputElement && 
            branchInput instanceof HTMLInputElement && 
            autoSyncCheckbox instanceof HTMLInputElement && 
            syncIntervalContainer instanceof HTMLElement && 
            syncIntervalInput instanceof HTMLInputElement && 
            lastSyncTimeElement instanceof HTMLElement) {
                
            repoUrlInput.value = config.repoUrl || '';
            branchInput.value = config.branch || 'main';
            autoSyncCheckbox.checked = !!config.autoSync; 
            syncIntervalContainer.style.display = autoSyncCheckbox.checked ? 'block' : 'none';
            syncIntervalInput.value = config.syncInterval || '60';
            
            if (config.lastSync) {
                const lastSyncDate = new Date(config.lastSync);
                lastSyncTimeElement.textContent = !isNaN(lastSyncDate.getTime()) 
                    ? lastSyncDate.toLocaleString() 
                    : '无效日期';
            } else {
                lastSyncTimeElement.textContent = '从未同步';
            }
            
            updateTokenStatus(!!config.hasToken); 
        } else {
            console.warn('加载配置时部分UI元素未找到或配置数据无效');
        }
    } catch (error) {
        console.error('加载配置失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        showToast('错误', `加载配置失败: ${message}`, 'danger');
    } finally {
        // Let checkGitStatus handle the final spinner state for git_status
    }
}

// 保存配置
async function saveConfig() {
    const repoUrlInput = document.getElementById('repo_url');
    const branchInput = document.getElementById('branch');
    const autoSyncCheckbox = document.getElementById('auto_sync');
    const syncIntervalInput = document.getElementById('sync_interval');

    if (!(repoUrlInput instanceof HTMLInputElement) || 
        !(branchInput instanceof HTMLInputElement) || 
        !(autoSyncCheckbox instanceof HTMLInputElement) || 
        !(syncIntervalInput instanceof HTMLInputElement)) {
        console.error('无法找到配置表单元素');
        showToast('错误', '无法保存配置，请刷新页面重试', 'danger');
        return;
    }

    try {
        const syncIntervalValue = parseInt(syncIntervalInput.value, 10);
        if (isNaN(syncIntervalValue) || syncIntervalValue < 5) {
            showToast('警告', '同步间隔必须是大于或等于5的整数', 'warning');
            syncIntervalInput.focus(); 
            return; 
        }

        const configData = {
            repoUrl: repoUrlInput.value.trim(), 
            branch: branchInput.value.trim() || 'main', 
            autoSync: autoSyncCheckbox.checked,
            syncInterval: syncIntervalValue
        };
        
        showSpinner('save_config_btn', true);
        // Explicitly pass the object data here for clarity
        await apiRequest('/config', 'POST', configData); 
        showToast('成功', '配置保存成功', 'success');
        
        await checkGitStatus(); 
    } catch (error) {
        console.error('保存配置失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        showToast('错误', `保存配置失败: ${message}`, 'danger');
    } finally {
        showSpinner('save_config_btn', false);
    }
}

// 检查Git状态
async function checkGitStatus() {
    const statusElement = document.getElementById('git_status');
    if (!(statusElement instanceof HTMLElement)) {
        console.warn('Git状态元素未找到');
        return; 
    }

    let isInitialized = false; 
    try {
        showSpinner('git_status', true, true); 
        const status = await apiRequest('/git/status');
        
        if (status && typeof status === 'object') {
            let statusHtml = '';
            isInitialized = !!status.initialized;
            
            if (status.initialized) {
                statusHtml = `<span class="badge text-bg-success status-badge">已初始化</span>`; 
            } else {
                statusHtml = `<span class="badge text-bg-warning status-badge">未初始化</span>`;
            }
            
            if (Array.isArray(status.changes) && status.changes.length > 0) {
                statusHtml += ` <span class="badge text-bg-info status-badge">${status.changes.length}个文件有变化</span>`;
            }
            
            statusElement.innerHTML = statusHtml;
        } else {
             statusElement.innerHTML = `<span class="badge text-bg-secondary status-badge">状态未知</span>`;
        }
    } catch (error) {
        console.error('检查Git状态失败:', error);
        // Check the error message for status code if needed (removed direct status property)
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('404')) { // Simple check for 404 in message
             statusElement.innerHTML = `<span class="badge text-bg-warning status-badge">未初始化</span>`;
             isInitialized = false;
        } else {
            statusElement.innerHTML = `<span class="badge text-bg-danger status-badge">检查错误</span>`;
            isInitialized = false; 
        }
    } finally {
        updateButtonsState(isInitialized);
        showSpinner('git_status', false, true);
    }
}

// 初始化仓库
async function initRepo() {
    try {
        showSpinner('init_repo_btn', true);
        await apiRequest('/git/init', 'POST');
        showToast('成功', '仓库初始化成功', 'success');
        await checkGitStatus(); 
    } catch (error) {
        console.error('初始化仓库失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        showToast('错误', `初始化仓库失败: ${message}`, 'danger');
    } finally {
        showSpinner('init_repo_btn', false);
    }
}

// 同步到远程
async function syncToRemote() {
    try {
        showSpinner('sync_to_remote_btn', true);
        await apiRequest('/git/sync/push', 'POST');
        showToast('成功', '成功同步到远程仓库', 'success');
        await Promise.all([
            checkGitStatus(),
            loadConfig() 
        ]);
    } catch (error) {
        console.error('同步到远程失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        showToast('错误', `同步到远程失败: ${message}`, 'danger');
    } finally {
        showSpinner('sync_to_remote_btn', false);
    }
}

// 从远程同步
async function syncFromRemote() {
    try {
        showSpinner('sync_from_remote_btn', true);
        await apiRequest('/git/sync/pull', 'POST');
        showToast('成功', '成功从远程仓库同步', 'success');
        await Promise.all([
            checkGitStatus(),
            loadConfig() 
        ]);
    } catch (error) {
        console.error('从远程同步失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Merge conflict')) {
             showToast('错误', '从远程同步失败: 存在合并冲突，请手动解决', 'danger');
        } else {
             showToast('错误', `从远程同步失败: ${message}`, 'danger');
        }
    } finally {
        showSpinner('sync_from_remote_btn', false);
    }
}

// 设置GitHub令牌
async function setGitHubToken() {
    const tokenInput = document.getElementById('github_token_input');
    if (!(tokenInput instanceof HTMLInputElement)) {
        console.warn('GitHub令牌输入框未找到');
        return;
    }

    const token = tokenInput.value.trim();
    if (!token) {
        showToast('警告', '请输入GitHub令牌', 'warning');
        tokenInput.focus();
        return;
    }
        
    try {
        showSpinner('set_token_btn', true);
        // Ensure data is passed as an object
        await apiRequest('/auth/token', 'POST', { token: token }); 
        showToast('成功', 'GitHub令牌设置成功', 'success');
        updateTokenStatus(true);
        await checkAuthStatus();
        tokenInput.value = ''; 
        
        // Attempt to close the modal using standard checks
        if (typeof window.bootstrap !== 'undefined' && window.bootstrap.Modal) {
            const tokenModalElement = document.getElementById('tokenModal');
            if (tokenModalElement) {
                 // Use window.bootstrap directly
                 const tokenModalInstance = window.bootstrap.Modal.getInstance(tokenModalElement); 
                 if (tokenModalInstance) {
                     tokenModalInstance.hide();
                 }
            } else {
                 console.warn('令牌模态框元素未找到');
            }
        } else {
             console.warn('Bootstrap Modal component not available to close modal.');
        }
    } catch (error) {
        console.error('设置GitHub令牌失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        showToast('错误', `设置GitHub令牌失败: ${message}`, 'danger');
    } finally {
        showSpinner('set_token_btn', false);
    }
}

// 更新令牌状态
function updateTokenStatus(hasToken) {
    const tokenStatus = document.getElementById('github_token_status');
    if (tokenStatus instanceof HTMLElement) {
        tokenStatus.innerHTML = hasToken 
            ? `<span class="badge text-bg-success status-badge">已设置</span>` 
            : `<span class="badge text-bg-danger status-badge">未设置</span>`;
    }
}

// 更新按钮状态 (基于仓库是否初始化)
function updateButtonsState(isRepoInitialized) {
    const initRepoBtn = document.getElementById('init_repo_btn');
    const syncToRemoteBtn = document.getElementById('sync_to_remote_btn');
    const syncFromRemoteBtn = document.getElementById('sync_from_remote_btn');
    
    if (initRepoBtn instanceof HTMLButtonElement) {
        initRepoBtn.disabled = isRepoInitialized;
    }
    if (syncToRemoteBtn instanceof HTMLButtonElement) {
        syncToRemoteBtn.disabled = !isRepoInitialized;
    }
    if (syncFromRemoteBtn instanceof HTMLButtonElement) {
        syncFromRemoteBtn.disabled = !isRepoInitialized;
    }
}

// 授权GitHub
function authorizeGitHub() {
    window.location.href = '/api/plugins/data-sync/auth/github/authorize';
}

// 检查授权状态
async function checkAuthStatus() {
    const authStatusElement = document.getElementById('auth_status');
    const authorizeBtn = document.getElementById('authorize_btn');
    if (!(authStatusElement instanceof HTMLElement)) {
         console.warn('授权状态元素未找到');
         return;
    }

    let isAuthorized = false;
    try {
        const status = await apiRequest('/auth/status');
        
        if (status && typeof status === 'object' && status.authorized) {
            isAuthorized = true;
            authStatusElement.innerHTML = 
                `<span class="badge text-bg-success status-badge">已授权</span> ${status.username || ''}`;
        } else {
            authStatusElement.innerHTML = 
                `<span class="badge text-bg-warning status-badge">未授权</span>`;
        }
    } catch (error) {
        console.error('检查授权状态失败:', error);
        authStatusElement.innerHTML = `<span class="badge text-bg-danger status-badge">检查错误</span>`;
        isAuthorized = false; 
    } finally {
         if (authorizeBtn instanceof HTMLButtonElement) {
             authorizeBtn.disabled = isAuthorized;
         }
    }
}

// 检查OAuth回调
function checkOAuthCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const state = urlParams.get('state');
    
    if (code && state) {
        window.history.replaceState({}, document.title, window.location.pathname);
        handleOAuthCallback(code, state);
    }
}

// 处理OAuth回调
async function handleOAuthCallback(code, state) {
    try {
        showToast('信息', '正在处理GitHub授权...', 'info');
        // Ensure data is passed as an object
        const result = await apiRequest('/auth/github/callback', 'POST', { code: code, state: state }); 
        
        if (result && result.success) {
            showToast('成功', 'GitHub授权成功', 'success');
            await checkAuthStatus(); 
        } else {
            const message = (result && result.message) ? result.message : '未知错误';
            showToast('错误', `授权失败: ${message}`, 'danger');
        }
    } catch (error) {
        console.error('处理OAuth回调失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        showToast('错误', `授权处理失败: ${message}`, 'danger');
    }
}

// 显示加载中的旋转器
function showSpinner(elementId, show, isStatusCheck = false) { 
    const element = document.getElementById(elementId);
    if (!(element instanceof HTMLElement)) return; 
    
    const spinnerHtml = `
        <div class="spinner-border spinner-border-sm" role="status" aria-hidden="true"> 
            <span class="visually-hidden">加载中...</span>
        </div>
    `;

    if (show) {
        const currentContent = element.innerHTML.trim();
        if (!element.hasAttribute('data-original-content') && !currentContent.includes('spinner-border')) {
             element.setAttribute('data-original-content', currentContent);
        }
        
        if (isStatusCheck) {
            const statusText = element.hasAttribute('data-original-content') && element.getAttribute('data-original-content') 
                               ? element.getAttribute('data-original-content') 
                               : '检查中...';
             element.innerHTML = spinnerHtml + `<span class="ms-1">${statusText}</span>`;
        } else {
             element.innerHTML = spinnerHtml + '<span class="ms-1">处理中...</span>';
        }
        
        if (element instanceof HTMLButtonElement) {
             element.disabled = true;
        }
    } else {
        const originalContent = element.getAttribute('data-original-content');
        if (originalContent !== null) { 
            element.innerHTML = originalContent;
            element.removeAttribute('data-original-content');
        } else if (isStatusCheck) {
             element.innerHTML = '<span class="text-muted">-</span>';
        } 
        
        if (element instanceof HTMLButtonElement) {
             element.disabled = false;
        }
    }
}

// 显示消息提示
function showToast(title, message, type) {
    const toastContainer = document.getElementById('toast-container');
    if (!(toastContainer instanceof HTMLElement)) {
        console.error('Toast container not found!');
        return;
    }
    
    const safeTitle = String(title).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const safeMessage = String(message).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // Basic validation for type to prevent unexpected classes
    const allowedTypes = ['success', 'info', 'warning', 'danger', 'primary', 'secondary', 'light', 'dark'];
    const safeType = allowedTypes.includes(type) ? type : 'secondary'; // Default to secondary

    const toastId = 'toast-' + Date.now();
    const toastHtml = `
        <div id="${toastId}" class="toast fade" role="alert" aria-live="assertive" aria-atomic="true">
            <div class="toast-header text-white text-bg-${safeType}">
                <strong class="me-auto">${safeTitle}</strong>
                <button type="button" class="btn-close btn-close-white" data-bs-dismiss="toast" aria-label="关闭"></button>
            </div>
            <div class="toast-body">
                ${safeMessage}
            </div>
        </div>
    `;
    
    toastContainer.insertAdjacentHTML('beforeend', toastHtml);
    
    const toastElement = document.getElementById(toastId);
    
    // Check if Bootstrap and Toast constructor are available using standard checks
    if (toastElement instanceof HTMLElement && 
        typeof window.bootstrap !== 'undefined' && 
        typeof window.bootstrap.Toast === 'function') {
            
        try {
             // Use window.bootstrap directly
            const toast = new window.bootstrap.Toast(toastElement, { 
                autohide: true, 
                delay: 5000 
            });
            toast.show();
            
            toastElement.addEventListener('hidden.bs.toast', function handleHide() {
                toastElement.removeEventListener('hidden.bs.toast', handleHide);
                if (toastElement.parentNode) {
                    toastElement.parentNode.removeChild(toastElement);
                }
            });
        } catch (e) {
             console.error('创建或显示 Bootstrap Toast 时出错:', e);
             if (toastElement.parentNode) {
                toastElement.parentNode.removeChild(toastElement);
             }
        }
    } else {
         console.error('无法找到 toast 元素或 Bootstrap Toast 组件。Toast 消息可能无法显示。');
         // Attempt to remove manually after a delay as a fallback
         if (toastElement && toastElement.parentNode) {
             setTimeout(() => {
                if (toastElement.parentNode) toastElement.parentNode.removeChild(toastElement);
             }, 5500); // Slightly longer than delay
         }
    }
}

// 显示确认对话框
function showConfirmDialog(options) {
    return new Promise((resolve, reject) => {
        const dialogElement = document.getElementById('confirmDialog');
        if (!(dialogElement instanceof HTMLElement)) {
            console.error('确认对话框元素未找到');
            // 回退到原生 confirm
            if (window.confirm(options.message)) {
                resolve(true);
            } else {
                resolve(false);
            }
            return;
        }

        // 设置对话框内容
        const titleElement = document.getElementById('confirmDialogLabel');
        const messageElement = document.getElementById('confirm-dialog-message');
        const confirmButton = document.getElementById('confirm-dialog-confirm-btn');
        const cancelButton = document.getElementById('confirm-dialog-cancel-btn');
        const iconElement = document.getElementById('confirm-dialog-icon');

        // 防止元素不存在导致错误
        if (titleElement instanceof HTMLElement) {
            titleElement.textContent = options.title || '确认操作';
        }
        if (messageElement instanceof HTMLElement) {
            messageElement.textContent = options.message || '';
        }
        if (confirmButton instanceof HTMLElement) {
            confirmButton.textContent = options.confirmText || '确认';
            confirmButton.className = 'btn ' + (options.confirmButtonClass || 'btn-primary');
        }
        if (cancelButton instanceof HTMLElement) {
            cancelButton.textContent = options.cancelText || '取消';
            cancelButton.className = 'btn ' + (options.cancelButtonClass || 'btn-secondary');
        }
        if (iconElement instanceof HTMLElement) {
            let iconClass = 'bi bi-question-circle-fill text-primary';
            if (options.type === 'warning') {
                iconClass = 'bi bi-exclamation-triangle-fill text-warning';
            } else if (options.type === 'danger') {
                iconClass = 'bi bi-exclamation-circle-fill text-danger';
            } else if (options.type === 'info') {
                iconClass = 'bi bi-info-circle-fill text-info';
            } else if (options.type === 'success') {
                iconClass = 'bi bi-check-circle-fill text-success';
            }
            iconElement.innerHTML = `<i class="${iconClass}" style="font-size: 2.5rem;"></i>`;
        }

        // 创建并显示模态框
        let dialog = null;
        if (typeof window.bootstrap !== 'undefined' && typeof window.bootstrap.Modal === 'function') {
            dialog = new window.bootstrap.Modal(dialogElement);
            dialog.show();
        } else {
            console.error('Bootstrap Modal 组件未找到');
            // 回退到原生 confirm
            if (window.confirm(options.message)) {
                resolve(true);
            } else {
                resolve(false);
            }
            return;
        }

        // 处理按钮点击事件
        const confirmHandler = () => {
            dialog.hide();
            cleanupEventListeners();
            resolve(true);
        };

        const cancelHandler = () => {
            dialog.hide();
            cleanupEventListeners();
            resolve(false);
        };

        // 处理模态框隐藏事件
        const hiddenHandler = () => {
            cleanupEventListeners();
            resolve(false);
        };

        // 清理事件监听器
        const cleanupEventListeners = () => {
            if (confirmButton instanceof HTMLElement) {
                confirmButton.removeEventListener('click', confirmHandler);
            }
            if (cancelButton instanceof HTMLElement) {
                cancelButton.removeEventListener('click', cancelHandler);
            }
            dialogElement.removeEventListener('hidden.bs.modal', hiddenHandler);
        };

        // 添加事件监听器
        if (confirmButton instanceof HTMLElement) {
            confirmButton.addEventListener('click', confirmHandler);
        }
        if (cancelButton instanceof HTMLElement) {
            cancelButton.addEventListener('click', cancelHandler);
        }
        dialogElement.addEventListener('hidden.bs.modal', hiddenHandler);
    });
}

// 处理同步按钮点击
async function handleSync(action) {
    const pluginId = 'data-sync'; // 或者从全局变量获取
    const actionText = action === 'pull' ? '下载' : '上传';
    const loadingText = `正在${actionText}...`;
    
    showLoading(loadingText);
    updateStatus(loadingText);
    disableButtons();

    const endpoint = action === 'pull' ? '/git/sync/pull' : '/git/sync/push';
    let forceEndpoint = null; // 用于后续强制操作
    let responseStatus = 0;
    let responseBody = {};

    try {
        const response = await fetch(`/api/plugins/${pluginId}${endpoint}`, { method: 'POST' });
        responseStatus = response.status;
        // 尝试解析所有响应体，即使是错误响应
        try {
            responseBody = await response.json();
        } catch (parseError) {
            // 如果响应体不是 JSON 或为空，则创建一个包含状态码的消息
            responseBody = { message: `请求失败，HTTP 状态码: ${responseStatus}` };
            console.warn('Failed to parse JSON response for status', responseStatus, await response.text());
        }

        if (response.ok) {
            showToast(`${actionText}成功: ${responseBody.message || '操作完成'}`);
            updateStatus('同步成功');
            fetchConfig(); // 刷新配置（主要是最后同步时间）
            fetchStatus(); // 刷新状态
        } else {
            // **处理特定错误 (409 Conflict)**
            if (responseStatus === 409) {
                if (responseBody.error === 'merge_conflict') {
                    // --- Pull 冲突处理 ---
                    updateStatus('合并冲突！请选择操作'); // 更新状态栏
                    
                    // 使用自定义确认对话框替代 window.confirm
                    const overwriteLocal = await showConfirmDialog({
                        title: '合并冲突',
                        message: `${responseBody.message}\n\n是否用远程版本覆盖本地 (将丢失本地未推送更改)？`,
                        confirmText: '覆盖本地',
                        cancelText: '手动解决',
                        type: 'warning',
                        confirmButtonClass: 'btn-danger'
                    });
                    
                    if (overwriteLocal) {
                        forceEndpoint = '/git/sync/force-overwrite-local';
                    } else {
                        showToast('操作已取消。请手动解决冲突后再次尝试。您也可以尝试强制推送(如果确定本地为最新)。');
                        updateStatus('合并冲突，请手动解决');
                    }
                } else if (responseBody.error === 'non_fast_forward') {
                    // --- Push 非快进错误处理 ---
                    updateStatus('推送失败，远程有更新'); // 更新状态栏
                    
                    // 使用自定义确认对话框替代 window.confirm
                    const forcePush = await showConfirmDialog({
                        title: '推送失败',
                        message: `${responseBody.message}\n\n是否强制推送以覆盖远程更改 (危险操作)？`,
                        confirmText: '强制推送',
                        cancelText: '先执行 Pull',
                        type: 'danger',
                        confirmButtonClass: 'btn-danger'
                    });
                    
                    if (forcePush) {
                        forceEndpoint = '/git/sync/force-push';
                    } else {
                        showToast('操作已取消。请先 Pull 合并更改。');
                        updateStatus('推送失败，需先 Pull');
                    }
                } else {
                    // 其他 409 错误
                     showToast(`${actionText}失败: ${responseBody.message || '未知冲突'}`, true);
                     updateStatus(`${actionText}失败 (冲突)`);
                }
            } else {
                 // 其他非 409 错误 (如 400, 401, 500)
                 showToast(`${actionText}失败: ${responseBody.message || `HTTP ${responseStatus}`}`, true);
                 updateStatus(`${actionText}失败`);
            }
        }

        // 如果用户选择了强制操作
        if (forceEndpoint) {
            const forceActionText = forceEndpoint === '/git/sync/force-push' ? '强制推送' : '强制覆盖本地';
            showLoading(`正在${forceActionText}...`);
            updateStatus(`正在${forceActionText}...`);
            // 按钮保持禁用状态

            const forceResponse = await fetch(`/api/plugins/${pluginId}${forceEndpoint}`, { method: 'POST' });
            let forceResponseBody = {};
            try {
                 forceResponseBody = await forceResponse.json();
            } catch (parseError) {
                 forceResponseBody = { message: `请求失败，HTTP 状态码: ${forceResponse.status}` };
            }

            if (forceResponse.ok) {
                showToast(`操作成功: ${forceResponseBody.message || '完成'}`);
                updateStatus('操作成功');
                fetchConfig();
                fetchStatus();
            } else {
                showToast(`操作失败: ${forceResponseBody.message || `HTTP ${forceResponse.status}`}`, true);
                updateStatus('操作失败');
                fetchStatus(); // 失败后也刷新状态，看看是否仍冲突
            }
        }

    } catch (error) {
        console.error('同步错误:', error);
        showToast(`同步过程中发生错误: ${error.message}`, true);
        updateStatus('同步错误');
        // 发生网络等错误时，也尝试刷新状态
        fetchStatus();
    } finally {
        // 只有在没有进行强制操作，或者强制操作完成后才隐藏loading和启用按钮
        if (!forceEndpoint || (forceEndpoint && (responseStatus !== 409))) {
             hideLoading();
             enableButtons();
             // 如果原始操作是 Pull 且遇到冲突但用户取消了，确保刷新状态
             if (action === 'pull' && responseStatus === 409 && responseBody.error === 'merge_conflict' && !forceEndpoint) {
                 fetchStatus();
             }
        }
        // 如果执行了强制操作，loading 和按钮状态由强制操作的 finally 处理
        else if (forceEndpoint) {
            hideLoading();
            enableButtons();
        }
    }
} 