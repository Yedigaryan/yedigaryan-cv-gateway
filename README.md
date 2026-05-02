# yedigaryan-cv-gateway

Public-edge LLM gateway for [davit.yedigaryan.pro](https://davit.yedigaryan.pro)'s
on-page chat widget. **Caddy + Tailscale (userspace)** in a single Alpine
Docker image, deployed to Render Free.

> Last redeploy trigger: **2026-05-02 — socat sidecar bridges Caddy →
> Tailscale HTTP-CONNECT (replaces failed Caddy `proxy_url` attempt) +
> admin API off + Tailscale 1.96.4 + `keepalive off` on upstream + boot
> diagnostics D1–D5 + socat-log surfacing**.
>
> Bump this date and `git push` to force Render to rebuild the container,
> which mints a fresh Tailscale identity (new `100.x.y.z` IP) on boot.
>
> Tailscale is pinned to a specific binary release via `TAILSCALE_VERSION`
> in [`render.yaml`](render.yaml). When the admin console flags a
> vulnerability, check <https://pkgs.tailscale.com/stable/> for the newest
> stable amd64 release, bump `dockerBuildArgs.TAILSCALE_VERSION`, and push.

## What this is (and isn't)

This service is **not** an LLM. It's a thin reverse proxy. Public requests
terminate at Caddy on Render, must carry `Authorization: Bearer
$LLM_API_TOKEN`, and are forwarded over a Tailscale tunnel to whatever
HTTP service is listening on `$LLM_BACKEND` (the M1 Pro running Ollama).

```
client (chat widget on davit.yedigaryan.pro)
  │  POST /v1/chat/completions
  │  Authorization: Bearer $LLM_API_TOKEN
  ▼
https://cv-llm-gateway.onrender.com         (this repo, on Render Free)
  │  Caddy
  │  ├── /health           → 200             (Render orchestration probe)
  │  ├── @authorized       → reverse_proxy localhost:18080
  │  │       ↓
  │  │   socat (bridge)    → HTTP-CONNECT proxy on localhost:1056
  │  │       ↓
  │  │   Tailscale (userspace, w/ TAILSCALE_AUTHKEY)
  │  └── otherwise         → 401
  ▼
<MacBook tailnet IP>:11434                  (M1 Pro, Ollama on 0.0.0.0)
```

## Repo layout

```
yedigaryan-cv-gateway/
├── render.yaml                    # Render Blueprint — single web service
├── DEPLOY.md                      # Step-by-step deploy + verify runbook
├── ollama/
│   └── dev.local.ollama.plist     # launchd template for Ollama on the M1 Pro
└── gateway/                       # Docker build context (rootDir in render.yaml)
    ├── Dockerfile
    ├── Caddyfile
    ├── run.sh
    └── .dockerignore
```

The frontend that consumes this gateway lives in a separate repo
([`davit-yedigaryan-cv`](https://github.com/yedigaryan/davit-yedigaryan-cv)).
That repo's chat widget reads `NEXT_PUBLIC_CHAT_API_URL` and bearer token at
build time and POSTs to this Render URL.

## Runtime contract

The container reads four env vars (set in the Render dashboard, never
committed):

| Var                  | Value                                                  |
| -------------------- | ------------------------------------------------------ |
| `TAILSCALE_AUTHKEY`  | Reusable, non-ephemeral Tailscale auth key.            |
| `LLM_BACKEND`        | `<MacBook tailnet IP>:11434` — Ollama target.          |
| `LLM_API_TOKEN`      | Bearer clients must send. `openssl rand -hex 32`.      |
| `PORT`               | `10000` (declared in `render.yaml`, non-secret).       |

Render's orchestrator probes `/health` continuously to keep the service
warm. That path is the only unauthenticated route.

## What lives where in `gateway/`

| File             | Role                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| `Dockerfile`     | Multi-stage Alpine build. Pulls Caddy from `caddy:2-alpine`, downloads Tailscale's official static binary at the version pinned by the `TAILSCALE_VERSION` build arg (the Alpine `tailscale` package lags upstream by weeks and trips the admin-console security banner — we deliberately avoid it). Strips `cap_net_bind_service` from the Caddy binary because Render's free-tier sandbox refuses to exec binaries with raised caps. Installs `socat` for the tunnel bridge. |
| `Caddyfile`      | Three handlers in order: `/health` open · OPTIONS preflight 204 with CORS · bearer-gated `reverse_proxy localhost:18080` (the socat side of the tunnel). Sends `Host: localhost:11434` to upstream so Ollama's anti-DNS-rebinding origin check doesn't reject. CORS uses `*` because the resource is bearer-gated; `keepalive off` because each socat connection is a one-shot HTTP CONNECT. |
| `run.sh`         | Entrypoint. Boots `tailscaled` userspace mode (SOCKS5 :1055, HTTP-CONNECT :1056), `tailscale up`, starts socat as `localhost:18080 → HTTP-CONNECT → $LLM_BACKEND`, prints five reachability diagnostics (D1–D5) so failures pin themselves to one hop, then `exec caddy run`. |
| `.dockerignore`  | Skips Markdown — README never enters the image.                           |

## Edits that *don't* require pushing this repo

- Swapping models (Gemma → Llama → Qwen): change `NEXT_PUBLIC_CHAT_MODEL`
  in the CV site's `.env.local` and rebuild the static site. Model name
  is forwarded by the chat widget at request time; Ollama looks it up.
- Rotating `LLM_API_TOKEN`: edit it in the Render dashboard *and* in the
  CV site's `.env.local`, rebuild the static site, redeploy `out/`.
- Pointing the gateway at a different laptop / new tailnet IP: update
  `LLM_BACKEND` in the Render dashboard. No code change.

## Edits that *do* require pushing

- Caddy routing changes (new paths, different auth scheme, custom CORS
  origins, additional security headers).
- Switching the upstream protocol (e.g. HTTPS, gRPC).
- Tailscale boot tweaks (auth options, hostname).
- Bumping `TAILSCALE_VERSION` for security updates.

Any commit on `main` triggers a Render redeploy automatically. The
`.dockerignore` makes Markdown-only edits no-op the apk/COPY layers, so
README bumps rebuild fast (~30s).

## Local sanity checks before pushing

```bash
bash -n gateway/run.sh                          # bash syntax
caddy validate --config gateway/Caddyfile --adapter caddyfile   # if you have caddy locally
docker build -t cv-llm-gateway:dev gateway/     # if Docker daemon is up
```

The Render build will catch anything these miss; local checks are just
faster feedback.

## Deploy + four-layer end-to-end verification

See [`DEPLOY.md`](DEPLOY.md) — Render Blueprint apply, Tailscale auth-key
minting, Ollama setup on the M1 Pro (Metal GPU + launchd plist), the four
`curl` layers used to isolate failures (loopback → tailnet → public →
live site), and free-tier honesty (cold-start latency, 750-hour monthly
budget).
