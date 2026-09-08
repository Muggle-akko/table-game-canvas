import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDirectory = resolve(root, "public");
const html = await readFile(resolve(publicDirectory, "index.html"), "utf8");
const app = await readFile(resolve(publicDirectory, "app.js"), "utf8");
const workspace = await readFile(resolve(publicDirectory, "workspace-ui.js"), "utf8");
const feedback = await readFile(resolve(publicDirectory, "room-feedback.js"), "utf8");
const dealing = await readFile(resolve(publicDirectory, "deal-ui.js"), "utf8");
const styles = await readFile(resolve(publicDirectory, "styles.css"), "utf8");
const icons = await readFile(resolve(publicDirectory, "phosphor-icons.js"), "utf8");
const previewEngine = await readFile(resolve(publicDirectory, "preview-engine.js"), "utf8");
const acceptancePack = JSON.parse(await readFile(resolve(root, "game-packs", "parlor-eight.json"), "utf8"));
const standardPack = JSON.parse(await readFile(resolve(root, "game-packs", "standard-54.json"), "utf8"));
const unoPack = JSON.parse(await readFile(resolve(root, "game-packs", "uno.json"), "utf8"));
const packSchema = JSON.parse(await readFile(resolve(root, "game-packs", "pack.schema.json"), "utf8"));

const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(htmlIds).size, htmlIds.length, "index.html contains duplicate IDs");

const queriedIds = [
  ...[...app.matchAll(/\$\("#([^"]+)"\)/g)].map((match) => match[1]),
  ...[...`${workspace}\n${feedback}\n${dealing}`.matchAll(/\$\("([\w-]+)"\)/g)].map((match) => match[1])
];
const missingIds = queriedIds.filter((id) => !htmlIds.includes(id));
assert.deepEqual(missingIds, [], `app.js queries missing DOM IDs: ${missingIds.join(", ")}`);

const localAssets = [...html.matchAll(/\b(?:src|href)="\.\/([^"]+)"/g)].map((match) => match[1]);
for (const asset of localAssets) await access(resolve(publicDirectory, asset));
const scriptOrder = ["phosphor-icons.js", "tabletop-engine.js", "builtin-packs.js", "preview-engine.js", "vault.js", "room-recovery.js", "preview-recovery.js", "board-art.js", "workspace-ui.js", "room-feedback.js", "deal-ui.js", "app.js"];
for (let index = 1; index < scriptOrder.length; index++) {
  assert.ok(html.indexOf(`./${scriptOrder[index - 1]}`) < html.indexOf(`./${scriptOrder[index]}`), `${scriptOrder[index]} must load after its dependencies`);
}
for (const match of html.matchAll(/\b(?:aria-controls|aria-labelledby)="([^"]+)"/g)) {
  for (const id of match[1].split(/\s+/)) assert.ok(htmlIds.includes(id), `ARIA references missing ${id}`);
}
assert.ok(
  html.indexOf("./phosphor-icons.js") < html.indexOf("./app.js"),
  "the local Phosphor icon runtime must load before the main client"
);
assert.ok(
  html.indexOf("./preview-engine.js") < html.indexOf("./app.js"),
  "the offline preview engine must load before the main client"
);

assert.equal(/\bon[a-z]+\s*=/.test(html), false, "inline event handlers are not allowed");
assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false, "inline scripts would violate the production CSP");
assert.equal(acceptancePack.cards.length, 8, "the acceptance pack must contain exactly eight cards");
assert.equal(standardPack.cards.length, 54, "the default pack must contain a complete 54-card deck");
assert.equal(unoPack.cards.length, 108, "the UNO pack must contain the classic 108-card structure");
assert.equal(acceptancePack.$schema, "./pack.schema.json", "the acceptance pack must link its schema");
assert.equal(packSchema.title, "Parlor JSON Game Pack", "the game pack schema must be readable");
assert.ok(packSchema.$defs?.assetPath, "the game pack schema must define safe local artwork paths");
assert.equal(
  packSchema.properties.cards.items.properties.image?.$ref,
  "#/$defs/assetPath",
  "card artwork must use the shared safe path definition"
);
assert.match(app, /roomAssetUrl\("card"/, "the client must request card artwork through the room endpoint");
assert.match(app, /image\.addEventListener\("error"/, "artwork loading must retain a visual fallback");
assert.match(previewEngine, /root\.ParlorPreview/, "the offline demo engine must expose its browser controller");
assert.match(app, /ParlorPreview\.applyCommand/, "preview controls must mutate the offline demo model");
assert.match(icons, /root\.ParlorIcons/, "the local Phosphor icon runtime must expose its DOM helper");
assert.ok((html.match(/data-ph=/g) || []).length >= 20, "interface controls must use the Phosphor icon set");
assert.match(workspace, /type: "add-pack"/, "the resource shelf must add independent packs");
assert.match(app, /ParlorWorkspace\.create/, "the workspace features must be connected to the main client");
assert.match(workspace, /type: "restore-scene"/, "local saves must have a restore action");
const iconContext = { window: {}, document: { querySelectorAll: () => [] } };
vm.runInNewContext(icons, iconContext);
const usedIcons = [
  ...[...html.matchAll(/data-ph="([^"]+)"/g)].map((match) => match[1]),
  ...[...`${app}\n${workspace}\n${feedback}\n${dealing}`.matchAll(/\b(?:phIcon|icon)\("([^"]+)"/g)].map((match) => match[1]),
  ...[...app.matchAll(/makeSelectionAction\("[^"]+", "([^"]+)"/g)].map((match) => match[1])
];
assert.deepEqual([...new Set(usedIcons.filter((name) => !iconContext.window.ParlorIcons.names.includes(name)))], [], "all controls need a bundled icon");
const cssStructure = styles.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
let depth = 0;
for (const character of cssStructure) {
  if (character === "{") depth++;
  if (character === "}") depth--;
  assert.ok(depth >= 0, "CSS closes a block before opening it");
}
assert.equal(depth, 0, "CSS contains an unclosed block");
assert.match(app, /if \(!roomCode\) \{\s*showWelcome\(\)/, "the static root must open a usable welcome screen");
assert.match(html, /id="start-demo"/, "the welcome screen must offer a direct demo action");
assert.match(app, /window\.sessionStorage\.setItem\(storageKey\(\), token\)/, "room identity must be isolated per browser tab");
assert.match(app, /searchParams\.set\("autojoin", "客人B"\)/, "hosts need a one-click isolated guest test page");
assert.match(
  html,
  /id="world"[\s\S]*id="local-cursor-root"/,
  "the local pointer needs a viewport layer outside the transformed table world"
);
assert.match(
  app,
  /elements\.localCursorRoot\.append\(node\)/,
  "the local pointer must render in its dedicated screen-space layer"
);
assert.match(styles, /\.local-cursor-root\s*\{[^}]*z-index:/s, "the local pointer layer must sit above the table world");
// Stream recovery is verified through production events in client-cursors and client-sync tests.
assert.equal(
  app.includes("与房主断开，暂时不能标记位置"),
  false,
  "attention pings must not mislabel a transient sync recovery as host disconnection"
);
assert.match(
  app,
  /if \(!app\.queuedCursorMessage \|\| app\.cursorSendInFlight \|\| app\.cursorSendTimer/,
  "public cursor traffic must coalesce while a previous update is in flight"
);
assert.match(
  app,
  /CURSOR_REQUEST_TIMEOUT = 1800/,
  "a stalled public cursor request must not block newer positions indefinitely"
);
for (const pack of [acceptancePack, standardPack, unoPack]) {
  assert.equal(new Set(pack.cards.map((card) => card.key)).size, pack.cards.length, `${pack.id} card keys must be unique`);
  assert.ok(pack.cards.every((card) => card.label && card.rank && card.suit && card.symbol), `${pack.id} cards need visible faces`);
  assert.ok(pack.cardBack?.label, `${pack.id} needs one shared card back`);
  assert.match(pack.cardBack?.color || "", /^#[0-9a-f]{6}$/i, `${pack.id} card back needs a hex color`);
}
assert.ok(Array.isArray(acceptancePack.tokens) && acceptancePack.tokens.length > 0, "the acceptance pack needs shared tokens");
assert.ok(
  acceptancePack.tokens.every((token) => token.key && token.label && token.symbol && /^#[0-9a-f]{6}$/i.test(token.color)),
  "every token needs a key, label, symbol, and hex color"
);
assert.ok(Number.isInteger(acceptancePack.die?.sides) && acceptancePack.die.sides >= 2, "the acceptance pack needs a die");
assert.ok(
  acceptancePack.counter?.label && Number.isInteger(acceptancePack.counter.initial) && Number.isInteger(acceptancePack.counter.min) && Number.isInteger(acceptancePack.counter.max),
  "the acceptance pack needs a shared counter"
);

for (const forbidden of ["shared web", "voice", "video", "account", "cloud room"]) {
  assert.equal(Object.hasOwn(acceptancePack, forbidden), false, `v1 pack unexpectedly includes ${forbidden}`);
}

console.log(
  `Static contract OK: ${htmlIds.length} DOM IDs, ${localAssets.length} local assets, complete 54-card and 108-card packs, plus the 8-card acceptance fixture.`
);
