// tools/lib/cdp.ts — a minimal Chrome DevTools Protocol client and a
// headless Chrome launcher, shared by the browser verification scripts.

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

export async function launchChrome(
  chrome: string,
  profile: string,
  windowSize = "1440,1000",
): Promise<{ proc: ReturnType<typeof Bun.spawn>; ws: string }> {
  const proc = Bun.spawn(
    [
      chrome, "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=0",
      `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-component-update", "--hide-scrollbars",
      `--window-size=${windowSize}`, "--force-device-scale-factor=1", "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
    if (match) {
      reader.releaseLock();
      const port = new URL(match[1]!).port;
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
      // Prefer the blank tab Chrome was started with: newer headless Chrome
      // also lists internal pages, and navigating one of those never
      // answers. Without a blank tab, open a fresh one.
      let page = targets.find((t) => t.type === "page" && t.url === "about:blank");
      if (!page) {
        const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
        if (created.ok) page = await created.json();
      }
      if (!page?.webSocketDebuggerUrl) throw new Error("Chrome started without a page target");
      return { proc, ws: page.webSocketDebuggerUrl };
    }
  }
  proc.kill();
  throw new Error(`Chrome did not start: ${text.slice(-2000)}`);
}
