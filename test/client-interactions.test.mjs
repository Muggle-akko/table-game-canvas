import test from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./helpers/client-dom.mjs";
import { createLocalStoreDouble } from "./helpers/local-store.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} should be within 0.000001 of ${expected}`);
function pointerFor(client, x, y) {
  const rect = client.$("viewport").getBoundingClientRect(), camera = client.app.camera;
  return { clientX: rect.left + camera.x + x * camera.scale, clientY: rect.top + camera.y + y * camera.scale };
}
async function dragResource(client, node, from, to) {
  await client.dispatch(node, "pointerdown", pointerFor(client, from.x, from.y));
  await client.dispatch(node, "pointermove", pointerFor(client, to.x, to.y));
  await client.dispatch(node, "pointerup", pointerFor(client, to.x, to.y));
}

test("client boots the actual scripts and adds packs without replacing the first deck or private hands", async () => {
  const client = await loadClient();
  const { app, $, document, dispatch } = client;
  assert.equal($("room-screen").classList.contains("is-hidden"), false);
  assert.equal($("library-panel").classList.contains("is-open"), false);
  await dispatch($("open-library"), "click");
  assert.equal($("pack-library").children.length, 17);
  assert.equal($("objects-root").children.length, 2);
  assert.equal($("welcome-resources").children.length, 5);
  const privateCard = app.state.cards.find((card) => card.ownerId === "player_a" && card.zone === "hand");
  const cardNode = document.querySelector(`#cards-root [data-card-id="${privateCard.id}"]`);
  await dispatch(document.querySelector('[data-add-asset="pack:uno"]'), "click");
  assert.equal(app.state.decks.length, 2);
  assert.equal(app.state.decks.find((deck) => deck.id === "main").count, 51);
  assert.equal(app.state.decks.at(-1).count, 108);
  assert.ok(app.state.cards.find((card) => card.id === privateCard.id).face);
  assert.equal(document.querySelector(`#cards-root [data-card-id="${privateCard.id}"]`), cardNode, "unrelated resources preserve existing card DOM");
  assert.equal(app.selection.id, app.state.decks.at(-1).id);
  assert.match($("selection-title").textContent, /UNO/);
  assert.match($("deck-root").textContent, /UNO/);
  await dispatch(document.querySelector('[data-selection-action="draw"]'), "click");
  assert.equal(app.state.decks.at(-1).count, 107);
  assert.equal(app.state.decks[0].count, 51);
  const unoHand = app.state.cards.find((card) => card.deckId === app.state.decks.at(-1).id);
  assert.equal(unoHand.back.label, "UNO");
  client.switchPreviewRole();
  const hidden = document.querySelector(`#cards-root [data-card-id="${unoHand.id}"]`);
  assert.ok(hidden.querySelector(".card-back"));
  assert.equal(hidden.querySelector(".card-back__label").textContent, "UNO");
  assert.equal(hidden.querySelector(".card-face"), null);
});

test("click selects a deck; dragging moves the whole deck; hand drops draw one before world placement", async () => {
  const client = await loadClient();
  const { app, document, dispatch, $ } = client;
  const main = () => app.state.decks.find((deck) => deck.id === "main");
  let node = document.querySelector('[data-deck-id="main"]');
  let from = { x: main().x + 20, y: main().y + 20 };
  await dispatch(node, "pointerdown", pointerFor(client, from.x, from.y));
  await dispatch(node, "pointerup", pointerFor(client, from.x, from.y));
  assert.equal(main().count, 51, "single-click must not take a card");
  assert.equal(app.selection.type, "deck");
  await dragResource(client, node, from, { x: 970, y: 510 });
  assert.equal(main().count, 51);
  closeTo(main().x, 950);
  closeTo(main().y, 490);
  assert.equal(app.state.cards.filter((card) => card.zone === "public").length, 1);
  client.switchPreviewRole();
  node = document.querySelector('[data-deck-id="main"]');
  const receiver = app.handLayouts.get("player_a");
  from = { x: main().x + 20, y: main().y + 20 };
  await dragResource(client, node, from, { x: receiver.x + 150, y: receiver.y + 110 });
  assert.equal(main().count, 50);
  closeTo(main().x, 950);
  const received = app.state.cards.filter((card) => card.ownerId === "player_a" && card.zone === "hand");
  assert.equal(received.length, 2);
  assert.ok(received.every((card) => card.face === null), "the giver sees no receiver faces");
  assert.equal($("drag-root").children.length, 0);
  assert.equal(app.drag, null);
});

test("a connected overlap group moves intact and enters a bag atomically through production pointer handlers", async () => {
  const client = await loadClient();
  const { app, document } = client;
  await client.sendCommand({ type: "draw-public", x: 653, y: 393, rotation: 20 });
  await client.sendCommand({ type: "draw-public", x: 683, y: 417, rotation: -15 });
  const stack = app.state.cards.filter((card) => card.zone === "public");
  assert.equal(client.visibleStackForCard(stack[0].id).length, 3);
  const before = stack.map((card) => ({ id: card.id, x: card.x, y: card.y, rotation: card.rotation, faceUp: card.faceUp }));
  const node = document.querySelector(`#cards-root [data-card-id="${stack[0].id}"]`);
  await dragResource(client, node, { x: stack[0].x + 15, y: stack[0].y + 20 }, { x: 870, y: 650 });
  const moved = app.state.cards.filter((card) => card.zone === "public");
  assert.equal(moved.length, 3);
  const dx = moved[0].x - before[0].x, dy = moved[0].y - before[0].y;
  moved.forEach((card, index) => {
    closeTo(card.x - before[index].x, dx);
    closeTo(card.y - before[index].y, dy);
    assert.equal(card.rotation, before[index].rotation);
    assert.equal(card.faceUp, before[index].faceUp);
  });
  await client.sendCommand({ type: "spawn-resource", resourceId: "bag", x: 1120, y: 420 });
  const bag = app.state.objects.find((object) => object.kind === "bag");
  const movedNode = document.querySelector(`#cards-root [data-card-id="${moved[0].id}"]`);
  const undoBefore = app.previewModel.engineRoom.undoStack.length;
  await dragResource(client, movedNode, { x: moved[0].x + 20, y: moved[0].y + 20 }, { x: bag.x + 50, y: bag.y + 50 });
  assert.equal(app.state.cards.filter((card) => card.zone === "public").length, 0);
  assert.equal(app.state.objects.find((object) => object.id === bag.id).count, 3);
  assert.equal(app.previewModel.engineRoom.undoStack.length, undoBefore + 1);
  assert.equal(document.querySelector(".card-stack-count"), null);
  await client.sendCommand({ type: "undo" });
  assert.deepEqual(plain(app.state.cards.filter((card) => card.zone === "public").map((card) => ({ id: card.id, x: card.x, y: card.y, rotation: card.rotation, faceUp: card.faceUp }))), plain(moved.map((card) => ({ id: card.id, x: card.x, y: card.y, rotation: card.rotation, faceUp: card.faceUp }))));
});

test("pocket drags target the world and Escape cancels without a partial command", async () => {
  const client = await loadClient({ width: 390, height: 844 });
  const { app, $, document, dispatch } = client;
  assert.equal($("library-panel").classList.contains("is-open"), false);
  await dispatch($("open-hand"), "click");
  const card = app.state.cards.find((item) => item.zone === "hand" && item.ownerId === "player_a");
  let node = document.querySelector(`#hand-cards [data-card-id="${card.id}"]`);
  node.rect = { left: 40, top: 600, width: 94, height: 138 };
  const revision = app.state.revision;
  await dispatch(node, "pointerdown", { clientX: 68, clientY: 630 });
  await dispatch(node, "pointermove", { clientX: 168, clientY: 480 });
  assert.ok(app.drag?.activated);
  await dispatch(document.body, "keydown", { key: "Escape" });
  assert.equal(app.drag, null);
  assert.equal(app.state.revision, revision);
  assert.equal($("drag-root").children.length, 0);
  await dispatch(node, "pointerdown", { clientX: 68, clientY: 630 });
  await dispatch(node, "pointermove", { clientX: 168, clientY: 420, shiftKey: true });
  await dispatch(node, "pointerup", { clientX: 168, clientY: 420, shiftKey: true });
  const placed = app.state.cards.find((item) => item.id === card.id);
  assert.equal(placed.zone, "public");
  assert.equal(placed.faceUp, false);
  assert.equal(placed.face, null);
});

test("object editing, dice, library favorites and room chat are connected without disturbing undo", async () => {
  const client = await loadClient();
  const { app, $, document, dispatch } = client;
  const note = app.state.objects.find((object) => object.kind === "note");
  await dispatch(document.querySelector(`[data-object-id="${note.id}"]`), "dblclick");
  assert.ok($("resource-editor").hasAttribute("open"));
  $("resource-label").value = "今天的约定";
  $("resource-text").value = '<img src=x onerror=alert(1)> 只是便签内容';
  await dispatch($("resource-edit-form"), "submit");
  assert.equal($("resource-editor").hasAttribute("open"), false);
  assert.match(document.querySelector(`[data-object-id="${note.id}"] .note-object-text`).textContent, /<img src=x/);
  assert.equal(document.querySelector(`[data-object-id="${note.id}"] img`), null);
  const die = app.state.objects.find((object) => object.kind === "die");
  await dispatch(document.querySelector(`[data-object-id="${die.id}"]`), "dblclick");
  assert.ok(app.state.objects.find((object) => object.id === die.id).value >= 1);
  await dispatch($("open-library"), "click");
  await dispatch(document.querySelector('[data-favorite="die-d6"]'), "click");
  await dispatch(document.querySelector('[data-category="favorites"]'), "click");
  assert.equal($("pack-library").children.length, 1);
  const undoCount = app.previewModel.engineRoom.undoStack.length;
  await dispatch($("open-chat"), "click");
  $("chat-input").value = "先玩十分钟";
  await dispatch($("chat-form"), "submit");
  assert.match($("chat-messages").textContent, /先玩十分钟/);
  assert.equal($("chat-input").value, "");
  assert.equal(app.previewModel.engineRoom.undoStack.length, undoCount);
  await dispatch($("identity-chip"), "click");
  $("nickname-input").value = "小鱼";
  await dispatch($("nickname-form"), "submit");
  assert.equal(app.state.players.find((player) => player.id === "player_a").name, "小鱼");
  assert.equal(app.previewModel.engineRoom.undoStack.length, undoCount);
});

test("search has a useful empty state and unavailable persistence reports failure instead of success", async () => {
  const client = await loadClient();
  const { $, dispatch } = client;
  await dispatch($("open-library"), "click");
  $("library-search").value = "没有这种资源";
  await dispatch($("library-search"), "input");
  assert.match($("pack-library").textContent, /没找到这件物品/);
  await dispatch($("open-saves"), "click");
  $("save-name").value = "周五";
  await dispatch($("save-form"), "submit");
  assert.match($("save-status").textContent, /不支持本机存档|不可用/);
  assert.doesNotMatch($("save-status").textContent, /已保存在/);
  assert.equal($("save-scene").disabled, false);
});

test("library drags cancel on Escape, pointer cancellation, capture loss, blur, and panel close", async () => {
  for (const cancel of ["Escape", "pointercancel", "lostpointercapture", "blur", "close"]) {
    const client = await loadClient();
    const { app, document, dispatch, $ } = client;
    await dispatch($("open-library"), "click");
    $("library-panel").rect = { left: 18, top: 84, width: 340, height: 700 };
    const source = document.querySelector('[data-add-asset="die-d20"]');
    const revision = app.state.revision;
    await dispatch(source, "pointerdown", { clientX: 100, clientY: 200 });
    await dispatch(source, "pointermove", { clientX: 800, clientY: 450 });
    assert.ok(document.querySelector(".library-drag-ghost"), cancel);
    if (cancel === "Escape") await dispatch(document.body, "keydown", { key: "Escape" });
    else if (cancel === "close") await dispatch($("close-library"), "click");
    else await dispatch(source, cancel);
    assert.equal(document.querySelector(".library-drag-ghost"), null, cancel);
    await dispatch(source, "pointerup", { clientX: 800, clientY: 450 });
    await dispatch(source, "click");
    assert.equal(app.state.revision, revision, `${cancel} also suppresses a trailing click`);
    if (cancel === "Escape") assert.ok($("library-panel").classList.contains("is-open"), "Escape only cancels the current drag");
  }
});

test("library resources only drop onto the world, not over other controls or panels", async () => {
  const client = await loadClient();
  const { app, document, dispatch, $ } = client;
  await dispatch($("open-library"), "click");
  $("library-panel").rect = { left: 18, top: 84, width: 340, height: 700 };
  const revision = app.state.revision;
  for (const selector of [".topbar", ".aux-panel", ".selection-dock", ".world-overview", ".aux-backdrop", ".hand-drawer"]) {
    const source = document.querySelector('[data-add-asset="die-d20"]');
    document.hitTarget = document.querySelector(selector);
    assert.ok(document.hitTarget, selector);
    await dispatch(source, "pointerdown", { clientX: 100, clientY: 200 });
    await dispatch(source, "pointermove", { clientX: 800, clientY: 450 });
    await dispatch(source, "pointerup", { clientX: 800, clientY: 450 });
    assert.equal(app.state.revision, revision, selector);
    assert.equal(document.querySelector(".library-drag-ghost"), null);
  }
  document.hitTarget = $("viewport");
  const source = document.querySelector('[data-add-asset="die-d20"]');
  await dispatch(source, "pointerdown", { clientX: 100, clientY: 200 });
  await dispatch(source, "pointermove", { clientX: 800, clientY: 450 });
  await dispatch(source, "pointerup", { clientX: 800, clientY: 450 });
  assert.ok(app.state.objects.some((object) => object.kind === "die" && object.sides === 20));
  assert.equal(app.state.revision, revision + 1);
});

test("touch on library previews leaves native scrolling available and keeps tap-to-add", async () => {
  const client = await loadClient({ width: 390, height: 844 });
  const { app, document, dispatch, $ } = client;
  await dispatch($("open-library"), "click");
  const source = document.querySelector('[data-add-asset="die-d20"]');
  const revision = app.state.revision;
  const down = await dispatch(source, "pointerdown", { pointerType: "touch", clientX: 100, clientY: 200 });
  assert.equal(Boolean(down.defaultPrevented), false);
  await dispatch(source, "pointermove", { pointerType: "touch", clientX: 100, clientY: 400 });
  await dispatch(source, "pointercancel", { pointerType: "touch" });
  assert.equal(document.querySelector(".library-drag-ghost"), null);
  assert.equal(app.state.revision, revision);
  await dispatch(source, "click");
  assert.ok(app.state.objects.some((object) => object.kind === "die" && object.sides === 20));
  assert.equal($("library-panel").classList.contains("is-open"), false);
});

test("imports with builtin or repeated pack IDs stay independent and removable without changing the tabletop", async () => {
  const indexedDB = createLocalStoreDouble(), storage = new Map();
  const client = await loadClient({ indexedDB, storage });
  const { app, document, dispatch, $ } = client;
  await dispatch($("open-library"), "click");
  const original = plain(client.context.ParlorPacks[0]);
  for (const name of ["周五扑克", "周六扑克"]) {
    const pack = { ...plain(original), name, cards: plain(original.cards.slice(0, 1)), tokens: [] };
    pack.cardBack.label = name;
    const json = JSON.stringify(pack);
    $("pack-file").files = [{ size: json.length, text: async () => json }];
    await dispatch($("pack-file"), "change");
  }
  const saved = plain(await client.context.ParlorVault.listPacks());
  assert.equal(saved.length, 2, "same source ID must not replace a saved import");
  assert.equal(new Set(saved.map((item) => item.id)).size, 2);
  assert.ok(saved.every((item) => item.id !== original.id && item.pack.id === original.id));
  assert.ok(document.querySelector(`[data-add-asset="pack:${original.id}"]`));
  for (const item of saved) assert.ok(document.querySelector(`[data-add-asset="import:${item.id}"]`));
  assert.equal(app.state.decks.length, 3);
  assert.equal(app.state.decks[0].count, 51);
  assert.deepEqual(plain(app.state.decks.slice(1).map((deck) => deck.back.label)), ["周五扑克", "周六扑克"]);
  const before = plain(app.state), remove = document.querySelector(`[data-remove-pack="${saved[0].id}"]`);
  client.context.confirm = () => false;
  await dispatch(remove, "click");
  assert.equal((await client.context.ParlorVault.listPacks()).length, 2);
  client.context.confirm = () => true;
  await dispatch(remove, "click");
  await client.settle();
  assert.equal(document.querySelector(`[data-add-asset="import:${saved[0].id}"]`), null);
  assert.ok(document.querySelector(`[data-add-asset="import:${saved[1].id}"]`));
  assert.deepEqual(plain(app.state), before);
  const reloaded = await loadClient({ indexedDB, storage });
  assert.ok(reloaded.document.querySelector(`[data-add-asset="pack:${original.id}"]`));
  assert.ok(reloaded.document.querySelector(`[data-add-asset="import:${saved[1].id}"]`));
  assert.equal(reloaded.document.querySelector(`[data-add-asset="import:${saved[0].id}"]`), null);
  const legacy = await loadClient({ indexedDB: createLocalStoreDouble({ packs: [{ id: original.id, pack: original, updatedAt: 1 }] }) });
  assert.ok(legacy.document.querySelector(`[data-add-asset="pack:${original.id}"]`));
  assert.ok(legacy.document.querySelector(`[data-add-asset="import:${original.id}"]`), "older stored imports remain accessible");
});

test("secondary actions survive room updates, preserve the recipient, and close with Escape", async () => {
  const client = await loadClient();
  const { app, document, dispatch, $ } = client;
  const card = app.state.cards.find((item) => item.zone === "public");
  client.selectResource("card", card.id);
  assert.deepEqual($("selection-actions").children.filter((node) => node.tagName === "BUTTON").map((node) => node.dataset.selectionAction), ["flip-card", "return-card"]);
  let more = document.querySelector(".selection-more");
  const rotate = more.querySelector('[data-selection-action="rotate-right"]');
  assert.ok(rotate, "secondary actions stay reachable");
  more.setAttribute("open", "");
  await dispatch(rotate, "click");
  assert.equal(app.state.cards.find((item) => item.id === card.id).rotation, card.rotation + 15);
  assert.equal($("quick-undo").disabled, false);
  await dispatch($("quick-undo"), "click");
  assert.equal(app.state.cards.find((item) => item.id === card.id).rotation, card.rotation);
  more = document.querySelector(".selection-more");
  more.setAttribute("open", ""); more.querySelector("summary").focus();
  await client.sendCommand({ type: "chat", text: "等我一下" });
  more = document.querySelector(".selection-more");
  assert.ok(more.hasAttribute("open"), "an unrelated chat update does not dismiss the menu");
  assert.equal(document.activeElement, more.querySelector("summary"));
  await dispatch(document.body, "keydown", { key: "Escape" });
  assert.equal(more.hasAttribute("open"), false);
  assert.equal(app.selection.id, card.id, "the first Escape closes only the menu");
  more.setAttribute("open", "");
  await dispatch(document.body, "pointerdown");
  assert.equal(more.hasAttribute("open"), false);
  client.selectResource("deck", "main");
  more = document.querySelector(".selection-more"); more.setAttribute("open", "");
  await dispatch(more.querySelector('[data-selection-action="toggle-transfer"]'), "click");
  assert.equal($("selection-transfer").classList.contains("is-hidden"), false);
  $("selection-player").value = "player_b";
  await client.sendCommand({ type: "rename-player", name: "小鱼" });
  assert.equal($("selection-player").value, "player_b", "unrelated state changes keep the chosen recipient");
  const before = app.state.cards.filter((item) => item.ownerId === "player_b" && item.zone === "hand").length;
  await dispatch($("selection-send"), "click");
  assert.equal(app.state.cards.filter((item) => item.ownerId === "player_b" && item.zone === "hand").length, before + 1);
  client.switchPreviewRole();
  assert.equal($("quick-undo").disabled, true);
});

test("minimap disclosure supports keyboard navigation and closes without changing shared state", async () => {
  const client = await loadClient({ width: 390, height: 844 });
  const { app, document, dispatch, $ } = client;
  const revision = app.state.revision;
  assert.equal($("minimap-panel").classList.contains("is-hidden"), true);
  client.selectResource("deck", "main");
  await dispatch($("open-hand"), "click");
  await dispatch($("toggle-minimap"), "click");
  assert.equal($("toggle-minimap").getAttribute("aria-expanded"), "true");
  assert.equal($("minimap-panel").classList.contains("is-hidden"), false);
  assert.equal($("hand-drawer").classList.contains("is-hidden"), true);
  assert.equal(app.selection, null);
  assert.equal(document.activeElement, $("minimap"));
  const beforeX = app.camera.x;
  await dispatch($("minimap"), "keydown", { key: "ArrowLeft" });
  closeTo(app.camera.x, beforeX + 180);
  await dispatch($("minimap"), "keydown", { key: "Escape" });
  assert.equal($("toggle-minimap").getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, $("toggle-minimap"));
  await dispatch($("toggle-minimap"), "click");
  await dispatch($("go-home"), "click");
  assert.equal($("minimap-panel").classList.contains("is-hidden"), true);
  await dispatch($("toggle-minimap"), "click");
  await dispatch($("open-library"), "click");
  assert.equal($("minimap-panel").classList.contains("is-hidden"), true);
  assert.equal($("library-panel").classList.contains("is-open"), true);
  assert.equal(app.state.revision, revision, "camera and panel controls stay local");
});

test("history is reachable from the rail and returns keyboard focus to its own control", async () => {
  const { app, document, dispatch, $ } = await loadClient();
  const revision = app.state.revision;
  await dispatch($("open-tools"), "click");
  await dispatch($("open-history"), "click");
  assert.equal($("tools-panel").classList.contains("is-open"), false);
  assert.equal($("history-panel").classList.contains("is-open"), true);
  await dispatch($("close-history"), "keydown", { key: "Escape" });
  assert.equal($("history-panel").classList.contains("is-open"), false);
  assert.equal(document.activeElement, $("open-history"));
  await dispatch($("open-tools"), "click");
  await dispatch($("open-history"), "click");
  await dispatch($("close-history"), "click");
  assert.equal($("history-panel").classList.contains("is-open"), false);
  assert.equal(document.activeElement, $("open-history"));
  assert.equal(app.state.revision, revision);
});
