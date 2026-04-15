# Reference Dockerfile for Cloudflare sandbox containers.
# Consumers can use this as a base or adapt for their needs.
#
# BUILD CONTEXT: repo root. Set via wrangler `image_build_context: "../../"`
# so `COPY` paths reference workspace packages directly — no staging step.
# A repo-root .dockerignore prunes node_modules and other noise.

FROM node:22-alpine

# Install FUSE support, privilege-drop, restic, and build tools for nm-intercept + node-pty
RUN apk add --no-cache fuse curl coreutils gosu shadow socat jq bash restic gcc musl-dev linux-headers python3 make g++ unzip

# Install bun (primary package manager — much faster than npm for installs)
RUN curl -fsSL https://bun.sh/install | bash && \
    mv /root/.bun/bin/bun /usr/local/bin/bun && \
    ln -sf /usr/local/bin/bun /usr/local/bin/bunx && \
    rm -rf /root/.bun

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
RUN mkdir -p /workspace /opt/sandbox/persist /opt/sandbox/nm && \
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
COPY packages/cloudflare-sandbox/container/nm-mount-helper.c packages/cloudflare-sandbox/container/nm-intercept.c /tmp/
RUN gcc -o /usr/local/bin/nm-mount-helper /tmp/nm-mount-helper.c && \
    chmod u+s /usr/local/bin/nm-mount-helper && \
    gcc -shared -fPIC -o /usr/local/lib/nm-intercept.so /tmp/nm-intercept.c -ldl && \
    rm /tmp/nm-mount-helper.c /tmp/nm-intercept.c

# Install node-pty (native module — must be compiled inside the container)
# Override BUN_INSTALL for this build step so bun doesn't write root-owned
# files into the sandbox persist path. Clean up after.
RUN cd /app && BUN_INSTALL=/tmp/bun-build bun install node-pty && \
    rm -rf /tmp/bun-build /tmp/.bun* /tmp/bun* && \
    apk del gcc musl-dev linux-headers python3 make g++ unzip

# Install @claw-for-cloudflare/vite-plugin so vibe-coded apps can import it.
# Placed at /node_modules/ (root) so ESM resolution finds it from any project path.
# (Committed prebuilt .js blob — not rebuilt from workspace TS at image build.)
COPY packages/cloudflare-sandbox/container/claw-vite-plugin/ /usr/local/lib/claw-vite-plugin/
RUN mkdir -p /node_modules/@claw-for-cloudflare && \
    ln -sf /usr/local/lib/claw-vite-plugin /node_modules/@claw-for-cloudflare/vite-plugin

# Install @claw-for-cloudflare/container-db so vibe-coded apps can import it.
# Copies the workspace source directly — no intermediate staging.
COPY packages/container-db/src/index.ts /usr/local/lib/claw-container-db/index.ts
RUN ln -sf /usr/local/lib/claw-container-db /node_modules/@claw-for-cloudflare/container-db

# Vendor bundle-authoring SDK packages at /opt/claw-sdk/ (read-only at runtime).
# Only bundle-side subpaths are vendored — no host-side WorkerEntrypoints.
# Sources COPY'd directly from workspace; tiny `package.vendored.json` stubs
# live next to each source package and are renamed to package.json on copy.
COPY packages/agent-bundle/src/bundle /opt/claw-sdk/agent-bundle/src/bundle
COPY packages/agent-bundle/package.vendored.json /opt/claw-sdk/agent-bundle/package.json
COPY packages/tavily-web-search/src/client.ts /opt/claw-sdk/tavily-client/src/client.ts
COPY packages/tavily-web-search/src/schemas.ts /opt/claw-sdk/tavily-client/src/schemas.ts
COPY packages/tavily-web-search/package.vendored.json /opt/claw-sdk/tavily-client/package.json
RUN chmod -R a-w /opt/claw-sdk/ && \
    ln -sf /opt/claw-sdk/agent-bundle /node_modules/@claw-for-cloudflare/agent-bundle

# Generate integrity manifest for vendored packages (SHA-256 per file).
# workshop_build verifies this before running bun build to detect tampering.
RUN find /opt/claw-sdk/ -type f -exec sha256sum {} \; | \
    jq -R -s 'split("\n") | map(select(length > 0)) | map(split("  ") | {key: .[1], value: .[0]}) | from_entries' \
    > /opt/claw-sdk/INTEGRITY.json && \
    chmod a-w /opt/claw-sdk/INTEGRITY.json

# Copy container scripts and sandbox server
COPY packages/cloudflare-sandbox/container/startup.sh \
     packages/cloudflare-sandbox/container/nm-guard.sh \
     packages/cloudflare-sandbox/container/restic-syncd.sh \
     packages/cloudflare-sandbox/container/server.ts \
     packages/cloudflare-sandbox/container/constants.ts \
     packages/cloudflare-sandbox/container/types.ts \
     packages/cloudflare-sandbox/container/state.ts \
     packages/cloudflare-sandbox/container/helpers.ts \
     packages/cloudflare-sandbox/container/sessions.ts \
     packages/cloudflare-sandbox/container/routes.ts \
     /app/
RUN chmod +x /app/startup.sh /app/nm-guard.sh /app/restic-syncd.sh

EXPOSE 8080

ENTRYPOINT ["/app/startup.sh"]
