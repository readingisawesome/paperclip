// An OpenAI-style endpoint for the apps inside the containers. Requests to
// http://workers-ai.internal/v1/... never leave Cloudflare: this code answers
// them with the AI binding, always through the "agents" AI Gateway, which
// logs every call and holds the request cap and the spend limit. No API key
// ever enters the container.
//
// Model names:
//   "@cf/..."          a Workers AI model, run on Cloudflare.
//   "author/model"     a third-party model from the AI Gateway catalog, such
//                      as "openai/gpt-5.5" or "anthropic/claude-opus-5.5". The
//                      gateway bills it to the account's AI Gateway credits
//                      (Unified Billing), so no provider key is needed
//                      anywhere. The gateway's spend limit caps the cost.
//   "openrouter/vendor/model"  a model on OpenRouter, such as
//                      "openrouter/mistralai/mistral-large". The gateway adds
//                      the OpenRouter key stored on it (Provider Keys, alias
//                      "default"); OpenRouter bills that account directly.
const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Shown on /v1/models. Any other catalog id still works if asked for by name.
const LISTED_MODELS = [
  // Open models on Workers AI (no provider account needed)
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/qwen/qwen3.8-27b",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/zai-org/glm-5.2",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/openai/gpt-oss-120b",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  // Paid models through AI Gateway, billed to AI Gateway credits
  "openai/gpt-5.5",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-sonnet-5",
  "google/gemini-3.8-flash",
  "xai/grok-4.6",
  "alibaba/qwen3.8-max",
];

function listedModels(env) {
  const extra = String(env.EXTRA_MODELS || "").split(",").map((m) => m.trim()).filter(Boolean);
  return [...new Set([...LISTED_MODELS, ...extra])];
}

async function viaOpenRouter(env, model, body, wantsStream) {
  const { stream: _s, stream_options: _so, ...rest } = body;
  const query = { ...rest, model: model.slice("openrouter/".length) };
  const gateway = env.AI.gateway(env.AI_GATEWAY_ID);
  let res;
  for (const endpoint of ["chat/completions", "v1/chat/completions"]) {
    res = await gateway.run({
      provider: "openrouter",
      endpoint,
      headers: { "content-type": "application/json", "cf-aig-metadata": JSON.stringify({ app: env.APP_NAME || "agents" }) },
      query,
    });
    if (res.status !== 404) break;
  }
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 || /key|credential|auth/i.test(text)
      ? " Add an OpenRouter key under AI Gateway > agents > Provider Keys."
      : "";
    return json({ error: { message: "OpenRouter (" + model + "): " + text.slice(0, 300) + hint } }, res.status === 401 ? 400 : res.status);
  }
  let completion;
  try { completion = JSON.parse(text); } catch { return json({ error: { message: "OpenRouter sent an unreadable answer." } }, 502); }
  return wantsStream ? asStream(completion) : json(completion);
}

function isThirdParty(model) {
  return typeof model === "string" && !model.startsWith("@cf/") && /^[a-z0-9][a-z0-9._-]*\/[^\s]+$/i.test(model);
}

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
    return json({ object: "list", data: listedModels(env).map((id) => ({ id, object: "model", owned_by: id.startsWith("@cf/") ? "workers-ai" : id.split("/")[0] })) });
  }
  if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
    return json({ error: { message: "Only /v1/chat/completions and /v1/models are available here." } }, 404);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: { message: "Request body must be JSON." } }, 400); }
  const wantsStream = body.stream === true;
  if (typeof body.model === "string" && body.model.startsWith("openrouter/")) {
    try {
      return await viaOpenRouter(env, body.model, body, wantsStream);
    } catch (err) {
      return json({ error: { message: "OpenRouter: " + String(err && err.message ? err.message : err).slice(0, 300) } }, 502);
    }
  }
  if (isThirdParty(body.model)) {
    const { model: thirdParty, stream: _s, stream_options: _so, ...rest } = body;
    // OpenAI's newer models reject max_tokens and want max_completion_tokens.
    if (thirdParty.startsWith("openai/") && rest.max_tokens !== undefined) {
      if (rest.max_completion_tokens === undefined) rest.max_completion_tokens = rest.max_tokens;
      delete rest.max_tokens;
    }
    try {
      const result = await env.AI.run(thirdParty, rest, { gateway: { id: env.AI_GATEWAY_ID, metadata: { app: env.APP_NAME || "agents" } } });
      const completion = toOpenAI(thirdParty, result);
      return wantsStream ? asStream(completion) : json(completion);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      const status = /rate limit|429|spend/i.test(msg) ? 429 : /credential|key|400/i.test(msg) ? 400 : 502;
      return json({ error: { message: "AI Gateway (" + thirdParty + "): " + msg.slice(0, 300) } }, status);
    }
  }
  const model = typeof body.model === "string" && body.model.startsWith("@cf/") ? body.model : DEFAULT_MODEL;
  const inputs = { messages: body.messages || [] };
  for (const k of ["tools", "temperature", "top_p", "max_tokens", "response_format", "seed", "frequency_penalty", "presence_penalty"]) {
    if (body[k] !== undefined) inputs[k] = body[k];
  }
  if (body.max_completion_tokens !== undefined && inputs.max_tokens === undefined) inputs.max_tokens = body.max_completion_tokens;
  try {
    const result = await env.AI.run(model, inputs, { gateway: { id: env.AI_GATEWAY_ID, metadata: { app: env.APP_NAME || "agents" } } });
    const completion = toOpenAI(model, result);
    return wantsStream ? asStream(completion) : json(completion);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    const status = /rate limit|429/i.test(msg) ? 429 : 502;
    return json({ error: { message: "Workers AI: " + msg.slice(0, 300) } }, status);
  }
}
