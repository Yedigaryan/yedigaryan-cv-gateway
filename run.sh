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

# Route all of Caddy's outbound HTTP through Tailscale's local proxies.
export ALL_PROXY=socks5://localhost:1055
export HTTP_PROXY=http://localhost:1056
export HTTPS_PROXY=http://localhost:1056
export NO_PROXY=localhost,127.0.0.1

log "Launching Caddy..."
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
