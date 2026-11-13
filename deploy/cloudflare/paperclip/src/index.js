import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { verifyAccess } from "../../shared/access.js";
import { handleWorkersAI } from "../../shared/workers-ai.js";
import { inactivityMs, waitForPort, forward, page } from "../../shared/box.js";

const PORT = 3100;

// Answers http://workers-ai.internal from inside the container.
export class WorkersAI extends WorkerEntrypoint {
  fetch(request) {
    return handleWorkersAI(request, this.env);
  }
}

export class PaperclipBox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const c = ctx.container;
    if (c && c.running) void ctx.blockConcurrencyWhile(() => c.setInactivityTimeout(inactivityMs(env)));
  }

  containerEnv() {
    const e = this.env;
    const host = new URL(e.PUBLIC_URL).hostname;
    const env = {
      PORT: String(PORT),
      HOST: "0.0.0.0",
      SERVE_UI: "true",
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
      PAPERCLIP_PUBLIC_URL: e.PUBLIC_URL,
      PAPERCLIP_ALLOWED_HOSTNAMES: host,
      PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
      DATABASE_URL: e.DATABASE_URL,
      BETTER_AUTH_SECRET: e.BETTER_AUTH_SECRET,
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: e.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET,
      PAPERCLIP_SECRETS_MASTER_KEY: e.PAPERCLIP_SECRETS_MASTER_KEY,
      // OpenAI-style access to Workers AI, answered by the WorkersAI entrypoint.
      OPENAI_BASE_URL: "http://workers-ai.internal/v1",
      OPENAI_API_KEY: "workers-ai-via-cloudflare",
    };
    if (e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY) {
      Object.assign(env, {
        PAPERCLIP_STORAGE_PROVIDER: "s3",
        PAPERCLIP_STORAGE_S3_BUCKET: e.R2_BUCKET,
        PAPERCLIP_STORAGE_S3_ENDPOINT: e.R2_ENDPOINT,
        PAPERCLIP_STORAGE_S3_REGION: "auto",
        PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE: "true",
        PAPERCLIP_STORAGE_S3_PREFIX: "paperclip/",
        AWS_ACCESS_KEY_ID: e.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: e.AWS_SECRET_ACCESS_KEY,
      });
    }
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    return env;
  }

  async ensureRunning() {
    const c = this.ctx.container;
    if (!c.running) {
      await c.interceptOutboundHttp("workers-ai.internal", this.ctx.exports.WorkersAI);
      c.start({ image: c.images.base, instance: "standard-1", enableInternet: true, env: this.containerEnv() });
      await this.ctx.storage.put("lastStartedAt", Date.now());
    }
    await c.setInactivityTimeout(inactivityMs(this.env));
    await waitForPort(c, PORT, "/api/health", 180);
  }

  async fetch(request) {
    this.starting ??= this.ensureRunning().finally(() => { this.starting = undefined; });
    try {
      await this.starting;
    } catch (err) {
      return page("Paperclip is waking up", "It didn't finish starting. Wait a minute and reload. (" + String(err.message).slice(0, 200) + ")", 503);
    }
    return forward(request, this.ctx.container, PORT);
  }

  async wake() {
    await this.ensureRunning();
    return "awake";
  }
}

// One Paperclip, placed in western North America so it sits near its
// database (Supabase, us-west-1). The name changed from "main" to "west" so
// the placement hint takes effect; all of Paperclip's data is in Postgres.
function box(env) {
  return env.PAPERCLIP.get(env.PAPERCLIP.idFromName("west"), { locationHint: "wnam" });
}

export default {
  async fetch(request, env) {
    const who = await verifyAccess(request, env).catch(() => null);
    if (!who) return page("Sign-in needed", "Open this address in your browser and sign in with Cloudflare.", 403);
    if (!env.DATABASE_URL) {
      return page("Almost ready", "Paperclip is waiting for its database setting (DATABASE_URL). Once it's added in Cloudflare, reload this page.", 503);
    }
    return box(env).fetch(request);
  },
  // Hourly wake so scheduled agents get a chance to run, then it sleeps again.
  async scheduled(_event, env, ctx) {
    if (!env.DATABASE_URL) return;
    ctx.waitUntil(box(env).wake());
  },
};
