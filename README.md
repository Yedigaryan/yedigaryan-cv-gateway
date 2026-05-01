# gateway/

Public-edge LLM gateway for the CV chat widget. Caddy + Tailscale (userspace
networking) running as a Docker container on Render Free.

The gateway is **not** an LLM — it's a thin reverse proxy. It terminates
public traffic, enforces a bearer-token gate, and forwards authorized
requests over a Tailscale tunnel to whatever HTTP service is listening on
`$LLM_BACKEND` (the M1 Pro running Ollama).

For deployment, environment-variable setup, and end-to-end verification, see
[`../DEPLOY-RENDER-GATEWAY.md`](../DEPLOY-RENDER-GATEWAY.md).
