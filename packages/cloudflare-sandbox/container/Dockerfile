# Reference Dockerfile for Cloudflare sandbox containers.
# Consumers can use this as a base or adapt for their needs.

FROM node:22-alpine

# Install FUSE support and privilege-drop utility
RUN apk add --no-cache fuse curl coreutils gosu shadow

# Create unprivileged user
RUN useradd -m -s /bin/sh gia

# Install tigrisfs (FUSE filesystem for S3-compatible storage)
ARG TIGRISFS_VERSION=0.1.11
RUN wget -q "https://github.com/tigrisdata-community/tigrisfs/releases/download/v${TIGRISFS_VERSION}/tigrisfs-linux-amd64" \
    -O /usr/local/bin/tigrisfs && \
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

# Copy container scripts
COPY startup.sh nm-guard.sh /app/
RUN chmod +x /app/startup.sh /app/nm-guard.sh

# Copy sandbox server (consumer provides this)
# COPY server.ts /app/

EXPOSE 8080

ENTRYPOINT ["/app/startup.sh"]
