// Scripted OpenAI-compatible SSE server: the hermetic stand-in for a real
// LLM provider in e2e-mock scenarios (docs/plans/2026-09-09-production-hardening.md §5).
// pi's openai-completions client posts to {baseUrl}/chat/completions and
// REQUIRES finish_reason (a stream without it raises "Stream ended without
// finish_reason") — that requirement is exactly what the `cut` step exploits.
//
// Step shapes (consumed one per request, per model id; the shared `any` queue
// is the fallback; an exhausted queue falls back to a deterministic text step
// so a miscounted script degrades instead of wedging):
//   { kind: "text",  text, dripMs? }   stream text deltas, finish "stop"
//   { kind: "tool",  name, args }      one tool_call delta, finish "tool_calls"
//   { kind: "error", status, message? }non-2xx JSON body (400 = non-retryable)
//   { kind: "stall" }                  hold the request open, no bytes ever
//   { kind: "cut",   text, dripMs? }   stream deltas, then close WITHOUT
//                                      finish_reason/[DONE] (stream-cut fault)

const DEFAULT_TEXT = "ok";
const USAGE = { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 };

const sleep = (ms) =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

function sseHeaders() {
  return { "content-type": "text/event-stream", "cache-control": "no-cache" };
}

function chunk(model, delta, extra = {}) {
  return {
    id: "mock-1",
    object: "chat.completion.chunk",
    created: 1730000000,
    model,
    choices: [{ index: 0, delta, finish_reason: extra.finishReason ?? null }],
    ...(extra.usage ? { usage: extra.usage } : {}),
  };
}

/**
 * Deterministic split; pieces.join("") === text. Splits on code points so a
 * surrogate pair is never cut in half (half a pair UTF-8-encodes to U+FFFD
 * and would corrupt the stitched text on the client side).
 */
function pieces(text, count = 8) {
  const chars = Array.from(text);
  if (chars.length === 0) return [""];
  const size = Math.max(1, Math.ceil(chars.length / count));
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: { message, type: "mock_error" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function startMockModel(config = {}) {
  // Copies: step consumption must not mutate the caller's script arrays.
  const queues = new Map(Object.entries(config.models ?? {}).map(([k, v]) => [k, [...v]]));
  const wildcard = [...(config.any ?? [])];
  const requests = [];

  const nextStep = (model) => {
    const own = queues.get(model);
    if (own !== undefined && own.length > 0) return own.shift();
    if (wildcard.length > 0) return wildcard.shift();
    return { kind: "text", text: DEFAULT_TEXT };
  };

  const server = Bun.serve({
    port: 0,
    // Stall steps must outlive the per-scenario watchdogs (default 120s).
    idleTimeout: 255,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
        return errorResponse(404, `mock: unexpected ${req.method} ${path}`);
      }
      const body = await req.json();
      requests.push({ model: body.model, messages: body.messages });
      const model = typeof body.model === "string" && body.model.length > 0 ? body.model : "mock";
      const step = nextStep(model);

      if (step.kind === "error") {
        const status =
          Number.isInteger(step.status) && step.status >= 400 && step.status <= 599
            ? step.status
            : 500;
        return errorResponse(status, step.message ?? `mock forced error ${status}`);
      }
      if (step.kind === "stall") {
        return new Response(
          new ReadableStream({
            start() {
              // Intentionally never enqueues and never closes.
            },
          }),
          { headers: sseHeaders() },
        );
      }

      if (!["text", "tool", "cut"].includes(step.kind)) {
        return errorResponse(500, `mock: unknown step kind ${JSON.stringify(step.kind)}`);
      }

      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
          try {
            if (step.kind === "tool") {
              send(
                chunk(model, {
                  tool_calls: [
                    {
                      index: 0,
                      id: step.callId ?? "call_mock_1",
                      type: "function",
                      function: { name: step.name, arguments: JSON.stringify(step.args ?? {}) },
                    },
                  ],
                }),
              );
              await sleep(step.dripMs ?? 0);
              send(chunk(model, {}, { finishReason: "tool_calls", usage: USAGE }));
            } else if (step.kind === "cut") {
              for (const piece of pieces(step.text ?? "partial-before-cut")) {
                send(chunk(model, { content: piece }));
                await sleep(step.dripMs ?? 0);
              }
              controller.close();
              return;
            } else {
              for (const piece of pieces(step.text ?? DEFAULT_TEXT)) {
                send(chunk(model, { content: piece }));
                await sleep(step.dripMs ?? 0);
              }
              send(chunk(model, {}, { finishReason: "stop", usage: USAGE }));
            }
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (_error) {
            // Client aborted mid-script; closing the stream is enough.
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        },
      });
      return new Response(stream, { headers: sseHeaders() });
    },
  });

  return {
    port: server.port,
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}
