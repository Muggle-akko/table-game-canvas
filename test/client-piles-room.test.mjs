import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { createRoom } from "../src/room-engine.mjs";
import { createRoomPersistence, readRoomCheckpoint } from "../src/room-persistence.mjs";
import { loadClient } from "./helpers/client-dom.mjs";
import { createLocalStoreDouble } from "./helpers/local-store.mjs";
import { createRoomLink } from "./helpers/room-link.mjs";

// Independent production clients, production transport and (where requested)
// real checkpoint files. The DOM, IndexedDB and HTTP/SSE endpoints are doubles;
// this suite does not open sockets or establish browser/network acceptance.
const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const plain = (value) => JSON.parse(JSON.stringify(value));
async function until(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await pause(5);
  assert.ok(predicate(), message);
}
function unload(client) {
  if (!client) return;
  client.app.closingStream = true;
  client.app.connectionOpen = false;
  client.app.eventSource?.close();
}
async function fixture(t, { durable = false } = {}) {
  const f = { room: createRoom({ code: "PLR-456", hostSecret: "pile-client-test-secret", pack }), clients: [], identities: [] };
  const directory = durable ? await mkdtemp(join(tmpdir(), "parlor-pile-clients-")) : null;
  if (durable) f.persistence = await createRoomPersistence(f.room, { directory });
  f.link = createRoomLink(f.room, { persistence: f.persistence });
  t.after(async () => {
    f.clients.forEach(unload);
    await f.link.transport.flush(); f.link.transport.close();
    await f.persistence?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  f.load = async (index, { offline = false, first = false } = {}) => {
    unload(f.clients[index]);
    const identity = f.identities[index];
    const url = `https://table.example/?room=${f.room.code}${first ? index === 0 ? `&host=${f.room.hostSecret}` : `&fresh=1&autojoin=朋友${index}` : ""}`;
    const client = await loadClient({ indexedDB: identity.indexedDB, storage: identity.storage, url,
      fetch: identity.link.fetch, EventSource: identity.link.EventSource, width: index === 2 ? 390 : 1440 });
    f.clients[index] = client;
    await until(() => offline ? Boolean(client.app.state) : client.app.connectionOpen, "client should load its seat or authorized offline snapshot");
    return client;
  };
  f.restart = async () => {
    f.clients.forEach(unload);
    await f.link.transport.flush(); f.link.transport.close();
    await f.persistence.close();
    f.room = await readRoomCheckpoint(f.persistence.path);
    f.persistence = await createRoomPersistence(f.room, { directory });
    f.link = createRoomLink(f.room, { persistence: f.persistence });
    for (const identity of f.identities) identity.link = f.link.createPeer();
  };
  for (let index = 0; index < 3; index++) {
    f.identities.push({ indexedDB: createLocalStoreDouble(), storage: new Map(), link: f.link.createPeer() });
    await f.load(index, { first: true });
  }
  return f;
}
async function assertSynced(f) {
  await until(() => f.clients.every((client) => client.app.state.revision === f.room.revision), "all clients receive the same committed revision");
  const expected = plain(f.clients[0].app.state.decks);
  for (const client of f.clients) {
    assert.deepEqual(plain(client.app.state.decks), expected);
    for (const card of client.app.state.cards) if (card.zone === "hand" && card.ownerId !== client.app.state.you.id) assert.equal(card.face, null);
    assert.equal(client.app.state.holdem, undefined);
    assert.equal(client.$("holdem-panel"), null);
  }
}

test("three independent clients can freely issue chips, merge piles and spread cards with matching top faces", async (t) => {
  const f = await fixture(t), host = f.clients[0], guest = f.clients[1];
  await guest.sendCommand({ type: "spawn-resource", resourceId: "chip-100", x: 700, y: 500 });
  const chip = guest.app.state.tokens[0];
  await guest.sendCommand({ type: "duplicate-resource", resourceType: "token", resourceId: chip.id });
  await host.sendCommand({ type: "draw-public", x: 600, y: 400, faceUp: true });
  const card = host.app.state.cards[0];
  await guest.sendCommand({ type: "stack-onto", resourceType: "card", resourceId: card.id, targetType: "deck", targetId: "main" });
  await assertSynced(f);
  assert.equal(f.clients[2].app.state.decks[0].top.face.label, card.face.label);
  await guest.sendCommand({ type: "duplicate-resource", resourceType: "deck", resourceId: "main" });
  const copy = guest.app.state.decks.at(-1);
  await guest.sendCommand({ type: "stack-onto", resourceType: "deck", resourceId: copy.id, targetType: "deck", targetId: "main" });
  await assertSynced(f);
  assert.equal(f.clients[2].app.state.decks[0].count, 108);
  await guest.sendCommand({ type: "spread-deck", layout: "row" });
  await assertSynced(f);
  assert.equal(f.clients[2].app.state.cards.length, 108);
  assert.equal(f.clients[2].app.state.cards.filter((entry) => entry.faceUp).length, 2);
  assert.equal(f.clients[2].app.state.tokens.filter((token) => token.symbol === "100").length, 2);
});

test("an unacknowledged top insertion survives checkpoint restart and retries without duplicating a card", async (t) => {
  const f = await fixture(t, { durable: true }), guest = f.clients[1], identity = f.identities[1];
  await guest.sendCommand({ type: "draw-public", x: 600, y: 400, faceUp: true });
  const card = guest.app.state.cards[0];
  for (const client of f.clients) await client.advanceTimers(250);
  identity.link.dropNextReceipt = true;
  void guest.sendCommand({ type: "stack-onto", resourceType: "card", resourceId: card.id, targetType: "deck", targetId: "main" });
  await until(() => !guest.app.connectionOpen && guest.recovery.pendingCount === 1, "the lost receipt remains retryable");
  const original = identity.link.commands.at(-1), order = [...f.room.deckOrder], historyCount = f.room.history.length;
  const seats = f.clients.map((client) => client.app.state.you.id);
  const disk = await readRoomCheckpoint(f.persistence.path);
  assert.equal(disk.cards.get(card.id).faceUp, true);
  assert.ok(disk.commandReceipts.has(`${seats[1]}:${original.id}`));
  await f.restart();
  assert.deepEqual(f.room.deckOrder, order);
  for (let index = 0; index < 3; index++) await f.load(index);
  await until(() => f.clients[1].recovery.pendingCount === 0, "the restarted server acknowledges the original drop");
  assert.equal(f.room.history.length, historyCount);
  assert.equal(f.room.deckOrder.filter((id) => id === card.id).length, 1);
  assert.deepEqual(f.clients.map((client) => client.app.state.you.id), seats);
  assert.ok(identity.link.responses.some((response) => response.payload.duplicate === true && response.payload.durable === true));
  await assertSynced(f);
  assert.equal(f.clients[2].app.state.decks[0].top.face.label, card.face.label);
  await f.clients[1].sendCommand({ type: "draw", deckId: "main" });
  await assertSynced(f);
  assert.equal(f.clients[0].app.state.cards[0].face, null);
  assert.equal(f.clients[1].app.state.cards[0].face.label, card.face.label);
});
