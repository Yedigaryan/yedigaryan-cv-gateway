# syntax=docker/dockerfile:1
#
# Self-contained Render gateway for the LLM chat backend.
# Caddy (reverse proxy) + Tailscale (userspace networking) on Alpine.
# The build context is `davit-yedigaryan-cv/gateway/` — set by `rootDir: gateway`
# in render.yaml so the Next.js project files don't end up in the image.

FROM caddy:2-alpine AS caddy

FROM alpine:3.20

# libcap provides /usr/sbin/setcap, which we need to strip the
# cap_net_bind_service xattr from the Caddy binary. The Caddy upstream
# image ships with that capability set so it can bind to ports <1024,
# but Render's free-tier sandbox refuses to exec any binary with raised
# caps ("Operation not permitted" at runtime). We listen on 10000 anyway,
# so the cap is dead weight — strip it.
RUN apk add --no-cache ca-certificates iptables ip6tables tailscale bash curl libcap

COPY --from=caddy /usr/bin/caddy /usr/bin/caddy

# Strip ALL file capabilities from the Caddy binary. No `|| true` — if
# this ever silently no-ops again, the deploy must fail fast at build
# time rather than crash on first exec at runtime.
RUN setcap -r /usr/bin/caddy \
 && getcap /usr/bin/caddy | tee /tmp/caddy-caps \
 && [ ! -s /tmp/caddy-caps ]

WORKDIR /app
COPY Caddyfile /etc/caddy/Caddyfile
COPY run.sh    /app/run.sh
RUN chmod +x /app/run.sh

EXPOSE 10000
ENTRYPOINT ["/app/run.sh"]
