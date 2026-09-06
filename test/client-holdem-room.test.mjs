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
  const f = { room: createRoom({ code: "TEX-456", hostSecret: "poker-client-test-secret", pack }), clients: [], identities: [] };
  const directory = durable ? await mkdtemp(join(tmpdir(), "parlor-poker-clients-")) : null;
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
async function use(client, id, type = "click") {
  assert.equal(client.$(id).disabled, false, `${id} should be available`);
  await client.dispatch(client.$(id), type);
  await until(() => client.recovery.pendingCount === 0 && client.app.pendingCommands.size === 0, `${id} should receive an acknowledgement`);
  await client.settle();
}
async function start(f) {
  await use(f.clients[0], "holdem-setup-form", "submit");
  await use(f.clients[0], "holdem-next");
  assert.equal(f.room.holdem.players.length, 3);
  assert.equal(f.room.holdem.phase, "preflop");
}
function assertPrivateView(view, identities) {
  for (const card of view.cards) {
    if (card.zone === "hand" && card.ownerId !== view.you.id || card.zone === "public" && !card.faceUp) assert.equal(card.face, null);
    if (card.zone === "hand" && card.ownerId === view.you.id || card.zone === "public" && card.faceUp) assert.ok(card.face);
    assert.notEqual(card.zone, "deck", "undealt cards do not travel to clients");
  }
  for (const player of identities) if (player.id !== view.you.id) assert.equal(JSON.stringify(view).includes(player.recoveryKey), false);
  if (view.holdem) {
    assert.equal("burns" in view.holdem, false);
    assert.equal(view.holdem.players.reduce((total, player) => total + player.stack + player.committed, 0), view.holdem.totalChips);
  }
}
function assertTable(f) {
  const expected = plain(f.clients[0].app.state.holdem); delete expected.legal;
  for (const client of f.clients) {
    const view = client.app.state, poker = plain(view.holdem); delete poker.legal;
    assert.equal(view.revision, f.room.revision);
    assert.deepEqual(poker, expected, "public poker state agrees across all clients");
    assertPrivateView(view, [...f.room.players.values()]);
    assert.equal(Boolean(view.holdem.legal), view.holdem.actorId === view.you.id);
    assert.equal(client.$("holdem-community").querySelectorAll(".poker-card:not(.is-back)").length, view.holdem.board.length);
    assert.equal(client.$("holdem-hole-cards").children.length, 2);
  }
}
function assertWirePrivacy(f) {
  for (const identity of f.identities) {
    const states = [...identity.link.events, ...identity.link.responses.map((response) => response.payload.state)].filter((state) => state?.type === "room-state");
    assert.ok(states.length > 0);
    for (const state of states) assertPrivateView(state, [...f.room.players.values()]);
  }
}
async function closeRound(f) {
  for (let count = 0; f.room.holdem.actorId && count < 12; count++) {
    const client = f.clients.find((candidate) => candidate.app.state.you.id === f.room.holdem.actorId);
    await use(client, "holdem-call"); assertTable(f);
  }
  assert.equal(f.room.holdem.actorId, null);
}

test("three production clients play one Hold'em hand with matching pots and individually private cards", async (t) => {
  const f = await fixture(t);
  await start(f); assertTable(f);
  const firstCards = f.room.holdem.players.flatMap((player) => player.holeCards);
  await closeRound(f);
  for (const phase of ["flop", "turn", "river"]) {
    await use(f.clients[0], "holdem-next");
    assert.equal(f.room.holdem.phase, phase); assertTable(f);
    await closeRound(f);
  }
  await use(f.clients[0], "holdem-next"); assertTable(f);
  assert.equal(f.room.holdem.phase, "complete");
  assert.equal(f.room.holdem.players.reduce((sum, player) => sum + player.stack, 0), 3000);
  for (const client of f.clients) for (const id of firstCards) assert.ok(client.app.state.cards.find((card) => card.id === id).face);
  await use(f.clients[0], "holdem-next"); assertTable(f);
  assert.equal(f.room.holdem.handNumber, 2);
  for (const client of f.clients) for (const id of firstCards) assert.equal(client.app.state.cards.some((card) => card.id === id), false);
  assertWirePrivacy(f);
});

test("a lost raise acknowledgement survives an offline reload while other players finish betting", async (t) => {
  const f = await fixture(t), host = f.clients[0], peer = f.identities[0].link;
  await start(f);
  await host.advanceTimers(250);
  const saved = plain(host.app.state.holdem), ownCards = plain(host.app.state.cards.filter((card) => card.ownerId === host.app.state.you.id));
  peer.dropNextReceipt = true;
  host.$("holdem-raise-to").value = "75";
  await host.dispatch(host.$("holdem-action-form"), "submit");
  await until(() => !host.app.connectionOpen && host.recovery.pendingCount === 1, "lost acknowledgement should leave a retryable raise");
  const sent = peer.commands.at(-1), raisedDecision = f.room.holdem.decision;
  assert.equal(f.room.holdem.currentBet, 75);
  peer.disconnect();
  for (const guest of f.clients.slice(1)) await use(guest, "holdem-call");
  assert.equal(f.room.holdem.actorId, null);
  const decision = f.room.holdem.decision, historyCount = f.room.history.length;
  const reloaded = await f.load(0, { offline: true });
  assert.equal(reloaded.app.connectionOpen, false);
  assert.equal(reloaded.app.state.holdem.decision, saved.decision);
  assert.deepEqual(plain(reloaded.app.state.cards.filter((card) => card.ownerId === reloaded.app.state.you.id)), ownCards);
  assert.equal(reloaded.$("holdem-call").disabled, true);
  peer.online = true;
  await reloaded.advanceTimers(1200);
  await until(() => reloaded.app.connectionOpen && reloaded.recovery.pendingCount === 0, "reconnection should resolve the original raise receipt");
  await reloaded.advanceTimers(2400);
  assert.ok(decision > raisedDecision, "the receipt is replayed after the action decision has advanced");
  assert.equal(f.room.holdem.decision, decision); assert.equal(f.room.history.length, historyCount);
  assert.equal(peer.commands.filter((message) => message.id === sent.id).length, 2);
  assert.ok(peer.responses.some((response) => response.path === "/api/message" && response.payload.duplicate === true));
  assertTable(f); assertWirePrivacy(f);
  await use(reloaded, "holdem-next");
  assert.equal(f.room.holdem.phase, "flop"); assertTable(f);
});

test("checkpoint restart resumes all three seats and deduplicates an unacknowledged flop bet before continuing", async (t) => {
  const f = await fixture(t, { durable: true });
  await start(f); await closeRound(f); await use(f.clients[0], "holdem-next");
  const guest = f.clients[1], identity = f.identities[1], playerId = guest.app.state.you.id;
  assert.equal(f.room.holdem.actorId, playerId);
  for (const client of f.clients) await client.advanceTimers(250);
  identity.link.dropNextReceipt = true;
  guest.$("holdem-raise-to").value = "125";
  await guest.dispatch(guest.$("holdem-action-form"), "submit");
  await until(() => !guest.app.connectionOpen && guest.recovery.pendingCount === 1, "the committed bet should retain its pending receipt locally");
  const original = identity.link.commands.at(-1), poker = structuredClone(f.room.holdem), gameId = f.room.gameId, epoch = f.room.epoch;
  const deckOrder = [...f.room.decks.get(poker.deckId).order], cards = [...f.room.cards.values()].filter((card) => card.deckId === poker.deckId).map((card) => structuredClone(card));
  const seats = f.clients.map((client) => client.app.state.you.id), historyCount = f.room.history.length;
  const disk = await readRoomCheckpoint(f.persistence.path);
  assert.deepEqual(disk.holdem, poker);
  assert.ok(disk.commandReceipts.has(`${playerId}:${original.id}`));
  await f.restart();
  assert.equal(f.room.gameId, gameId); assert.equal(f.room.epoch, epoch);
  assert.deepEqual(f.room.holdem, poker); assert.deepEqual(f.room.decks.get(poker.deckId).order, deckOrder);
  assert.deepEqual([...f.room.cards.values()].filter((card) => card.deckId === poker.deckId), cards);
  for (let index = 0; index < 3; index++) await f.load(index);
  await until(() => f.clients[1].recovery.pendingCount === 0, "the restored server should confirm its durable receipt");
  assert.deepEqual(f.clients.map((client) => client.app.state.you.id), seats);
  assert.equal(f.room.players.size, 3); assert.equal(f.room.history.length, historyCount);
  assert.deepEqual(f.room.holdem, poker);
  assert.equal(f.identities[1].link.commands.filter((message) => message.id === original.id).length, 1);
  assert.ok(f.identities[1].link.responses.some((response) => response.payload.duplicate === true && response.payload.durable === true));
  assertTable(f); assertWirePrivacy(f);
  await closeRound(f);
  for (const phase of ["turn", "river", "complete"]) {
    await use(f.clients[0], "holdem-next");
    assert.equal(f.room.holdem.phase, phase); assertTable(f);
    if (phase !== "complete") await closeRound(f);
  }
  assert.equal(f.room.holdem.players.reduce((sum, player) => sum + player.stack, 0), 3000);
  assert.equal((await readRoomCheckpoint(f.persistence.path)).holdem.phase, "complete");
});
