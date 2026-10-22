import { existsSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
for (const path of [
  "dist", ".test-tmp",
  "node_modules/.vite", "node_modules/.vite-temp", "node_modules/.compat",
  "examples/library/dist", "examples/library/node_modules/.vite", "examples/library/node_modules/.vite-temp",
]) {
  const target = resolve(root, path);
  const location = relative(root, existsSync(target) ? realpathSync(target) : target);
  if (!location || location.startsWith("..") || isAbsolute(location)) throw new Error(`Cleanup escaped workspace: ${target}`);
  rmSync(target, { recursive: true, force: true });
}
