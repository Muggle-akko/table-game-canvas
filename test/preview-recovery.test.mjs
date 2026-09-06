import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRoom, joinRoom, applyCommand, exportRoomGame } from "../src/room-engine.mjs";
import { loadClient } from "./helpers/client-dom.mjs";
import { createLocalStoreDouble } from "./helpers/local-store.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const saved = (client, id = client.app.previewPersistence.id) => client.vm(`ParlorVault.getPreview(${JSON.stringify(id)})`);
const deckOrders = (client) => plain([...client.app.previewModel.engineRoom.decks.values()].map((deck) => [deck.id, deck.order]));

test("preview refresh restores exact private cards, positions, poker decisions, chat and camera", async () => {
  const indexedDB = createLocalStoreDouble(), client = await loadClient({ indexedDB });
  await client.previewRecovery.flush();
  await client.sendCommand({ type: "draw" });
  const card = client.app.state.cards.find((card) => card.ownerId === client.app.state.you.id);
  await client.sendCommand({ type: "move-card", cardId: card.id, target: "hand", x: 430, y: 950, rotation: 30 });
  await client.sendCommand({ type: "rename-player", name: "明晚继续" });
  await client.sendCommand({ type: "holdem-setup" });
  await client.sendCommand({ type: "holdem-start" });
  await client.sendCommand({ type: "holdem-action", action: "raise", to: 70 });
  await client.sendCommand({ type: "chat", text: "这手明天接着来" });
  client.vm("app.camera = { x: -500, y: 270, scale: .7 }; applyCamera();");
  await client.advanceTimers(350);
  assert.equal(client.app.previewPersistence.pending, false);
  const expected = { gameId: client.app.state.room.gameId, poker: plain(client.app.state.holdem), decks: deckOrders(client), cards: plain(client.app.state.cards) };
  const refreshed = await loadClient({ indexedDB });
  assert.equal(refreshed.app.state.room.gameId, expected.gameId);
  assert.deepEqual(plain(refreshed.app.state.holdem), expected.poker);
  assert.deepEqual(deckOrders(refreshed), expected.decks);
  assert.deepEqual(plain(refreshed.app.state.cards), expected.cards);
  assert.deepEqual(plain(refreshed.app.camera), { x: -500, y: 270, scale: .7 });
  assert.equal(refreshed.app.state.you.name, "明晚继续");
  assert.equal(refreshed.app.state.messages.at(-1).text, "这手明天接着来");
  assert.equal(refreshed.app.state.canUndo, false, "a resumed preview starts a new undo chain");
  assert.equal(refreshed.$("room-notices").children.length, 0, "resuming does not replay old operation notices");
  refreshed.vm("app.camera.x = 90; applyCamera(); document.visibilityState = 'hidden';");
  await refreshed.dispatch(refreshed.document, "visibilitychange");
  assert.equal((await saved(refreshed)).camera.x, 90, "backgrounding flushes the pending camera save");
});

test("concurrent preview tabs save independent copies instead of overwriting each other's table", async () => {
  const indexedDB = createLocalStoreDouble(), first = await loadClient({ indexedDB });
  await first.previewRecovery.flush();
  const second = await loadClient({ indexedDB });
  const count = first.app.state.deck.count;
  assert.equal(second.app.state.room.gameId, first.app.state.room.gameId);
  await Promise.all([first.sendCommand({ type: "draw" }), second.sendCommand({ type: "rename-player", name: "另一张桌" })]);
  assert.notEqual(first.app.previewPersistence.id, second.app.previewPersistence.id);
  assert.equal(first.app.state.deck.count, count - 1);
  assert.equal(second.app.state.deck.count, count);
  const reloadedFirst = await loadClient({ indexedDB });
  const reloadedSecond = await loadClient({ indexedDB, url: second.context.location.href });
  assert.equal(reloadedFirst.app.state.deck.count, count - 1);
  assert.equal(reloadedFirst.app.state.you.name, "房主A");
  assert.equal(reloadedSecond.app.state.deck.count, count);
  assert.equal(reloadedSecond.app.state.you.name, "另一张桌");
  assert.equal(new URL(reloadedSecond.app.state.room.shareUrl).searchParams.has("local"), false);
  await reloadedFirst.dispatch(reloadedFirst.$("open-saves"), "click");
  const copy = reloadedFirst.$("saved-previews").querySelector(`[data-preview-id="${second.app.previewPersistence.id}"]`);
  assert.ok(copy, "the independent copy can be found from the saves panel");
  await reloadedFirst.dispatch(copy, "click");
  assert.equal(new URL(reloadedFirst.context.location.href).searchParams.get("local"), second.app.previewPersistence.id.slice("preview:".length));
});

test("a failed preview write preserves the live change, reports it and retries without losing the old save", async () => {
  const indexedDB = createLocalStoreDouble(), client = await loadClient({ indexedDB });
  await client.previewRecovery.flush();
  const previous = await saved(client), count = client.app.state.deck.count;
  indexedDB.failWrites = true;
  assert.equal(await client.sendCommand({ type: "draw" }), true, "the mutation already happened in the local table");
  assert.equal(client.app.state.deck.count, count - 1);
  assert.ok(client.app.previewPersistence.error);
  assert.equal((await saved(client)).generation, previous.generation);
  assert.equal(client.$("autosave-status").classList.contains("has-error"), true);
  assert.equal(client.previewRecovery.hasUnsavedChanges(), true);
  const unload = await client.dispatch(client.document.body, "beforeunload");
  assert.equal(unload.defaultPrevented, true);
  await client.dispatch(client.$("open-saves"), "click");
  const gameId = client.app.state.room.gameId;
  await client.dispatch(client.$("new-preview"), "click");
  assert.equal(client.app.state.room.gameId, gameId, "a failed backup must not reset the live table");
  indexedDB.failWrites = false;
  await client.dispatch(client.$("retry-preview-save"), "click");
  assert.equal(client.app.previewPersistence.error, null);
  assert.equal(client.previewRecovery.hasUnsavedChanges(), false);
  assert.equal(client.$("autosave-status").classList.contains("has-error"), false);
  const refreshed = await loadClient({ indexedDB });
  assert.equal(refreshed.app.state.deck.count, count - 1);
});

test("starting a new preview first backs up the complete old game and the fresh table survives refresh", async () => {
  const indexedDB = createLocalStoreDouble(), client = await loadClient({ indexedDB });
  await client.sendCommand({ type: "draw" });
  const previousGame = client.app.state.room.gameId, count = client.app.state.deck.count;
  await client.dispatch(client.$("open-saves"), "click");
  let release;
  const delayedWrite = new Promise((resolve) => { release = resolve; });
  indexedDB.beforeWrite = (store) => store === "scenes" ? delayedWrite : undefined;
  const opening = client.dispatch(client.$("new-preview"), "click");
  await client.settle();
  assert.equal(client.app.previewTransition, true);
  assert.equal(await client.sendCommand({ type: "draw" }), false, "new actions cannot land between the backup and reset");
  assert.equal(client.app.state.deck.count, count);
  release(); await opening;
  assert.equal(client.app.previewTransition, false);
  const backups = await client.vm("ParlorVault.listScenes()");
  assert.equal(backups.length, 1); assert.ok(backups[0].name.startsWith("新开前"));
  assert.equal(backups[0].scene.gameId, previousGame);
  assert.notEqual(client.app.state.room.gameId, previousGame);
  assert.equal(client.app.state.deck.count, count + 1);
  assert.equal(client.$("room-notices").children.length, 0);
  const refreshed = await loadClient({ indexedDB });
  assert.equal(refreshed.app.state.room.gameId, client.app.state.room.gameId);
  assert.equal(refreshed.app.state.deck.count, count + 1);
});

test("corrupt preview records are preserved while a fresh independent table remains usable", async () => {
  const corrupt = { id: "preview:standard-54", format: "parlor.preview", version: 1, generation: 7, checkpoint: { code: "PREVIEW" } };
  const indexedDB = createLocalStoreDouble({ previews: [corrupt] }), client = await loadClient({ indexedDB });
  await client.previewRecovery.flush();
  assert.equal(client.app.state.deck.count, 51);
  assert.notEqual(client.app.previewPersistence.id, corrupt.id);
  assert.deepEqual(plain(await saved(client, corrupt.id)), corrupt);
  assert.ok(client.$("toast-region").textContent.includes("原记录已保留"));
  assert.equal(await client.sendCommand({ type: "draw" }), true);
});

test("imported multiplayer games cycle through actual private seats and resume the selected preview identity", async () => {
  const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
  const room = createRoom({ code: "OLD-123", hostSecret: "imported-game-secret", pack });
  const host = joinRoom(room, { hostSecret: room.hostSecret }).player;
  const guests = ["朋友一", "朋友二"].map((displayName) => joinRoom(room, { displayName }).player);
  for (const player of guests) applyCommand(room, player.id, { type: "draw" });
  const indexedDB = createLocalStoreDouble(), client = await loadClient({ indexedDB });
  await client.sendCommand({ type: "restore-game", game: exportRoomGame(room, host.id) });
  assert.ok(client.app.state.players.every((player) => player.online), "preview seats remain locally controllable after import");
  for (const guest of guests) {
    client.switchPreviewRole();
    assert.equal(client.app.state.you.id, guest.id);
    assert.ok(client.app.state.cards.find((card) => card.ownerId === guest.id).face);
    assert.equal(client.app.state.cards.find((card) => card.ownerId === guests.find((other) => other !== guest).id).face, null);
  }
  await client.previewRecovery.flush();
  const refreshed = await loadClient({ indexedDB });
  assert.equal(refreshed.app.state.you.id, guests[1].id);
  refreshed.switchPreviewRole();
  assert.equal(refreshed.app.state.you.role, "host");
  assert.ok(refreshed.app.state.cards.every((card) => !card.ownerId || card.face === null));
});
