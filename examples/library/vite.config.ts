import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import dirft from "dirft";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => ({
  root,
  plugins: [dirft({
    external: ["electron", "ws", "express"],
    restart: mode === "development" ? { entry: "napcat" } : false,
    lazy: true,
    args: ["--demo"],
  })],
  resolve: { alias: { "@/napcat-core": fileURLToPath(new URL("./core", import.meta.url)) } },
  build: {
    target: "node22", minify: false,
    lib: {
      entry: {
        napcat: fileURLToPath(new URL("./src/napcat.ts", import.meta.url)),
        "worker/conoutSocketWorker": fileURLToPath(new URL("./src/worker.ts", import.meta.url)),
      },
      formats: ["es"],
      fileName: (_, name) => `${name}.mjs`,
    },
  },
}));
