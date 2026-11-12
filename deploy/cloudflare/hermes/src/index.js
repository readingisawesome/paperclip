import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { verifyAccess } from "../../shared/access.js";
import { handleWorkersAI } from "../../shared/workers-ai.js";
import { inactivityMs, waitForPort, forward, page } from "../../shared/box.js";

const PORT = 9120;
const USER = "lauren";

export class WorkersAI extends WorkerEntrypoint {
  fetch(request) {
    return handleWorkersAI(request, this.env);
  }
}

export class HermesBox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const c = ctx.container;
    if (c && c.running) void ctx.blockConcurrencyWhile(() => c.setInactivityTimeout(inactivityMs(env)));
  }

  // Hermes needs a password before it will listen beyond localhost. This Worker
  // makes one, keeps it in its own storage and adds it to each request, so it
  // never has to be typed or shown. Cloudflare Access is the real sign-in.
  async innerPassword() {
    let pw = await this.ctx.storage.get("innerPassword");
    if (!pw) {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      pw = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      await this.ctx.storage.put("innerPassword", pw);
    }
    return pw;
  }

  async ensureRunning() {
    const c = this.ctx.container;
    if (!c.running) {
      await c.interceptOutboundHttp("workers-ai.internal", this.ctx.exports.WorkersAI);
      c.start({
        image: c.images.base,
        instance: "basic",
        enableInternet: true,
        env: {
          HERMES_DASHBOARD_BASIC_AUTH_USERNAME: USER,
          HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: await this.innerPassword(),
        },
      });
    }
    await c.setInactivityTimeout(inactivityMs(this.env));
    await waitForPort(c, PORT, "/", 180);
  }

  async fetch(request) {
    this.starting ??= this.ensureRunning().finally(() => { this.starting = undefined; });
    try {
      await this.starting;
    } catch (err) {
      return page("Hermes is waking up", "It didn't finish starting. Wait a minute and reload. (" + String(err.message).slice(0, 200) + ")", 503);
    }
    const auth = "Basic " + btoa(USER + ":" + (await this.innerPassword()));
    return forward(request, this.ctx.container, PORT, { authorization: auth });
  }
}

export default {
  async fetch(request, env) {
    const who = await verifyAccess(request, env).catch(() => null);
    if (!who) return page("Sign-in needed", "Open this address in your browser and sign in with Cloudflare.", 403);
    return env.HERMES.getByName("main").fetch(request);
  },
};
