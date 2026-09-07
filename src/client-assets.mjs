import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// A refreshed entry page must not combine new markup with cached older scripts
// or styles. The same content URLs are used by the room server and static build.
export async function versionClientHtml(html, directory) {
  const pattern = /\b(src|href)="\.\/([\w-]+\.(?:js|css))(?:\?[^"#]*)?"/g;
  const files = [...new Set([...html.matchAll(pattern)].map((match) => match[2]))];
  const versions = new Map(await Promise.all(files.map(async (file) => {
    const bytes = await readFile(resolve(directory, file));
    return [file, createHash("sha256").update(bytes).digest("hex").slice(0, 16)];
  })));
  return html.replace(pattern, (_, attribute, file) => `${attribute}="./${file}?v=${versions.get(file)}"`);
}
