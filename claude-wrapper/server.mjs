#!/usr/bin/env node
// claude-wrapper — tiny HTTP shim that exposes an OpenAI-compatible
// /v1/chat/completions endpoint backed by the `claude` CLI running in
// print + stream-json mode.
//
// Runs on the M1 Pro alongside Ollama:
//   - Ollama                  :11434   (existing)
//   - This wrapper            :11435   (bound to 127.0.0.1)
//
// The Render gateway tunnels a second socat bridge to this port (see
// gateway/run.sh) and Caddy routes `/v1/claude/*` here.
//
// No dependencies beyond Node's built-ins. Node >= 18 (needs
// AbortController and native fetch-style APIs, both are fine here).
//
// Auth: requires `Authorization: Bearer $LLM_API_TOKEN` — the same token
// the gateway forwards. Reject anything else.

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

const PORT = Number(process.env.PORT ?? 11435)
const HOST = process.env.HOST ?? '127.0.0.1'
const TOKEN = process.env.LLM_API_TOKEN ?? ''
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude'
const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT ?? 2)
const DEFAULT_MODEL = process.env.CLAUDE_MODEL ?? '' // empty → CLI default

if (!TOKEN) {
    console.error('[claude-wrapper] FATAL: LLM_API_TOKEN not set.')
    process.exit(1)
}

let inflight = 0

const log = (...args) => console.log(new Date().toISOString(), ...args)

// ---------------------------------------------------------------------
// Request-body helpers
// ---------------------------------------------------------------------

function readBody(req, limitBytes = 1_000_000) {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', (chunk) => {
            size += chunk.length
            if (size > limitBytes) {
                reject(new Error('body too large'))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
    })
}

// Extract the pieces we need from an OpenAI chat.completions payload:
//   { model?, messages: [{ role, content }...], stream? }
//
// The Claude CLI takes: --system-prompt "<sys>", positional "<user>".
// For prior-turn context (the widget's sliding window can still send
// one previous exchange), we fold it into --append-system-prompt as
// "Prior conversation:" so the model sees it without needing full
// stream-json input plumbing.
function unpackMessages(payload) {
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    let system = ''
    const nonSystem = []
    for (const m of messages) {
        if (!m || typeof m !== 'object') continue
        const role = String(m.role ?? '')
        const content = typeof m.content === 'string' ? m.content : ''
        if (role === 'system') {
            system = system ? `${system}\n\n${content}` : content
        } else if (role === 'user' || role === 'assistant') {
            nonSystem.push({ role, content })
        }
    }
    const lastUser = [...nonSystem].reverse().find((m) => m.role === 'user')
    const prior = nonSystem.slice(0, nonSystem.lastIndexOf(lastUser))
    return {
        system,
        prior,
        userPrompt: lastUser?.content ?? '',
        stream: payload?.stream === true,
        model: typeof payload?.model === 'string' ? payload.model : '',
    }
}

// ---------------------------------------------------------------------
// SSE emission — OpenAI shape so the widget's default parser handles it
// ---------------------------------------------------------------------

function sseFrame(delta) {
    const payload = JSON.stringify({ choices: [{ delta: { content: delta } }] })
    return `data: ${payload}\n\n`
}
const SSE_DONE = 'data: [DONE]\n\n'

// ---------------------------------------------------------------------
// Claude stream-json → OpenAI SSE
// ---------------------------------------------------------------------
//
// With --output-format stream-json --include-partial-messages the CLI
// emits one JSON object per line. Types we care about:
//   { type: "stream_event", event: { type: "content_block_delta",
//     delta: { type: "text_delta", text: "..." } } }  → text delta
//   { type: "result", subtype: "success" | "error", ... }
//     → definitive end-of-turn marker; also carries the full text at
//        obj.result for the non-streaming code path.
// Anything else (system init, assistant summary, rate_limit_event,
// post_turn_summary) is skipped for the streaming path.
//
// We rely on `result` to signal end of turn rather than child-process
// exit, because the CLI leaves detached sub-processes (MCP hosts, memory
// writers, background tasks) that inherit stdout and keep it open —
// `child.on('close')` may not fire for tens of seconds after the
// user-visible response is complete.
function parseLine(line) {
    let obj
    try {
        obj = JSON.parse(line)
    } catch {
        return { delta: '', terminal: false, finalText: null }
    }
    if (obj?.type === 'stream_event') {
        const ev = obj.event
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            const text = typeof ev.delta.text === 'string' ? ev.delta.text : ''
            return { delta: text, terminal: false, finalText: null }
        }
    }
    if (obj?.type === 'result') {
        const finalText = typeof obj.result === 'string' ? obj.result : ''
        return { delta: '', terminal: true, finalText }
    }
    return { delta: '', terminal: false, finalText: null }
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

async function handleChat(req, res) {
    if (inflight >= MAX_INFLIGHT) {
        res.writeHead(429, { 'Content-Type': 'text/plain' })
        res.end('claude-wrapper busy (concurrency cap reached)')
        return
    }
    inflight += 1

    let child = null
    let clientAborted = false

    // Detect client disconnect via the RESPONSE stream, not the request
    // stream — Node emits `req.close` as soon as the request body is
    // fully read (even on a healthy connection), which was flipping
    // `clientAborted` before we ever wrote the response.
    // `res.close` fires either when we end the response cleanly (in
    // which case `res.writableEnded` is already true) or when the
    // socket dies mid-flight (in which case it isn't).
    res.on('close', () => {
        if (!res.writableEnded) {
            clientAborted = true
            if (child && !child.killed) child.kill('SIGTERM')
        }
    })

    try {
        const raw = await readBody(req)
        const payload = raw ? JSON.parse(raw) : {}
        const { system, prior, userPrompt, stream, model } = unpackMessages(payload)

        if (!userPrompt) {
            res.writeHead(400, { 'Content-Type': 'text/plain' })
            res.end('no user message in payload')
            return
        }

        const args = ['--print', '--output-format', 'stream-json', '--include-partial-messages', '--verbose']
        if (system) args.push('--system-prompt', system)
        if (prior.length > 0) {
            const priorText = prior
                .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
                .join('\n\n')
            args.push('--append-system-prompt', `Prior conversation:\n${priorText}`)
        }
        const chosenModel = model && model.startsWith('claude') ? model : DEFAULT_MODEL
        if (chosenModel) args.push('--model', chosenModel)
        args.push(userPrompt)

        log(`spawn ${CLAUDE_BIN} (model=${chosenModel || 'default'}, prior=${prior.length}, stream=${stream})`)

        child = spawn(CLAUDE_BIN, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
        })

        // Kill the child + any grandchildren that may still be holding
        // stdout open (auto-memory writer, MCP hosts, etc). We can't
        // wait for `close` because those grandchildren keep the pipe
        // alive well past the user-visible end of turn.
        const finalizeChild = () => {
            if (!child || child.killed) return
            try {
                child.kill('SIGTERM')
            } catch {
                /* already gone */
            }
            setTimeout(() => {
                if (child && !child.killed) {
                    try {
                        child.kill('SIGKILL')
                    } catch {
                        /* already gone */
                    }
                }
            }, 2000).unref()
        }

        const stderrChunks = []
        child.stderr.on('data', (b) => stderrChunks.push(b))

        // Non-streaming: accumulate deltas + final result, respond once.
        if (!stream) {
            let acc = ''
            let final = null
            await new Promise((resolve) => {
                let done = false
                const finish = () => {
                    if (done) return
                    done = true
                    finalizeChild()
                    resolve()
                }
                let buf = ''
                child.stdout.on('data', (b) => {
                    buf += b.toString('utf8')
                    let idx
                    while ((idx = buf.indexOf('\n')) !== -1) {
                        const line = buf.slice(0, idx)
                        buf = buf.slice(idx + 1)
                        const p = parseLine(line)
                        if (p.delta) acc += p.delta
                        if (p.terminal) {
                            if (p.finalText) final = p.finalText
                            finish()
                        }
                    }
                })
                child.on('close', finish)
                child.on('error', finish)
            })
            if (clientAborted) return
            const content = final ?? acc
            if (!content) {
                res.writeHead(502, { 'Content-Type': 'text/plain' })
                res.end(`claude produced no content: ${Buffer.concat(stderrChunks).toString('utf8').slice(0, 500)}`)
                return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
            return
        }

        // Streaming: pipe SSE as deltas arrive; end on `result` line.
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        })

        await new Promise((resolve) => {
            let done = false
            const finish = () => {
                if (done) return
                done = true
                if (!res.writableEnded) {
                    res.write(SSE_DONE)
                    res.end()
                }
                finalizeChild()
                resolve()
            }
            let buf = ''
            let deltaSeen = false
            child.stdout.on('data', (b) => {
                buf += b.toString('utf8')
                let idx
                while ((idx = buf.indexOf('\n')) !== -1) {
                    const line = buf.slice(0, idx)
                    buf = buf.slice(idx + 1)
                    const p = parseLine(line)
                    if (p.delta && !res.writableEnded) {
                        res.write(sseFrame(p.delta))
                        deltaSeen = true
                    }
                    if (p.terminal) {
                        // If we somehow got no deltas but the result
                        // carries the final text, emit it as one frame
                        // so the widget's DEFAULT_PARSE_CHUNK sees content.
                        if (!deltaSeen && p.finalText && !res.writableEnded) {
                            res.write(sseFrame(p.finalText))
                        }
                        finish()
                    }
                }
            })
            child.on('close', finish)
            child.on('error', finish)
        })
    } catch (err) {
        log('handler error:', err.message)
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' })
        }
        if (!res.writableEnded) res.end(`wrapper error: ${err.message}`)
    } finally {
        inflight -= 1
        if (child && !child.killed) child.kill('SIGTERM')
    }
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------

const server = createServer((req, res) => {
    // CORS preflight — the widget hits this via the gateway, but keep
    // it working for direct-loopback debugging.
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        })
        res.end()
        return
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('OK')
        return
    }

    // Everything else needs a bearer token.
    const auth = req.headers['authorization'] ?? ''
    if (auth !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'text/plain' })
        res.end('unauthorized')
        return
    }

    if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
        void handleChat(req, res)
        return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
})

server.listen(PORT, HOST, () => {
    log(`claude-wrapper listening on http://${HOST}:${PORT}  (max in-flight: ${MAX_INFLIGHT})`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        log(`received ${sig}, shutting down`)
        server.close(() => process.exit(0))
    })
}
