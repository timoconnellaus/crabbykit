# Reference Dockerfile for Cloudflare sandbox containers.
# Consumers can use this as a base or adapt for their needs.

FROM node:22-alpine

# Install FUSE support, privilege-drop, restic, and build tools for nm-intercept + node-pty
RUN apk add --no-cache fuse curl coreutils gosu shadow socat jq bash restic gcc musl-dev linux-headers python3 make g++

# Create unprivileged user
RUN useradd -m -s /bin/sh sandbox

# Install tigrisfs (FUSE filesystem for S3-compatible storage)
# Detect architecture and fetch the matching release from tigrisdata/tigrisfs
RUN ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/') && \
    VERSION=$(curl -s https://api.github.com/repos/tigrisdata/tigrisfs/releases/latest | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4) && \
    curl -L "https://github.com/tigrisdata/tigrisfs/releases/download/${VERSION}/tigrisfs_${VERSION#v}_linux_${ARCH}.tar.gz" -o /tmp/tigrisfs.tar.gz && \
    tar -xzf /tmp/tigrisfs.tar.gz -C /usr/local/bin/ && \
    rm /tmp/tigrisfs.tar.gz && \
    chmod +x /usr/local/bin/tigrisfs

# Create workspace and persist directories
RUN mkdir -p /mnt/r2 /opt/sandbox/persist /opt/sandbox/nm && \
    chown -R sandbox:sandbox /opt/sandbox

# Redirect global package managers to persist volume (not FUSE)
ENV BUN_INSTALL="/opt/sandbox/persist/bun" \
    NPM_CONFIG_PREFIX="/opt/sandbox/persist/npm" \
    PNPM_HOME="/opt/sandbox/persist/pnpm" \
    PIP_TARGET="/opt/sandbox/persist/pip" \
    CARGO_HOME="/opt/sandbox/persist/cargo" \
    GOPATH="/opt/sandbox/persist/go" \
    GEM_HOME="/opt/sandbox/persist/gems" \
    NODE_PATH="/opt/sandbox/persist/npm/lib/node_modules"

# Add persist volume bin paths (appended, not prepended, to avoid shadowing system binaries)
ENV PATH="$PATH:/opt/sandbox/persist/bun/bin:/opt/sandbox/persist/npm/bin:/opt/sandbox/persist/pnpm"

WORKDIR /app

# Compile nm-mount-helper (setuid root binary for bind-mounts) and
# nm-intercept (LD_PRELOAD library that calls the helper on node_modules mkdir)
COPY nm-mount-helper.c nm-intercept.c /tmp/
RUN gcc -o /usr/local/bin/nm-mount-helper /tmp/nm-mount-helper.c && \
    chmod u+s /usr/local/bin/nm-mount-helper && \
    gcc -shared -fPIC -o /usr/local/lib/nm-intercept.so /tmp/nm-intercept.c -ldl && \
    rm /tmp/nm-mount-helper.c /tmp/nm-intercept.c

# Install node-pty (native module — must be compiled inside the container)
RUN cd /app && npm install node-pty && \
    apk del gcc musl-dev linux-headers python3 make g++

# Install @claw-for-cloudflare/vite-plugin so vibe-coded apps can import it.
# Placed at /node_modules/ (root) so ESM resolution finds it from any project path.
COPY claw-vite-plugin/ /usr/local/lib/claw-vite-plugin/
RUN mkdir -p /node_modules/@claw-for-cloudflare && \
    ln -sf /usr/local/lib/claw-vite-plugin /node_modules/@claw-for-cloudflare/vite-plugin

# Copy container scripts and sandbox server
COPY startup.sh nm-guard.sh restic-syncd.sh server.ts /app/
RUN chmod +x /app/startup.sh /app/nm-guard.sh /app/restic-syncd.sh

EXPOSE 8080

ENTRYPOINT ["/app/startup.sh"]
