# gateway/

Public-edge LLM gateway: **Caddy + Tailscale (userspace)** in a single
Alpine Docker image, deployed to Render Free.

> Last redeploy trigger: **2026-05-02 — socat sidecar bridges Caddy → Tailscale HTTP-CONNECT (replaces failed Caddy `proxy_url` attempt) + admin API off + Tailscale 1.96.4**.
> Bump this date and `git push` to force Render to rebuild the container,
> which mints a fresh Tailscale identity (new `100.x.y.z` IP) on boot.
>
> The Tailscale binary is pinned via `TAILSCALE_VERSION` in
> [`../render.yaml`](../render.yaml) (default in `Dockerfile`'s `ARG`).
> When the admin console flags a vulnerability, check
> <https://pkgs.tailscale.com/stable/> for the newest amd64 release, bump
> the `dockerBuildArgs.TAILSCALE_VERSION` value, and push.

The gateway is **not** an LLM — it's a thin reverse proxy. Public requests
terminate at Caddy, must carry `Authorization: Bearer $LLM_API_TOKEN`, and
are forwarded over a Tailscale tunnel to whatever HTTP service is listening
on `$LLM_BACKEND` (in this setup: Ollama on the M1 Pro).

## What's in this folder

| File             | Role                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| `Dockerfile`     | Multi-stage Alpine build. Pulls Caddy from `caddy:2-alpine`, downloads Tailscale's official static binary at the version pinned by the `TAILSCALE_VERSION` build arg (we deliberately do *not* use Alpine's `tailscale` package — it lags upstream and triggers the admin-console security banner). Strips `cap_net_bind_service` from the Caddy binary because Render's free-tier sandbox refuses to exec binaries with raised capabilities. |
| `Caddyfile`      | Three handlers in order: `/health` open · OPTIONS preflight 204 with CORS · bearer-gated `reverse_proxy` to `{$LLM_BACKEND}`. Sends `Host: localhost:11434` to upstream so Ollama's anti-DNS-rebinding origin check doesn't reject. |
| `run.sh`         | Entrypoint. Boots `tailscaled` in userspace mode (SOCKS5 on `localhost:1055`), `tailscale up` with `$TAILSCALE_AUTHKEY`, waits for an IP lease, exports `ALL_PROXY=socks5://localhost:1055` so Caddy's reverse_proxy dials over the tunnel, then `exec caddy run`. |
| `.dockerignore`  | Skips Markdown — README never enters the image.                           |

## Runtime contract

The container reads four env vars (set in the Render dashboard, never in
git):

| Var                  | Value                                            |
| -------------------- | ------------------------------------------------ |
| `TAILSCALE_AUTHKEY`  | Reusable, non-ephemeral Tailscale auth key.      |
| `LLM_BACKEND`        | `<MacBook tailnet IP>:11434` — Ollama target.    |
| `LLM_API_TOKEN`      | Bearer token clients must send. `openssl rand -hex 32`. |
| `PORT`               | `10000` (declared in `render.yaml`, non-secret). |

Render's orchestrator probes `/health` continuously to keep the service
warm — that path is the only unauthenticated route.

## Edits that *don't* require touching this folder

- Swapping models (Gemma → Llama → Qwen): change `NEXT_PUBLIC_CHAT_MODEL`
  in the static site's `.env.local` and rebuild. The model name is
  forwarded by the chat widget at request time; Ollama looks it up
  locally.
- Rotating `LLM_API_TOKEN`: edit it in the Render dashboard *and* in the
  static site's `.env.local`, rebuild the static site, redeploy `out/`.
- Pointing the gateway at a different laptop / new tailnet IP: update
  `LLM_BACKEND` in the Render dashboard. No code change.

## Edits that *do* require pushing this folder

- Caddy routing changes (new paths, different auth scheme, custom CORS
  origins, additional security headers).
- Switching the upstream protocol (e.g. HTTPS, gRPC).
- Tailscale boot tweaks (auth options, hostname, routes).

Any commit that lands on `main` triggers a Render redeploy automatically;
the `.dockerignore` makes Markdown-only edits no-op for the image layer
cache, so README bumps rebuild fast (~30s).

## Local sanity checks before pushing

```bash
# 1. Bash-syntax check on the boot script.
bash -n run.sh

# 2. Caddyfile validation, if you have caddy installed locally.
caddy validate --config Caddyfile --adapter caddyfile

# 3. Optional — full image build (requires Docker daemon).
docker build -t cv-llm-gateway:dev .
```

The Render build will catch anything these miss, but a failed local build
is faster feedback than a failed deploy.

## Deployment, env vars, and four-layer end-to-end verification

See **[`../DEPLOY-RENDER-GATEWAY.md`](../DEPLOY-RENDER-GATEWAY.md)** —
covers Render Blueprint apply, Tailscale auth-key minting, Ollama setup on
the M1 Pro (Metal GPU + launchd plist), the four `curl` layers used to
isolate failures (loopback → tailnet → public → live site), and free-tier
honesty (cold-start latency, 750-hour monthly budget).
