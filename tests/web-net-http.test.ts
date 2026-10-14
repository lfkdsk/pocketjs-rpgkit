import { describe, expect, test } from "bun:test";
// The vendored browser transport intentionally remains plain JavaScript.
// @ts-expect-error no declaration file for the browser-only host module
import { createNetHost } from "../vendor/pocketjs/hosts/web/net.js";
// The browser player intentionally remains plain JavaScript.
// @ts-expect-error no declaration file for the browser-only host module
import { mountHttpHost } from "../tools/web/player.js";
import { playerHostCapabilities } from "../tools/web.ts";

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

  test("uses no credentials and bounds manual same-scheme redirects", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const host = createNetHost(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: { location: "/final" } });
      }
      return new Response(new Uint8Array([7]), { status: 200, headers: { "x-result": "ok" } });
    }) as Host;
    const handle = host.ns.start(meta({ method: "POST" }), new Uint8Array([1, 2]).buffer as ArrayBuffer);
    const events = await admitted(host);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ t: "done", h: handle, status: 200, bytes: 1 });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.example.test/start",
      "https://api.example.test/final",
    ]);
    expect(calls[0]!.init).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
    });
    expect(calls[1]!.init).toMatchObject({
      method: "GET",
      body: undefined,
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
    });

    let redirects = 0;
    const limited = createNetHost(async (_url: string, init: RequestInit) => {
      redirects++;
      expect(init.credentials).toBe("omit");
      return new Response(null, { status: 307, headers: { location: `/hop-${redirects}` } });
    }) as Host;
    const limitedHandle = limited.ns.start(meta(), empty());
    expect(await admitted(limited)).toEqual([{
      t: "error",
      h: limitedHandle,
      code: "redirect",
      message: "redirect_limit",
    }]);
    expect(redirects).toBe(4);
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
