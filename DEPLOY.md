# Deploying the LLM gateway (Render Free + Tailscale → Ollama on M1 Pro)

This is the backend for the chat widget. The static CV site (`out/`) lives
on name.am Apache; the gateway is a separate Render service that proxies
public requests over Tailscale to Ollama running on your laptop.

```
chat widget on davit.yedigaryan.pro      ← name.am Apache (static)
        │  POST /v1/chat/completions
        │  Authorization: Bearer $LLM_API_TOKEN
        ▼
https://cv-llm-gateway.onrender.com      ← Render Free (Docker)
        │  Caddy (this repo's gateway/)
        │  ├─ /health          → 200            (no auth — Render probe)
        │  ├─ @authorized      → reverse_proxy
        │  └─ otherwise        → 401
        ▼
Tailscale (userspace, SOCKS5 :1055 inside the container)
        ▼
<MacBook tailnet IP>:11434               ← M1 Pro
        ▼
ollama serve                             ← Metal GPU (Apple Silicon)
```

---

## 1. Set up Tailscale

If your laptop isn't on a tailnet yet:

1. Install the Tailscale client: `brew install --cask tailscale`. Sign in.
2. Find your laptop's tailnet IPv4: `tailscale ip -4` → something like `100.x.y.z`.
3. Generate a **reusable** auth key for the Render container at
   <https://login.tailscale.com/admin/settings/keys>. Tick *Reusable* and
   *Ephemeral* off (we want the gateway to keep its identity across deploys).
   Copy the `tskey-auth-…` value — you'll paste it into Render in step 4.

---

## 2. Run Ollama on the M1 Pro (Metal GPU)

### Install

```bash
brew install ollama
```

Ollama on Apple Silicon uses Metal Performance Shaders by default — no
flags, no driver setup. (Apple deprecated OpenCL on M1+; Metal is the only
first-class GPU path on Apple Silicon, which is why we use it.)

### Bind to the tailnet interface

By default Ollama listens on `127.0.0.1:11434`, which is invisible to
Tailscale. Set `OLLAMA_HOST=0.0.0.0:11434` so it accepts inbound on the
`utun*` Tailscale interface too. The cleanest macOS pattern is a launchd
user agent — a template is shipped at [`ollama/dev.local.ollama.plist`](ollama/dev.local.ollama.plist).

```bash
cp ollama/dev.local.ollama.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/dev.local.ollama.plist 2>/dev/null
launchctl load   ~/Library/LaunchAgents/dev.local.ollama.plist
```

Verify the listener is bound on all interfaces (look for `*.11434`, **not**
`127.0.0.1.11434`):

```bash
lsof -nP -iTCP:11434 -sTCP:LISTEN
```

### Allow inbound through the macOS firewall

System Settings → Network → Firewall → Options → ensure `ollama` is allowed
to receive incoming connections. Without this the OS silently drops
Tailscale-routed packets even though `lsof` shows the listener.

### Pull a model

```bash
ollama pull gemma3        # current verifiable Gemma tag in Ollama's library
# or, if newer is available on your install:
# ollama pull gemma4
```

`OLLAMA_KEEP_ALIVE=30m` (set in the plist) keeps the model resident in VRAM
between requests, so the second-and-onwards turn of a chat is fast.

### Prevent the laptop from sleeping while it's serving

System Settings → Battery → **Prevent automatic sleeping when the display
is off**. The Render gateway can't reach a sleeping Mac, and Tailscale will
not magically wake it.

---

## 3. Deploy the Render gateway

### Push this repo to GitHub

This is a standalone gateway repo. The Render Blueprint at
[`render.yaml`](render.yaml) points at `gateway/` as the Docker build
context. The frontend that consumes this gateway is a separate repo
([`davit-yedigaryan-cv`](https://github.com/yedigaryan/davit-yedigaryan-cv)) —
its chat widget reads `NEXT_PUBLIC_CHAT_API_URL` and POSTs to this
service's URL.

```bash
git add .
git commit -m "Provision gateway"
git push
```

### Create the Render service from the Blueprint

1. Open <https://dashboard.render.com/blueprints>.
2. **New Blueprint Instance** → pick the `yedigaryan-cv-gateway` repo.
3. Render reads `render.yaml` and proposes a single service named
   `cv-llm-gateway`. Click **Apply**.
4. Set the three secrets in the dashboard (they're declared `sync: false`
   so they never enter git):

   | Key                | Value                                                  |
   | ------------------ | ------------------------------------------------------ |
   | `TAILSCALE_AUTHKEY`| The `tskey-auth-…` from step 1.                        |
   | `LLM_BACKEND`      | Your laptop's tailnet IP + Ollama port — `100.x.y.z:11434`. |
   | `LLM_API_TOKEN`    | Generate with `openssl rand -hex 32`.                  |

5. First build takes ~3 min (multi-stage Alpine + Tailscale install).
   Subsequent deploys are ~30s.

---

## 4. Verify, four layers

Run in order. Failing at layer N tells you exactly which segment is broken.

### Layer 1 — Ollama on loopback (run on the M1 Pro)

```bash
curl -sS http://127.0.0.1:11434/api/tags | jq .
# → {"models":[{"name":"gemma3:latest", ...}]}
```

### Layer 2 — Ollama over the tailnet (run from any *other* tailnet device)

```bash
curl -sS http://<MacBook-tailnet-IP>:11434/api/tags | jq .
```

Layer 1 passes but layer 2 fails →
- `OLLAMA_HOST` is still `127.0.0.1` (re-check `lsof`), or
- the macOS firewall is dropping inbound (re-check Firewall Options).

### Layer 3 — Public Render endpoint

```bash
# Health probe — must 200, no auth:
curl -i https://cv-llm-gateway.onrender.com/health

# No auth — must 401:
curl -i https://cv-llm-gateway.onrender.com/api/tags

# With auth — must succeed:
curl -sS https://cv-llm-gateway.onrender.com/api/tags \
    -H "Authorization: Bearer $LLM_API_TOKEN" | jq .

# OpenAI-compat smoke test:
curl -sS https://cv-llm-gateway.onrender.com/v1/chat/completions \
    -H "Authorization: Bearer $LLM_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"model":"gemma3","messages":[{"role":"user","content":"ping"}]}' | jq .
```

Layer 2 passes but layer 3 401s the *authorized* request → `LLM_API_TOKEN`
in the Render dashboard doesn't match the header. Layer 3 502s mid-stream →
the laptop went to sleep, or the read timeout is too tight (raise it in
`gateway/Caddyfile` and redeploy).

### Layer 4 — Live site

Wire the chat widget in the **frontend repo**
([`davit-yedigaryan-cv`](https://github.com/yedigaryan/davit-yedigaryan-cv))
by adding to its `.env.local`:

```bash
NEXT_PUBLIC_CHAT_API_URL=https://cv-llm-gateway.onrender.com/v1/chat/completions
NEXT_PUBLIC_CHAT_API_KEY=<same value as LLM_API_TOKEN on Render>
NEXT_PUBLIC_CHAT_MODEL=gemma4:e4b
NEXT_PUBLIC_CHAT_STREAMING=true
```

Then rebuild and redeploy the static site from that repo (its
`DEPLOY-NAME-AM.md` has the full procedure):

```bash
pnpm run build
rsync -avz --delete --include='.htaccess' ./out/ user@host:public_html/
```

`NEXT_PUBLIC_*` values are inlined into the JS bundle at build time —
that's the *only* way they reach the browser on a static deploy.

Open the deployed site, click the chat bubble, send "ping". Tokens should
stream in. Cmd+Shift+R if HTML is cached.

---

## Free-tier honesty

- **Render Free web services sleep after ~15 min idle** and take ~50s to
  cold-start. Combined with Ollama's first-request model load (~30s), the
  first chat turn after a quiet period can take **~80s**. Subsequent turns
  are fast (`OLLAMA_KEEP_ALIVE=30m` keeps the model warm).
- **Render Free monthly compute budget = 750 hours.** A service that never
  sleeps would burn ~720 hours per 30-day month — exactly at the edge.
  Sleep-on-idle keeps you well below.
- **The laptop must be awake** for chat to work end-to-end.

If any of these become unacceptable, the upgrade path is Render's $7/mo
Starter plan (always-on, no sleep) — same code, same gateway, just toggle
the plan in the dashboard.

---

## Security notes

- `NEXT_PUBLIC_CHAT_API_KEY` ships to every visitor's browser. That's
  acceptable here because the token only authorizes use of *your laptop's*
  compute — worst case is rate-limited noise, not paid spend. If you ever
  put a paid-provider key behind this gateway, the bearer must move into a
  server-side proxy (i.e. stop being `NEXT_PUBLIC_`).
- The Caddy auth gate enforces equality on the entire `Authorization`
  header value (`Bearer <token>`). Rotate `LLM_API_TOKEN` periodically by
  setting a new value in the Render dashboard, regenerating the static
  site, and re-uploading.
- Tailscale auth keys can be revoked from
  <https://login.tailscale.com/admin/settings/keys> if the Render container
  is ever compromised — the laptop stays on the tailnet, but the gateway's
  identity dies.

---

## Troubleshooting

**`/health` 502s** — the Render container hasn't finished booting Tailscale
yet. Wait 30s and retry; the boot script in `gateway/run.sh` has explicit
log lines for each step (search the Render logs for `tailscale ip` /
`tailscale up`).

**`/api/tags` 502s but `/health` 200s** — Caddy is up but can't reach the
laptop. Check from the Render shell: `tailscale status` should list your
laptop. If the laptop isn't there, the auth key was probably ephemeral or
single-use; mint a reusable, non-ephemeral one.

**`/api/tags` 504s** — `LLM_BACKEND` value is wrong (port off, IP off, or
laptop offline). Validate by SSHing to another tailnet device and running
the layer-2 curl.

**Chat widget says "Failed to fetch" / CORS error** — should not happen
out of the box; `gateway/Caddyfile` already emits
`Access-Control-Allow-Origin: *` and answers preflights with 204. If you
see one, check that your reverse-proxy chain (e.g. a CDN in front of
Render) isn't stripping the CORS headers. The wildcard origin is safe here
because the resource is bearer-token-gated — anyone with the token can
call it anyway, so CORS isn't acting as a security boundary.
