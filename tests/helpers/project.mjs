import assert from "node:assert/strict";
import { after } from "node:test";
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const workspace = fileURLToPath(new URL("../..", import.meta.url));
const temporary = join(workspace, ".test-tmp");

export function project(t) {
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, "case-"));
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  write("package.json", JSON.stringify({ type: "module" }));
  write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "ESNext", target: "ES2022", jsx: "react-jsx" } }));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(temporary));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, write };
}

after(() => {
  try { rmdirSync(temporary); } catch { /* Other test processes may still be running. */ }
});
