default:
    @just --list

# Build the Docker image for the current platform
build:
    docker build -t denkeeper-browser .

# Build multi-arch (amd64 + arm64) — requires buildx
build-multi:
    docker buildx build --platform linux/amd64,linux/arm64 -t denkeeper-browser .

# Run the MCP smoke test against the locally built image
test: build
    ./test/smoke.sh denkeeper-browser

# Lint the Dockerfile with hadolint
lint:
    docker run --rm -i hadolint/hadolint < Dockerfile

# Run all checks (lint + test)
check: lint test

# Audit npm dependencies for known vulnerabilities
audit:
    npm audit --audit-level=high

# Run the image interactively for debugging
run:
    docker run --rm -it --tmpfs /tmp --tmpfs /home/mcp denkeeper-browser --headless --browser chromium --no-sandbox

# Tag and push a release (usage: just release patch|minor|major)
release bump:
    #!/usr/bin/env bash
    set -euo pipefail
    git fetch --tags
    latest=$(git tag -l 'v*' --sort=-v:refname | head -n1)
    if [ -z "$latest" ]; then
        latest="v0.0.0"
    fi
    # Strip leading 'v' and split
    ver="${latest#v}"
    IFS='.' read -r major minor patch <<< "$ver"
    case "{{bump}}" in
        patch) patch=$((patch + 1)) ;;
        minor) minor=$((minor + 1)); patch=0 ;;
        major) major=$((major + 1)); minor=0; patch=0 ;;
        *) echo "Usage: just release [patch|minor|major]"; exit 1 ;;
    esac
    tag="v${major}.${minor}.${patch}"
    echo "Tagging ${tag} (previous: ${latest})"
    git tag -a "$tag" -m "$tag"
    git push origin "$tag"
    echo "Released ${tag}"
