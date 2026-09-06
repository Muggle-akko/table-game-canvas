import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateGamePack } from "../src/room-engine.mjs";
import { validatePackAssets } from "../src/room-assets.mjs";

const requestedPaths = process.argv.slice(2);
if (requestedPaths.length === 0) requestedPaths.push("./game-packs/standard-54.json");

for (const requestedPath of requestedPaths) {
  const packPath = resolve(process.cwd(), requestedPath);
  try {
    const pack = JSON.parse(await readFile(packPath, "utf8"));
    validateGamePack(pack);
    await validatePackAssets(pack, dirname(packPath));
    console.log(`游戏包校验通过：${pack.name}（${pack.cards.length} 张牌，${pack.tokens?.length || 0} 枚 Token）`);
  } catch (error) {
    console.error(`游戏包校验失败 [${requestedPath}]：${error.message}`);
    process.exitCode = 1;
  }
}
