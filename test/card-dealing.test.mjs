import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as server from "../src/room-engine.mjs";
import { loadPreviewEngine } from "./helpers/preview.mjs";
import { createRoomLink } from "./helpers/room-link.mjs";

const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const { core: browser } = await loadPreviewEngine();
const plain = (value) => JSON.parse(JSON.stringify(value));
const hand = (room, player) => [...room.cards.values()].filter((card) => card.zone === "hand" && card.ownerId === player.id).sort((a, b) => a.handOrder - b.handOrder);
const snapshot = (core, room) => {
  const value = core.exportRoomCheckpoint(room); delete value.savedAt; delete value.game.savedAt;
  return JSON.stringify(value);
};

for (const [mode, core] of [["server", server], ["browser", browser]]) {
  function setup(source = pack) {
    const room = core.createRoom({ code: "DLS-020", hostSecret: "test-host", pack: source, randomizeDeck: false });
    const host = core.joinRoom(room, { hostSecret: room.hostSecret }).player;
    const dealer = core.joinRoom(room, { displayName: "发牌人" }).player;
    const alice = core.joinRoom(room, { displayName: "小林" }).player;
    const bob = core.joinRoom(room, { displayName: "小周" }).player;
    const command = (value, actor = dealer) => core.applyCommand(room, actor.id, value);
    const deal = (options = {}) => command({ type: "deal-resources", resources: [{ type: "deck", id: "main" }],
      playerIds: [bob.id, alice.id], mode: "count", count: 2, remainder: "keep", order: "random", ...options });
    return { room, host, dealer, alice, bob, command, deal };
  }

  test(`${mode}: dealing from the top follows seat order, names the actor, and undoes the entire deal once`, () => {
    const { room, host, dealer, alice, bob, command, deal } = setup();
    command({ type: "draw" }, host);
    const privateBefore = plain(hand(room, host));
    const cardsBefore = plain([...room.cards.values()]), order = [...room.deckOrder];
    const top = [...order].reverse().map((id) => room.cards.get(id).face.label);
    const undo = room.undoStack.length, history = room.history.length, revision = room.revision;
    const result = deal({ order: "top" });
    assert.deepEqual(hand(room, alice).map((card) => card.face.label), [top[0], top[2]]);
    assert.deepEqual(hand(room, bob).map((card) => card.face.label), [top[1], top[3]]);
    assert.deepEqual([...room.deckOrder], order.slice(0, -4));
    assert.deepEqual(plain(hand(room, host)), privateBefore); assert.equal(hand(room, dealer).length, 0);
    assert.deepEqual(plain(result.selectedResources), [{ type: "deck", id: "main" }]);
    assert.equal(room.undoStack.length, undo + 1); assert.equal(room.revision, revision + 1);
    assert.equal(room.history.length, history + 1);
    const entry = room.history.at(-1);
    assert.equal(entry.actorId, dealer.id); assert.equal(entry.actorName, "发牌人");
    assert.match(entry.label, /按牌堆顺序发牌：小林 2 张、小周 2 张；余 49 张/);
    for (const viewer of [host, dealer, alice, bob]) {
      const state = core.projectRoom(room, viewer.id);
      for (const card of state.cards.filter((card) => card.zone === "hand")) {
        assert.equal(Boolean(card.face), card.ownerId === viewer.id);
      }
    }
    for (const id of order.slice(-4)) assert.equal(room.cards.has(id), false, "exposed identities must not follow a card into a private hand");
    command({ type: "undo" }, host);
    assert.deepEqual(plain([...room.cards.values()]), cardsBefore); assert.deepEqual([...room.deckOrder], order);
  });

  test(`${mode}: random dealing changes only chosen sources and keeps the undealt order and physical artwork`, () => {
    const { room, host, alice, bob, command, deal } = setup();
    command({ type: "draw-public", x: 400, y: 350, faceUp: true });
    const publicCard = [...room.cards.values()].find((card) => card.zone === "public");
    publicCard.rotation = 35; publicCard.face.image = "art/unique-front.png";
    const other = core.addRoomPack(room, host.id, { ...structuredClone(pack), id: "other-cards", name: "另一副牌" });
    const untouched = plain(room.decks.get(other).order.map((id) => room.cards.get(id)));
    const sourceCards = [...room.deckOrder.map((id) => room.cards.get(id)), publicCard];
    const originals = new Map(sourceCards.map((card) => [card.face.label, plain(card)]));
    const order = [...room.deckOrder], oldIds = new Set(sourceCards.map((card) => card.id));
    deal({ resources: [{ type: "card", id: publicCard.id }, { type: "deck", id: "main" }], mode: "equal" });
    const dealt = [...hand(room, alice), ...hand(room, bob)];
    assert.equal(dealt.length, 54); assert.equal(new Set(dealt.map((card) => card.id)).size, 54);
    for (const card of dealt) {
      const original = originals.get(card.face.label);
      assert.ok(!oldIds.has(card.id)); assert.equal(card.faceUp, false);
      assert.deepEqual(plain(card.face), original.face); assert.equal(card.rotation, original.rotation);
      assert.equal(card.deckId, original.deckId);
    }
    assert.deepEqual(plain(room.decks.get(other).order.map((id) => room.cards.get(id))), untouched);
    assert.equal(room.deckOrder.length, 0);
    command({ type: "undo" }, host);
    const known = new Map(order.map((id) => [room.cards.get(id).face.label, id]));
    deal({ count: 7 });
    const chosen = new Set([...hand(room, alice), ...hand(room, bob)].map((card) => known.get(card.face.label)));
    assert.deepEqual([...room.deckOrder], order.filter((id) => !chosen.has(id)), "random draws leave the rest in their original order");
  });

  test(`${mode}: equal shares can keep or randomly distribute the remainder, including fewer cards than people`, () => {
    for (const remainder of ["keep", "distribute"]) {
      const { room, alice, bob, dealer, deal } = setup({ ...structuredClone(pack), cards: pack.cards.slice(0, 11) });
      deal({ playerIds: [alice.id, bob.id, dealer.id], mode: "equal", remainder });
      const counts = [alice, bob, dealer].map((player) => hand(room, player).length).sort();
      assert.deepEqual(counts, remainder === "keep" ? [3, 3, 3] : [3, 4, 4]);
      assert.equal(room.deckOrder.length, remainder === "keep" ? 2 : 0);
    }
    const { room, alice, bob, dealer, command, deal } = setup();
    for (let index = 0; index < 2; index++) command({ type: "draw-public", x: 600, y: 400 });
    const resources = [...room.cards.values()].filter((card) => card.zone === "public").map((card) => ({ type: "card", id: card.id }));
    let before = snapshot(core, room);
    assert.throws(() => deal({ resources, playerIds: [alice.id, bob.id, dealer.id], mode: "equal" }), { code: "NOT_ENOUGH_CARDS" });
    assert.equal(snapshot(core, room), before);
    const receipt = deal({ resources, playerIds: [alice.id, bob.id, dealer.id], mode: "equal", remainder: "distribute" });
    assert.deepEqual([alice, bob, dealer].map((player) => hand(room, player).length).sort(), [0, 1, 1]);
    assert.deepEqual(plain(receipt.selectedResources), []); assert.equal(room.deckOrder.length, 52);
  });

  test(`${mode}: invalid recipients, amounts, source changes and non-card selections reject atomically`, () => {
    const { room, dealer, alice, command, deal } = setup();
    command({ type: "draw" });
    const privateCard = hand(room, dealer)[0];
    const { createdResource: token } = command({ type: "spawn-resource", resourceId: "chip-25", x: 700, y: 400 });
    const before = snapshot(core, room), deck = room.decks.get("main");
    const cases = [
      [{ playerIds: [] }, "INVALID_DEAL_RECIPIENTS"],
      [{ playerIds: [alice.id, alice.id] }, "INVALID_DEAL_RECIPIENTS"],
      [{ playerIds: ["departed-player"] }, "DEAL_PLAYERS_CHANGED"],
      [{ count: 0 }, "INVALID_DEAL_COUNT"], [{ count: 1.5 }, "INVALID_DEAL_COUNT"], [{ count: "2" }, "INVALID_DEAL_COUNT"],
      [{ count: 30 }, "NOT_ENOUGH_CARDS"], [{ count: Number.MAX_SAFE_INTEGER }, "NOT_ENOUGH_CARDS"],
      [{ mode: "unknown" }, "INVALID_DEAL_MODE"], [{ remainder: "unknown" }, "INVALID_DEAL_MODE"], [{ order: "unknown" }, "INVALID_DEAL_ORDER"],
      [{ expectedCount: 54 }, "SELECTION_CHANGED"],
      [{ resources: [{ type: "deck", id: "main", count: 54 }] }, "SELECTION_CHANGED"],
      [{ resources: [{ type: "deck", id: "main", topId: "old-top" }] }, "SELECTION_CHANGED"],
      [{ resources: [{ type: "deck", id: "main", x: deck.x + 20, y: deck.y }] }, "SELECTION_CHANGED"],
      [{ resources: [{ type: "card", id: privateCard.id }] }, "PRIVATE_SELECTION"],
      [{ resources: [token] }, "CARDS_ONLY"]
    ];
    for (const [options, code] of cases) {
      assert.throws(() => deal(options), { code }); assert.equal(snapshot(core, room), before, code);
    }
    try { deal({ playerIds: ["departed-player"] }); } catch (error) { assert.equal(error.status, 409, "a departed recipient must not expire the dealer's session"); }
  });

  test(`${mode}: locked public cards cannot be dealt, but a position-locked deck still permits dealing`, () => {
    const { room, command, deal } = setup();
    command({ type: "draw-public", x: 600, y: 400 });
    const card = [...room.cards.values()].find((card) => card.zone === "public");
    command({ type: "lock-resource", resourceType: "card", resourceId: card.id });
    const before = snapshot(core, room);
    assert.throws(() => deal({ resources: [{ type: "deck", id: "main" }, { type: "card", id: card.id }] }), { code: "RESOURCE_LOCKED" });
    assert.equal(snapshot(core, room), before);
    command({ type: "lock-resource", resourceType: "deck", resourceId: "main" });
    assert.doesNotThrow(() => deal()); assert.equal(room.decks.get("main").locked, true); assert.equal(room.cards.get(card.id).zone, "public");
  });

  test(`${mode}: a large deal and the longest recipient labels survive a checkpoint without lost cards`, () => {
    const large = { ...structuredClone(pack), cards: Array.from({ length: 500 }, (_, index) => ({ ...pack.cards[index % 54], key: `large-${index}` })) };
    const { room, host, command, deal } = setup(large);
    while (room.players.size < 8) core.joinRoom(room, { displayName: `长昵称${"玩家".repeat(8)}${room.players.size}` });
    const playerIds = [...room.players.keys()];
    deal({ playerIds, mode: "equal", remainder: "distribute" });
    assert.equal([...room.cards.values()].filter((card) => card.zone === "hand").length, 500);
    assert.equal(room.history.at(-1).label.length <= 600, true);
    const restored = core.roomFromCheckpoint(plain(core.exportRoomCheckpoint(room)));
    for (const player of room.players.values()) {
      assert.deepEqual(plain(hand(restored, player)), plain(hand(room, player)));
      const zone = core.privateZoneForSeat(player.seatIndex);
      for (const card of hand(room, player)) assert.ok(Number.isFinite(card.x) && card.x >= zone.x && card.x < zone.x + zone.width && Number.isFinite(card.y));
    }
    assert.equal(restored.cards.size, 500); assert.equal(restored.deckOrder.length, 0);
    command({ type: "undo" }, host); assert.equal(room.deckOrder.length, 500);
    deal({ playerIds: [host.id], count: 500 }); assert.equal(hand(room, host).length, 500);
  });
}

test("a dealt selection has one durable receipt across concurrent retries and a server restart", async (t) => {
  let room = server.createRoom({ code: "RCPT-020", hostSecret: "test-host", pack, randomizeDeck: false });
  const host = server.joinRoom(room, { hostSecret: room.hostSecret }), guest = server.joinRoom(room, { displayName: "朋友" });
  for (let index = 0; index < 5; index++) server.applyCommand(room, host.player.id, { type: "draw-public", x: 600, y: 400, faceUp: true });
  let saved, link = createRoomLink(room, { persistence: { save: async () => { saved = server.exportRoomCheckpoint(room); } } });
  const body = JSON.stringify({ roomCode: room.code, sessionToken: guest.sessionToken, message: { type: "command", id: "deal-once-020", command: {
    type: "deal-resources", resources: [...room.cards.values()].filter((card) => card.zone === "public").map((card) => ({ type: "card", id: card.id })),
    playerIds: [host.player.id, guest.player.id], mode: "count", count: 2, order: "random", remainder: "keep", expectedCount: 5
  } } });
  const send = async () => (await link.fetch("https://table.example/api/message", { method: "POST", body })).json();
  t.after(() => link.transport.close());
  const revision = room.revision;
  const [first, duplicate] = await Promise.all([send(), send()]);
  assert.equal(first.ok, true); assert.equal(duplicate.duplicate, true);
  assert.deepEqual(first.selectedResources, duplicate.selectedResources); assert.equal(first.selectedResources.length, 1);
  const remainingId = first.selectedResources[0].id;
  assert.equal(room.cards.get(remainingId).faceUp, true); assert.equal(room.cards.get(remainingId).zone, "public");
  assert.equal(room.revision, revision + 1);
  const normalizedCards = () => plain([...room.cards.values()].map((card) => ({ ...card, ownerId: card.zone === "hand" ? card.ownerId : null })));
  const cards = normalizedCards();
  link.transport.close(); room = server.roomFromCheckpoint(plain(saved)); link = createRoomLink(room);
  const replay = await send();
  assert.equal(replay.duplicate, true); assert.deepEqual(replay.selectedResources, first.selectedResources);
  assert.deepEqual(normalizedCards(), cards);
  assert.equal(room.history.filter((entry) => entry.label.includes("随机发牌")).length, 1);
  assert.ok(replay.state.cards.filter((card) => card.ownerId === host.player.id).every((card) => card.face === null));
});
