# Reference Dockerfile for Cloudflare sandbox containers.
# Consumers can use this as a base or adapt for their needs.

FROM node:22-alpine

# Install FUSE support, privilege-drop, restic, and build tools for nm-intercept
RUN apk add --no-cache fuse curl coreutils gosu shadow socat jq bash restic gcc musl-dev linux-headers

# Create unprivileged user
RUN useradd -m -s /bin/sh gia

# Install tigrisfs (FUSE filesystem for S3-compatible storage)
# Detect architecture and fetch the matching release from tigrisdata/tigrisfs
RUN ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/') && \
    VERSION=$(curl -s https://api.github.com/repos/tigrisdata/tigrisfs/releases/latest | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4) && \
    curl -L "https://github.com/tigrisdata/tigrisfs/releases/download/${VERSION}/tigrisfs_${VERSION#v}_linux_${ARCH}.tar.gz" -o /tmp/tigrisfs.tar.gz && \
    tar -xzf /tmp/tigrisfs.tar.gz -C /usr/local/bin/ && \
    rm /tmp/tigrisfs.tar.gz && \
    chmod +x /usr/local/bin/tigrisfs

# Create workspace and persist directories
RUN mkdir -p /mnt/r2 /opt/gia/persist /opt/gia/nm && \
    chown -R gia:gia /opt/gia

# Redirect global package managers to persist volume (not FUSE)
ENV BUN_INSTALL="/opt/gia/persist/bun" \
    NPM_CONFIG_PREFIX="/opt/gia/persist/npm" \
    PNPM_HOME="/opt/gia/persist/pnpm" \
    PIP_TARGET="/opt/gia/persist/pip" \
    CARGO_HOME="/opt/gia/persist/cargo" \
    GOPATH="/opt/gia/persist/go" \
    GEM_HOME="/opt/gia/persist/gems"

# Add persist volume bin paths (appended, not prepended, to avoid shadowing system binaries)
ENV PATH="$PATH:/opt/gia/persist/bun/bin:/opt/gia/persist/npm/bin:/opt/gia/persist/pnpm"

WORKDIR /app

# Compile nm-intercept (LD_PRELOAD library for instant node_modules bind-mounts)
COPY nm-intercept.c /tmp/nm-intercept.c
RUN gcc -shared -fPIC -o /usr/local/lib/nm-intercept.so /tmp/nm-intercept.c -ldl && \
    rm /tmp/nm-intercept.c && \
    apk del gcc musl-dev linux-headers

# Copy container scripts and sandbox server
COPY startup.sh nm-guard.sh restic-syncd.sh server.ts /app/
RUN chmod +x /app/startup.sh /app/nm-guard.sh /app/restic-syncd.sh

EXPOSE 8080

ENTRYPOINT ["/app/startup.sh"]
