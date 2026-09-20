import https from 'https';
import type { Express } from 'express';

/**
 * Provider proxy route: the single-session-standalone HTTP fan-out to
 * OpenRouter / Anthropic / OpenAI / Gemini. This is part of `agentCore`
 * because it's needed to run a single agent session on its own (e.g.
 * scripts/review-pr.ts spins up its own dedicated instance of this proxy) --
 * it is not orchestration-across-sessions logic.
 *
 * Extracted out of `orchestration/serverRuntime.ts`, which previously
 * defined this route (and its module-level state) directly on the shared
 * Express `app` at module load time. `mountProviderProxyRoute` now takes
 * that `app` as a parameter so `orchestration/serverRuntime.ts` wires it in
 * via a real import/mount, rather than sharing module scope with it.
 *
 * `agentCore` must never import from `orchestration`, so logging is taken
 * as an injected dependency (`writeLog`) rather than imported directly from
 * `orchestration/orchestrator/sessionState`. The boundary guard
 * (scripts/check-agentcore-boundary.ts) now enforces this mechanically.
 *
 * This file lives in its own `proxy/` subdirectory (extraction plan phase
 * 2c) because it is the only agentCore module that touches `express` —
 * the future package exposes it as the `./proxy` subpath with `express` as
 * an optional peer dependency. The import above is type-only, so nothing
 * loads at runtime.
 */

/**
 * Session id to stamp onto outgoing OpenRouter request bodies as "session_id",
 * so requests from a given copilot-sdk session are grouped together in
 * OpenRouter's dashboard/logs. Set by the caller (e.g. review-pr.ts) right
 * after a CopilotSession is created, before any prompt is sent.
 *
 * NOTE: this is a single module-level value, not per-request. That's fine for
 * a short-lived, single-session process like review-pr.ts (which starts its
 * own dedicated instance of this proxy), but it is NOT safe if this server is
 * ever handling multiple concurrent copilot-sdk sessions at once (e.g. the
 * main long-running app) -- concurrent sessions would stamp each other's
 * requests with the wrong session_id. The SDK does not currently send any
 * per-request session identifier we could forward instead, so a real fix for
 * the concurrent case would need to come from there.
 *
 * TODO: not safe for concurrent multi-session use of this server (e.g. the
 * main long-running app). Before reusing this proxy for anything beyond a
 * single-session process like review-pr.ts, either scope this per-request
 * (e.g. via a header/query param carrying the session id, once the SDK
 * supports emitting one) or otherwise stop relying on shared module state.
 */
let activeOpenRouterSessionId: string | undefined;
export function setActiveOpenRouterSessionId(sessionId: string | undefined) {
  activeOpenRouterSessionId = sessionId;
  // A new session means a fresh agentic loop -- reset dedupe state so the
  // next outbound request logs instead of being skipped as a repeat of the
  // previous session's already-logged tools list. See
  // `hasLoggedProviderToolsForCurrentSession` below for what this gates.
  hasLoggedProviderToolsForCurrentSession = false;
}

/**
 * Dedupe state for the tool-list logging in the '/api/providers/:provider/*'
 * proxy route below. A "turn" here means the whole agentic loop -- every
 * iteration of tool calls, nudge retries (toolCallEnforcement.ts), and
 * streaming reconnects the agent runs through before it goes idle and hands
 * control back -- not each individual outbound LLM call within that loop.
 * Since the `tools` list is fixed for a session's entire lifetime
 * (SessionWrapper._createConfig never re-derives it from later
 * enableTools/disableTools calls), it's identical on every one of those
 * calls anyway, so logging once per *session* -- gated by this flag,
 * flipped back to false only when a new session starts -- is what "once per
 * turn" actually means here, not once per distinct message count. Same
 * single-module-value caveat as `activeOpenRouterSessionId` above -- not
 * safe for concurrent multi-session use of this server.
 */
let hasLoggedProviderToolsForCurrentSession = false;

export function mountProviderProxyRoute(app: Express, writeLog: (msg: string) => void) {
  // Generic adapter registry route for model providers (SYS-REQ-004 & SYS-REQ-005)
  app.all('/api/providers/:provider/*', (req, res) => {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', () => {
      const provider = req.params.provider;
      const method = req.method;

      let modifiedBody = bodyData;
      let targetHostname = 'api.openai.com';

      if (provider === 'gemini') {
        targetHostname = 'generativelanguage.googleapis.com';
        try {
          if (bodyData) {
            const data = JSON.parse(bodyData);
            if (data && Array.isArray(data.messages)) {
              data.messages.forEach((m: { refusal?: unknown; parsed?: unknown }) => {
                if ('refusal' in m) delete m.refusal;
                if ('parsed' in m) delete m.parsed;
              });
              modifiedBody = JSON.stringify(data);
            }
          }
        } catch (e) {
             writeLog("Provider parse error: " + e);
        }
      } else if (provider === 'anthropic') {
        targetHostname = 'api.anthropic.com';
      } else if (provider === 'openrouter') {
        targetHostname = 'openrouter.ai';
        try {
          if (bodyData && activeOpenRouterSessionId) {
            const data = JSON.parse(bodyData);
            if (data && typeof data === 'object' && !data.session_id) {
              data.session_id = activeOpenRouterSessionId;
              modifiedBody = JSON.stringify(data);
            }
          }
        } catch (e) {
          writeLog("Provider parse error (openrouter session_id): " + e);
        }
      }

      const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: targetHostname };
      if (provider === 'openrouter') {
        if (!headers.authorization) {
          const key = process.env.OPENROUTER_API_KEY;
          if (key) {
            headers.authorization = `Bearer ${key}`;
          }
        }
        if (!headers['http-referer']) {
          headers['http-referer'] = 'https://github.com/github/copilot';
        }
        if (!headers['x-openrouter-title']) {
          headers['x-openrouter-title'] = 'GitHub Copilot';
        }
      }
      delete headers['accept-encoding'];
      headers['content-length'] = Buffer.byteLength(modifiedBody).toString();

      // Log just the tool names this request declares to the provider, not
      // the full body (which carries prompt/message content we don't want
      // landing in a shared log file). This is the earliest point in this
      // codebase where the outbound provider-bound `tools` array is
      // actually visible -- everything upstream of here (SessionWrapper,
      // CopilotClient) hands off to the spawned Copilot CLI runtime over
      // JSON-RPC, which builds this HTTP request itself; we only get to see
      // it once it lands back here as a proxied request.
      //
      // Deduped to once per turn (the whole agentic loop, not each
      // individual call within it) via
      // `hasLoggedProviderToolsForCurrentSession` -- see its declaration
      // above for why session-scoped is the right granularity here.
      //
      // Uses console.log directly (in addition to writeLog, for the file
      // record / GET /api/logs) rather than relying on writeLog's own
      // console echo: that echo is gated behind CURRENT_LOG_LEVEL, which
      // defaults to WARN unless LOG_LEVEL is exported (writeLog's default
      // level is INFO, which doesn't clear that bar) -- so a caller running
      // this script without LOG_LEVEL set would never see this line in
      // their terminal even though it was being written to the debug file
      // the whole time. This diagnostic exists specifically to be visible
      // in a normal run, so it shouldn't be silently gated by quiet mode.
      if (!hasLoggedProviderToolsForCurrentSession) {
        try {
          const parsedForLogging = modifiedBody ? JSON.parse(modifiedBody) : undefined;
          const toolNames = Array.isArray(parsedForLogging?.tools)
            ? parsedForLogging.tools.map((t: { name?: string; function?: { name?: string } }) => t.function?.name ?? t.name ?? '<unnamed>')
            : undefined;
          const line = toolNames
            ? `[ProviderProxy] ${provider} request tools (${toolNames.length}): ${toolNames.join(', ')}` +
              (activeOpenRouterSessionId ? ` [session_id=${activeOpenRouterSessionId}]` : '')
            : `[ProviderProxy] ${provider} request has no 'tools' field.`;
          console.log(line);
          writeLog(line);
          hasLoggedProviderToolsForCurrentSession = true;
        } catch (e) {
          const errLine = `[ProviderProxy] tool-list logging: failed to parse/log tools: ${e instanceof Error ? e.message : String(e)}`;
          console.log(errLine);
          writeLog(errLine);
        }
      }

      const options = {
        hostname: targetHostname,
        port: 443,
        path: req.originalUrl.replace(`/api/providers/${provider}`, ''),
        method: method,
        headers
      };

      const proxyReq = https.request(options, (proxyRes) => {
        if (provider === 'gemini' && proxyRes.statusCode && proxyRes.statusCode >= 400) {
          let errorBody: Buffer[] = [];
          proxyRes.on('data', d => errorBody.push(d));
          proxyRes.on('end', () => {
            let bodyStr = Buffer.concat(errorBody).toString();
            try {
              const parsed = JSON.parse(bodyStr);
              if (Array.isArray(parsed) && parsed.length === 1 && parsed[0].error) {
                bodyStr = JSON.stringify(parsed[0]);
              }
            } catch (e) {
              // ignore parse errors
            }
            res.writeHead(proxyRes.statusCode || 500, { ...proxyRes.headers, 'content-length': Buffer.byteLength(bodyStr).toString() });
            res.end(bodyStr);
          });
          return;
        }

        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        writeLog("Provider proxy error: " + err);
        res.writeHead(500);
        res.end('Provider proxy error: ' + err.message);
      });

      proxyReq.write(modifiedBody);
      proxyReq.end();
    });
  });
}
