# denkeeper-browser

Hardened Docker image running `@playwright/mcp` for [denkeeper](https://github.com/Temikus/denkeeper) browser automation. Communicates via MCP stdio transport.

## Architecture

Single-container image, two-stage Dockerfile:
- **Builder stage**: `node:22-bookworm-slim` — installs npm deps + Chromium via Playwright
- **Runtime stage**: `node:22-bookworm-slim` — copies node_modules, server.js, and lib/, runs as non-root user `mcp` (UID 10001)

### MCP Server Wrapper

`server.js` is a wrapper MCP server that:
1. Embeds `@playwright/mcp` via `createConnection()` with InMemoryTransport
2. Proxies all upstream Playwright tools transparently
3. Adds two custom tools: `browser_extract_text` and `browser_extract_html`

The wrapper acts as a single MCP server over stdio. denkeeper core auto-discovers all tools (upstream + custom) via the same MCP protocol.

### Custom Tools

**`browser_extract_text`** — Readability-based DOM extraction for non-vision LLMs.
- Injects `@mozilla/readability` into the page via `browser_evaluate`
- Converts extracted article content to Markdown (headings, lists, tables, links)
- `mode`: `"auto"` (default) tries Readability, falls back to all-text. Also `"readability"` or `"all"`.
- `include_forms`: extracts form field descriptions (labels, types, values, submit buttons)
- `selector`: CSS scope. `max_length`: truncation (default 16000 chars)

**`browser_extract_html`** — Raw HTML extraction via CSS selector.
- `selector` (required): CSS selector for target elements
- `outer`: outerHTML (true, default) or innerHTML (false)

### Key Files

- `server.js` — Wrapper MCP server (proxy + custom tools)
- `lib/extract.js` — Extraction script generators (run in browser context via evaluate)
- `Dockerfile` — Multi-stage build
- `package.json` — Pins `@playwright/mcp`, `@modelcontextprotocol/sdk`, `@mozilla/readability`
- `justfile` — All build/test/release tasks
- `.github/workflows/` — CI, release, and security pipelines

## Security model

The image provides: non-root execution, Chromium-only (no Firefox/WebKit), no ambient credentials.

The caller (denkeeper sandbox runtime) provides: `--cap-drop ALL`, `--read-only`, `--security-opt no-new-privileges`, network egress only, resource limits.

`--no-sandbox` is required because Docker's isolation replaces Chromium's internal sandbox.

## Build / Test / Release

Requires [just](https://github.com/casey/just) and Docker.

```
just build            # Build image for current platform
just test             # Build + run all tests (unit + smoke + structure)
just test unit        # Extraction unit tests only (no Docker)
just test smoke       # MCP smoke test only
just test structure   # Container structure tests only
just test-unit        # Extraction unit tests (no Docker build)
just lint             # Hadolint Dockerfile lint
just check            # lint + all tests
just audit            # npm audit
just scan             # All security scans (grype + audit)
just scan grype       # Grype container vulnerability scan
just scan audit       # npm audit only
just build-multi      # Multi-arch build (amd64 + arm64)
just release <bump>   # Tag and push (patch|minor|major)
```

## CI/CD

- **ci.yml**: lint, build, smoke test, structure test, Grype vuln scan (on push/PR to main)
- **release.yml**: multi-arch build+push to GHCR, cosign signing, SLSA provenance, SBOM (on tag push)
- **security.yml**: Gitleaks secret detection, npm audit (on push/PR + weekly cron)

## Tests

- `test/extract.test.js` — Unit tests for extraction script generation (jsdom, no Docker)
- `test/smoke.sh` — MCP protocol handshake over stdio (initialize + tools/list + custom tool presence)
- `test/structure.sh` — Container security invariants (UID, entrypoint, files, labels, workdir)
