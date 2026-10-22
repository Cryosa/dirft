import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
await build({
  configFile: false, root,
  build: {
    ssr: true, target: "node22", minify: false, sourcemap: true,
    emptyOutDir: true,
    lib: {
      entry: { index: "src/index.ts", "runtime/runner": "src/runtime/runner.ts", "runtime/control": "src/runtime/control.ts" },
      formats: ["es"],
    },
    rolldownOptions: {
      output: { preserveModules: true, preserveModulesRoot: "src", entryFileNames: "[name].js" },
    },
  },
});
