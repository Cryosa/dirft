import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import dirft from "../dist/index.js";
import { nodeExternal } from "../dist/vite/external.js";
import { project } from "./helpers/project.mjs";
import { runtime } from "./helpers/runtime.mjs";
import { engines } from "./helpers/vite.mjs";

test("external rules always include Node builtins and preserve existing callback context and regex state", () => {
  const context = {};
  const existing = function (id, importer, resolved) {
    assert.equal(this, context);
    assert.equal(importer, "entry.ts");
    assert.equal(resolved, false);
    return id === "existing";
  };
  const regex = /^native-/g;
  regex.lastIndex = 3;
  const external = nodeExternal(existing, ["express", regex]);
  for (const id of ["fs", "node:fs", "fs/promises", "node:sqlite", "node:future_builtin", "express", "express/router", "native-addon"]) {
    assert.equal(external.call(context, id, "entry.ts", false), true, id);
  }
  assert.equal(regex.lastIndex, 3);
  assert.equal(external.call(context, "existing", "entry.ts", false), true);
  assert.equal(external.call(context, "express-other", "entry.ts", false), false);
});

for (const engine of engines) {
  test(`${engine.name}: NapCat-style library entries keep builtins and user dependencies external, with native aliases and plugins`, async t => {
    const { root, write } = project(t);
    write("packages/core/index.ts", "export const value: string = 'workspace-alias';");
    write("src/napcat.ts", `import {basename} from 'path'; import {readFile} from 'node:fs/promises';
      import {token} from 'express/router'; import {value} from '@/napcat-core';
      import {extra} from 'existing-keep';
      export {readFile}; export const answer: string = basename('/'+value)+':'+token+':'+extra;`);
    write("src/worker.ts", "export {isMainThread} from 'worker_threads';");
    write("node_modules/express/package.json", JSON.stringify({ type: "module", exports: { "./router": "./router.js" } }));
    write("node_modules/express/router.js", "export const token='external-express';");
    write("node_modules/existing-keep/package.json", JSON.stringify({ type: "module", exports: "./index.js" }));
    write("node_modules/existing-keep/index.js", "export const extra='existing-rule';");
    for (const mode of ["array", "function"]) {
      const result = await engine.build({
        configFile: false, root, logLevel: "silent",
        resolve: { alias: { "@/napcat-core": join(root, "packages/core/index.ts") } },
        plugins: [dirft({ external: ["express", "electron"], restart: false, lazy: true }), {
          name: "fixture:asset",
          generateBundle() { this.emitFile({ type: "asset", fileName: "plugin-kept.txt", source: "copied" }); },
        }],
        build: {
          outDir: `dist-${mode}`, target: "node22", minify: false,
          lib: { entry: { napcat: join(root, "src/napcat.ts"), "worker/conoutSocketWorker": join(root, "src/worker.ts") },
            formats: ["es", "cjs"], fileName: (format, name) => `${name}.${format === "cjs" ? "cjs" : "mjs"}` },
          rollupOptions: { external: mode === "array" ? [/^existing-/] : id => id === "existing-keep" },
        },
      });
      assert.ok(result);
      const code = readFileSync(join(root, `dist-${mode}/napcat.mjs`), "utf8");
      assert.match(code, /["'](?:node:)?path["']/);
      assert.match(code, /["']node:fs\/promises["']/);
      assert.match(code, /["']express\/router["']/);
      assert.match(code, /["']existing-keep["']/);
      assert.doesNotMatch(code, /__vite-browser-external|external-express|existing-rule|@\/napcat-core/);
      const library = await import(pathToFileURL(join(root, `dist-${mode}/napcat.mjs`)).href);
      assert.equal(library.answer, "workspace-alias:external-express:existing-rule");
      assert.equal(library.readFile, (await import("node:fs/promises")).readFile);
      const commonjs = await import(pathToFileURL(join(root, `dist-${mode}/napcat.cjs`)).href);
      assert.equal(commonjs.answer, library.answer);
      assert.equal(readFileSync(join(root, `dist-${mode}/plugin-kept.txt`), "utf8"), "copied");
      assert.ok(existsSync(join(root, `dist-${mode}/worker/conoutSocketWorker.mjs`)));
      assert.ok(existsSync(join(root, `dist-${mode}/worker/conoutSocketWorker.cjs`)));
    }
  });

  test(`${engine.name}: lazy build watch starts source before bundling completes`, { timeout: 20000 }, async t => {
    const app = await runtime(t, engine, { watch: true, slowBuild: true });
    assert.equal(app.records("built").length, 0);
    assert.equal((await app.request()).label, "plugin-initial");
    await app.wait(() => app.records("built").length >= 1);
    app.write("core/value.ts", "export const value: number = 2;");
    await app.wait(() => app.records("app").length === 2);
    assert.equal((await app.request()).value, 2);
    app.write("tsconfig.json", JSON.stringify({ extends: "./base.json", compilerOptions: { target: "ES2022", module: "ESNext", useDefineForClassFields: true } }));
    await app.wait(() => app.records("app").length === 3);
    await app.stop();
  });

  test(`${engine.name}: lazy false restarts completed bundles and retains the old process after build errors`, { timeout: 25000 }, async t => {
    const app = await runtime(t, engine, { watch: true, lazy: false });
    await app.wait(() => app.records("built").length > 0);
    assert.equal(app.records("app").length, 1, "multiple output formats must start only one main process");
    assert.equal((await app.request()).label, "plugin-initial");
    const pid = (await app.request()).pid;
    const builds = app.records("built").length;
    app.write("core/value.ts", "export const value: = ;");
    await app.wait(() => app.records("build-error").length > 0 && app.records("built").length > builds);
    assert.equal((await app.request()).pid, pid);
    app.write("core/value.ts", "export const value: number = 2;");
    await app.wait(() => app.records("app").length === 2);
    assert.equal((await app.request()).value, 2);
    assert.notEqual((await app.request()).pid, pid);
  });
}
