FROM node:lts-alpine3.19

# Arguments
ARG APP_HOME=/home/node/app

# Install system dependencies
# Add unzip for extracting the application code
# Keep git for potential use by scripts or future plugin updates
RUN apk add --no-cache gcompat tini git unzip

# Create app directory
WORKDIR ${APP_HOME}

# Set NODE_ENV to production
ENV NODE_ENV=production

# Copy the zip file from the build context
COPY sillytavern.zip .
RUN \
  echo "*** Unzipping SillyTavern Core ***" && \
  unzip -q sillytavern.zip && \
  rm sillytavern.zip

# --- BEGIN: Clone data-sync plugin ---
RUN \
  echo "*** Cloning data-sync plugin ***" && \
  # Create plugins directory if it doesn't exist
  mkdir -p plugins && \
  # Clone the plugin into the plugins directory
  git clone https://github.com/fuwei99/data-sync.git plugins/data-sync
# --- END: Clone data-sync plugin ---

# Install base SillyTavern dependencies (package*.json should be in the unzipped root)
RUN \
  echo "*** Install Base npm packages ***" && \
  if [ -f package.json ]; then \
    # Added --force to potentially overcome file system issues in docker/overlayfs
    npm i --no-audit --no-fund --loglevel=error --no-progress --omit=dev --force && npm cache clean --force; \
  else \
    echo "No package.json found in root, skipping base npm install."; \
  fi

# Install data-sync plugin dependencies
RUN \
  # Check if plugins/data-sync directory exists (it should now)
  if [ -d "plugins/data-sync" ]; then \
    echo "*** Install data-sync plugin npm packages ***" && \
    cd plugins/data-sync && \
    if [ -f package.json ]; then \
      # Added --force
      npm install --no-audit --no-fund --loglevel=error --no-progress --omit=dev --force && npm cache clean --force; \
    else \
      echo "No package.json found in data-sync, skipping npm install."; \
    fi && \
    cd ${APP_HOME}; \
  else \
    # This else block should ideally not be reached now
    echo "Error: plugins/data-sync directory not found after attempting clone."; \
    exit 1; # Exit with error if cloning failed or dir not found
  fi

# Go back to the main app directory (redundant but safe)
WORKDIR ${APP_HOME}

# Create config directory. config.yaml will be handled at runtime by ENTRYPOINT
RUN mkdir -p config

# Pre-compile public libraries (build-lib.js should be in the unzipped structure)
RUN \
  echo "*** Run Webpack ***" && \
  # Check if build-lib.js exists before running
  if [ -f "./docker/build-lib.js" ]; then \
    node "./docker/build-lib.js"; \
  elif [ -f "./build-lib.js" ]; then \
    node "./build-lib.js"; \
  else \
    echo "build-lib.js not found, skipping Webpack build."; \
  fi

# Cleanup unnecessary files (like the docker dir if it exists in the zip) and make entrypoint executable
# This block is removed as we no longer use docker-entrypoint.sh
# RUN \
#  echo "*** Cleanup and Permissions ***" && \
#  ...

# Fix potential git safe.directory issues if git commands are run later by scripts
RUN git config --global --add safe.directory "${APP_HOME}"

# Ensure the node user owns the application directory and its contents
RUN chown -R node:node ${APP_HOME}

EXPOSE 8000

# Entrypoint: Read config from environment variable CONFIG_YAML if set, copy default if not, then run node server.js directly
ENTRYPOINT ["tini", "--", "sh", "-c", " \
    echo '--- Checking for CONFIG_YAML environment variable ---'; \
    # Ensure the CWD has correct permissions for writing config.yaml
    # mkdir -p ./config && chown node:node ./config; # Removed mkdir
    if [ -n \"$CONFIG_YAML\" ]; then \
      echo 'Environment variable CONFIG_YAML found. Writing to ./config.yaml (root directory)...'; \
      # Write directly to ./config.yaml in the CWD
      printf '%s\n' \"$CONFIG_YAML\" > ./config.yaml && \
      chown node:node ./config.yaml && \
      echo 'Config written to ./config.yaml and permissions set successfully.'; \
      # --- BEGIN DEBUG: Print the written config file --- 
      echo '--- Verifying written ./config.yaml ---'; \
      cat ./config.yaml; \
      echo '--- End of ./config.yaml ---'; \
      # --- END DEBUG --- 
    else \
      echo 'Warning: Environment variable CONFIG_YAML is not set or empty. Attempting to copy default config...'; \
      # Copy default if ENV VAR is missing and the example exists
      if [ -f \"./public/config.yaml.example\" ]; then \
          # Copy default to ./config.yaml in the CWD
          cp \"./public/config.yaml.example\" \"./config.yaml\" && \
          chown node:node ./config.yaml && \
          echo 'Copied default config to ./config.yaml'; \
      else \
          echo 'Warning: Default config ./public/config.yaml.example not found.'; \
      fi; \
    fi; \
    echo 'Starting SillyTavern server directly...'; \
    # Execute node server directly, bypassing docker-entrypoint.sh
    exec node server.js; \
  "]