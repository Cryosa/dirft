import "./control";
import { dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { isBuiltin } from "node:module";
import { moduleKey, type RuntimeModule } from "./modules";
import type { ModuleRunnerContext, ModuleRunnerTransport } from "vite/module-runner";

const runtime = process.env.DIRFT_MODULE_RUNNER!;
const bundled = process.env.DIRFT_BUNDLE_ENTRY;
const preload = process.env.DIRFT_PRELOAD === "1";
const bundleMeta = bundled ? { url: pathToFileURL(bundled).href, filename: bundled, dirname: dirname(bundled), main: true } : undefined;
delete process.env.DIRFT_MODULE_RUNNER;
delete process.env.DIRFT_BUNDLE_ENTRY;
delete process.env.DIRFT_PRELOAD;
const entry = process.argv[2]!;
process.argv.splice(1, 1);
if (bundled) process.argv[1] = bundled;

type Reply = { result: unknown } | { error: unknown };
let sequence = 0;
const pending = new Map<number, { resolve(value: Reply): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
const seeded = new Map<string, RuntimeModule>();
let initialized: (() => void) | undefined;
const initialization = preload ? new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Vite startup snapshot timed out")), 30_000);
  initialized = () => { clearTimeout(timer); resolve(); };
}) : Promise.resolve();

process.on("message", (message: unknown) => {
  const seed = message as { type?: string; modules?: Array<[string, RuntimeModule]> } | null;
  if (seed?.type === "dirft:seed") {
    for (const [id, module] of seed.modules ?? []) seeded.set(id, module);
    initialized?.();
    return;
  }
  if (seed?.type === "dirft:invalidate") { seeded.clear(); return; }
  const response = message as { type?: string; id?: number; value?: Reply } | null;
  if (response?.type !== "dirft:reply" || typeof response.id !== "number" || !response.value) return;
  const task = pending.get(response.id);
  if (!task) return;
  pending.delete(response.id);
  clearTimeout(task.timer);
  task.resolve(response.value);
});
process.once("disconnect", () => {
  for (const task of pending.values()) {
    clearTimeout(task.timer);
    task.reject(new Error("Vite server disconnected"));
  }
  pending.clear();
});

const transport: ModuleRunnerTransport = {
  invoke(data) {
    const call = data as { data?: { name?: string; data?: unknown[] } };
    if (call.data?.name === "fetchModule") {
      const [id, importer, options] = call.data.data ?? [];
      if (typeof id === "string") {
        if (isBuiltin(id) || id.startsWith("node:")) return Promise.resolve({ result: { externalize: id, type: "builtin" } });
        if ((options as { cached?: boolean } | undefined)?.cached && (id.startsWith("/") || isAbsolute(id) || id.startsWith("file:"))) {
          return Promise.resolve({ result: { cache: true } });
        }
        const key = moduleKey(id, importer)!;
        const module = seeded.get(key);
        if (module) {
          process.send?.({ type: "dirft:loaded", key });
          return Promise.resolve({ result: module });
        }
      }
    }
    return new Promise<Reply>((resolve, reject) => {
      if (!process.connected) { reject(new Error("Vite server disconnected")); return; }
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Vite module request timed out")); }, 30_000);
      pending.set(id, { resolve, reject, timer });
      process.send?.({ type: "dirft:invoke", id, data }, error => {
        if (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    });
  },
};

if (preload) process.send?.({ type: "dirft:init" });
const { ModuleRunner, ESModulesEvaluator, ssrImportMetaKey } = await import(runtime) as typeof import("vite/module-runner");
await initialization;
class BundleEvaluator extends ESModulesEvaluator {
  override async runInlinedModule(context: ModuleRunnerContext, code: string): Promise<void> {
    const meta = context[ssrImportMetaKey];
    if (bundleMeta && isAbsolute(meta.filename)) {
      Object.assign(meta, bundleMeta);
    }
    return super.runInlinedModule(context, code);
  }
}
const runner = new ModuleRunner({ transport, hmr: false, sourcemapInterceptor: false }, new BundleEvaluator());
try { await runner.import(entry); }
catch (error) { console.error(error); process.exit(1); }
process.channel?.unref();
