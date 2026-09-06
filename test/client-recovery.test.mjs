import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRoom, projectRoom } from "../src/room-engine.mjs";
import { loadClient } from "./helpers/client-dom.mjs";
import { createLocalStoreDouble } from "./helpers/local-store.mjs";
import { createRoomLink } from "./helpers/room-link.mjs";

const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
function fixture(t) {
  const room = createRoom({ code: "SAV-123", pack, hostSecret: "client-recovery-secret", randomizeDeck: false });
  const link = createRoomLink(room), indexedDB = createLocalStoreDouble(), storage = new Map();
  t.after(() => link.transport.close());
  const client = (extra = {}) => loadClient({ indexedDB, storage, fetch: link.fetch, EventSource: link.EventSource,
    url: `https://table.example/?room=${room.code}&host=${room.hostSecret}`, ...extra });
  return { room, link, indexedDB, storage, client };
}

test("a lost command acknowledgement retries the same id and refresh resumes its pending receipt", async (t) => {
  const f = fixture(t), client = await f.client();
  assert.equal(client.app.connectionOpen, true);
  f.link.dropNextReceipt = true;
  void client.sendCommand({ type: "draw" });
  await client.settle();
  assert.equal(f.room.deckOrder.length, 53);
  assert.equal(client.recovery.pendingCount, 1);
  const commandId = f.link.commands[0].id;
  // Reload the same tab, preserving its seat reference and pending command store.
  const refreshed = await f.client({ url: `https://table.example/?room=${f.room.code}` });
  await refreshed.settle();
  assert.equal(refreshed.app.state.you.id, client.app.state.you.id);
  assert.equal(f.room.deckOrder.length, 53);
  assert.equal(refreshed.recovery.pendingCount, 0);
  assert.ok(f.link.commands.length >= 2);
  assert.ok(f.link.commands.every((message) => message.id === commandId));
});

test("offline refresh keeps the authorized table and camera visible and reconnects after repeated failures", async (t) => {
  const f = fixture(t), client = await f.client();
  await client.sendCommand({ type: "draw" });
  client.vm("app.camera = { x: 123, y: -456, scale: 0.8 }; applyCamera();");
  await client.advanceTimers(500);
  const playerId = client.app.state.you.id, cardId = client.app.state.cards[0].id;
  f.link.disconnect();
  const refreshed = await f.client({ url: `https://table.example/?room=${f.room.code}` });
  await refreshed.settle();
  assert.equal(refreshed.app.state.you.id, playerId);
  assert.equal(refreshed.app.state.cards[0].id, cardId);
  assert.equal(refreshed.app.camera.x, 123);
  await refreshed.advanceTimers(60000);
  assert.equal(refreshed.$("room-screen").classList.contains("is-hidden"), false);
  assert.equal(refreshed.app.connectionOpen, false);
  assert.equal(refreshed.$("draw-card").disabled, true);
  assert.equal(refreshed.app.terminalOffline, false);
  f.link.online = true;
  await refreshed.advanceTimers(18000);
  assert.equal(refreshed.app.connectionOpen, true);
  assert.equal(refreshed.app.state.you.id, playerId);
  assert.equal(refreshed.app.state.cards[0].id, cardId);
});

test("undo rejects unknown old operations while an existing receipt still acknowledges without replay", async (t) => {
  const f = fixture(t), client = await f.client(), state = client.app.state;
  const request = async (message) => {
    const response = await f.link.fetch("https://table.example/api/message", { method: "POST", body: JSON.stringify({
      roomCode: f.room.code, sessionToken: client.app.sessionToken, message
    }) });
    return response.json();
  };
  const original = { type: "command", id: "before-undo-draw", gameId: f.room.gameId, epoch: f.room.epoch, baseRevision: state.revision, command: { type: "draw" } };
  assert.equal((await request(original)).ok, true);
  assert.equal(f.room.deckOrder.length, 53);
  assert.equal((await request({ ...original, id: "undo-original-draw", command: { type: "undo" } })).ok, true);
  assert.equal(f.room.deckOrder.length, 54);
  assert.equal((await request(original)).duplicate, true);
  assert.equal(f.room.deckOrder.length, 54);
  assert.equal((await request({ ...original, id: "unknown-delayed-draw" })).code, "GAME_CHANGED");
  assert.equal(f.room.deckOrder.length, 54);
  assert.equal((await request({ ...original, id: "current-new-draw", epoch: f.room.epoch, baseRevision: f.room.revision })).ok, true);
  assert.equal(f.room.deckOrder.length, 53);
});

test("multiple local identities require a seat choice and a fresh guest tab never resumes the host", async (t) => {
  const f = fixture(t), host = await f.client();
  await host.advanceTimers(250);
  const guest = await f.client({ storage: new Map(), url: `https://table.example/?room=${f.room.code}&fresh=1&autojoin=朋友` });
  await guest.advanceTimers(250);
  assert.equal(guest.app.state.you.role, "guest");
  assert.notEqual(guest.app.state.you.id, host.app.state.you.id);
  const undecided = await f.client({ storage: new Map(), url: `https://table.example/?room=${f.room.code}` });
  assert.equal(undecided.app.state, null);
  assert.equal(undecided.$("saved-seat-choices").children.length, 2);
  assert.equal(undecided.$("join-screen").classList.contains("is-hidden"), false);
  const link = guest.recovery.personalLink();
  assert.equal(new URL(link).searchParams.get("host"), null);
  const resumed = await f.client({ storage: new Map(), url: link });
  assert.equal(resumed.app.state.you.id, guest.app.state.you.id);
  assert.equal(resumed.context.location.search.includes("seat="), false);
});

test("save UI defaults to a complete game and makes a recoverable backup before restoring", async () => {
  const client = await loadClient({ indexedDB: createLocalStoreDouble() });
  await client.dispatch(client.$("open-saves"), "click");
  client.$("save-name").value = "今晚的牌局";
  await client.dispatch(client.$("save-form"), "submit");
  const records = await client.vm("ParlorVault.listScenes()");
  assert.equal(records[0].scene.format, "parlor.game");
  const before = client.app.state.cards.filter((card) => card.zone === "hand").length;
  await client.sendCommand({ type: "draw" });
  await client.dispatch(client.$("saved-scenes").querySelector(".saved-scene-load"), "click");
  await client.settle();
  assert.equal(client.app.state.cards.filter((card) => card.zone === "hand").length, before);
  const after = await client.vm("ParlorVault.listScenes()");
  assert.ok(after.some((record) => record.name.startsWith("恢复前")));
  assert.equal(after.length, 2);
});
