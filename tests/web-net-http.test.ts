import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
// The vendored browser transport intentionally remains plain JavaScript.
// @ts-expect-error no declaration file for the browser-only host module
import { createNetHost } from "../vendor/pocketjs/hosts/web/net.js";
// The browser player intentionally remains plain JavaScript.
// @ts-expect-error no declaration file for the browser-only host module
import { mountHttpHost } from "../tools/web/player.js";
import { playerHostCapabilities } from "../tools/web.ts";
import { Cdp, CHROME_START_BUDGET_MS, launchChrome } from "../tools/lib/cdp.ts";

interface Host {
  ns: {
    start(meta: string, body: ArrayBuffer): number;
    take(handle: number, into: ArrayBuffer): number;
    poll(): string | undefined;
    lastError(): string;
  };
  beginFrame(): void;
  reset(): void;
}

const meta = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  url: "https://api.example.test/start",
  method: "GET",
  headers: {},
  timeoutMs: 1_000,
  maxBytes: 1024,
  ...overrides,
});

const empty = () => new ArrayBuffer(0);

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Bun.sleep(0);
}

async function admitted(host: Host): Promise<any[]> {
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(1);
    host.beginFrame();
    const batch = host.ns.poll();
    if (batch !== undefined) return JSON.parse(batch);
  }
  throw new Error("HTTP host produced no admitted event");
}

describe("web player HTTP capability", () => {
  test("serializes only a resolved net.http declaration", () => {
    expect(playerHostCapabilities({ "input.buttons": true })).toEqual({});
    expect(playerHostCapabilities({ "net.http": false })).toEqual({});
    expect(playerHostCapabilities({ "net.http": true })).toEqual({ netHttp: true });
  });

  test("leaves an undeclared player unmounted and out of its frame path", () => {
    let factories = 0;
    let audioFrames = 0;
    const target: { net?: unknown } = { net: { stale: true } };
    const player = { audio: { beginFrame: () => { audioFrames++; } } };
    const host = mountHttpHost(player, false, target, () => {
      factories++;
      throw new Error("undeclared net.http must not create a host");
    });

    expect(host).toBeNull();
    expect(factories).toBe(0);
    expect(target.net).toBeUndefined();
    player.audio.beginFrame();
    expect(audioFrames).toBe(1);
  });

  test("mounts, resets, and admits HTTP before the existing guest boundary", () => {
    const order: string[] = [];
    const ns = { marker: "bounded-http" };
    const host = {
      ns,
      reset: () => { order.push("reset"); },
      beginFrame: () => { order.push("http"); },
    };
    const player = { audio: { beginFrame: () => { order.push("audio"); } } };
    const target: { net?: unknown } = {};

    expect(mountHttpHost(player, true, target, () => host)).toBe(host);
    expect(target.net).toBe(ns);
    expect(order).toEqual(["reset"]);
    player.audio.beginFrame();
    expect(order).toEqual(["reset", "audio", "http"]);
  });
});

describe("PocketJS browser HTTP contract through the component gate", () => {
  test("enforces request and response byte limits", async () => {
    const host = createNetHost(async () => new Response(new Uint8Array(5))) as Host;
    const exact = host.ns.start(meta({ method: "POST" }), new ArrayBuffer(64 * 1024));
    expect(exact).toBeGreaterThan(0);
    host.reset();

    expect(host.ns.start(meta({ method: "POST" }), new ArrayBuffer(64 * 1024 + 1))).toBe(-1);
    expect(host.ns.lastError()).toContain("request body too large");

    const handle = host.ns.start(meta({ maxBytes: 4 }), empty());
    expect(handle).toBeGreaterThan(0);
    expect(await admitted(host)).toEqual([{
      t: "error",
      h: handle,
      code: "response_too_large",
      message: "response exceeded 4 bytes",
    }]);
  });

  test("turns one deadline into a frame-admitted timeout", async () => {
    let signal: AbortSignal | undefined;
    const host = createNetHost((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as Host;
    const handle = host.ns.start(meta({ timeoutMs: 1 }), empty());
    expect(handle).toBeGreaterThan(0);
    expect(host.ns.poll()).toBeUndefined();
    const events = await admitted(host);
    expect(signal?.aborted).toBe(true);
    expect(events).toEqual([{ t: "error", h: handle, code: "timeout", message: "request timed out" }]);
  });

  test("uses no credentials and delegates redirects to browser fetch", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const host = createNetHost(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const response = new Response(new Uint8Array([7]), { status: 200, headers: { "x-result": "ok" } });
      Object.defineProperties(response, {
        redirected: { value: true },
        url: { value: "https://api.example.test/final" },
      });
      return response;
    }) as Host;
    const handle = host.ns.start(meta({ method: "POST" }), new Uint8Array([1, 2]).buffer as ArrayBuffer);
    const events = await admitted(host);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      t: "done",
      h: handle,
      status: 200,
      url: "https://api.example.test/final",
      bytes: 1,
    });
    expect(calls.map((call) => call.url)).toEqual(["https://api.example.test/start"]);
    expect(calls[0]!.init).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
    });
  });

  test("publishes all transport facts as one batch at the next frame", async () => {
    const complete: Array<(response: Response) => void> = [];
    const host = createNetHost(() => new Promise<Response>((resolve) => complete.push(resolve))) as Host;
    const first = host.ns.start(meta({ url: "https://api.example.test/a" }), empty());
    const second = host.ns.start(meta({ url: "https://api.example.test/b" }), empty());
    complete[0]!(new Response(new Uint8Array([1])));
    complete[1]!(new Response(new Uint8Array([2, 3])));
    await settle();

    expect(host.ns.poll()).toBeUndefined();
    host.beginFrame();
    const batch = JSON.parse(host.ns.poll()!);
    expect(batch.map((event: any) => [event.t, event.h, event.bytes])).toEqual([
      ["done", first, 1],
      ["done", second, 2],
    ]);
    expect(host.ns.poll()).toBeUndefined();
  });

  test("reset aborts work and discards every late completion", async () => {
    let signal: AbortSignal | undefined;
    const host = createNetHost((_url: string, init: RequestInit) => new Promise<Response>((resolve) => {
      signal = init.signal as AbortSignal;
      signal.addEventListener("abort", () => resolve(new Response(new Uint8Array([9]))), { once: true });
    })) as Host;
    const handle = host.ns.start(meta(), empty());
    expect(handle).toBeGreaterThan(0);
    expect(signal?.aborted).toBe(false);

    host.reset();
    expect(signal?.aborted).toBe(true);
    await settle();
    host.beginFrame();
    expect(host.ns.poll()).toBeUndefined();
    expect(host.ns.take(handle, new ArrayBuffer(1))).toBe(-1);
  });
});

const CHROME = Bun.which("google-chrome") ?? Bun.which("google-chrome-stable") ??
  Bun.which("chromium") ?? "/usr/bin/google-chrome";
setDefaultTimeout(CHROME_START_BUDGET_MS + 30_000);

interface BrowserProbe {
  event: {
    t: "done" | "error";
    h: number;
    status?: number;
    url?: string;
    code?: string;
    message?: string;
    bytes?: number;
  };
  text: string | null;
}

describe.skipIf(!existsSync(CHROME))("PocketJS redirects in real Chrome", () => {
  let httpServer: ReturnType<typeof Bun.serve> | null = null;
  let foreignServer: ReturnType<typeof Bun.serve> | null = null;
  let httpsServer: ReturnType<typeof Bun.serve> | null = null;
  let validationRoot = "";
  let pageOrigin = "";
  let cdp: Cdp | null = null;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  const requests: Array<{ server: "main" | "foreign" | "secure"; path: string; method: string }> = [];

  const evaluate = async <T>(expression: string): Promise<T> => {
    if (!cdp) throw new Error("CDP is not connected");
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`Chrome evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value as T;
  };

  const probe = (path: string, method = "GET", body: number[] = []) =>
    evaluate<BrowserProbe>(`window.runNetProbe(${JSON.stringify(path)}, ${JSON.stringify(method)}, ${JSON.stringify(body)})`);

  beforeAll(async () => {
    validationRoot = resolve(
      import.meta.dir,
      "..",
      ".pocket-build",
      "validation",
      "web-net-redirect",
      `${process.pid}-${Date.now()}`,
    );
    mkdirSync(validationRoot, { recursive: true });
    const key = join(validationRoot, "key.pem");
    const cert = join(validationRoot, "cert.pem");
    const certificate = Bun.spawnSync([
      "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert, "-days", "1", "-sha256",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    ], { stdout: "ignore", stderr: "pipe" });
    if (certificate.exitCode !== 0) {
      throw new Error(`could not create the local HTTPS certificate: ${certificate.stderr.toString()}`);
    }

    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "..", "vendor", "pocketjs", "hosts", "web", "net.js")],
      target: "browser",
      format: "esm",
    });
    if (!built.success || built.outputs.length !== 1) throw new Error("could not bundle the PocketJS browser NET host");
    const netModule = await built.outputs[0]!.text();
    const corsHeaders = () => ({
      "Access-Control-Allow-Origin": pageOrigin,
      "Content-Type": "text/plain; charset=utf-8",
    });

    foreignServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push({ server: "foreign", path: url.pathname, method: request.method });
        return new Response("foreign target", { headers: corsHeaders() });
      },
    });
    httpsServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: Bun.file(key), cert: Bun.file(cert) },
      fetch(request) {
        const url = new URL(request.url);
        requests.push({ server: "secure", path: url.pathname, method: request.method });
        return new Response("secure target", { headers: corsHeaders() });
      },
    });

    const page = `<!doctype html><meta charset="utf-8"><script type="module">
      import { createNetHost } from "/net.js";
      const decoder = new TextDecoder();
      window.runNetProbe = async (path, method = "GET", bytes = []) => {
        const host = createNetHost();
        const handle = host.ns.start(JSON.stringify({
          url: new URL(path, location.origin).href,
          method,
          headers: {},
          timeoutMs: 10_000,
          maxBytes: 1024,
        }), new Uint8Array(bytes).buffer);
        if (handle < 0) throw new Error(host.ns.lastError());
        for (let i = 0; i < 2_000; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          host.beginFrame();
          const batch = host.ns.poll();
          if (!batch) continue;
          const event = JSON.parse(batch)[0];
          let text = null;
          if (event.t === "done") {
            const body = new ArrayBuffer(event.bytes);
            if (host.ns.take(handle, body) !== event.bytes) throw new Error("response body was not available");
            text = decoder.decode(body);
          }
          host.reset();
          return { event, text };
        }
        host.reset();
        throw new Error("NET host did not produce an event");
      };
      window.__netReady = true;
    </script>`;

    httpServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/") return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        if (url.pathname === "/net.js") return new Response(netModule, { headers: { "Content-Type": "text/javascript" } });
        requests.push({ server: "main", path: url.pathname, method: request.method });
        if (url.pathname === "/same-start") return Response.redirect(new URL("/same-final", url).href, 302);
        if (url.pathname === "/same-final") return new Response("same target");
        if (url.pathname === "/cross-origin") {
          return Response.redirect(`http://127.0.0.1:${foreignServer!.port}/foreign-final`, 302);
        }
        if (url.pathname === "/cross-scheme") {
          return Response.redirect(`https://127.0.0.1:${httpsServer!.port}/secure-final`, 302);
        }
        const hop = /^\/multi-(\d+)$/.exec(url.pathname);
        if (hop) {
          const index = Number(hop[1]);
          return Response.redirect(new URL(index === 4 ? "/multi-final" : `/multi-${index + 1}`, url).href, 302);
        }
        if (url.pathname === "/multi-final") return new Response("multi target");
        return new Response("not found", { status: 404 });
      },
    });
    pageOrigin = `http://127.0.0.1:${httpServer.port}`;

    const chrome = await launchChrome(CHROME, join(validationRoot, "chrome"), "800,600");
    proc = chrome.proc;
    cdp = await Cdp.connect(chrome.ws);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Security.enable");
    await cdp.send("Security.setIgnoreCertificateErrors", { ignore: true });
    const loaded = new Promise((resolveLoaded) => cdp!.on("Page.loadEventFired", resolveLoaded));
    await cdp.send("Page.navigate", { url: `${pageOrigin}/` });
    await loaded;
    expect(await evaluate<boolean>("window.__netReady === true")).toBe(true);
  });

  afterAll(() => {
    cdp?.close();
    proc?.kill();
    httpServer?.stop(true);
    foreignServer?.stop(true);
    httpsServer?.stop(true);
    if (validationRoot) rmSync(validationRoot, { recursive: true, force: true });
  });

  test("follows a same-origin 302 and applies browser POST rewriting", async () => {
    const result = await probe("/same-start", "POST", [1, 2]);
    expect(result).toMatchObject({
      event: { t: "done", status: 200, url: `${pageOrigin}/same-final` },
      text: "same target",
    });
    expect(requests.filter((entry) => entry.path.startsWith("/same"))).toEqual([
      { server: "main", path: "/same-start", method: "POST" },
      { server: "main", path: "/same-final", method: "GET" },
    ]);
  });

  test("lets Chrome follow multiple hops and reports the final URL", async () => {
    const result = await probe("/multi-0");
    expect(result).toMatchObject({
      event: { t: "done", status: 200, url: `${pageOrigin}/multi-final` },
      text: "multi target",
    });
    expect(requests.filter((entry) => entry.path.startsWith("/multi")).map((entry) => entry.path)).toEqual([
      "/multi-0", "/multi-1", "/multi-2", "/multi-3", "/multi-4", "/multi-final",
    ]);
  });

  test("rejects a scheme-changing final URL", async () => {
    expect(await probe("/cross-scheme")).toMatchObject({
      event: { t: "error", code: "redirect", message: "redirect_scheme" },
      text: null,
    });
    expect(requests.filter((entry) => entry.server === "secure")).toEqual([
      { server: "secure", path: "/secure-final", method: "GET" },
    ]);
  });

  test("rejects a final URL at another origin", async () => {
    expect(await probe("/cross-origin")).toMatchObject({
      event: { t: "error", code: "redirect", message: "redirect_origin" },
      text: null,
    });
    expect(requests.filter((entry) => entry.server === "foreign")).toEqual([
      { server: "foreign", path: "/foreign-final", method: "GET" },
    ]);
  });
});
