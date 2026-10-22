import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const urls = [new URL("../../node_modules/vite/dist/node/index.js", import.meta.url).href];
if (process.env.DIRFT_TEST_VITE) urls.push(pathToFileURL(resolve(process.env.DIRFT_TEST_VITE)).href);
export const engines = await Promise.all(urls.map(async url => {
  const api = await import(url);
  return { name: `Vite ${api.version}`, url, ...api };
}));
