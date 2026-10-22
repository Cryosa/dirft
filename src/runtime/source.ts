import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { HotPayload, ViteDevServer } from "vite";
import type { ModuleRunnerTransport } from "vite/module-runner";
import { NodeProcess } from "./child";
import { ModuleCache, moduleKey, type RuntimeModule } from "./modules";
import type { LaunchOptions } from "./child";
import { canonical, inside } from "../vite/config";

function fingerprint(file: string): string | undefined {
  try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch { return undefined; }
}

export class SourceRuntime {
  private process: NodeProcess;
  private loaded = new Map<string, string | undefined>();
  private fingerprints = new Map<string, string | undefined>();
  private cache: ModuleCache;
  private modules = new Set<string>();
  private warmQueue: string[] = [];
  private warmed = new Set<string>();
  private warming = new Set<Promise<void>>();
  private child: ChildProcess | undefined;
  private timer: NodeJS.Timeout | undefined;
  private failed = false;
  private closed = false;

  constructor(private server: ViteDevServer, options: LaunchOptions, private lazy: boolean, private debounce: number, private events: ModuleRunnerTransport) {
    if (!server.environments.ssr) throw new Error("dirft requires Vite's ssr dev environment");
    const cacheDir = resolve(server.config.cacheDir, "dirft");
    this.cache = new ModuleCache(server.environments.ssr);
    this.process = new NodeProcess({ ...options, cacheDir: resolve(cacheDir, "node") }, child => this.connect(child), code => { if (code !== 0) this.failed = true; });
    server.watcher.on("all", this.onFile);
    events.connect?.({ onMessage: this.onHot, onDisconnection() {} });
    this.process.start();
  }

  private track(file: unknown): void {
    if (typeof file !== "string" || !isAbsolute(file) || inside(this.server.config.cacheDir, file)) return;
    const path = canonical(file);
    if (this.loaded.has(path)) return;
    if (!this.fingerprints.has(path)) this.fingerprints.set(path, fingerprint(path));
    this.loaded.set(path, this.fingerprints.get(path));
  }

  private warm(deps: string[] = []): void {
    if (this.closed) return;
    for (const id of deps) {
      if (!id.startsWith("/") || this.warmed.has(id)) continue;
      this.warmed.add(id);
      this.warmQueue.push(id);
    }
    const environment = this.server.environments.ssr!;
    while (this.warming.size < 8 && this.warmQueue.length) {
      const id = this.warmQueue.shift()!;
      const task = environment.transformRequest(id).then(result => this.warm(result?.deps)).catch(() => {}).finally(() => {
        this.warming.delete(task);
        this.warm();
      });
      this.warming.add(task);
    }
  }

  private connect(child: ChildProcess): void {
    this.child = child;
    this.loaded.clear();
    this.modules.clear();
    this.failed = false;
    child.on("message", async (message: unknown) => {
      const request = message as { type?: string; id?: number; key?: string; data?: HotPayload } | null;
      if (this.child !== child) return;
      if (request?.type === "dirft:init") {
        const modules = this.cache.seed();
        if (child.connected) child.send({ type: "dirft:seed", modules }, () => {});
        return;
      }
      if (request?.type === "dirft:loaded" && request.key) {
        const cached = this.cache.get(request.key);
        if (cached) {
          this.track(cached.module.file);
          if (cached.module.id) this.modules.add(cached.module.id);
          if (!cached.valid) this.schedule();
        }
        return;
      }
      if (request?.type !== "dirft:invoke" || typeof request.id !== "number" || !request.data) return;
      let value: { result: unknown } | { error: unknown };
      try {
        const call = request.data as { data?: { name?: string; data?: unknown[] } };
        const args = call.data?.name === "fetchModule" ? call.data.data : undefined;
        value = await this.server.environments.ssr!.hot.handleInvoke(request.data);
        if (this.closed || this.child !== child) return;
        if ("result" in value) {
          const module = value.result as RuntimeModule | null;
          if (module) this.warm(this.cache.prepare(moduleKey(args?.[0], args?.[1]), module));
          this.track(module?.file);
          if (module?.id) this.modules.add(module.id);
        }
        else {
          const error = value.error as { id?: string; watchFiles?: string[] } | null;
          this.track(error?.id);
          for (const file of error?.watchFiles ?? []) this.track(file);
          this.failed = true;
        }
      } catch (error) {
        const detail = error instanceof Error ? error : new Error(String(error));
        value = { error: { message: detail.message, stack: detail.stack } };
        this.failed = true;
      }
      if (child.connected) child.send({ type: "dirft:reply", id: request.id, value }, () => {});
    });
  }

  private invalidateSeed(): void {
    if (this.child?.connected) this.child.send({ type: "dirft:invalidate" }, () => {});
  }

  private onHot = (payload: HotPayload): void => {
    if (this.closed || payload.type !== "full-reload") return;
    this.invalidateSeed();
    if (!payload.triggeredBy) { this.schedule(); return; }
    const file = canonical(payload.triggeredBy);
    if (this.loaded.has(file)) return; // The file watcher already compares its contents.
    if (this.dependsOn(payload.triggeredBy.replaceAll("\\", "/"))) this.schedule();
  };

  private dependsOn(file: string): boolean {
    const pending = [...this.server.environments.ssr!.moduleGraph.getModulesByFile(file) ?? []];
    const seen = new Set();
    for (const module of pending) {
      if (seen.has(module)) continue;
      seen.add(module);
      if (module.id && this.modules.has(module.id)) return true;
      // Only watched resources propagate to importers. Source modules from
      // earlier processes may remain analyzed without being executed here.
      if (module.id && (module.isSelfAccepting === undefined || this.cache.isSource(module.id))) continue;
      pending.push(...module.importers);
    }
    return false;
  }

  private onFile = (event: string, file: string): void => {
    if (this.closed || !["add", "change", "unlink"].includes(event)) return;
    const path = canonical(file);
    this.fingerprints.delete(path);
    if (inside(this.server.config.cacheDir, path) || path.split("/").includes("node_modules") || inside(resolve(this.server.config.root, this.server.config.build.outDir), path)) return;
    this.invalidateSeed();
    const tracked = this.loaded.has(path);
    const vitePath = file.replaceAll("\\", "/");
    if (!tracked && this.lazy && !this.failed && !this.dependsOn(vitePath)) return;
    if (tracked && fingerprint(path) === this.loaded.get(path)) return;
    const graph = this.server.environments.ssr!.moduleGraph;
    if (this.failed) graph.invalidateAll();
    else graph.onFileChange(vitePath);
    this.schedule();
  };

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      console.error("[dirft] Vite dependency changed; restarting");
      void this.process.restart();
    }, this.debounce);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.warmQueue.length = 0;
    if (this.timer) clearTimeout(this.timer);
    this.server.watcher.off("all", this.onFile);
    await this.events.disconnect?.();
    await this.process.close();
    this.child = undefined;
    await Promise.allSettled(this.warming);
  }
}
