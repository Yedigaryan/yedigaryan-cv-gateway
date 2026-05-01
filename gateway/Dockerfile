# syntax=docker/dockerfile:1
#
# Self-contained Render gateway for the LLM chat backend.
# Caddy (reverse proxy) + Tailscale (userspace networking) on Alpine.
# The build context is `davit-yedigaryan-cv/gateway/` — set by `rootDir: gateway`
# in render.yaml so the Next.js project files don't end up in the image.

FROM caddy:2-alpine AS caddy

FROM alpine:3.20

# Tailscale version pin — bumping this is how we pick up upstream security
# fixes (the Tailscale admin console flags out-of-date nodes). Compare
# against the latest stable at https://pkgs.tailscale.com/stable/ and
# release notes at https://tailscale.com/changelog. Render runs amd64
# containers; Apple Silicon laptops are unaffected by this pin (their
# Tailscale comes from the macOS app, not this image).
ARG TAILSCALE_VERSION=1.96.4

# libcap → setcap (we strip Caddy's NET_BIND_SERVICE cap below).
# iptables/ip6tables → only relevant when tailscaled runs in TUN mode,
#   but lightweight enough to keep for parity with the upstream package.
# We deliberately do NOT install Alpine's `tailscale` package — it lags
# upstream by weeks and is what triggers the security-update banner.
RUN apk add --no-cache ca-certificates iptables ip6tables bash curl libcap

# Install Tailscale from the official static binary tarball, pinned by
# version. Bump TAILSCALE_VERSION above and rebuild to update.
RUN curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz" -o /tmp/ts.tgz \
 && tar -xzf /tmp/ts.tgz -C /tmp \
 && mv "/tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscale"  /usr/local/bin/ \
 && mv "/tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscaled" /usr/local/bin/ \
 && rm -rf /tmp/ts.tgz "/tmp/tailscale_${TAILSCALE_VERSION}_amd64" \
 && tailscale --version

COPY --from=caddy /usr/bin/caddy /usr/bin/caddy

# Strip ALL file capabilities from the Caddy binary. No `|| true` — if
# this ever silently no-ops again, the deploy must fail fast at build
# time rather than crash on first exec at runtime. (Render's free-tier
# sandbox refuses to exec any binary with raised caps.)
RUN setcap -r /usr/bin/caddy \
 && getcap /usr/bin/caddy | tee /tmp/caddy-caps \
 && [ ! -s /tmp/caddy-caps ]

WORKDIR /app
COPY Caddyfile /etc/caddy/Caddyfile
COPY run.sh    /app/run.sh
RUN chmod +x /app/run.sh

EXPOSE 10000
ENTRYPOINT ["/app/run.sh"]
