import { readFile } from "node:fs/promises";
import { basename } from "path";
import { message } from "@/napcat-core/message";

export { readFile, message };
export function filename(path: string): string { return basename(path); }

if (process.argv.includes("--demo")) console.log({ message, pid: process.pid });
