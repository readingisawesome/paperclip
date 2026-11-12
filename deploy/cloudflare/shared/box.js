// Starts a container on demand, waits until its web server answers, and lets it
// sleep after a quiet spell. Shared by the Paperclip and Hermes Workers.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function inactivityMs(env) {
  const m = Number(env.SLEEP_AFTER_MINUTES || 15);
  return Math.min(Math.max(m, 1), 360) * 60 * 1000;
}

export async function waitForPort(container, port, path, maxSeconds) {
  const tcp = container.getTcpPort(port);
  const deadline = Date.now() + maxSeconds * 1000;
  let last;
  while (Date.now() < deadline) {
    try {
      const res = await tcp.fetch("http://container" + path);
      if (res.status < 500) return;
      last = new Error("status " + res.status);
    } catch (e) {
      last = e;
    }
    await sleep(1000);
  }
  throw new Error("The app did not start in time: " + (last && last.message));
}

export function forward(request, container, port, extraHeaders = {}) {
  const url = new URL(request.url);
  url.protocol = "http:";
  url.host = "container";
  const fwd = new Request(url, request);
  fwd.headers.delete("host");
  fwd.headers.delete("cf-access-jwt-assertion");
  for (const [k, v] of Object.entries(extraHeaders)) fwd.headers.set(k, v);
  return container.getTcpPort(port).fetch(fwd);
}

export function page(title, text, status = 200) {
  const html = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>" + title + "</title><body style='font:16px/1.5 system-ui;max-width:36rem;margin:3rem auto;padding:0 1rem'><h1 style='font-size:1.3rem'>" + title + "</h1><p>" + text + "</p>";
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
