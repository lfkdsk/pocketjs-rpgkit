// tools/lib/cdp.ts launchChrome: readiness is polled from the DevTools port,
// slow launches get their full budget, failed launches are retried with a
// fresh profile, and a launch that never comes up fails with every attempt's
// stderr and timing instead of hanging or losing the evidence. Fake Chrome
// scripts stand in for the slow and broken cases; the success paths hand
// over to the real browser when one is installed.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROME_START_BUDGET_MS, CHROME_START_TIMEOUT_MS, Cdp, launchChrome } from "../tools/lib/cdp.ts";

const CHROME = Bun.which("google-chrome") ?? Bun.which("chromium") ?? "/usr/bin/google-chrome";
const HAVE_CHROME = existsSync(CHROME);
const ROOT = mkdtempSync(join(tmpdir(), "pocket-rpgkit-cdp-launch-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const DBUS = "ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address";

/** Write an executable stand-in for Chrome. `body` runs with "$@" as the
 *  Chrome arguments and $PROFILE as the --user-data-dir value. */
function fakeChrome(name: string, body: string): string {
  const path = join(ROOT, name);
  writeFileSync(path, `#!/bin/sh
for arg in "$@"; do case "$arg" in --user-data-dir=*) PROFILE="\${arg#--user-data-dir=}";; esac; done
echo "$$" >> "${join(ROOT, `${name}.pids`)}"
${body}
`);
  chmodSync(path, 0o755);
  return path;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const pids = (name: string) =>
  readFileSync(join(ROOT, `${name}.pids`), "utf8").trim().split("\n").map(Number);

describe("launchChrome", () => {
  test("the default budget covers every attempt with room to reap them", () => {
    expect(CHROME_START_TIMEOUT_MS).toBeGreaterThan(20_000);
    expect(CHROME_START_BUDGET_MS).toBeGreaterThan(CHROME_START_TIMEOUT_MS * 2);
  });

  test("a launch that never opens DevTools is killed, retried, and reported in full", async () => {
    const chrome = fakeChrome("silent", `echo "[1:2:0101/000000.000:${DBUS}" >&2
echo "profile $PROFILE" >&2
exec sleep 600`);
    const profile = mkdtempSync(join(ROOT, "silent-"));
    const started = Date.now();
    const error = await launchChrome(chrome, profile, "800,600", { startTimeoutMs: 700, attempts: 2 })
      .then(() => null, (e: Error) => e);
    const elapsed = Date.now() - started;
    expect(error).toBeInstanceOf(Error);
    const message = error!.message;
    expect(message).toStartWith("Chrome did not start: 2 attempt(s) failed in ");
    // Each attempt names its profile, how it ended, how long it waited, and
    // keeps the stderr it printed.
    expect(message).toMatch(new RegExp(`attempt 1 \\(--user-data-dir=${profile}\\): no DevTools endpoint after \\d+\\.\\d s; killed`));
    expect(message).toMatch(new RegExp(`attempt 2 \\(--user-data-dir=${profile}/retry-2\\): no DevTools endpoint after \\d+\\.\\d s; killed`));
    expect(message.split(DBUS)).toHaveLength(3);
    expect(message).toContain(`profile ${profile}\n`);
    expect(message).toContain(`profile ${join(profile, "retry-2")}\n`);
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(10_000);
    // Both stand-ins were killed, not left behind.
    expect(pids("silent")).toHaveLength(2);
    for (const pid of pids("silent")) expect(alive(pid)).toBe(false);
  }, 20_000);

  test("a launch that exits is reported with its exit code without waiting out the budget", async () => {
    const chrome = fakeChrome("crash", `echo "cannot open display" >&2
exit 3`);
    const profile = mkdtempSync(join(ROOT, "crash-"));
    const started = Date.now();
    const error = await launchChrome(chrome, profile, "800,600", { startTimeoutMs: 20_000, attempts: 3 })
      .then(() => null, (e: Error) => e);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(error!.message).toStartWith("Chrome did not start: 3 attempt(s) failed in ");
    expect(error!.message).toContain("attempt 3 (");
    expect(error!.message).toContain("Chrome exited (code 3, signal none) after ");
    expect(error!.message.split("cannot open display")).toHaveLength(4);
  }, 20_000);

  test.skipIf(!HAVE_CHROME)("a launch that prints noise before DevTools is waited for", async () => {
    // What a cold CI runner looks like, compressed: dbus noise for a while,
    // then DevTools.
    const chrome = fakeChrome("slow", `echo "[1:2:0101/000000.000:${DBUS}" >&2
sleep 1.5
echo "[1:2:0101/000001.500:${DBUS}" >&2
exec "${CHROME}" "$@"`);
    const profile = mkdtempSync(join(ROOT, "slow-"));
    const { proc, ws } = await launchChrome(chrome, profile, "800,600", { startTimeoutMs: 20_000, attempts: 1 });
    try {
      const cdp = await Cdp.connect(ws);
      const result = await cdp.send("Runtime.evaluate", { expression: "1 + 2", returnByValue: true });
      expect(result.result.value).toBe(3);
      cdp.close();
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 30_000);

  test.skipIf(!HAVE_CHROME)("a failed first attempt is retried with a fresh profile and the browser comes up", async () => {
    const chrome = fakeChrome("flaky", `case "$PROFILE" in
  */retry-2) exec "${CHROME}" "$@";;
  *) echo "first launch wedged" >&2; exec sleep 600;;
esac`);
    const profile = mkdtempSync(join(ROOT, "flaky-"));
    const { proc, ws } = await launchChrome(chrome, profile, "800,600", { startTimeoutMs: 5_000, attempts: 2 });
    try {
      expect(ws).toStartWith("ws://127.0.0.1:");
      expect(existsSync(join(profile, "retry-2", "DevToolsActivePort"))).toBe(true);
      const [first] = pids("flaky");
      expect(alive(first!)).toBe(false);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 30_000);
});

describe("launchChrome readiness", () => {
  const PAGE = { type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/fake" };
  /** A stand-in DevTools HTTP endpoint. */
  function devtools(list: (request: Request) => Response | Promise<Response>) {
    return Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: list });
  }
  const servers: ReturnType<typeof devtools>[] = [];
  afterAll(() => { for (const server of servers) server.stop(true); });
  const serve = (list: (request: Request) => Response | Promise<Response>) => {
    const server = devtools(list);
    servers.push(server);
    return server.port!;
  };
  const writePort = (port: number) => `printf '%s\\n/devtools/browser/fake\\n' ${port} > "$PROFILE/DevToolsActivePort"`;

  test("the port Chrome writes to DevToolsActivePort is enough, without a stderr line", async () => {
    const port = serve(() => Response.json([PAGE]));
    const chrome = fakeChrome("portfile", `${writePort(port)}
exec sleep 600`);
    const { proc, ws } = await launchChrome(chrome, mkdtempSync(join(ROOT, "portfile-")), "800,600", { startTimeoutMs: 5_000, attempts: 1 });
    expect(ws).toBe(PAGE.webSocketDebuggerUrl);
    proc.kill("SIGKILL");
    await proc.exited;
  }, 20_000);

  test("a port file left in a reused profile is not trusted", async () => {
    const stale = serve(() => Response.json([{ ...PAGE, webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/stale" }]));
    const port = serve(() => Response.json([PAGE]));
    const profile = mkdtempSync(join(ROOT, "stale-"));
    writeFileSync(join(profile, "DevToolsActivePort"), `${stale}\n/devtools/browser/stale\n`);
    const chrome = fakeChrome("stale", `sleep 0.3
${writePort(port)}
exec sleep 600`);
    const { proc, ws } = await launchChrome(chrome, profile, "800,600", { startTimeoutMs: 5_000, attempts: 1 });
    expect(ws).toBe(PAGE.webSocketDebuggerUrl);
    proc.kill("SIGKILL");
    await proc.exited;
  }, 20_000);

  test("an endpoint that never answers cannot hold the attempt past its deadline", async () => {
    const port = serve(() => new Promise<Response>(() => {}));
    const chrome = fakeChrome("hung", `${writePort(port)}
exec sleep 600`);
    const started = Date.now();
    const error = await launchChrome(chrome, mkdtempSync(join(ROOT, "hung-")), "800,600", { startTimeoutMs: 800, attempts: 1 })
      .then(() => null, (e: Error) => e);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(error!.message).toMatch(/no DevTools endpoint after \d+\.\d s; killed; last DevTools probe on port \d+: /);
  }, 20_000);

  test("an endpoint without a page target is reported as such", async () => {
    const port = serve((request) => new URL(request.url).pathname === "/json/list"
      ? Response.json([{ type: "service_worker", url: "chrome://x" }])
      : new Response("no", { status: 500 }));
    const chrome = fakeChrome("nopage", `${writePort(port)}
exec sleep 600`);
    const error = await launchChrome(chrome, mkdtempSync(join(ROOT, "nopage-")), "800,600", { startTimeoutMs: 600, attempts: 1 })
      .then(() => null, (e: Error) => e);
    expect(error!.message).toMatch(/DevTools answered without a page target after \d+\.\d s; killed; last DevTools probe on port \d+: Chrome started without a page target/);
  }, 20_000);

  test("a failed attempt takes the browser's children down with it", async () => {
    const childPid = join(ROOT, "tree.child");
    const chrome = fakeChrome("tree", `sleep 600 &
echo $! > "${childPid}"
exec sleep 600`);
    await launchChrome(chrome, mkdtempSync(join(ROOT, "tree-")), "800,600", { startTimeoutMs: 500, attempts: 1 })
      .then(() => null, (e: Error) => e);
    const child = Number(readFileSync(childPid, "utf8"));
    expect(child).toBeGreaterThan(0);
    for (let i = 0; i < 50 && alive(child); i++) await Bun.sleep(20);
    expect(alive(child)).toBe(false);
  }, 20_000);
});
