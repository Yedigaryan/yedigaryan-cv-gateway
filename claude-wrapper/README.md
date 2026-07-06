# claude-wrapper

Tiny HTTP shim that exposes `POST /v1/chat/completions` (OpenAI shape,
SSE streaming) backed by the local `claude` CLI running in
subscription-mode. Sits alongside Ollama on the M1 Pro:

| Service        | Bind port | Runs as          |
|----------------|-----------|------------------|
| Ollama         | 11434     | dev.local.ollama |
| claude-wrapper | 11435     | dev.local.claude-wrapper (this) |

The Render gateway routes `/v1/*` to Ollama and `/v1/claude/*` here
(see `gateway/Caddyfile` and `gateway/run.sh`).

## One-time setup

1. **Log in to Claude Code as your user** (interactive, once):

   ```sh
   claude              # opens a session; complete OAuth in the browser
   /login              # if not prompted automatically
   # exit the session; the CLI now has credentials in ~/.claude/
   ```

2. **Fill in the plist placeholders** and install as a LaunchAgent:

   ```sh
   NODE_BIN=$(command -v node)
   WRAPPER_DIR="$HOME/WebstormProjects/davit-yedigaryan-cv/gateway/claude-wrapper"
   TOKEN="<same value as $LLM_API_TOKEN on Render>"

   sed \
     -e "s|REPLACE_NODE_BIN|$NODE_BIN|" \
     -e "s|REPLACE_WRAPPER_DIR|$WRAPPER_DIR|" \
     -e "s|REPLACE_TOKEN|$TOKEN|" \
     "$WRAPPER_DIR/dev.local.claude-wrapper.plist" \
     > "$HOME/Library/LaunchAgents/dev.local.claude-wrapper.plist"

   launchctl bootstrap "gui/$(id -u)" \
       "$HOME/Library/LaunchAgents/dev.local.claude-wrapper.plist"
   launchctl kickstart -k "gui/$(id -u)/dev.local.claude-wrapper"
   ```

3. **Verify it's serving:**

   ```sh
   curl -sSI http://127.0.0.1:11435/health           # 200 OK
   curl -sS -N http://127.0.0.1:11435/v1/chat/completions \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -H "Accept: text/event-stream" \
     -d '{"model":"","messages":[{"role":"user","content":"ping"}],"stream":true}'
   ```

   Expect SSE frames ending with `data: [DONE]`.

## Environment variables

| Var             | Default                | Purpose                                                      |
|-----------------|------------------------|--------------------------------------------------------------|
| `PORT`          | `11435`                | Local bind port.                                             |
| `HOST`          | `127.0.0.1`            | Bind host. Set `0.0.0.0` if the tailnet path needs it.       |
| `LLM_API_TOKEN` | (required)             | Bearer token; must match the gateway's.                      |
| `CLAUDE_BIN`    | `claude` (PATH lookup) | Absolute path if `claude` isn't on PATH under launchd.       |
| `CLAUDE_MODEL`  | (empty → CLI default)  | Model alias forwarded to the CLI. E.g. `claude-sonnet-4-5`.  |
| `MAX_INFLIGHT`  | `2`                    | Concurrency cap. Excess requests get `429`.                  |

## Operational notes

- **Subscription re-auth.** If Claude ever forces a re-login (plan change,
  token rotation, CLI major upgrade), spawned subprocesses will start
  failing with a non-zero exit and stderr complaining about auth. The
  fix is a manual `claude` login as the same user. There is no headless
  recovery.
- **Tool use.** `--print` mode uses the CLI's default tool set. The CV
  Q&A prompt doesn't invite tool calls, but if you see delays or the
  model deciding to Bash/Read/Edit, add explicit `--disallowedTools` in
  `server.mjs` to lock it down.
- **Concurrency.** Cap defaults to 2. Bursty CV traffic + Pro/Max plan
  rate limits could otherwise throttle. Raise cautiously.
- **Logs.** `stdout` → `/tmp/claude-wrapper.out.log`, `stderr` →
  `/tmp/claude-wrapper.err.log`. Rotate manually if they grow.
