# denkeeper-browser

[![CI](https://github.com/Temikus/denkeeper-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/Temikus/denkeeper-browser/actions/workflows/ci.yml)
[![Security](https://github.com/Temikus/denkeeper-browser/actions/workflows/security.yml/badge.svg)](https://github.com/Temikus/denkeeper-browser/actions/workflows/security.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![FOSSA Status](https://app.fossa.com/api/projects/git%2Bgithub.com%2FTemikus%2Fdenkeeper-browser.svg?type=shield)](https://app.fossa.com/projects/git%2Bgithub.com%2FTemikus%2Fdenkeeper-browser?ref=badge_shield)

Hardened Docker image running [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) for [denkeeper](https://github.com/Temikus/denkeeper) browser automation. Communicates via the MCP stdio transport.

## Quick start

```bash
docker pull ghcr.io/temikus/denkeeper-browser:latest

docker run --rm -i \
  --tmpfs /tmp --tmpfs /home/mcp \
  ghcr.io/temikus/denkeeper-browser:latest \
  --headless --browser chromium --no-sandbox
```

## Usage with denkeeper

Enable in `denkeeper.toml`:

```toml
[browser]
enabled      = true
image        = "ghcr.io/temikus/denkeeper-browser:latest"
memory_limit = "512m"
cpu_limit    = "1"
```

Denkeeper's sandbox runtime handles container lifecycle, security flags, and MCP tool discovery automatically.

## Entrypoint contract

The image entrypoint is:

```
node /app/node_modules/@playwright/mcp/cli.js
```

All configuration flags must be passed as arguments. Denkeeper passes `--headless --browser chromium --no-sandbox` by default. Common flags:

| Flag | Description |
|------|-------------|
| `--headless` | Run browser in headless mode (headed by default) |
| `--browser <name>` | Browser to use: `chrome`, `firefox`, `webkit`, `msedge` |
| `--no-sandbox` | Disable Chromium's internal sandbox (required in Docker with `--cap-drop ALL`) |
| `--user-data-dir <path>` | Persistent browser profile directory |
| `--isolated` | Keep profile in memory only, don't persist to disk |
| `--viewport-size <WxH>` | Viewport dimensions (e.g. `1280x720`) |

See the [`@playwright/mcp` docs](https://github.com/microsoft/playwright-mcp) for the full flag reference.

## Security model

The image provides:
- **Non-root execution** (UID 10001, user `mcp`)
- **Minimal attack surface** — only Chromium, no Firefox/WebKit
- **No ambient credentials** — no host browser data mounted

The caller (denkeeper's sandbox runtime) provides:
- `--cap-drop ALL` — drop all Linux capabilities
- `--read-only` — read-only root filesystem
- `--security-opt no-new-privileges` — prevent privilege escalation
- `--network egress` — outbound-only network (no host/localhost access)
- `--memory` / `--cpus` — resource limits

Chromium's `--no-sandbox` flag is required because Docker's own isolation (`--cap-drop ALL`, seccomp, namespaces) replaces Chromium's internal sandbox. This is the standard pattern for running Chromium in containers.

## Read-only filesystem and tmpfs

When running with `--read-only` (as denkeeper does), Chromium needs writable temporary directories. Add these tmpfs mounts:

```bash
docker run --rm -i \
  --read-only \
  --tmpfs /tmp \
  --tmpfs /home/mcp \
  --shm-size=256m \
  ghcr.io/temikus/denkeeper-browser:latest \
  --headless --browser chromium --no-sandbox
```

| Mount | Purpose |
|-------|---------|
| `--tmpfs /tmp` | General temp files, IPC sockets |
| `--tmpfs /home/mcp` | Chromium runtime state, user data |
| `--shm-size=256m` | Shared memory for Chromium's multi-process architecture (Docker default of 64MB is insufficient) |

> **Note**: denkeeper's `SpawnOpts` does not yet support tmpfs mounts. A follow-up change will add `Tmpfs` and `ShmSize` fields to `internal/sandbox/sandbox.go`. Until then, browser automation with `--read-only` requires manual testing.

## Multi-architecture

Images are built for `linux/amd64` and `linux/arm64`. ARM64 support enables deployment on devices like Raspberry Pi 5. Uncompressed image size is ~1.5 GB (Chromium is the dominant component); compressed layer size is typically ~500 MB.

## Supply chain verification

Images are signed with [cosign](https://github.com/sigstore/cosign) (keyless OIDC), include SLSA build provenance attestations, and ship with an SPDX SBOM attached to each image.

```bash
# Verify signature
cosign verify \
  --certificate-identity-regexp="https://github.com/Temikus/denkeeper-browser/" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  ghcr.io/temikus/denkeeper-browser:latest

# Verify SLSA provenance
gh attestation verify \
  oci://ghcr.io/temikus/denkeeper-browser:latest \
  --owner Temikus
```

## Building from source

Requires [just](https://github.com/casey/just) and Docker.

```bash
just build          # Build for current platform
just test           # Build + run all tests (smoke + structure)
just test smoke     # Run MCP smoke test only
just test structure # Run container structure tests only
just lint           # Lint Dockerfile with hadolint
just check          # Run all checks (lint + tests)
just audit          # Audit npm dependencies for vulnerabilities
just build-multi    # Build for amd64 + arm64 (requires buildx)
```

## Version pinning

The `@playwright/mcp` version is pinned in `package.json`. Image releases track upstream versions. Dependabot opens PRs for version bumps automatically.

## License

[Apache License 2.0](LICENSE)


[![FOSSA Status](https://app.fossa.com/api/projects/git%2Bgithub.com%2FTemikus%2Fdenkeeper-browser.svg?type=large)](https://app.fossa.com/projects/git%2Bgithub.com%2FTemikus%2Fdenkeeper-browser?ref=badge_large)