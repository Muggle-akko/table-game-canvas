import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const assetPattern = /\b(src|href)="\.\/([\w-]+\.(?:js|css))(?:\?[^"#]*)?"/g;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readClientAssets(html, directory) {
  const pattern = new RegExp(assetPattern);
  const files = [...new Set([...html.matchAll(pattern)].map((match) => match[2]))];
  return new Map(await Promise.all(files.map(async (file) => {
    const bytes = await readFile(resolve(directory, file));
    return [file, digest(bytes)];
  })));
}

function versionHtml(html, assets) {
  return html.replace(assetPattern, (_, attribute, file) => `${attribute}="./${file}?v=${assets.get(file).slice(0, 16)}"`);
}

// Use the same content URLs for a room server and a statically hosted client.
export async function versionClientHtml(html, directory) {
  return versionHtml(html, await readClientAssets(html, directory));
}

export async function buildClientShell(directory) {
  const [source, template] = await Promise.all([
    readFile(resolve(directory, "index.html"), "utf8"),
    readFile(resolve(directory, "service-worker.js"), "utf8")
  ]);
  const assets = await readClientAssets(source, directory);
  const html = versionHtml(source, assets);
  const manifest = {
    version: digest(`${html}\n${template}`).slice(0, 24),
    resources: [
      { url: "./", hash: digest(html), type: "html" },
      ...[...assets].map(([file, hash]) => ({ url: `./${file}?v=${hash.slice(0, 16)}`, hash, type: file.endsWith(".css") ? "css" : "js" }))
    ]
  };
  const marker = "/* PARLOR_SHELL_MANIFEST */ null";
  if (!template.includes(marker)) throw new Error("Offline shell manifest marker is missing");
  return { html, worker: template.replace(marker, JSON.stringify(manifest)) };
}
