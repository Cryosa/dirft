import type { DevEnvironment } from "vite";

export interface RuntimeModule {
  id?: string;
  file?: string | null;
  code?: string;
  url?: string;
  invalidate?: boolean;
}

export function moduleKey(id: unknown, importer: unknown): string | undefined {
  return typeof id === "string" ? JSON.stringify([id, importer]) : undefined;
}
interface Snapshot {
  module: RuntimeModule;
  transformed: object;
  invalidated: number;
}

export class ModuleCache {
  private cached = new Map<string, Snapshot>();
  private sources = new Set<string>();

  constructor(private environment: DevEnvironment) {}

  prepare(key: unknown, module: RuntimeModule): string[] {
    if (module.id && typeof module.code === "string") this.sources.add(module.id);
    const graph = module.id ? this.environment.moduleGraph.getModuleById(module.id) : undefined;
    if (graph && typeof key === "string" && typeof module.code === "string" && graph.transformResult) {
      this.cached.set(key, { module: { ...module, invalidate: false }, transformed: graph.transformResult, invalidated: graph.lastInvalidationTimestamp });
      if (this.cached.size > 4096) this.cached.delete(this.cached.keys().next().value!);
    }
    return graph?.transformResult?.deps ?? [];
  }

  seed(): Array<[string, RuntimeModule]> {
    return [...this.cached].filter(([, cached]) => this.valid(cached)).map(([id, cached]) => [id, cached.module]);
  }

  isSource(id: string): boolean { return this.sources.has(id); }

  get(key: string): { module: RuntimeModule; valid: boolean } | undefined {
    const cached = this.cached.get(key);
    return cached && { module: cached.module, valid: this.valid(cached) };
  }

  private valid(cached: Snapshot): boolean {
    const graph = cached.module.id ? this.environment.moduleGraph.getModuleById(cached.module.id) : undefined;
    return !!graph && graph.transformResult === cached.transformed && graph.lastInvalidationTimestamp === cached.invalidated;
  }
}
