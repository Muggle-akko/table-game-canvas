import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { versionClientHtml } from "../src/client-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "public");
const output = resolve(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });
const html = await readFile(resolve(source, "index.html"), "utf8");
await writeFile(resolve(output, "index.html"), await versionClientHtml(html, source));

console.log(`Static client built in ${output}`);
