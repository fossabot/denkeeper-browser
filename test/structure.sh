#!/usr/bin/env bash
# Structure tests: verify container security invariants.
#
# Usage: ./test/structure.sh [IMAGE_NAME]
#   IMAGE_NAME defaults to "denkeeper-browser"

set -euo pipefail

IMAGE="${1:-denkeeper-browser}"
PASS=0
FAIL=0

# ── helpers ──────────────────────────────────────────────────────────

fail() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }

assert_eq() {
    local label="$1" actual="$2" expected="$3"
    if [ "$actual" = "$expected" ]; then
        pass "$label"
    else
        fail "$label (expected '$expected', got '$actual')"
    fi
}

assert_contains() {
    local label="$1" haystack="$2" needle="$3"
    if echo "$haystack" | grep -q "$needle"; then
        pass "$label"
    else
        fail "$label (expected to contain '$needle')"
    fi
}

assert_not_contains() {
    local label="$1" haystack="$2" needle="$3"
    if echo "$haystack" | grep -q "$needle"; then
        fail "$label (should not contain '$needle')"
    else
        pass "$label"
    fi
}

# Run a command inside the container with the entrypoint overridden.
drun() {
    docker run --rm --entrypoint="" "$IMAGE" "$@"
}

# ── tests ────────────────────────────────────────────────────────────

echo "=== Structure tests: $IMAGE ==="
echo ""

# 1. Non-root user (UID 10001)
uid="$(drun id -u)"
assert_eq "runs as UID 10001" "$uid" "10001"

# 2. Entrypoint is node + wrapper server
entrypoint="$(docker inspect --format='{{json .Config.Entrypoint}}' "$IMAGE")"
assert_eq "entrypoint is node + wrapper server" "$entrypoint" \
    '["node","/app/server.js"]'

# 3. Only Chromium — no Firefox or WebKit
browsers="$(drun ls /home/mcp/.cache/ms-playwright/)"
assert_contains "chromium is installed" "$browsers" "chromium"
assert_not_contains "firefox is not installed" "$browsers" "firefox"
assert_not_contains "webkit is not installed" "$browsers" "webkit"

# 4. mcp user exists with correct UID/GID
id_output="$(drun id mcp)"
assert_contains "mcp user has uid=10001" "$id_output" "uid=10001"
assert_contains "mcp user has gid=10001" "$id_output" "gid=10001"

# 5. Node.js is available
node_version="$(drun node --version)"
assert_contains "node is available" "$node_version" "v"

# 6. Server files exist at expected paths
if drun test -f /app/server.js; then
    pass "server.js exists at expected path"
else
    fail "server.js missing at /app/server.js"
fi

if drun test -f /app/lib/extract.js; then
    pass "lib/extract.js exists at expected path"
else
    fail "lib/extract.js missing at /app/lib/extract.js"
fi

if drun test -f /app/node_modules/@mozilla/readability/Readability.js; then
    pass "Readability.js exists in node_modules"
else
    fail "Readability.js missing from node_modules"
fi

if drun test -f /app/node_modules/@playwright/mcp/cli.js; then
    pass "playwright MCP cli.js exists"
else
    fail "playwright MCP cli.js missing"
fi

# 7. OCI labels are set
for label in source description licenses; do
    val="$(docker inspect --format="{{index .Config.Labels \"org.opencontainers.image.$label\"}}" "$IMAGE")"
    if [ -n "$val" ]; then
        pass "OCI label org.opencontainers.image.$label is set"
    else
        fail "OCI label org.opencontainers.image.$label is missing"
    fi
done

# 8. Working directory is /home/mcp
workdir="$(drun pwd)"
assert_eq "workdir is /home/mcp" "$workdir" "/home/mcp"

# ── summary ──────────────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
