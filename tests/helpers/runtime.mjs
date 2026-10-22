import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { project, workspace } from "./project.mjs";

export async function runtime(t, engine, options = {}) {
  let stop;
  t.after(async () => { await stop?.(); });
  const { root, write } = project(t);
  write("base.json", JSON.stringify({ compilerOptions: { jsx: "react-jsx", useDefineForClassFields: false } }));
  write("tsconfig.json", JSON.stringify({ extends: "./base.json", compilerOptions: { module: "ESNext", target: "ES2022" } }));
  if (options.noConfig) unlinkSync(join(root, "tsconfig.json"));
  write("core/value.ts", "export const value: number = 1;");
  write("src/unused.ts", "const invalid: = ;");
  write("src/lazy.ts", "export const lazy: number = 1;");
  write("src/message.txt", "raw-initial");
  write("plugin-data.txt", "plugin-initial");
  write("src/main.tsx", options.entry ?? `
    import {createServer} from 'node:http';
    import fs from 'fs'; import nodeFs from 'node:fs';
    import {renderToStaticMarkup} from 'react-dom/server';
    import {value} from '@/core/value';
    import {label} from 'virtual:settings';
    import raw from './message.txt?raw';
    class Example { field!: string; }
    const server=createServer(async(request,response)=>{
      try {
        const lazy=request.url==='/lazy'?(await import('./lazy')).lazy:undefined;
        response.setHeader('Content-Type','application/json');
        response.end(JSON.stringify({value,label,raw,lazy,own:Object.hasOwn(new Example(),'field'),
          sameBuiltin:fs===nodeFs,html:renderToStaticMarkup(<strong>{value}</strong>),pid:process.pid}));
      } catch(error) {response.writeHead(500).end(String(error));}
    });
    server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({type:'app',port:server.address().port,pid:process.pid})));
    process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
  `);
  write("src/worker.ts", "export {isMainThread} from 'node:worker_threads';");
  for (const [file, contents] of Object.entries(options.files ?? {})) write(file, contents);
  write("guard.mjs", `import {registerHooks} from 'node:module';
    registerHooks({resolve(id,context,next){
      if(/(^|[/\\\\])typescript([/\\\\]|$)/i.test(id))throw new Error('FORBIDDEN_TYPESCRIPT_COMPILER');
      return next(id,context);
    }});`);
  write("harness.mjs", `
    import {readFileSync} from 'node:fs';
    import {createServer,build} from ${JSON.stringify(engine.url)};
    import dirft from ${JSON.stringify(pathToFileURL(join(workspace, "dist/index.js")).href)};
    const config={configFile:false,root:${JSON.stringify(root)},logLevel:'silent',
      cacheDir:'custom-vite-cache',
      resolve:{alias:{'@/core':${JSON.stringify(join(root, "core"))}}},
      plugins:[{name:'fixture:native-map',enforce:'pre',async configureServer(server){
        if(${JSON.stringify(options.referenceMap)}){
          const fixture=await server.ssrLoadModule(${JSON.stringify(options.referenceMap)});
          try{fixture.fail();}catch(error){console.log(JSON.stringify({type:'reference-map',stack:error.stack}));}
        }
      }},dirft({external:['react','react-dom'],restart:{entry:'main'},
        lazy:${options.lazy ?? true},bundled:${JSON.stringify(options.bundled)},sourcemap:${JSON.stringify(options.sourcemap)}}),{
        name:'fixture:settings',
        async buildStart(){
          if(${!!options.slowBuild} && this.environment.mode==='build')await new Promise(done=>setTimeout(done,700));
        },
        resolveId(id){if(id==='virtual:settings')return '\\0virtual:settings';},
        load(id){if(id==='\\0virtual:settings'){
          const file=${JSON.stringify(join(root, "plugin-data.txt"))};
          this.addWatchFile(file);
          return 'export const label='+JSON.stringify(readFileSync(file,'utf8'));
        }},
      }],
      // Let failed writes leave Chokidar's throttle window before the repair.
      build:{target:'node22',minify:false,sourcemap:${!!options.sourcemap},watch:${options.watch ? "{buildDelay:100}" : "null"},
        lib:{entry:{main:${JSON.stringify(join(root, "src/main.tsx"))},worker:${JSON.stringify(join(root, "src/worker.ts"))}},
          formats:['es','cjs'],fileName:(format,name)=>name+(format==='cjs'?'.cjs':'.mjs')}},
      server:{host:'127.0.0.1',port:0},
    };
    let owner;
    if(${!!options.watch}){
      owner=await build(config);
      owner.on('event',event=>{
        if(event.code==='END')console.log(JSON.stringify({type:'built'}));
        if(event.code==='ERROR')console.log(JSON.stringify({type:'build-error',message:event.error?.message}));
      });
    }else{owner=await createServer(config);await owner.listen();}
    console.log(JSON.stringify({type:'owner',cacheDir:owner.config?.cacheDir}));
    process.on('message',async message=>{
      if(message.type==='stop'){await owner.close();process.disconnect();}
      if(message.type==='exit')process.exit(0);
      if(message.type==='restart'){await owner.restart();console.log(JSON.stringify({type:'restarted'}));}
    });
  `);
  let output = "", errors = "";
  const child = spawn(process.execPath, [...(options.nodeArgs ?? []), "--import", pathToFileURL(join(root, "guard.mjs")).href, join(root, "harness.mjs")], {
    cwd: workspace, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { errors += data; });
  child.on("error", error => { errors += error.stack; });
  const records = type => output.split(/\r?\n/).flatMap(line => {
    try { const value = JSON.parse(line); return value.type === type ? [value] : []; } catch { return []; }
  });
  const wait = async predicate => {
    const until = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > until || child.exitCode !== null) assert.fail(`Vite runtime failed\n${output}\n${errors}`);
      await delay(20);
    }
  };
  stop = async () => {
    if (child.exitCode !== null) return;
    if (child.connected) child.send({ type: "stop" });
    try { await wait(() => child.exitCode !== null); }
    catch (error) { child.kill("SIGKILL"); throw error; }
    assert.equal(child.exitCode, 0, errors);
    assert.doesNotMatch(errors, /FORBIDDEN_TYPESCRIPT_COMPILER/);
  };
  await wait(() => records("app").length > 0 && records("owner").length > 0);
  return { root, write, records, wait, stop,
    send: type => child.send({ type }),
    errors: () => errors,
    url: () => `http://127.0.0.1:${records("app").at(-1).port}`,
    request: async (path = "/") => {
      const response = await fetch(`http://127.0.0.1:${records("app").at(-1).port}${path}`, { signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    },
    assertViteCache() {
      assert.equal(records("owner")[0].cacheDir.replaceAll("\\", "/"), join(root, "custom-vite-cache").replaceAll("\\", "/"));
      assert.equal(existsSync(join(root, ".dirft")), false);
    },
  };
}
