// studio-desktop/src/helper-client.ts — the main process's side of the helper
// (helper.ts): one child process, started on first use, that runs local
// agents, rpgkit-check's engine checks and RPG Maker imports. It is a Bun
// program (compiled to one executable for the app), because those tools are
// shared with the kit's command-line tools.
//
// The child gets a fixed argv, no shell and an allowlisted environment, plus a
// random token made fresh for every launch: the first line on its stdin must
// carry that token or it exits. Requests and replies are JSON lines.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { HELPER_PROTOCOL_VERSION, HELPER_TOKEN_ENV, parseHelperLine } from "./helper-protocol.ts";

/** What the helper may inherit; everything else (credentials, proxies,
 * NODE_OPTIONS, ELECTRON_*) stays behind. The agent launcher narrows it
 * again for the agent process (LOCAL_AGENT_ENV_ALLOWLIST). */
const HELPER_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL",
  "TMPDIR", "TMP", "TEMP",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
  "TERM", "COLORTERM", "NO_COLOR", "TZ",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "TRAE_HOME", "CLAUDE_CONFIG_DIR",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "SYSTEMROOT", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
];

export interface HelperCommand {
  command: string;
  args: string[];
}

export type HelperReply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

export interface HelperEvent {
  event: string;
  [key: string]: unknown;
}

/** The compiled helper if the app has one, else `bun helper.ts` for a
 * development checkout. Returns null when neither exists. */
export function locateHelper(candidates: readonly string[], source: string): HelperCommand | null {
  for (const path of candidates) if (existsSync(path)) return { command: path, args: ["serve"] };
  if (existsSync(source)) return { command: "bun", args: [source, "serve"] };
  return null;
}

interface Pending {
  resolve(reply: HelperReply): void;
}

export class HelperClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private listeners = new Set<(event: HelperEvent) => void>();
  /** Last lines the helper wrote to stderr, for error messages. */
  private stderr: string[] = [];

  constructor(private readonly command: HelperCommand | null) {}

  get available(): boolean {
    return this.command !== null;
  }

  onEvent(listener: (event: HelperEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const command = this.command;
    if (!command) return Promise.reject(new Error("the Studio helper is missing from this build"));
    const token = randomBytes(32).toString("hex");
    const env: Record<string, string> = {};
    for (const key of HELPER_ENV) if (process.env[key] !== undefined) env[key] = process.env[key]!;
    env[HELPER_TOKEN_ENV] = token;
    const child = spawn(command.command, command.args, { env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    this.child = child;
    this.buffer = "";
    this.ready = new Promise<void>((resolve, reject) => {
      let greeted = false;
      const fail = (message: string) => {
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
        const detail = this.stderr.slice(-3).join(" ").trim();
        const error = new Error(`${message}${detail ? `: ${detail}` : ""}`);
        if (!greeted) reject(error);
        for (const [id, pending] of this.pending) {
          this.pending.delete(id);
          pending.resolve({ ok: false, error: { code: "FAILED", message: error.message } });
        }
      };
      child.on("error", (error) => fail(`could not start the Studio helper (${error.message})`));
      child.on("exit", (code, signal) => fail(`the Studio helper stopped (${signal ?? `exit ${code}`})`));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.stderr.push(...chunk.split("\n").filter(Boolean));
        if (this.stderr.length > 20) this.stderr.splice(0, this.stderr.length - 20);
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        this.buffer += chunk;
        let newline: number;
        while ((newline = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          const message = parseHelperLine(line);
          if (!message) continue;
          if (!greeted) {
            if (message.hello === "ok") {
              if (message.version !== HELPER_PROTOCOL_VERSION) {
                child.kill("SIGKILL");
                fail(`the Studio helper uses protocol ${String(message.version)}; this app needs ${HELPER_PROTOCOL_VERSION}`);
                continue;
              }
              greeted = true;
              resolve();
            }
            continue;
          }
          this.receive(message);
        }
      });
      child.stdin.write(`${JSON.stringify({ hello: token })}\n`);
    });
    return this.ready;
  }

  private receive(message: Record<string, unknown>): void {
    if (typeof message.event === "string") {
      for (const listener of this.listeners) listener(message as HelperEvent);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.resolve(message.ok === true
      ? { ok: true, result: message.result }
      : { ok: false, error: { code: String((message.error as { code?: unknown })?.code ?? "FAILED"), message: String((message.error as { message?: unknown })?.message ?? "the helper reported an error") } });
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs = 0): Promise<HelperReply> {
    try {
      await this.start();
    } catch (error) {
      return { ok: false, error: { code: "UNAVAILABLE", message: error instanceof Error ? error.message : String(error) } };
    }
    const id = ++this.seq;
    return new Promise<HelperReply>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.pending.set(id, {
        resolve: (reply) => {
          if (timer) clearTimeout(timer);
          resolve(reply);
        },
      });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          resolve({ ok: false, error: { code: "TIMED_OUT", message: `the helper did not answer ${method} within ${Math.round(timeoutMs / 1000)} s` } });
        }, timeoutMs);
      }
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** Close stdin (the helper cancels its work and exits), then make sure. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.ready = null;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
