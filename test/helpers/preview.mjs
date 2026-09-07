import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

export async function loadPreviewEngine() {
  const context = vm.createContext({ window: {}, JSON, Math, Date, crypto: webcrypto, structuredClone });
  for (const file of ["tabletop-engine.js", "builtin-packs.js", "preview-engine.js"]) {
    new vm.Script(await readFile(new URL(`../../public/${file}`, import.meta.url), "utf8"), { filename: file }).runInContext(context);
  }
  return { engine: context.window.ParlorPreview, core: context.ParlorEngine };
}
