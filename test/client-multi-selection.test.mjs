import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { createRoom, exportRoomCheckpoint, roomFromCheckpoint } from "../src/room-engine.mjs";
import { loadClient } from "./helpers/client-dom.mjs";
import { createLocalStoreDouble } from "./helpers/local-store.mjs";
import { createRoomLink } from "./helpers/room-link.mjs";

// Production pointer handlers and room protocol; native browser hit-testing is
// checked separately in the disposable local room.
const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const plain = (value) => JSON.parse(JSON.stringify(value));
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < .000001, `${actual} should be close to ${expected}`);
const point = (client, x, y) => ({ clientX: client.app.camera.x + x * client.app.camera.scale, clientY: 58 + client.app.camera.y + y * client.app.camera.scale });
const nodeFor = (client, type, id) => client.document.querySelector(`#${type === "card" ? "cards" : type === "object" ? "objects" : type}-root [data-${type}-id="${id}"]`);
async function click(client, type, resource, shiftKey = false) {
  const node = nodeFor(client, type, resource.id), options = { ...point(client, resource.x + 20, resource.y + 20), shiftKey };
  await client.dispatch(node, "pointerdown", options); await client.dispatch(node, "pointerup", options); await client.dispatch(node, "click", options);
}
async function drag(client, type, resource, x, y, options = {}) {
  const node = nodeFor(client, type, resource.id);
  await client.dispatch(node, "pointerdown", { ...point(client, resource.x + 20, resource.y + 20), ...options });
  await client.dispatch(node, "pointermove", { ...point(client, x + 20, y + 20), ...options });
  const id = client.app.drag?.dragId;
  await client.dispatch(node, "pointerup", { ...point(client, x + 20, y + 20), ...options });
  return id;
}
async function until(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await pause(5);
  assert.ok(predicate(), message);
}

test("Shift clicking selects mixed resources, toggles membership and moves the formation without stacking", async () => {
  const client = await loadClient(), { app, dispatch } = client;
  const card = app.state.cards.find((card) => card.zone === "public"), object = app.state.objects.find((object) => object.kind === "note");
  await client.sendCommand({ type: "spawn-resource", resourceId: "chip-25", x: 1200, y: 550 });
  client.vm("clearSelection()");
  const token = app.state.tokens.at(-1), revision = app.state.revision;
  await click(client, "card", card); await click(client, "token", token, true); await click(client, "object", object, true);
  assert.equal(app.selection.type, "group"); assert.equal(app.selection.items.length, 3);
  assert.match(client.$("selection-title").textContent, /3 件/);
  for (const [type, value] of [["card", card], ["token", token], ["object", object]]) assert.ok(nodeFor(client, type, value.id).classList.contains("is-group-selected"));
  await click(client, "token", token, true); assert.equal(app.selection.items.length, 2);
  await click(client, "token", token, true); assert.equal(app.selection.items.length, 3);
  await dispatch(nodeFor(client, "card", card.id), "dblclick", { shiftKey: true });
  assert.equal(app.state.revision, revision, "selection must not flip cards or mutate the room");
  const previous = plain([app.state.cards.find((entry) => entry.id === card.id), app.state.tokens.find((entry) => entry.id === token.id), app.state.objects.find((entry) => entry.id === object.id)]);
  const undo = app.previewModel.engineRoom.undoStack.length, deck = app.state.decks[0], count = deck.count;
  client.document.hitTarget = nodeFor(client, "deck", deck.id);
  await drag(client, "card", previous[0], deck.x, deck.y);
  const next = [app.state.cards.find((entry) => entry.id === card.id), app.state.tokens.find((entry) => entry.id === token.id), app.state.objects.find((entry) => entry.id === object.id)];
  const dx = deck.x - previous[0].x, dy = deck.y - previous[0].y;
  next.forEach((value, index) => {
    closeTo(value.x, previous[index].x + dx); closeTo(value.y, previous[index].y + dy);
    assert.deepEqual({ ...plain(value), x: previous[index].x, y: previous[index].y }, previous[index]);
  });
  assert.equal(app.state.decks[0].count, count); assert.equal(app.selection.type, "group");
  assert.equal(app.previewModel.engineRoom.undoStack.length, undo + 1);
  assert.equal(app.pendingDrops.size, 0); assert.equal(client.$("drag-root").children.length, 0);
  await client.sendCommand({ type: "undo" });
  assert.equal(app.state.cards.find((entry) => entry.id === card.id).x, previous[0].x);
});

test("Shift marquee uses the current camera, skips hands and locks, and leaves normal panning available", async () => {
  const client = await loadClient(), { app, dispatch, $ } = client;
  await client.sendCommand({ type: "spawn-resource", resourceId: "chip-25", x: 600, y: 400 });
  const token = app.state.tokens.at(-1), card = app.state.cards.find((card) => card.zone === "public");
  await client.sendCommand({ type: "move-card", cardId: card.id, target: "public", x: 350, y: 300, rotation: 25 });
  await client.sendCommand({ type: "lock-resource", resourceType: "deck", resourceId: "main" });
  await dispatch($("zoom-in"), "click");
  await dispatch($("viewport"), "pointerdown", { clientX: 300, clientY: 300 });
  await dispatch($("viewport"), "pointermove", { clientX: 350, clientY: 320 });
  await dispatch($("viewport"), "pointerup", { clientX: 350, clientY: 320 });
  const camera = plain(app.camera), revision = app.state.revision;
  await dispatch($("viewport"), "pointerdown", { ...point(client, 220, 190), shiftKey: true });
  await dispatch($("viewport"), "pointermove", point(client, 1240, 720));
  assert.ok(app.marquee); assert.equal(app.pan, null); assert.equal($("selection-box").classList.contains("is-hidden"), false);
  await dispatch($("viewport"), "pointerup", point(client, 1240, 720));
  assert.equal(app.marquee, null); assert.equal($("selection-box").classList.contains("is-hidden"), true);
  assert.ok(app.selection.items.some((ref) => ref.id === card.id)); assert.ok(app.selection.items.some((ref) => ref.id === token.id));
  assert.ok(!app.selection.items.some((ref) => ref.id === "main"));
  assert.ok(!app.selection.items.some((ref) => app.state.cards.some((card) => card.id === ref.id && card.zone === "hand")));
  assert.deepEqual(plain(app.camera), camera); assert.equal(app.state.revision, revision);
  await dispatch(client.document.body, "keydown", { key: "Escape" }); assert.equal(app.selection, null);
  await dispatch($("viewport"), "pointerdown", { clientX: 300, clientY: 300 });
  await dispatch($("viewport"), "pointermove", { clientX: 390, clientY: 300 });
  await dispatch($("viewport"), "pointerup", { clientX: 390, clientY: 300 });
  assert.equal(app.camera.x, camera.x + 90);
});

test("marquee cancellation restores the previous selection and locks never partially move a group", async () => {
  const client = await loadClient(), { app, dispatch, $ } = client;
  await client.sendCommand({ type: "spawn-resource", resourceId: "chip-25", x: 600, y: 400 });
  const token = app.state.tokens.at(-1), card = app.state.cards.find((card) => card.zone === "public");
  await click(client, "card", card); const previous = plain(app.selection);
  for (const cancel of ["Escape", "pointercancel", "lostpointercapture", "blur"]) {
    await dispatch($("viewport"), "pointerdown", { ...point(client, 150, 150), shiftKey: true });
    await dispatch($("viewport"), "pointermove", point(client, 1450, 780));
    assert.equal(app.selection.type, "group");
    await dispatch(cancel === "Escape" ? client.document.body : $("viewport"), cancel === "Escape" ? "keydown" : cancel, { key: "Escape" });
    assert.equal(app.marquee, null); assert.deepEqual(plain(app.selection), previous);
    await dispatch($("viewport"), "pointerup", point(client, 1450, 780));
    assert.deepEqual(plain(app.selection), previous);
  }
  await click(client, "token", token, true);
  await client.sendCommand({ type: "lock-resource", resourceType: "token", resourceId: token.id });
  const revision = app.state.revision;
  await drag(client, "card", card, card.x + 80, card.y + 70);
  assert.equal(app.drag, null); assert.equal(app.state.revision, revision);
  assert.match($("selection-meta").textContent, /锁定/);
  await click(client, "token", token, true);
  assert.equal(app.selection.items.length, 1);
  await drag(client, "card", card, card.x + 80, card.y + 70);
  closeTo(app.state.cards.find((entry) => entry.id === card.id).x, card.x + 80);
  assert.equal(app.state.tokens.find((entry) => entry.id === token.id).x, token.x);
});

test("framing an already selected card still enters bulk movement mode", async () => {
  const client = await loadClient(), { app, dispatch, $ } = client;
  const card = app.state.cards.find((card) => card.zone === "public");
  await click(client, "card", card);
  assert.equal(app.selection.type, "card");
  await dispatch($("viewport"), "pointerdown", { ...point(client, card.x - 25, card.y - 25), shiftKey: true });
  await dispatch($("viewport"), "pointermove", point(client, card.x + 120, card.y + 163));
  await dispatch($("viewport"), "pointerup", point(client, card.x + 120, card.y + 163));
  assert.equal(app.selection.type, "group");
  assert.deepEqual(plain(app.selection.items), [{ type: "card", id: card.id }]);
});

test("choosing a pile includes its members, and Shift hand drops retain the face-down gesture", async () => {
  const client = await loadClient(), { app } = client;
  for (const resourceId of ["chip-25", "chip-100"]) await client.sendCommand({ type: "spawn-resource", resourceId, x: 550, y: 450 });
  const chips = app.state.tokens.slice(-2);
  client.vm("clearSelection()");
  await click(client, "token", chips[0], true);
  assert.equal(app.selection.items.length, 2);
  await drag(client, "token", chips[1], 650, 520);
  app.state.tokens.filter((entry) => chips.some((chip) => chip.id === entry.id)).forEach((token) => closeTo(token.x, 650));
  const hand = app.state.cards.find((card) => card.ownerId === app.state.you.id);
  await drag(client, "card", hand, 1120, 640, { shiftKey: true });
  const moved = app.state.cards.find((entry) => entry.id === hand.id);
  assert.equal(moved.zone, "public"); assert.equal(moved.faceUp, false);
});

async function fixture(t) {
  const room = createRoom({ code: "BLK-123", hostSecret: "test-host", pack, randomizeDeck: false });
  const link = createRoomLink(room), guestLink = link.createPeer(), indexedDB = createLocalStoreDouble(), storage = new Map();
  const f = { room, link, guestLink, indexedDB, storage, clients: [], hold: false, holdCommand: "move-resources", held: [] };
  const fetch = async (url, options = {}) => {
    const message = options.body ? JSON.parse(options.body).message : null;
    if (f.hold && message?.type === "command" && message.command.type === f.holdCommand) await new Promise((resolve) => f.held.push(resolve));
    return link.fetch(url, options);
  };
  f.fetch = fetch;
  const host = await loadClient({ indexedDB, storage, url: `https://table.example/?room=${room.code}&host=${room.hostSecret}`, fetch, EventSource: link.EventSource });
  await until(() => host.app.connectionOpen, "host joined");
  const guest = await loadClient({ indexedDB: createLocalStoreDouble(), url: `https://table.example/?room=${room.code}&fresh=1&autojoin=朋友`, fetch: guestLink.fetch, EventSource: guestLink.EventSource });
  await until(() => guest.app.connectionOpen, "guest joined");
  f.clients.push(host, guest);
  t.after(() => { for (const client of f.clients) { client.app.closingStream = true; client.app.connectionOpen = false; client.app.eventSource?.close(); } f.held.forEach((resolve) => resolve()); link.transport.close(); });
  await host.sendCommand({ type: "draw-public", x: 350, y: 350 });
  await host.sendCommand({ type: "spawn-resource", resourceId: "chip-25", x: 650, y: 400 });
  host.vm("clearSelection()");
  await click(host, "card", host.app.state.cards[0], true); await click(host, "token", host.app.state.tokens.at(-1), true);
  return Object.assign(f, { host, guest });
}

test("a delayed group drop holds all sources on both clients and a lost receipt never repeats the move", async (t) => {
  const f = await fixture(t), { host, guest, room } = f;
  const card = host.app.state.cards[0], token = host.app.state.tokens.at(-1);
  f.hold = true;
  await drag(host, "card", card, 470, 490);
  await until(() => f.held.length === 1 && guest.app.remoteDrops.size === 1, "group preview reaches the guest");
  assert.equal(guest.$("remote-drag-root").querySelector(".card-face"), null, "a covered card stays covered during the group preview");
  for (const [type, value] of [["card", card], ["token", token]]) {
    assert.ok(nodeFor(host, type, value.id).classList.contains("is-drop-source"));
    assert.ok(nodeFor(guest, type, value.id).classList.contains("is-remote-drop-source"));
    assert.ok(host.app.pendingCommands.has(`drop:${type}:${value.id}`));
  }
  await guest.sendCommand({ type: "chat", text: "整理这一片" });
  await host.dispatch(host.$("viewport"), "pointerleave");
  assert.equal(guest.$("remote-drag-root").querySelectorAll(".drag-group").length, 1);
  await drag(host, "token", token, 1000, 650); assert.equal(f.held.length, 1, "pending members cannot be moved twice");
  f.hold = false; f.link.dropNextReceipt = true; const revision = room.revision;
  f.held[0]();
  await until(() => host.recovery.pendingCount === 1 && !host.app.connectionOpen, "the committed move waits for its receipt");
  closeTo(room.cards.get(card.id).x, 470); closeTo(room.tokens.get(token.id).x, token.x + 120);
  assert.equal(guest.$("remote-drag-root").children.length, 0);
  host.app.connectionOpen = true; host.recovery.retry();
  await until(() => host.recovery.pendingCount === 0 && host.app.pendingDrops.size === 0, "one receipt releases every selected resource");
  assert.equal(room.revision, revision + 1); assert.equal(host.app.pendingCommands.size, 0);
  assert.equal(nodeFor(host, "token", token.id).classList.contains("is-drop-source"), false);
});

test("concurrent locks reject the entire released group, and drag signals cannot expose private members", async (t) => {
  const f = await fixture(t), { host, guest, room } = f;
  const card = host.app.state.cards[0], token = host.app.state.tokens.at(-1);
  f.hold = true;
  await drag(host, "card", card, 470, 490);
  await until(() => f.held.length === 1, "group command is pending");
  await guest.sendCommand({ type: "lock-resource", resourceType: "token", resourceId: token.id });
  f.held[0]();
  await until(() => !host.app.pendingDrops.size, "rejected group rolls back");
  assert.equal(room.cards.get(card.id).x, card.x); assert.equal(room.tokens.get(token.id).x, token.x);
  assert.equal(host.$("drag-root").children.length, 0); assert.equal(guest.$("remote-drag-root").children.length, 0);
  await host.sendCommand({ type: "draw" });
  const hand = host.app.state.cards.find((card) => card.zone === "hand");
  const count = f.guestLink.events.filter((message) => message.type === "drag-drop").length;
  await f.link.fetch("https://table.example/api/message", { method: "POST", body: JSON.stringify({ roomCode: room.code, sessionToken: host.app.sessionToken,
    message: { type: "drag-drop", drag: { sourceType: "group", resourceId: card.id, anchorType: "card", dragId: "private-group", x: 600, y: 500, resources: [{ type: "card", id: card.id }, { type: "card", id: hand.id, face: { label: "secret" } }] } } }) });
  assert.equal(f.guestLink.events.filter((message) => message.type === "drag-drop").length, count);
  assert.equal(guest.app.state.cards.find((card) => card.id === hand.id).face, null);
});

test("refreshing a pending batch protects every selected member and reuses the original command", async (t) => {
  const f = await fixture(t), { host, room } = f;
  const card = host.app.state.cards[0], token = host.app.state.tokens.at(-1);
  f.hold = true;
  await drag(host, "card", card, 500, 510);
  await until(() => f.held.length === 1, "first batch is waiting");
  host.app.closingStream = true; host.app.eventSource.close(); host.app.connectionOpen = false;
  const reloaded = await loadClient({ indexedDB: f.indexedDB, storage: f.storage, url: `https://table.example/?room=${room.code}`, fetch: f.fetch, EventSource: f.link.EventSource });
  f.clients.push(reloaded);
  await until(() => reloaded.recovery.pendingCount === 1 && f.held.length === 2, "saved batch is restored");
  for (const [type, resource] of [["card", card], ["token", token]]) {
    assert.ok(reloaded.app.pendingCommands.has(`drop:${type}:${resource.id}`));
    await drag(reloaded, type, resource, 900, 700);
    assert.equal(reloaded.app.drag, null);
  }
  assert.equal(f.held.length, 2);
  const revision = room.revision;
  f.hold = false; f.held.forEach((resolve) => resolve());
  await until(() => reloaded.recovery.pendingCount === 0 && host.recovery.pendingCount === 0, "both receipts confirm the same batch");
  assert.equal(room.revision, revision + 1);
  closeTo(room.cards.get(card.id).x, 500); closeTo(room.tokens.get(token.id).x, token.x + 150);
  assert.equal(reloaded.app.pendingCommands.size, 0);
});

test("bulk controls adapt to tokens and mixed resources, preserve menus and retain edited content on return", async () => {
  const client = await loadClient(), { app, document, dispatch, $ } = client;
  for (const [resourceId, x] of [["chip-25", 850], ["chip-100", 1100]]) await client.sendCommand({ type: "spawn-resource", resourceId, x, y: 450 });
  const tokens = app.state.tokens.slice(-2), note = app.state.objects.find((value) => value.kind === "note");
  client.vm("clearSelection()");
  for (const token of tokens) await click(client, "token", token, true);
  const action = (name) => document.querySelector(`[data-selection-action="${name}"]`);
  assert.ok(action("group-gather")); assert.ok(action("group-return")); assert.equal(action("group-shuffle"), null);
  await dispatch(action("group-gather"), "click");
  const gathered = app.state.tokens.filter((token) => tokens.some((original) => original.id === token.id));
  assert.equal(gathered[0].x, gathered[1].x); assert.equal(app.selection.items.length, 2);
  await dispatch(action("group-spread-grid"), "click");
  assert.notEqual(app.state.tokens.find((token) => token.id === tokens[0].id).x, app.state.tokens.find((token) => token.id === tokens[1].id).x);
  const menu = $("selection-actions").querySelector("details"); menu.setAttribute("open", "");
  action("group-lock").focus();
  await client.sendCommand({ type: "chat", text: "保留批量菜单" });
  assert.ok($("selection-actions").querySelector("details").hasAttribute("open"));
  assert.equal(document.activeElement.dataset.selectionAction, "group-lock");
  await dispatch(action("group-lock"), "click");
  assert.ok(action("group-return").disabled); assert.match(action("group-lock").textContent, /解锁全部/);
  await dispatch(action("group-lock"), "click");
  await client.sendCommand({ type: "edit-resource", resourceType: "object", resourceId: note.id, text: "今晚按这张指引玩" });
  await click(client, "object", app.state.objects.find((value) => value.id === note.id), true);
  assert.equal(action("group-gather"), null); assert.equal(action("group-shuffle"), null);
  const undo = app.previewModel.engineRoom.undoStack.length;
  await dispatch(action("group-return"), "click");
  assert.equal(app.selection, null); assert.equal(app.state.objects.some((value) => value.id === note.id), false);
  assert.equal(app.state.tokens.some((value) => tokens.some((token) => token.id === value.id)), false);
  assert.ok([...app.previewModel.engineRoom.templates.values()].some((entry) => entry.resource.text === "今晚按这张指引玩"));
  assert.equal(app.previewModel.engineRoom.undoStack.length, undo + 1);
  await client.sendCommand({ type: "undo" });
  assert.equal(app.state.objects.find((value) => value.id === note.id).text, "今晚按这张指引玩");
});

test("selected cards keep their selection through shuffle, spread and flipping before returning to the library", async () => {
  const client = await loadClient(), { app, document, dispatch } = client;
  await client.sendCommand({ type: "draw-public", x: 900, y: 400 });
  const cards = app.state.cards.filter((card) => card.zone === "public"), privateCards = plain(app.state.cards.filter((card) => card.zone === "hand"));
  client.vm("clearSelection()"); for (const card of cards) await click(client, "card", card, true);
  const action = (name) => document.querySelector(`[data-selection-action="${name}"]`);
  assert.match(client.$("selection-title").textContent, /2 张牌/);
  assert.match(action("group-shuffle").title, /保留.*正反面/);
  await dispatch(action("group-shuffle"), "click");
  assert.equal(app.selection.type, "group"); assert.equal(app.selection.items.length, 2);
  assert.ok(app.selection.items.every((ref) => !cards.some((card) => card.id === ref.id)));
  assert.deepEqual(app.state.cards.filter((card) => card.zone === "public").map((card) => card.faceUp).sort(), cards.map((card) => card.faceUp).sort());
  await dispatch(action("group-spread-row"), "click");
  assert.equal(app.selection.items.length, 2);
  const spread = app.state.cards.filter((card) => card.zone === "public"); assert.notEqual(spread[0].x, spread[1].x);
  await dispatch(action("group-face-down"), "click");
  assert.ok(app.state.cards.filter((card) => card.zone === "public").every((card) => !card.faceUp));
  await dispatch(action("group-face-up"), "click");
  assert.ok(app.state.cards.filter((card) => card.zone === "public").every((card) => card.faceUp));
  await dispatch(action("group-return"), "click");
  assert.equal(app.selection, null); assert.deepEqual(plain(app.state.cards), privateCards);
  assert.equal(app.state.templates.find((entry) => entry.kind === "deck").count, 2);
});

test("a pending shuffle protects the selected cards and restores its exact selection after a lost receipt", async (t) => {
  const f = await fixture(t), { host, guest, room } = f;
  await host.sendCommand({ type: "draw-public", x: 550, y: 350 });
  const cards = host.app.state.cards.filter((card) => card.zone === "public");
  host.vm(`setGroupSelection(${JSON.stringify(cards.map((card) => ({ type: "card", id: card.id })))})`);
  f.hold = true; f.holdCommand = "shuffle-resources";
  host.runSelectionAction("group-shuffle");
  await until(() => f.held.length === 1, "shuffle is waiting");
  for (const card of cards) assert.ok(host.app.pendingCommands.has(`drop:card:${card.id}`));
  assert.equal(host.document.querySelector('[data-selection-action="group-return"]').disabled, true);
  await drag(host, "card", cards[0], 1000, 700); assert.equal(host.app.drag, null);
  host.runSelectionAction("group-gather"); assert.equal(f.held.length, 1);
  const revision = room.revision;
  f.hold = false; f.link.dropNextReceipt = true; f.held[0]();
  await until(() => host.recovery.pendingCount === 1 && !host.app.connectionOpen, "only the acknowledgement was lost");
  const receipt = [...room.commandReceipts.values()].at(-1);
  assert.equal(receipt.selectedResources.length, 2);
  const restored = roomFromCheckpoint(plain(exportRoomCheckpoint(room)));
  assert.deepEqual(plain([...restored.commandReceipts.values()].at(-1).selectedResources), plain(receipt.selectedResources));
  assert.ok(guest.app.state.cards.every((card) => !card.face), "covered cards remain covered on the other seat");
  host.app.connectionOpen = true; host.recovery.retry();
  await until(() => host.recovery.pendingCount === 0 && host.app.selection?.items.length === 2, "the original selection is rekeyed and restored once");
  assert.equal(room.revision, revision + 1); assert.equal(host.app.pendingCommands.size, 0);
  assert.deepEqual(plain(host.app.selection.items), plain(receipt.selectedResources));
});

test("returning resources rejects concurrent locks and a later selection is not cleared by the receipt", async (t) => {
  const f = await fixture(t), { host, guest, room } = f;
  const card = host.app.state.cards[0], token = host.app.state.tokens.at(-1);
  f.hold = true; f.holdCommand = "return-resources";
  host.runSelectionAction("group-return");
  await until(() => f.held.length === 1, "return command is waiting");
  await guest.sendCommand({ type: "lock-resource", resourceType: "token", resourceId: token.id });
  f.held[0]();
  await until(() => !host.recovery.pendingCount, "the whole return is rejected");
  assert.ok(room.cards.has(card.id)); assert.ok(room.tokens.has(token.id)); assert.equal(room.templates.size, 0);
  assert.ok(host.document.querySelector('[data-selection-action="group-return"]').disabled);
  await guest.sendCommand({ type: "lock-resource", resourceType: "token", resourceId: token.id });
  host.runSelectionAction("group-return");
  await until(() => f.held.length === 2, "return is retried after unlocking");
  host.selectResource("deck", "main");
  f.hold = false; f.held[1]();
  await until(() => !host.recovery.pendingCount, "the return completes");
  assert.equal(room.cards.has(card.id), false); assert.equal(room.tokens.has(token.id), false);
  assert.deepEqual(plain(host.app.selection), { type: "deck", id: "main" });
  assert.equal(guest.app.state.cards.some((value) => value.id === card.id), false);
  assert.equal(guest.app.state.templates.length, 1);
});

test("a return resumed after refresh keeps every member protected and creates one saved resource", async (t) => {
  const f = await fixture(t), { host, room } = f;
  const selection = plain(host.app.selection.items);
  f.hold = true; f.holdCommand = "return-resources";
  host.runSelectionAction("group-return");
  await until(() => f.held.length === 1, "return is pending");
  host.app.closingStream = true; host.app.eventSource.close(); host.app.connectionOpen = false;
  const reloaded = await loadClient({ indexedDB: f.indexedDB, storage: f.storage, url: `https://table.example/?room=${room.code}`, fetch: f.fetch, EventSource: f.link.EventSource });
  f.clients.push(reloaded);
  await until(() => reloaded.recovery.pendingCount === 1 && f.held.length === 2, "the batch is restored");
  for (const ref of selection) assert.ok(reloaded.app.pendingCommands.has(`drop:${ref.type}:${ref.id}`));
  const revision = room.revision;
  f.hold = false; f.held.forEach((resolve) => resolve());
  await until(() => reloaded.recovery.pendingCount === 0 && host.recovery.pendingCount === 0, "both requests resolve to the same return");
  assert.equal(room.revision, revision + 1); assert.equal(room.templates.size, 1);
  assert.equal(reloaded.app.pendingCommands.size, 0);
});
