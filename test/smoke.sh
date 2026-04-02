#!/usr/bin/env bash
# Smoke test: verify the MCP protocol handshake works over stdio.
#
# Usage: ./test/smoke.sh [IMAGE_NAME]
#   IMAGE_NAME defaults to "denkeeper-browser"

set -euo pipefail

IMAGE="${1:-denkeeper-browser}"
TIMEOUT_SEC=30
PASS=0
FAIL=0

# Use GNU timeout (Linux) or gtimeout (macOS via coreutils).
if command -v timeout &>/dev/null; then
    TIMEOUT_CMD="timeout"
elif command -v gtimeout &>/dev/null; then
    TIMEOUT_CMD="gtimeout"
else
    echo "ERROR: neither 'timeout' nor 'gtimeout' found. Install coreutils." >&2
    exit 1
fi

# ── helpers ──────────────────────────────────────────────────────────

fail() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }

# Send a JSON-RPC request to a running container and capture the response.
# Uses a FIFO so we can write to stdin and read from stdout independently.
run_mcp_session() {
    local tmpdir
    tmpdir="$(mktemp -d)"
    local fifo_in="$tmpdir/in"
    local fifo_out="$tmpdir/out"
    mkfifo "$fifo_in" "$fifo_out"

    # Start the container in the background, wired to the FIFOs.
    docker run --rm -i \
        --network none \
        --tmpfs /tmp \
        --tmpfs /home/mcp \
        "$IMAGE" \
        --headless --browser chromium --no-sandbox \
        < "$fifo_in" > "$fifo_out" 2>/dev/null &
    local pid=$!

    # Open the write end of the FIFO (keep it open for the session).
    exec 3>"$fifo_in"

    # ── Test 1: MCP initialize ──

    local init_req='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.1.0"}}}'
    echo "$init_req" >&3

    local init_resp
    if ! init_resp="$($TIMEOUT_CMD "$TIMEOUT_SEC" head -n1 < "$fifo_out")"; then
        fail "initialize: timed out after ${TIMEOUT_SEC}s"
        exec 3>&-; kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; rm -rf "$tmpdir"
        return
    fi

    if echo "$init_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'result' in d and 'serverInfo' in d['result']" 2>/dev/null; then
        pass "initialize: got valid serverInfo"
    else
        fail "initialize: unexpected response: $init_resp"
    fi

    # Send initialized notification (required by MCP protocol before calling tools).
    echo '{"jsonrpc":"2.0","method":"notifications/initialized"}' >&3

    # ── Test 2: tools/list ──

    local list_req='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
    echo "$list_req" >&3

    local list_resp
    if ! list_resp="$($TIMEOUT_CMD "$TIMEOUT_SEC" head -n1 < "$fifo_out")"; then
        fail "tools/list: timed out after ${TIMEOUT_SEC}s"
        exec 3>&-; kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; rm -rf "$tmpdir"
        return
    fi

    local tool_count
    if tool_count="$(echo "$list_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['result']['tools']))")"; then
        if [ "$tool_count" -gt 0 ]; then
            pass "tools/list: found $tool_count tools"
        else
            fail "tools/list: empty tools array"
        fi
    else
        fail "tools/list: unexpected response: $list_resp"
    fi

    # ── Test 3: custom extraction tools are present ──

    local has_extract_text
    has_extract_text="$(echo "$list_resp" | python3 -c "
import sys, json
d = json.load(sys.stdin)
names = [t['name'] for t in d['result']['tools']]
print('yes' if 'browser_extract_text' in names else 'no')
")"
    if [ "$has_extract_text" = "yes" ]; then
        pass "tools/list: browser_extract_text present"
    else
        fail "tools/list: browser_extract_text missing"
    fi

    local has_extract_html
    has_extract_html="$(echo "$list_resp" | python3 -c "
import sys, json
d = json.load(sys.stdin)
names = [t['name'] for t in d['result']['tools']]
print('yes' if 'browser_extract_html' in names else 'no')
")"
    if [ "$has_extract_html" = "yes" ]; then
        pass "tools/list: browser_extract_html present"
    else
        fail "tools/list: browser_extract_html missing"
    fi

    # ── Cleanup ──

    exec 3>&-
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null || true
    rm -rf "$tmpdir"
}

# Same as run_mcp_session but with --read-only + tmpfs + shm-size,
# matching denkeeper's production runtime conditions.
run_mcp_session_readonly() {
    local tmpdir
    tmpdir="$(mktemp -d)"
    local fifo_in="$tmpdir/in"
    local fifo_out="$tmpdir/out"
    mkfifo "$fifo_in" "$fifo_out"

    docker run --rm -i \
        --network none \
        --read-only \
        --tmpfs /tmp \
        --tmpfs /home/mcp \
        --shm-size=256m \
        "$IMAGE" \
        --headless --browser chromium --no-sandbox \
        < "$fifo_in" > "$fifo_out" 2>/dev/null &
    local pid=$!

    exec 3>"$fifo_in"

    # ── Test: MCP initialize over read-only filesystem ──

    local init_req='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.1.0"}}}'
    echo "$init_req" >&3

    local init_resp
    if ! init_resp="$($TIMEOUT_CMD "$TIMEOUT_SEC" head -n1 < "$fifo_out")"; then
        fail "read-only: initialize timed out after ${TIMEOUT_SEC}s"
        exec 3>&-; kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; rm -rf "$tmpdir"
        return
    fi

    if echo "$init_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'result' in d and 'serverInfo' in d['result']" 2>/dev/null; then
        pass "read-only: initialize succeeded"
    else
        fail "read-only: unexpected response: $init_resp"
    fi

    exec 3>&-
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null || true
    rm -rf "$tmpdir"
}

# ── main ─────────────────────────────────────────────────────────────

echo "=== Smoke test: $IMAGE ==="
echo ""

run_mcp_session

echo ""
echo "--- Read-only filesystem ---"
echo ""

run_mcp_session_readonly

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
