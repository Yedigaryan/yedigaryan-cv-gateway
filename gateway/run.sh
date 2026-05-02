#!/bin/bash
# Boot order on Render:
#   1. Start tailscaled in userspace-networking mode (no TUN device on Render).
#   2. Authenticate with $TAILSCALE_AUTHKEY and wait for an IPv4 lease.
#   3. Export ALL_PROXY=socks5://localhost:1055 so Caddy's reverse_proxy
#      transparently dials through the Tailscale-exposed SOCKS5 server.
#   4. exec Caddy.
set -e
log() { echo "[$(date +%FT%T%z)] $1"; }

export TAILSCALE_STATE_DIR=/var/lib/tailscale
mkdir -p "$TAILSCALE_STATE_DIR" /var/run/tailscale

log "Starting tailscaled (userspace networking)..."
tailscaled --tun=userspace-networking \
           --socks5-server=localhost:1055 \
           --outbound-http-proxy-listen=localhost:1056 \
           --statedir="$TAILSCALE_STATE_DIR" >/tmp/tailscaled.log 2>&1 &

# Wait for the daemon socket to come up before issuing `tailscale up`.
for _ in $(seq 1 30); do
    tailscale status --json >/dev/null 2>&1 && break
    sleep 1
done

if [ -z "$TAILSCALE_AUTHKEY" ]; then
    log "FATAL: TAILSCALE_AUTHKEY missing — set it in the Render dashboard."
    exit 1
fi

log "tailscale up..."
if ! tailscale up --auth-key="$TAILSCALE_AUTHKEY" \
                  --accept-routes=false \
                  --hostname="cv-llm-gateway" \
                  --timeout=30s >/tmp/ts-up.log 2>&1; then
    log "WARNING: 'tailscale up' failed; container will still start so /health works."
    cat /tmp/ts-up.log || true
fi

# Wait for IP assignment so reverse_proxy can dial the tailnet target.
for _ in $(seq 1 15); do
    tailscale ip -4 >/dev/null 2>&1 && break
    sleep 2
done
log "Tailnet IP: $(tailscale ip -4 || echo NONE)"

# Default proxy env (kept for any incidental shell tools — Caddy ignores).
export ALL_PROXY=socks5://localhost:1055
export HTTP_PROXY=http://localhost:1056
export HTTPS_PROXY=http://localhost:1056
export NO_PROXY=localhost,127.0.0.1

# --- socat tailnet bridge ----------------------------------------------
# Caddy's reverse_proxy can't reach tailnet IPs because Tailscale runs in
# userspace mode and Caddy's transport ignores ALL_PROXY. socat opens a
# local TCP listener on :18080 and, for each connection, dials Tailscale's
# HTTP-CONNECT proxy (localhost:1056) and issues `CONNECT <LLM_BACKEND>`.
# Caddy's Caddyfile then reverse_proxies to localhost:18080 — a normal
# direct dial inside the container — and the bytes flow through the
# tunnel transparently.
if [ -n "$LLM_BACKEND" ]; then
    log "Starting socat: localhost:18080 -> HTTP-CONNECT (localhost:1056) -> $LLM_BACKEND ..."
    socat -d -lf /tmp/socat.log \
        "TCP-LISTEN:18080,fork,reuseaddr,bind=127.0.0.1" \
        "PROXY:localhost:${LLM_BACKEND%%:*}:${LLM_BACKEND##*:},proxyport=1056" &
    sleep 1
fi

# --- Boot-time diagnostics ----------------------------------------------
# Each line that prints is one verified hop in the chain. Read top-down;
# the first failure points at the broken segment.
log "--- diagnostics ---"
if [ -n "$LLM_BACKEND" ]; then
    LAPTOP_IP="${LLM_BACKEND%%:*}"

    log "D1: tailscale ping ${LAPTOP_IP} ..."
    tailscale ping --c=1 --timeout=5s "$LAPTOP_IP" 2>&1 | head -3 | sed 's/^/    /'

    log "D2: curl /api/tags via Tailscale HTTP proxy (localhost:1056) ..."
    curl --max-time 8 -x http://localhost:1056 -sS -o /dev/null \
         -w "    -> HTTP %{http_code} in %{time_total}s\n" \
         "http://${LLM_BACKEND}/api/tags" \
         || log "    -> proxy curl failed"

    log "D3: curl /api/tags via SOCKS5 (localhost:1055) ..."
    curl --max-time 8 --socks5 localhost:1055 -sS -o /dev/null \
         -w "    -> HTTP %{http_code} in %{time_total}s\n" \
         "http://${LLM_BACKEND}/api/tags" \
         || log "    -> socks5 curl failed"

    log "D4: curl /api/tags via socat bridge (localhost:18080) — what Caddy will use ..."
    curl --max-time 8 -sS -o /dev/null \
         -w "    -> HTTP %{http_code} in %{time_total}s\n" \
         "http://localhost:18080/api/tags" \
         || log "    -> socat curl failed"
else
    log "(skipping D1-D4 — LLM_BACKEND not set in env)"
fi
log "--- end diagnostics ---"

log "Launching Caddy..."
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
