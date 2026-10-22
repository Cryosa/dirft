import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface LaunchOptions {
  entry: string;
  cwd: string;
  args: string[];
  env?: Record<string, string | undefined>;
  runner?: string;
  bundled?: string;
  cacheDir?: string;
  sourcemap?: boolean;
}

export class NodeProcess {
  private child: ChildProcess | undefined;
  private task: Promise<void> | undefined;
  private closing = false;
  private pending = false;

  constructor(private options: LaunchOptions, private onStart?: (child: ChildProcess) => void, private onExit?: (code: number | null) => void) {}

  start(): void {
    if (this.closing) return;
    const { entry, cwd, args, env, runner, bundled, cacheDir, sourcemap } = this.options;
    const runtime = fileURLToPath(new URL("./runner.js", import.meta.url));
    const control = new URL("./control.js", import.meta.url).href;
    const child = spawn(process.execPath, [
      ...process.execArgv.filter(arg => !arg.startsWith("--input-type=")),
      ...(sourcemap ? ["--enable-source-maps"] : []),
      ...(runner ? [runtime, entry] : ["--import", control, entry]), ...args,
    ], {
      cwd, stdio: ["inherit", "inherit", "inherit", "ipc"], serialization: "advanced",
      env: { ...process.env, ...env, ...(cacheDir && !(env?.NODE_COMPILE_CACHE ?? process.env.NODE_COMPILE_CACHE) ? { NODE_COMPILE_CACHE: cacheDir } : {}),
        ...(runner ? { DIRFT_MODULE_RUNNER: runner, DIRFT_BUNDLE_ENTRY: bundled, DIRFT_PRELOAD: "1" } : {}) },
    });
    this.child = child;
    this.onStart?.(child);
    child.on("error", error => console.error(`[dirft] ${error.message}`));
    child.once("close", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (!this.closing) {
        console.error(`[dirft] application exited (${signal ?? code}); waiting for changes`);
        this.onExit?.(code);
      }
    });
  }

  restart(): Promise<void> {
    if (this.closing) return this.task ?? Promise.resolve();
    this.pending = true;
    if (!this.task) this.task = this.replace().finally(() => { this.task = undefined; });
    return this.task;
  }

  private async replace(): Promise<void> {
    while (this.pending && !this.closing) {
      this.pending = false;
      const child = this.child;
      this.child = undefined;
      await this.stop(child);
      this.start();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.pending = false;
    const child = this.child;
    this.child = undefined;
    await Promise.all([this.stop(child), this.task]);
  }

  private stop(child: ChildProcess | undefined): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(done => {
      const force = setTimeout(() => { child.kill("SIGKILL"); }, 1000);
      child.once("close", () => { clearTimeout(force); done(); });
      if (child.connected) child.send({ type: "dirft:stop" }, error => { if (error) child.kill("SIGTERM"); });
      else child.kill("SIGTERM");
    });
  }
}
