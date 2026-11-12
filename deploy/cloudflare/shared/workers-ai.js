// An OpenAI-style endpoint for the apps inside the containers. Requests to
// http://workers-ai.internal/v1/... never leave Cloudflare: this code answers
// them with the Workers AI binding, through the "agents" AI Gateway, which
// holds the hourly request cap. No API key ever enters the container.
const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function toOpenAI(model, result) {
  if (result && Array.isArray(result.choices)) return result;
  const toolCalls = (result?.tool_calls || []).map((t, i) => ({
    id: t.id || "call_" + i + "_" + crypto.randomUUID().slice(0, 8),
    type: "function",
    function: {
      name: t.name ?? t.function?.name,
      arguments: typeof (t.arguments ?? t.function?.arguments) === "string"
        ? (t.arguments ?? t.function?.arguments)
        : JSON.stringify(t.arguments ?? t.function?.arguments ?? {}),
    },
  }));
  const message = { role: "assistant", content: result?.response ?? "" };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: "chatcmpl-" + crypto.randomUUID(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    usage: result?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function asStream(completion) {
  const choice = completion.choices[0] || {};
  const delta = { role: "assistant", content: choice.message?.content ?? "" };
  if (choice.message?.tool_calls) delta.tool_calls = choice.message.tool_calls.map((t, index) => ({ index, ...t }));
  const chunk = { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model, choices: [{ index: 0, delta, finish_reason: null }] };
  const done = { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || "stop" }], usage: completion.usage };
  const text = "data: " + JSON.stringify(chunk) + "\n\n" + "data: " + JSON.stringify(done) + "\n\n" + "data: [DONE]\n\n";
  return new Response(text, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

export async function handleWorkersAI(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (request.method === "GET" && path.endsWith("/models")) {
    return json({ object: "list", data: [{ id: DEFAULT_MODEL, object: "model", owned_by: "workers-ai" }] });
  }
  if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
    return json({ error: { message: "Only /v1/chat/completions and /v1/models are available here." } }, 404);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: { message: "Request body must be JSON." } }, 400); }
  const model = typeof body.model === "string" && body.model.startsWith("@cf/") ? body.model : DEFAULT_MODEL;
  const wantsStream = body.stream === true;
  const inputs = { messages: body.messages || [] };
  for (const k of ["tools", "temperature", "top_p", "max_tokens", "response_format", "seed", "frequency_penalty", "presence_penalty"]) {
    if (body[k] !== undefined) inputs[k] = body[k];
  }
  if (body.max_completion_tokens !== undefined && inputs.max_tokens === undefined) inputs.max_tokens = body.max_completion_tokens;
  try {
    const result = await env.AI.run(model, inputs, { gateway: { id: env.AI_GATEWAY_ID } });
    const completion = toOpenAI(model, result);
    return wantsStream ? asStream(completion) : json(completion);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    const status = /rate limit|429/i.test(msg) ? 429 : 502;
    return json({ error: { message: "Workers AI: " + msg.slice(0, 300) } }, status);
  }
}
