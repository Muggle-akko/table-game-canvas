import test from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./helpers/client-dom.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < .000001, `${actual} should be close to ${expected}`);
const point = (client, x, y) => ({ clientX: client.app.camera.x + x * client.app.camera.scale, clientY: 58 + client.app.camera.y + y * client.app.camera.scale });
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const boundsFor = (client, type, value) => client.context.ParlorEngine.tableResourceBounds(type, value);
function assertFramed(client, bounds, { left = 72, right = 36, bottom = 104 } = {}) {
  const viewport = client.$("viewport").getBoundingClientRect(), camera = client.app.camera;
  assert.ok(camera.x + bounds.x * camera.scale >= left, "left edge stays clear of the rail or panel");
  assert.ok(camera.x + (bounds.x + bounds.width) * camera.scale <= viewport.width - right, "right edge is visible");
  assert.ok(camera.y + bounds.y * camera.scale >= 32, "top edge is visible");
  assert.ok(camera.y + (bounds.y + bounds.height) * camera.scale <= viewport.height - bottom, "bottom edge stays above controls");
}
async function add(client, key) {
  await client.dispatch(client.$("open-library"), "click");
  await client.dispatch(client.document.querySelector(`.asset-add[data-add-asset="${key}"]`), "click");
}

function renderBounds(client, node, bounds) {
  const screen = point(client, bounds.x, bounds.y), scale = client.app.camera.scale;
  node.rect = { left: screen.clientX, top: screen.clientY, width: bounds.width * scale, height: bounds.height * scale };
}

test("the closed shelf defers art, observes only the current entries, and reuses hydrated thumbnails", async () => {
  let observer;
  class Observer {
    constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); observer = this; }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
    reveal(...targets) { this.callback(targets.map((target) => ({ target, isIntersecting: true }))); }
  }
  const client = await loadClient({ IntersectionObserver: Observer }), { $, document, dispatch } = client;
  assert.equal($("pack-library").children.length, 80);
  assert.equal($("pack-library").querySelectorAll(".asset-art").length, 0);
  assert.equal(observer.targets.size, 0);
  await dispatch($("open-library"), "click");
  assert.equal(observer.targets.size, 80);
  assert.equal(observer.options.root, document.querySelector(".library-panel__body"));
  const chess = document.querySelector('.asset-preview[data-add-asset="set:chess"]');
  const plane = document.querySelector('.asset-preview[data-add-asset="set:aeroplane"]');
  observer.reveal(chess);
  const art = chess.querySelector(".board-art"); assert.ok(art);
  assert.equal($("pack-library").querySelectorAll(".asset-art").length, 1);
  await dispatch(document.querySelector('[data-category="packs"]'), "click");
  observer.reveal(plane);
  assert.equal(plane.querySelector(".asset-art"), null, "late intersections cannot hydrate detached entries");
  await dispatch(document.querySelector('[data-category="all"]'), "click");
  assert.equal(document.querySelector('.asset-preview[data-add-asset="set:chess"]'), chess);
  assert.equal(chess.querySelector(".board-art"), art);
  await dispatch($("close-library"), "click");
  observer.reveal(plane);
  assert.equal(plane.querySelector(".asset-art"), null, "closing the shelf also suspends queued intersections");
  await dispatch($("open-library"), "click");
  await dispatch(plane, "focusin");
  assert.ok(plane.querySelector(".board-art"), "keyboard focus makes a thumbnail ready without waiting for intersection");
});

test("set parts, search feedback, clearing, favorites and keyboard categories stay discoverable", async () => {
  const client = await loadClient(), { $, document, dispatch } = client;
  await dispatch($("open-library"), "click");
  await dispatch(document.querySelector('[data-set-parts="chess"]'), "click");
  assert.match($("library-scope").textContent, /国际象棋/);
  assert.equal($("pack-library").children.length, 14);
  assert.match($("library-result-count").textContent, /14 件/);
  assert.equal(document.activeElement, $("library-scope"));
  $("library-search").value = "白后"; await dispatch($("library-search"), "input");
  assert.equal($("pack-library").children.length, 1);
  assert.match($("library-result-count").textContent, /找到 1/);
  await dispatch($("library-search-clear"), "click");
  assert.equal($("pack-library").children.length, 14);
  assert.equal(document.activeElement, $("library-search"));
  await dispatch($("library-scope"), "click");
  await dispatch(document.querySelector('[data-set-parts="aeroplane"]'), "click");
  assert.equal($("pack-library").children.length, 7);
  assert.ok(document.querySelector('.asset-add[data-add-asset="die-d6"]'), "the shared die is included among plane-set parts");
  await dispatch($("library-scope"), "click");
  const favorite = document.querySelector('[data-favorite="board-chess"]'); favorite.focus();
  await dispatch(favorite, "click");
  assert.equal(document.activeElement, favorite);
  const all = document.querySelector('[data-category="all"]'); all.focus();
  await dispatch(all, "keydown", { key: "ArrowRight" });
  assert.equal(document.activeElement.dataset.category, "sets");
  assert.equal($("pack-library").children.length, 4);
  await dispatch(document.activeElement, "keydown", { key: "End" });
  assert.equal(document.activeElement.dataset.category, "favorites");
  assert.equal($("pack-library").children.length, 1);
  $("library-search").value = "不存在的棋子"; await dispatch($("library-search"), "input");
  assert.match($("library-result-count").textContent, /找到 0/);
  await dispatch(document.querySelector("[data-reset-library]"), "click");
  assert.equal($("pack-library").children.length, 80);
  assert.equal($("library-search").value, "");
});

test("clicking large sets finds clear space for boards and guides without rearranging existing resources", async () => {
  const client = await loadClient(), { app, $ } = client;
  $("selection-dock").rect = { left: 370, top: 760, width: 700, height: 62 };
  const original = plain({ cards: app.state.cards, tokens: app.state.tokens, objects: app.state.objects, decks: app.state.decks });
  const occupied = [...app.handLayouts.values()];
  for (const [type, values] of [["card", app.state.cards], ["token", app.state.tokens], ["object", app.state.objects], ["deck", app.state.decks]]) {
    for (const value of values) if (type !== "card" || value.zone === "public") occupied.push(boundsFor(client, type, value));
  }
  for (const id of ["chess", "aeroplane"]) {
    await add(client, `set:${id}`);
    const board = app.state.objects.find((object) => object.resourceId === `board-${id}`), set = client.context.ParlorEngine.BOARD_GAME_SETS.find((set) => set.id === id);
    const bounds = { x: board.x, y: board.y, width: set.width, height: set.height }, zone = app.state.room.geometry.publicZone;
    assert.ok(occupied.every((rect) => !overlaps(rect, bounds)), "the complete set avoids public resources, private zones and the previous set");
    assert.ok(bounds.x >= zone.x + 18 && bounds.y >= zone.y + 28);
    assert.ok(bounds.x + bounds.width <= zone.x + zone.width - 18 && bounds.y + bounds.height <= zone.y + zone.height - 28);
    assertFramed(client, bounds, { bottom: 164 }); occupied.push(bounds);
    assert.equal($("library-panel").classList.contains("is-open"), false);
    assert.equal(client.document.activeElement.dataset.objectId, board.id);
  }
  for (const key of ["cards", "tokens", "objects", "decks"]) for (const previous of original[key]) {
    assert.deepEqual(plain(app.state[key].find((value) => value.id === previous.id)), previous);
  }
  client.vm("app.camera = { x: 100000, y: 100000, scale: 1 }; applyCamera();");
  await add(client, "board-jungle");
  const edgeBoard = app.state.objects.find((object) => object.resourceId === "board-jungle");
  assert.equal(edgeBoard.x, app.state.room.geometry.publicZone.x + 18);
  assert.equal(edgeBoard.y, app.state.room.geometry.publicZone.y + 28);
  assertFramed(client, boundsFor(client, "object", edgeBoard), { bottom: 164 });
  await client.advanceTimers(50);
  assert.notEqual(client.document.activeElement, $("close-library"), "an old opening timer cannot focus a now-hidden control");
});

test("explicit board drags retain the chosen overlapping position and camera", async () => {
  const client = await loadClient(), { app, $, document, dispatch } = client;
  await dispatch($("open-library"), "click");
  $("library-panel").rect = { left: 80, top: 74, width: 320, height: 790 };
  const preview = document.querySelector('.asset-preview[data-add-asset="set:chess"]');
  const camera = plain(app.camera), end = { clientX: 730, clientY: 340 };
  const expected = client.vm("screenToWorld(730, 340)");
  await dispatch(preview, "pointerdown", { clientX: 210, clientY: 290 });
  await dispatch(preview, "pointermove", end);
  await dispatch(preview, "pointerup", end);
  const board = app.state.objects.find((object) => object.resourceId === "board-chess");
  assert.equal(board.x, expected.x); assert.equal(board.y, expected.y);
  assert.deepEqual(plain(app.camera), camera);
  assert.equal($("library-panel").classList.contains("is-open"), true);
});

test("a full table reports no clear space while retaining the explicit placement option", async () => {
  const client = await loadClient(), { app, $, document, dispatch } = client;
  client.vm(`{
    const prototype = ParlorEngine.RESOURCE_CATALOG.find((resource) => resource.id === "holdem-mat");
    for (let row = 0; row < 8; row++) for (let column = 0; column < 6; column++) {
      const id = 'occupied-' + row + '-' + column;
      app.previewModel.engineRoom.objects.set(id, { ...prototype, id, resourceId: prototype.id, x: Math.min(6282 - prototype.width, -4482 + column * 1780), y: Math.min(4072 - prototype.height, -2972 + row * 875), rotation: 0, locked: false, z: 0 });
    }
    syncPreviewState();
  }`);
  const before = app.state.objects.length, camera = plain(app.camera);
  await dispatch($("open-library"), "click");
  const button = document.querySelector('.asset-add[data-add-asset="set:chess"]');
  await dispatch(button, "click");
  assert.equal(app.state.objects.length, before);
  assert.deepEqual(plain(app.camera), camera);
  assert.match($("toast-region").textContent, /没有足够空位.*拖到/);
  assert.equal(button.dataset.pendingCount, undefined);
  assert.equal(button.disabled, false);
});

test("board interiors pan or marquee, border drags move only the board and locks still apply", async () => {
  const client = await loadClient(), { app, $, dispatch } = client;
  await add(client, "set:chess");
  let board = app.state.objects.find((object) => object.resourceId === "board-chess");
  const node = $("objects-root").querySelector(`[data-object-id="${board.id}"]`), initial = plain(board), revision = app.state.revision;
  const start = point(client, board.x + 400, board.y + 400), camera = plain(app.camera);
  await dispatch(node, "pointerdown", start);
  assert.equal(app.drag, null); assert.ok(app.pan);
  await dispatch(node, "pointermove", { clientX: start.clientX + 30, clientY: start.clientY + 20 });
  await dispatch(node, "pointerup", { clientX: start.clientX + 30, clientY: start.clientY + 20 });
  closeTo(app.camera.x, camera.x + 30); closeTo(app.camera.y, camera.y + 20);
  assert.equal(app.state.revision, revision);
  await dispatch(node, "pointerdown", { ...point(client, board.x + 40, board.y + 40), shiftKey: true });
  await dispatch(node, "pointermove", point(client, board.x + 792, board.y + 380));
  await dispatch(node, "pointerup", point(client, board.x + 792, board.y + 380));
  assert.equal(app.selection.type, "group");
  assert.ok(app.selection.items.some((ref) => ref.type === "token"));
  assert.ok(app.selection.items.every((ref) => ref.id !== board.id), "an internal marquee does not scoop up the whole board");
  const edge = node.querySelector('[data-mat-handle="left"]'), tokens = plain(app.state.tokens);
  await dispatch(edge, "pointerdown", point(client, board.x + 10, board.y + 410));
  await dispatch(edge, "pointermove", point(client, board.x + 110, board.y + 460));
  await dispatch(edge, "pointerup", point(client, board.x + 110, board.y + 460));
  board = app.state.objects.find((object) => object.id === board.id);
  closeTo(board.x, initial.x + 100); closeTo(board.y, initial.y + 50);
  assert.deepEqual(plain(app.state.tokens), tokens);
  await client.sendCommand({ type: "lock-resource", resourceType: "object", resourceId: board.id });
  const lockedRevision = app.state.revision, lockedEdge = $("objects-root").querySelector(`[data-object-id="${board.id}"] [data-mat-handle="right"]`);
  await dispatch(lockedEdge, "pointerdown", point(client, board.x + 820, board.y + 410));
  await dispatch(lockedEdge, "pointermove", point(client, board.x + 880, board.y + 410));
  await dispatch(lockedEdge, "pointerup", point(client, board.x + 880, board.y + 410));
  assert.equal(app.state.revision, lockedRevision);
});

test("focusing rotated boards and mixed selections accounts for panels and the hand drawer without shared mutations", async () => {
  const client = await loadClient(), { app, $, document, dispatch } = client;
  await add(client, "set:chess");
  const boardId = app.selection.id;
  client.vm(`app.previewModel.engineRoom.objects.get(${JSON.stringify(boardId)}).rotation = 35; syncPreviewState();`);
  const board = app.state.objects.find((value) => value.id === boardId), revision = app.state.revision;
  await dispatch($("open-library"), "click");
  $("library-panel").rect = { left: 80, top: 74, width: 320, height: 790 };
  await dispatch($("open-hand"), "click");
  $("selection-dock").rect = { left: 430, top: 530, width: 630, height: 60 };
  await dispatch(document.querySelector('[data-selection-action="focus-selection"]'), "click");
  assertFramed(client, boundsFor(client, "object", board), { left: 420, bottom: 394 });
  const token = app.state.tokens[0];
  client.vm(`setGroupSelection(${JSON.stringify([{ type: "object", id: board.id }, { type: "token", id: token.id }])})`);
  await dispatch(document.body, "keydown", { key: "F", shiftKey: true });
  assertFramed(client, boundsFor(client, "object", board), { left: 420, bottom: 394 });
  assertFramed(client, boundsFor(client, "token", token), { left: 420, bottom: 394 });
  const camera = plain(app.camera);
  await dispatch($("quick-chat-input"), "keydown", { key: "F", shiftKey: true });
  assert.deepEqual(plain(app.camera), camera);
  assert.equal(app.state.revision, revision);
});

test("Tab frames an offscreen private card through the camera without changing selection or shared state", async () => {
  const client = await loadClient(), { app, $, document, dispatch } = client;
  const card = app.state.cards.find((value) => value.zone === "hand" && value.ownerId === app.state.you.id);
  const node = $("cards-root").querySelector(`[data-card-id="${card.id}"]`), flip = node.querySelector("[data-card-action]");
  const bounds = boundsFor(client, "card", { ...card, ...app.cardPositions.get(card.id) });
  client.selectResource("token", app.state.tokens[0].id);
  client.vm("app.camera = { x: -2400, y: -1200, scale: .8 }; applyCamera();");
  const initial = plain(app.camera), selection = plain(app.selection), state = plain(app.state), intent = app.selectionIntent;
  renderBounds(client, node, bounds);
  await dispatch(flip, "focusin");
  assert.deepEqual(plain(app.camera), initial, "ordinary focus does not move the camera");
  await dispatch(document.body, "keydown", { key: "Tab" });
  await dispatch(flip, "focusin");
  assertFramed(client, bounds);
  assert.equal(app.camera.scale, initial.scale, "keyboard navigation never zooms in");
  assert.deepEqual(plain(app.selection), selection);
  assert.deepEqual(plain(app.state), state, "framing is local and never exposes or moves the private card");
  assert.equal(app.selectionIntent, intent + 1, "Tab supersedes a delayed resource-add receipt");
  const framed = plain(app.camera);
  renderBounds(client, node, bounds);
  await dispatch(flip, "keydown", { key: "Tab", shiftKey: true });
  await dispatch(node, "focusin");
  assert.deepEqual(plain(app.camera), framed, "a resource already in view stays still");
});

test("Tab frames a large rotated board above the hand drawer and clear of an open resource shelf", async () => {
  const client = await loadClient(), { app, $, document, dispatch } = client;
  await add(client, "set:chess");
  const id = app.selection.id;
  client.vm(`app.previewModel.engineRoom.objects.get(${JSON.stringify(id)}).rotation = 35; syncPreviewState();`);
  await dispatch($("open-library"), "click");
  $("library-panel").rect = { left: 80, top: 74, width: 320, height: 790 };
  await dispatch($("open-hand"), "click");
  $("selection-dock").rect = { left: 430, top: 530, width: 630, height: 60 };
  client.vm("app.camera = { x: -900, y: 500, scale: 1 }; applyCamera();");
  const board = app.state.objects.find((value) => value.id === id), bounds = boundsFor(client, "object", board);
  const node = $("objects-root").querySelector(`[data-object-id="${id}"]`), revision = app.state.revision;
  renderBounds(client, node, bounds);
  await dispatch(document.body, "keydown", { key: "Tab" });
  await dispatch(node, "focusin");
  assertFramed(client, bounds, { left: 420, bottom: 394 });
  assert.ok(app.camera.scale < 1, "a large board may zoom out to fit");
  assert.equal(app.state.revision, revision);
});

test("keyboard framing intent is consumed once and cannot outlive pointer input, blur or its event turn", async () => {
  const client = await loadClient(), { app, $, document, dispatch } = client;
  const node = $("token-root").querySelector(".table-token");
  node.rect = { left: -200, top: -180, width: 40, height: 40 };
  const camera = plain(app.camera);
  for (const cancel of [
    () => dispatch($("quick-chat-input"), "focusin"),
    async () => { await dispatch(node, "pointerdown"); client.cancelDrag(); },
    () => dispatch(document.body, "blur"),
    () => dispatch(document.body, "keydown", { key: "Shift" }),
    () => client.advanceTimers(0)
  ]) {
    await dispatch(document.body, "keydown", { key: "Tab" });
    await cancel();
    assert.equal(app.keyboardFocusPending, false);
    await dispatch(node, "focusin");
    assert.deepEqual(plain(app.camera), camera);
  }
  for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
    await dispatch(document.body, "keydown", { key: "Tab", [modifier]: true });
    await dispatch(node, "focusin");
    assert.deepEqual(plain(app.camera), camera);
  }
  for (const interaction of ["drag", "pan", "marquee", "touchNavigation", "handTouch"]) {
    app[interaction] = {};
    await dispatch(document.body, "keydown", { key: "Tab" });
    await dispatch(node, "focusin");
    assert.equal(app.keyboardFocusPending, false);
    assert.deepEqual(plain(app.camera), camera, `${interaction} retains its camera`);
    app[interaction] = null;
  }
  app.tableTouches.set(9, { x: 20, y: 30 });
  await dispatch(document.body, "keydown", { key: "Tab" });
  await dispatch(node, "focusin");
  assert.deepEqual(plain(app.camera), camera);
});
