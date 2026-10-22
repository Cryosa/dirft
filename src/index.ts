import { resolve } from "node:path";
import type { Plugin, ResolvedConfig, UserConfig, ViteDevServer } from "vite";
import { nodeExternal } from "./vite/external";
import { canonical, entryFile, firstFormat, hostVite, withoutDirft } from "./vite/config";
import { NodeProcess } from "./runtime/child";
import { SourceRuntime } from "./runtime/source";
import type { LaunchOptions } from "./runtime/child";
import type { DirftOptions } from "../types";

export function dirft(options: DirftOptions = {}): Plugin {
  const restart = options.restart ?? !!options.entry;
  const lazy = options.lazy ?? true;
  const delay = typeof restart === "object" ? restart.debounce ?? 60 : 60;
  if (!Number.isInteger(delay) || delay < 0 || delay > 60_000) throw new Error("dirft restart.debounce must be an integer between 0 and 60000 milliseconds");

  let config: ResolvedConfig;
  let userConfig: UserConfig;
  let launch: LaunchOptions;
  let source: SourceRuntime | undefined;
  let sourceEnvironment: unknown;
  let bundle: NodeProcess | undefined;
  let ownedHost: ViteDevServer | undefined;
  let output: string | undefined;
  let failed = false;

  const startSource = async (server: ViteDevServer): Promise<void> => {
    await source?.close();
    const vite = hostVite(server.config);
    const { createServerModuleRunnerTransport } = await import(vite.node) as typeof import("vite");
    const events = createServerModuleRunnerTransport({ channel: server.environments.ssr!.hot });
    source = new SourceRuntime(server, { ...launch, runner: vite.runner }, lazy, delay, events);
    sourceEnvironment = server.environments.ssr;
  };
  const close = async (): Promise<void> => {
    await source?.close();
    await bundle?.close();
    source = undefined;
    bundle = undefined;
    await ownedHost?.close();
    ownedHost = undefined;
  };
  return {
    name: "dirft:node", enforce: "pre",
    config(value) { userConfig = value; },
    options(input) { return { ...input, external: nodeExternal(input.external, options.external) }; },
    configResolved(value) {
      config = value;
      const entry = entryFile(config, (typeof restart === "object" && restart.entry) || options.entry);
      if (restart && !entry) throw new Error("dirft restart requires entry or Vite build.lib.entry/input");
      launch = { entry: entry ?? config.root, cwd: resolve(config.root, options.cwd ?? "."), args: options.args ?? [], env: options.env,
        sourcemap: options.sourcemap,
        bundled: options.bundled ? resolve(config.root, options.bundled) : undefined };
    },
    async configureServer(server) { if (restart) await startSource(server); },
    async buildStart() {
      failed = false;
      output = undefined;
      if (config.command !== "build" || !config.build.watch || !restart || !lazy || source) return;
      const { createServer } = await import(hostVite(config).node) as typeof import("vite");
      ownedHost = await createServer({
        ...userConfig, configFile: false, root: config.root, cacheDir: config.cacheDir,
        plugins: await withoutDirft(userConfig.plugins ?? []),
        server: { ...userConfig.server, middlewareMode: true, hmr: false },
        optimizeDeps: { noDiscovery: true, include: [] },
        appType: "custom",
      });
      await startSource(ownedHost);
    },
    buildEnd(error) { failed = !!error; },
    writeBundle(outputOptions, files) {
      if (!restart || lazy || !config.build.watch || output) return;
      const normalize = (format?: string): string => format === "esm" || format === "module" ? "es" : format === "commonjs" ? "cjs" : format ?? "es";
      if (normalize(outputOptions.format) !== normalize(firstFormat(config))) return;
      const entry = Object.values(files).find(file => file.type === "chunk" && file.isEntry && file.facadeModuleId && canonical(file.facadeModuleId) === canonical(launch.entry));
      if (entry) output = outputOptions.file ? resolve(outputOptions.file) : resolve(outputOptions.dir ?? resolve(config.root, config.build.outDir), entry.fileName);
    },
    async closeBundle() {
      if (config.command === "serve") {
        if (this.environment === sourceEnvironment) { await source?.close(); source = undefined; }
        return;
      }
      if (!restart || lazy || !config.build.watch || failed || !output) return;
      const file = output;
      if (!bundle) { bundle = new NodeProcess({ ...launch, entry: file }); bundle.start(); }
      else { await bundle.close(); bundle = new NodeProcess({ ...launch, entry: file }); bundle.start(); }
    },
    closeWatcher: close,
  };
}

export default dirft;
export type { DirftOptions, RestartOptions, ExternalOption } from "../types";
