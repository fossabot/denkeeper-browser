# Stage 1: Install dependencies and Chromium
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Install Chromium and its OS-level dependencies.
# Only Chromium is needed — Firefox and WebKit are not installed.
# Separate RUN for layer caching (different invalidation than npm ci).
# hadolint ignore=DL3059
RUN npx playwright install --with-deps chromium


# Stage 2: Runtime image
FROM node:22-bookworm-slim

# Create non-root user with explicit UID for K8s PSA compatibility.
RUN groupadd -r -g 10001 mcp && useradd -r -u 10001 -g mcp -d /home/mcp -s /sbin/nologin -m mcp

# Copy application code and Chromium binary from the builder stage.
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder --chown=mcp:mcp /root/.cache/ms-playwright /home/mcp/.cache/ms-playwright

# Install Chromium's OS-level runtime dependencies. Playwright's install-deps
# resolves the correct package names for the current distro automatically.
# hadolint ignore=DL3008,DL3013
RUN npx --prefix /app playwright install-deps chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/mcp
USER mcp

# OCI image labels.
LABEL org.opencontainers.image.source="https://github.com/Temikus/denkeeper-browser"
LABEL org.opencontainers.image.description="Hardened Playwright MCP server for denkeeper browser automation"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# Bare entrypoint — all flags (--headless, --browser, --no-sandbox) are
# passed by the caller (denkeeper's sandbox runtime or docker run).
ENTRYPOINT ["node", "/app/node_modules/@playwright/mcp/cli.js"]
