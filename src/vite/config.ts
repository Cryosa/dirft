import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ResolvedConfig, PluginOption } from "vite";

export function entryFile(config: ResolvedConfig, requested?: string): string | undefined {
  const inputs = (config.build.lib && config.build.lib.entry) || config.build.rolldownOptions?.input || config.build.rollupOptions?.input || config.input;
  const source = requested && inputs && !Array.isArray(inputs) && typeof inputs === "object" && requested in inputs ? inputs[requested]
    : requested ?? (typeof inputs === "string" ? inputs : Array.isArray(inputs) ? inputs[0] : inputs ? Object.values(inputs)[0] : undefined);
  return source ? resolve(config.root, source) : undefined;
}

export function firstFormat(config: ResolvedConfig): string {
  const outputs = config.build.rolldownOptions?.output ?? config.build.rollupOptions?.output;
  const output = Array.isArray(outputs) ? outputs[0] : outputs;
  return (output?.format ?? (config.build.lib && config.build.lib.formats?.[0])) || "es";
}

export const canonical = (file: string): string => {
  const path = resolve(file).replaceAll("\\", "/");
  return process.platform === "win32" ? path.toLowerCase() : path;
};

export function inside(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return !path || (!path.startsWith("..") && !isAbsolute(path));
}

export function hostVite(config: ResolvedConfig): { node: string; runner: string } {
  const client = config.resolve.alias.find(alias => alias.replacement.endsWith("/vite/dist/client/client.mjs"))?.replacement.replace(/^\/@fs\//, "");
  // Vite's /@fs/ prefix replaces the leading POSIX slash, but keeps Windows drives.
  const clientPath = client && (isAbsolute(client) ? client : `/${client}`);
  const require = createRequire(pathToFileURL(clientPath || resolve(config.root, "package.json")));
  return { node: pathToFileURL(require.resolve("vite")).href, runner: pathToFileURL(require.resolve("vite/module-runner")).href };
}

export async function withoutDirft(options: PluginOption[]): Promise<PluginOption[]> {
  const result: PluginOption[] = [];
  for (const option of options) {
    const plugin = await option;
    if (Array.isArray(plugin)) result.push(...await withoutDirft(plugin));
    else if (plugin && plugin.name !== "dirft:node") result.push(plugin);
  }
  return result;
}
