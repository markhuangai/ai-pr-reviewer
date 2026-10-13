import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { isRecord } from "./agent-logging.js";

export const CODEX_TARGETS: Readonly<Record<string, string>> = {
  "linux/x64": "x86_64-unknown-linux-musl",
  "linux/arm64": "aarch64-unknown-linux-musl",
  "darwin/x64": "x86_64-apple-darwin",
  "darwin/arm64": "aarch64-apple-darwin",
  "win32/x64": "x86_64-pc-windows-msvc",
  "win32/arm64": "aarch64-pc-windows-msvc",
};

export function codexExecutable(
  os: string = process.platform,
  cpu: string = process.arch,
  resolvePackage: (id: string) => string = createRequire(import.meta.url).resolve,
): string {
  const target = CODEX_TARGETS[os + "/" + cpu];
  if (target === undefined) throw new Error("Unsupported Codex platform: " + os + "/" + cpu);
  const root = dirname(resolvePackage("@openai/codex-" + os + "-" + cpu + "/package.json"));
  return join(root, "vendor", target, "bin", os === "win32" ? "codex.exe" : "codex");
}

export type CodexConfigValue =
  | string
  | number
  | boolean
  | readonly CodexConfigValue[]
  | { readonly [key: string]: CodexConfigValue };

function configSegment(value: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(value) ? value : JSON.stringify(value);
}

export function codexConfigArgs(
  config: Readonly<Record<string, CodexConfigValue>>,
  prefix = "",
): string[] {
  return Object.entries(config).flatMap(([key, value]) => {
    const path = prefix + configSegment(key);
    return typeof value === "object" && !Array.isArray(value)
      ? codexConfigArgs(value as Record<string, CodexConfigValue>, path + ".")
      : ["-c", path + "=" + JSON.stringify(value)];
  });
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private notifications: Promise<void> = Promise.resolve();
  private stderr = "";
  private stopped = false;
  private closing = false;
  private readonly exited: Promise<void>;

  constructor(
    executable: string,
    config: Readonly<Record<string, CodexConfigValue>>,
    cwd: string,
    env: NodeJS.ProcessEnv,
    private readonly notify: (method: string, params: Record<string, unknown>) => Promise<void>,
    private readonly failure: (error: Error) => void,
  ) {
    this.child = spawn(
      executable,
      [...codexConfigArgs(config), "app-server", "--listen", "stdio://"],
      {
        cwd,
        env,
        stdio: "pipe",
        windowsHide: true,
      },
    );
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (data: string) => {
      this.stderr = (this.stderr + data).slice(-4_096);
    });
    this.child.on("error", (error) => {
      this.fail(error);
    });
    this.child.stdin.on("error", (error) => {
      if (!this.closing) this.fail(error);
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      this.receive(line);
    });
    lines.on("close", () => {
      if (!this.closing) this.fail(new Error("Codex app-server closed stdout before shutdown."));
    });
    this.exited = new Promise<void>((resolve) => {
      this.child.once("close", (code, signal) => {
        if (!this.closing) {
          this.fail(
            new Error("Codex app-server exited: " + String(code ?? signal) + ". " + this.stderr),
          );
        }
        resolve();
      });
    });
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.failure(error);
  }

  private receive(line: string): void {
    if (this.stopped) return;
    try {
      if (Buffer.byteLength(line) > 4 * 1024 * 1024) {
        throw new Error("Codex app-server message exceeds the bounded protocol size.");
      }
      const message: unknown = JSON.parse(line);
      if (!isRecord(message)) throw new Error("Codex app-server emitted a non-object message.");
      if (typeof message.method === "string") {
        if (message.id !== undefined) {
          this.write({
            id: message.id,
            error: { code: -32601, message: "Client action is disabled." },
          });
          throw new Error("Codex requested a disabled client action: " + message.method);
        }
        if (!isRecord(message.params))
          throw new Error("Codex notification has invalid parameters.");
        const method = message.method;
        const params = message.params;
        this.notifications = this.notifications.then(() => this.notify(method, params));
        void this.notifications.catch((error: unknown) => {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        });
        return;
      }
      if (typeof message.id !== "number")
        throw new Error("Codex response has no numeric request ID.");
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (isRecord(message.error)) {
        pending.reject(
          new Error(
            typeof message.error.message === "string" ? message.error.message : "Codex RPC failed.",
          ),
        );
      } else if ("result" in message) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error("Codex RPC response has neither a result nor an error."));
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private write(message: unknown): void {
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.stopped || this.closing)
      return Promise.reject(new Error("Codex app-server is closed."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex RPC timed out: " + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notification(method: string): void {
    this.write({ method });
  }

  async drain(): Promise<void> {
    await this.notifications;
  }

  async close(): Promise<void> {
    if (this.closing) return this.exited;
    this.closing = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Codex app-server was shut down."));
    }
    this.pending.clear();
    this.child.stdin.end();
    const terminate = setTimeout(() => this.child.kill("SIGTERM"), 250);
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 1_000);
    try {
      await this.exited;
      await this.notifications;
    } finally {
      clearTimeout(terminate);
      clearTimeout(kill);
    }
  }
}
