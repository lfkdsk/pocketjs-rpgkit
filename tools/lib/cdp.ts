// tools/lib/cdp.ts — a minimal Chrome DevTools Protocol client and a
// headless Chrome launcher, shared by the browser verification scripts.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, ((params: any) => void)[]>();
  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(`${message.error.message} (${message.error.code})`));
        else waiter?.resolve(message.result);
      } else {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      }
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method: string, listener: (params: any) => void): void {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }
  close(): void {
    this.ws.close();
  }
}

/** How long one Chrome launch may take to open its DevTools endpoint. The
 *  first launch on a fresh CI runner has been seen to take over 20 s before
 *  printing anything (warm launches take well under 2 s). */
export const CHROME_START_TIMEOUT_MS = 30_000;
/** Launches tried, each with a fresh profile, before giving up. */
export const CHROME_START_ATTEMPTS = 3;
/** The longest launchChrome can take before it throws, plus the time it
 *  needs to kill and reap each attempt. Callers size their own timeouts
 *  from this. */
export const CHROME_START_BUDGET_MS = CHROME_START_TIMEOUT_MS * CHROME_START_ATTEMPTS + 5_000;

export interface LaunchChromeOptions {
  /** Per-attempt limit; defaults to CHROME_START_TIMEOUT_MS. */
  startTimeoutMs?: number;
  /** Number of launches; defaults to CHROME_START_ATTEMPTS. */
  attempts?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Launch headless Chrome and return a page target's DevTools URL.
 *
 *  Readiness is polled: Chrome writes the port it bound to into
 *  `DevToolsActivePort` in its profile, and the launch is ready once that
 *  port answers /json/list. A launch that exits, or that is not ready within
 *  `startTimeoutMs`, is killed and retried with a fresh profile (the first
 *  attempt uses `profile` itself, retries use subdirectories of it so the
 *  caller's cleanup removes them too). When every attempt fails, the error
 *  carries each attempt's full stderr, how it ended and how long it took. */
export async function launchChrome(
  chrome: string,
  profile: string,
  windowSize = "1440,1000",
  options: LaunchChromeOptions = {},
): Promise<{ proc: ReturnType<typeof Bun.spawn>; ws: string }> {
  const startTimeoutMs = options.startTimeoutMs ?? CHROME_START_TIMEOUT_MS;
  const attempts = options.attempts ?? CHROME_START_ATTEMPTS;
  const started = Date.now();
  const reports: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const dir = attempt === 1 ? profile : join(profile, `retry-${attempt}`);
    mkdirSync(dir, { recursive: true });
    // A port file left by an earlier browser in a reused profile would
    // point the readiness probe at the wrong port.
    rmSync(join(dir, "DevToolsActivePort"), { force: true });
    const result = await launchOnce(chrome, dir, windowSize, startTimeoutMs);
    if ("ws" in result) return result;
    reports.push(`attempt ${attempt} (--user-data-dir=${dir}): ${result.failure}\n` +
      `--- stderr ---\n${result.stderr || "(empty)"}\n--- end stderr ---`);
    if (attempt < attempts) {
      console.error(`Chrome launch attempt ${attempt} of ${attempts} failed (${result.failure}); retrying with a fresh profile`);
    }
  }
  throw new Error(`Chrome did not start: ${attempts} attempt(s) failed in ${seconds(Date.now() - started)}\n${reports.join("\n")}`);
}

async function launchOnce(
  chrome: string,
  dir: string,
  windowSize: string,
  startTimeoutMs: number,
): Promise<{ proc: ReturnType<typeof Bun.spawn>; ws: string } | { failure: string; stderr: string }> {
  const started = Date.now();
  const proc = Bun.spawn(
    [
      chrome, "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=0",
      `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-component-update", "--hide-scrollbars",
      `--window-size=${windowSize}`, "--force-device-scale-factor=1", "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  // Collect stderr in the background so the poll below never blocks on a
  // read; the text is kept until the browser is ready.
  let stderr = "";
  let ready = false;
  const decoder = new TextDecoder();
  const reader = proc.stderr.getReader();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!ready) stderr += decoder.decode(value, { stream: true });
      }
      if (!ready) stderr += decoder.decode();
    } catch {
      // the pipe closes when Chrome is killed
    }
  })();
  let exited = false;
  void proc.exited.then(() => { exited = true; });
  const deadline = started + startTimeoutMs;
  let lastProbe = "";
  let answered = false;
  while (Date.now() < deadline && !exited) {
    const port = devToolsPort(dir, stderr);
    if (port) {
      try {
        const ws = await pageTarget(port, Math.max(1, deadline - Date.now()), () => { answered = true; });
        ready = true;
        return { proc, ws };
      } catch (error) {
        lastProbe = `; last DevTools probe on port ${port}: ${(error as Error).message}`;
      }
    }
    await sleep(100);
  }
  const waited = Date.now() - started;
  let failure: string;
  if (exited) {
    failure = `Chrome exited (code ${proc.exitCode}, signal ${proc.signalCode ?? "none"}) after ${seconds(waited)}`;
  } else {
    // Take the children (zygote, crashpad) down too: one left behind keeps
    // writing into the profile the caller is about to delete.
    killTree(proc.pid);
    failure = `${answered ? "DevTools answered without a page target" : "no DevTools endpoint"} after ${seconds(waited)}; killed`;
  }
  await proc.exited;
  // Give the drain a moment to collect what Chrome wrote before it died.
  await sleep(50);
  return { failure: failure + lastProbe, stderr };
}

/** The DevTools port Chrome has bound, or 0 while it has not. */
function devToolsPort(dir: string, stderr: string): number {
  try {
    const port = Number(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]);
    if (port > 0) return port;
  } catch {
    // not written yet
  }
  const match = /DevTools listening on ws:\/\/[^:/\s]+:(\d+)\//.exec(stderr);
  return match ? Number(match[1]) : 0;
}

/** SIGKILL `pid` and every descendant, children first found while their
 *  parent still holds them. */
function killTree(pid: number): void {
  let children: string[] = [];
  try {
    children = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split(/\s+/);
  } catch {
    // pgrep exits 1 when there are no children
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  for (const child of children) if (child) killTree(Number(child));
}

async function pageTarget(port: number, timeoutMs: number, onAnswer: () => void): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal })).json()) as any[];
  onAnswer();
  // Prefer the blank tab Chrome was started with: newer headless Chrome
  // also lists internal pages, and navigating one of those never
  // answers. Without a blank tab, open a fresh one.
  let page = targets.find((t) => t.type === "page" && t.url === "about:blank");
  if (!page) {
    const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT", signal });
    if (created.ok) page = await created.json();
  }
  if (!page?.webSocketDebuggerUrl) throw new Error("Chrome started without a page target");
  return page.webSocketDebuggerUrl;
}
