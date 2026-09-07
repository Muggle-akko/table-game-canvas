import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClientShell } from "../src/client-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "public");
const output = resolve(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
const shell = await buildClientShell(source);
await writeFile(resolve(output, "index.html"), shell.html);
await writeFile(resolve(output, "service-worker.js"), shell.worker);

console.log(`Static client built in ${output}`);
