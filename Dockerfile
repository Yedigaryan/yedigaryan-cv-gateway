# syntax=docker/dockerfile:1
#
# Self-contained Render gateway for the LLM chat backend.
# Caddy (reverse proxy) + Tailscale (userspace networking) on Alpine.
# The build context is `davit-yedigaryan-cv/gateway/` — set by `rootDir: gateway`
# in render.yaml so the Next.js project files don't end up in the image.

FROM caddy:2-alpine AS caddy

FROM alpine:3.20
RUN apk add --no-cache ca-certificates iptables ip6tables tailscale bash curl
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy

# Render disallows raised capabilities; strip Caddy's NET_BIND_SERVICE bit so
# the container can start cleanly. The exposed port is unprivileged anyway.
RUN setcap -r /usr/bin/caddy || true

WORKDIR /app
COPY Caddyfile /etc/caddy/Caddyfile
COPY run.sh    /app/run.sh
RUN chmod +x /app/run.sh

EXPOSE 10000
ENTRYPOINT ["/app/run.sh"]
