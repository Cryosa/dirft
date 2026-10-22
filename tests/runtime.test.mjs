import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { engines } from "./helpers/vite.mjs";
import { runtime } from "./helpers/runtime.mjs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

for (const engine of engines) {
  test(`${engine.name}: source maps default off and support options and native Node flags`, async t => {
    for (const [options, enabled] of [
      [{}, false],
      [{sourcemap:true}, true],
      [{watch:true,lazy:false,sourcemap:true}, true],
      [{nodeArgs:["--enable-source-maps"]}, true],
    ]) {
      const app = await runtime(t, engine, { ...options, entry: `
        import {createServer} from 'node:http';
        import {findSourceMap} from 'node:module';
        import {fileURLToPath} from 'node:url';
        const server=createServer((request,response)=>response.end(JSON.stringify({
          enabled:process.sourceMapsEnabled,registered:!!findSourceMap(fileURLToPath(import.meta.url))
        })));
        server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({type:'app',port:server.address().port})));
        process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
      ` });
      assert.deepEqual(await app.request(), { enabled, registered: enabled }, JSON.stringify(options));
      await app.stop();
    }
  });

  test(`${engine.name}: Vite evaluator preserves cycles, live bindings and fresh process state`, async t => {
    const app = await runtime(t, engine, {
      files: {
        "src/a.ts": `import {readB} from './b';
          (globalThis.trace??=[]).push('a');
          let value: number = 1;
          export function read(){return value;}
          export function increment(){value++;}
          export {readB};`,
        "src/b.ts": `import {read} from './a';
          (globalThis.trace??=[]).push('b');
          export function readB(){return read();}`,
        "src/restart.ts": "export const marker: number = 1;",
      },
      entry: `
        import {createServer} from 'node:http';
        import {readB,increment} from './a';
        import './restart';
        await Promise.resolve();
        globalThis.trace.push('entry');
        const server=createServer((request,response)=>{
          if(request.url==='/increment')increment();
          response.end(JSON.stringify({value:readB(),trace:globalThis.trace,pid:process.pid}));
        });
        server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({type:'app',port:server.address().port})));
        process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
      `,
    });
    const initial = await app.request();
    assert.equal(initial.value, 1);
    assert.deepEqual(initial.trace, ["b", "a", "entry"]);
    assert.equal((await app.request("/increment")).value, 2);
    app.write("src/restart.ts", "export const marker: number = 2;");
    await app.wait(() => app.records("app").length === 2);
    const restarted = await app.request();
    assert.notEqual(restarted.pid, initial.pid);
    assert.equal(restarted.value, 1);
    assert.deepEqual(restarted.trace, initial.trace);
    await app.stop();
  });

  test(`${engine.name}: Node owns source maps before errors and follows native Vite behavior`, async t => {
    const app = await runtime(t, engine, {
      nodeArgs: ["--enable-source-maps"],
      bundled: "dist/napcat.mjs",
      referenceMap: "/src/failure space 中文.ts",
      files: {
        "src/failure中文.ts": 'export function fail(): never {\n  const message: string = "映射错误";\n  throw new Error(message);\n}\n',
        "src/failure space 中文.ts": 'export function fail(): never {\n  const message: string = "映射错误";\n  throw new Error(message);\n}\n',
        "src/restart.ts": "export const marker: number = 1;",
      },
      entry: `
        import {createServer} from 'node:http';
        import {findSourceMap} from 'node:module';
        import {fileURLToPath} from 'node:url';
        import {fail} from './failure中文';
        import {fail as spacedFail} from './failure space 中文';
        import './restart';
        const server=createServer((request,response)=>{
          if(request.url==='/map'){
            const file=fileURLToPath(new URL('../src/failure中文.ts',import.meta.url));
            response.end(JSON.stringify({enabled:process.sourceMapsEnabled,registered:!!findSourceMap(file)}));return;
          }
          try {(request.url==='/space'?spacedFail:fail)();} catch(error) {response.end(JSON.stringify({stack:error.stack}));}
        });
        server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({type:'app',port:server.address().port})));
        process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
      `,
    });
    assert.deepEqual(await app.request("/map"), { enabled: true, registered: true }, "Node registers maps before an error occurs");
    assert.match((await app.request()).stack, /failure中文\.ts:3:\d+/);
    const spaced = /failure space 中文\.ts:3:\d+/;
    assert.equal(spaced.test((await app.request("/space")).stack), spaced.test(app.records("reference-map")[0].stack),
      "filename handling must match the same Vite host without dirft adaptations");
    app.write("src/restart.ts", "export const marker: number = 2;");
    await app.wait(() => app.records("app").length === 2);
    assert.equal((await app.request("/map")).registered, true);
    assert.match((await app.request()).stack, /failure中文\.ts:3:\d+/);
    app.write("src/failure中文.ts", 'export function fail(): never {\n\n\n  const message: string = "映射已更新";\n  throw new Error(message);\n}\n');
    await app.wait(() => app.records("app").length === 3);
    assert.match((await app.request()).stack, /failure中文\.ts:5:\d+/);
    assert.equal(existsSync(join(app.root, "custom-vite-cache/dirft/maps")), false);
  });

  test(`${engine.name}: runs without tsconfig and simulates flat bundle metadata`, async t => {
    const app = await runtime(t, engine, { noConfig: true, bundled: 'dist/napcat.mjs',
      files: { 'core/meta.ts': "export const meta: Record<string,string>={url:import.meta.url,filename:import.meta.filename,dirname:import.meta.dirname};" },
      entry: `
        import {createServer} from 'node:http';
        import {meta as helperMeta} from '@/core/meta';
        const server=createServer((request,response)=>response.end(JSON.stringify({meta:helperMeta,url:import.meta.url,argv:process.argv[1]})));
        server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({type:'app',port:server.address().port})));
        process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
      ` });
    const value = await app.request();
    const file = join(app.root, 'dist/napcat.mjs');
    assert.equal(value.url, pathToFileURL(file).href);
    assert.deepEqual(value.meta, {url:value.url,filename:file,dirname:join(app.root,'dist')});
    assert.equal(value.argv, file);
    app.assertViteCache();
  });

  test(`${engine.name}: completed scripts still watch only executed dependencies`, async t => {
    const app = await runtime(t, engine, { entry: `
      import {value} from '@/core/value';
      console.log(JSON.stringify({type:'app',value,pid:process.pid}));
    ` });
    await app.wait(() => /application exited \(0\)/.test(app.errors()));
    app.write("src/unused.ts", "const stillInvalid: = ;");
    await delay(200);
    assert.equal(app.records("app").length, 1);
    app.write("core/value.ts", "export const value: number = 2;");
    await app.wait(() => app.records("app").length === 2);
    assert.equal(app.records("app").at(-1).value, 2);
  });

  test(`${engine.name}: shares Vite aliases, JSX/tsconfig, virtual modules, raw imports and cache`, { timeout: 20000 }, async t => {
    const app = await runtime(t, engine);
    const first = await app.request();
    assert.equal(first.value, 1);
    assert.equal(first.label, "plugin-initial");
    assert.equal(first.raw, "raw-initial");
    assert.equal(first.own, false);
    assert.equal(first.sameBuiltin, true);
    assert.equal(first.html, "<strong>1</strong>");
    app.assertViteCache();

    app.write("src/unused.ts", "const stillInvalid: = ;");
    app.write("src/lazy.ts", "export const lazy: = ;");
    await delay(200);
    assert.equal(app.records("app").length, 1);
    app.write("src/lazy.ts", "export const lazy: number = 2;");
    assert.equal((await app.request("/lazy")).lazy, 2);
    // Separate edits beyond Chokidar's change-event throttle window.
    await delay(150);
    app.write("src/lazy.ts", "export const lazy: number = 3;");
    await app.wait(() => app.records("app").length === 2);
    assert.equal((await app.request("/lazy")).lazy, 3);

    app.write("src/message.txt", "raw-changed");
    await app.wait(() => app.records("app").length === 3);
    assert.equal((await app.request()).raw, "raw-changed");

    app.write("plugin-data.txt", "plugin-changed");
    await app.wait(() => app.records("app").length === 4);
    assert.equal((await app.request()).label, "plugin-changed");

    app.write("tsconfig.json", JSON.stringify({ extends: "./base.json", compilerOptions: { module: "ESNext", target: "ES2022", useDefineForClassFields: true } }));
    await app.wait(() => app.records("app").length === 5);
    assert.equal((await app.request()).own, true);
    assert.notEqual((await app.request()).pid, first.pid);
    app.write("src/lazy.ts", "export const lazy: number = 4;");
    await delay(200);
    assert.equal(app.records("app").length, 5, "a snapshot must not mark an unused dynamic import as executed");
    assert.equal((await app.request("/lazy")).lazy, 4, "an unused snapshot must be invalidated before its first import");
  });

  test(`${engine.name}: recovers source errors and missing imports without a second compiler`, { timeout: 20000 }, async t => {
    const app = await runtime(t, engine);
    app.write("core/value.ts", "export const value: = ;");
    await app.wait(() => /application exited/.test(app.errors()));
    app.write("core/value.ts", "export const value: number = 2;");
    await app.wait(() => app.records("app").length === 2);
    assert.equal((await app.request()).value, 2);

    const count = (app.errors().match(/application exited/g) ?? []).length;
    app.write("core/value.ts", "export {value} from './created';");
    await app.wait(() => (app.errors().match(/application exited/g) ?? []).length > count);
    app.write("core/created.ts", "export const value: number = 3;");
    await app.wait(() => app.records("app").length === 3);
    assert.equal((await app.request()).value, 3);
  });
}

test("lazy false in serve follows source changes observed by Vite", { timeout: 15000 }, async t => {
  const app = await runtime(t, engines[0], { lazy: false });
  app.write("src/unused.ts", "export const unused = 2;");
  await app.wait(() => app.records("app").length === 2);
  assert.equal((await app.request()).value, 1);
});

test("Vite config restart and close release the previous Node listener", { timeout: 15000 }, async t => {
  const app = await runtime(t, engines[0]);
  const previous = app.url();
  app.send("restart");
  await app.wait(() => app.records("restarted").length === 1 && app.records("app").length === 2);
  await assert.rejects(fetch(previous));
  assert.equal((await app.request()).value, 1);
  const current = app.url();
  await app.stop();
  await assert.rejects(fetch(current));
});

test("parent exit releases the Node application", { timeout: 15000 }, async t => {
  const app = await runtime(t, engines[0]);
  const address = app.url();
  app.send("exit");
  let stopped = false;
  for (let attempt = 0; attempt < 100 && !stopped; attempt++) {
    try { await fetch(address, { signal: AbortSignal.timeout(200) }); }
    catch (error) { stopped = error.cause?.code === "ECONNREFUSED"; }
    if (!stopped) await delay(20);
  }
  assert.equal(stopped, true);
});
