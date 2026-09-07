import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as server from "../src/room-engine.mjs";
import { loadPreviewEngine } from "./helpers/preview.mjs";

const standard = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const uno = JSON.parse(await readFile(new URL("../game-packs/uno.json", import.meta.url)));
const legacy = JSON.parse(await readFile(new URL("./fixtures/legacy-holdem.game.json", import.meta.url)));
const { core: browser } = await loadPreviewEngine();
const plain = (value) => JSON.parse(JSON.stringify(value));

for (const [mode, core] of [["server", server], ["browser", browser]]) {
  function setup() {
    const room = core.createRoom({ code: "PILE-123", pack: standard, hostSecret: "test-only", randomizeDeck: false });
    const host = core.joinRoom(room, { hostSecret: room.hostSecret }).player;
    const guest = core.joinRoom(room, { displayName: "朋友" }).player;
    const command = (value, actor = host) => core.applyCommand(room, actor.id, value);
    const state = (viewer = host) => core.projectRoom(room, viewer.id);
    const drop = (resourceType, resourceId, targetType = "deck", targetId = "main") => command({ type: "stack-onto", resourceType, resourceId, targetType, targetId });
    const draw = (faceUp = false, x = 600, y = 400) => {
      const id = room.deckOrder.at(-1);
      command({ type: "draw-public", x, y, faceUp });
      return room.cards.get(id);
    };
    return { room, host, guest, command, state, drop, draw };
  }

  test(`${mode}: top insertion preserves facing, rotation and existing order, and undoes in one step`, () => {
    const { room, command, state, drop, draw } = setup();
    const card = draw(true);
    command({ type: "move-card", cardId: card.id, target: "public", x: 600, y: 400, rotation: 35, faceUp: true });
    const before = plain(state().cards), order = [...room.deckOrder], undo = room.undoStack.length;
    drop("card", card.id);
    assert.deepEqual([...room.deckOrder], [...order, card.id]);
    assert.equal(room.undoStack.length, undo + 1);
    assert.equal(state().cards.length, 0);
    assert.equal(state().decks[0].top.face.label, card.face.label);
    assert.equal(state().decks[0].top.rotation, 35);
    assert.equal(state().decks[0].top.faceUp, true);
    command({ type: "undo" });
    assert.deepEqual(plain(state().cards), before);
    assert.deepEqual([...room.deckOrder], order);
    drop("card", card.id);
    command({ type: "draw-public", x: 1200, y: 300 });
    assert.equal(state().cards[0].id, card.id);
    assert.equal(state().cards[0].faceUp, true);
    assert.equal(state().cards[0].rotation, 35);
  });

  test(`${mode}: merged packs retain their own backs and source artwork, including outside hands`, () => {
    const { room, host, guest, command, state, drop } = setup();
    const added = core.addRoomPack(room, host.id, uno);
    command({ type: "draw" }, guest);
    const privateCard = state(guest).cards[0];
    const mainOrder = [...room.deckOrder], targetOrder = [...room.decks.get(added).order];
    const originals = new Map([...room.cards.values()].map((card) => [card.id, plain(card.source)]));
    drop("deck", "main", "deck", added);
    assert.equal(state().decks.length, 1);
    assert.equal(state().decks[0].id, added);
    assert.equal(room.decks.get("main").hidden, true);
    assert.equal(room.deckOrder.length, 0);
    assert.deepEqual([...room.decks.get(added).order], [...targetOrder, ...mainOrder]);
    assert.equal(state(guest).cards[0].face.label, privateCard.face.label);
    assert.equal(state().cards[0].face, null);
    for (const card of room.cards.values()) assert.deepEqual(plain(card.source), originals.get(card.id));
    assert.equal(state().decks[0].top.back.label, standard.cardBack.label);
    drop("card", privateCard.id, "deck", added);
    assert.equal(state().decks[0].top.back.label, standard.cardBack.label);
    assert.equal(state().decks[0].top.face, null, "a card from a private hand remains face down on return");
    command({ type: "save-template", resourceType: "deck", resourceId: added });
    command({ type: "spawn-template", templateId: state().templates[0].id, x: 2000, y: 500 });
    const copy = state().decks.at(-1);
    const counts = (id) => [...room.cards.values()].filter((card) => card.deckId === id).map((card) => card.source.packId).sort();
    assert.deepEqual(counts(copy.id), counts(added));
    const resumed = core.roomFromCheckpoint(core.exportRoomCheckpoint(room));
    assert.deepEqual(plain([...resumed.decks]), plain([...room.decks]));
    for (const card of resumed.cards.values()) assert.deepEqual(plain(card.source), plain(room.cards.get(card.id).source));
    assert.equal(resumed.cards.size, 324);
  });

  test(`${mode}: card, loose stack and whole deck drops all place the source above the target`, () => {
    const { room, command, state, drop, draw } = setup();
    const bottom = draw(true, 300, 400), top = draw(false, 600, 400);
    const receipt = drop("card", top.id, "card", bottom.id);
    const pile = room.decks.get(receipt.createdResource.id);
    assert.deepEqual([...pile.order], [bottom.id, top.id]);
    assert.equal(state().decks.find((deck) => deck.id === pile.id).top.face, null);
    const lower = draw(false, 400, 700), upper = draw(true, 420, 710);
    drop("stack", lower.id, "deck", pile.id);
    assert.deepEqual([...pile.order], [bottom.id, top.id, lower.id, upper.id]);
    assert.equal(state().decks.find((deck) => deck.id === pile.id).top.face.label, upper.face.label);
    const base = draw(true, 1100, 300), order = [...pile.order];
    drop("deck", pile.id, "card", base.id);
    assert.deepEqual([...pile.order], [base.id, ...order]);
    assert.equal(pile.x, 1100);
    const mergedOrder = [...room.deckOrder, ...pile.order];
    drop("deck", pile.id);
    assert.equal(room.decks.has(pile.id), false);
    assert.deepEqual([...room.deckOrder], mergedOrder);
    command({ type: "undo" });
    assert.ok(room.decks.has(pile.id));
    assert.equal(state().cards.length, 0);
  });

  test(`${mode}: shuffling keeps each card facing the same way and exposes only the top face`, () => {
    const { room, command, state, drop, draw } = setup();
    const up = draw(true), down = draw(false, 1100, 500);
    drop("card", up.id);
    drop("card", down.id);
    assert.equal(state().decks[0].top.face, null);
    assert.equal(JSON.stringify(state()).includes(up.face.label), false);
    const facings = new Map([...room.cards.values()].map((card) => [card.face.label, card.faceUp]));
    const oldIds = new Set(room.cards.keys());
    command({ type: "shuffle" });
    for (const card of room.cards.values()) {
      assert.equal(card.faceUp, facings.get(card.face.label));
      assert.equal(oldIds.has(card.id), false);
    }
    let seenFaceUp = false;
    while (room.deckOrder.length) {
      const expected = room.cards.get(room.deckOrder.at(-1));
      assert.equal(state().decks[0].top.face?.label || null, expected.faceUp ? expected.face.label : null);
      command({ type: "draw-public", x: 600, y: 400 });
      assert.equal(expected.faceUp, facings.get(expected.face.label));
      seenFaceUp ||= expected.faceUp;
    }
    assert.ok(seenFaceUp, "the original face-up card emerges after shuffling");
  });

  for (const type of ["collect-deck", "collect-public"]) test(`${mode}: ${type} gathers loose cards on top without flipping or shuffling`, () => {
    const { room, command, state, draw } = setup();
    const up = draw(true), down = draw(false, 1100, 500);
    command({ type: "move-card", cardId: up.id, target: "public", x: 600, y: 400, rotation: 35, faceUp: true });
    const order = [...room.deckOrder];
    command({ type, deckId: "main" });
    assert.deepEqual([...room.deckOrder], [...order, down.id, up.id]);
    assert.equal(state().cards.length, 0);
    assert.equal(up.faceUp, true);
    assert.equal(up.rotation, 35);
    assert.equal(down.faceUp, false);
    assert.equal(state().decks[0].top.face.label, up.face.label);
    command({ type: "undo" });
    assert.deepEqual([...room.deckOrder], order);
    assert.equal(state().cards.length, 2);
  });

  for (const layout of ["row", "column", "grid"]) test(`${mode}: ${layout} spreading preserves top-first order and faces through save and undo`, () => {
    const { room, command, state, drop, draw } = setup();
    drop("card", draw(true).id);
    const order = [...room.deckOrder].reverse();
    command({ type: "spread-deck", deckId: "main", layout });
    assert.equal(room.deckOrder.length, 0);
    const cards = state().cards;
    assert.deepEqual(plain(cards.map((card) => card.id)), order);
    assert.equal(cards[0].faceUp, true);
    assert.ok(cards.slice(1).every((card) => !card.faceUp && !card.face));
    assert.equal(new Set(cards.map((card) => `${card.x},${card.y}`)).size, 54);
    if (layout === "row") assert.equal(new Set(cards.map((card) => card.y)).size, 1);
    if (layout === "column") assert.equal(new Set(cards.map((card) => card.x)).size, 1);
    const resumed = core.roomFromCheckpoint(core.exportRoomCheckpoint(room));
    assert.deepEqual(plain([...resumed.cards.values()]), plain([...room.cards.values()]));
    command({ type: "undo" });
    assert.deepEqual([...room.deckOrder], [...order].reverse());
    assert.equal(state().cards.length, 0);
  });

  test(`${mode}: stale, private, locked and malformed drops are atomic; a fixed pile can still receive cards`, () => {
    const { room, guest, command, state, drop, draw } = setup();
    const publicCard = draw(true);
    command({ type: "draw" });
    const privateCard = state().cards.find((card) => card.zone === "hand");
    command({ type: "lock-resource", resourceType: "card", resourceId: publicCard.id });
    const revision = room.revision, undo = room.undoStack.length, order = [...room.deckOrder];
    for (const [value, actor, code] of [
      [{ type: "stack-onto", resourceType: "card", resourceId: publicCard.id, targetType: "deck", targetId: "main" }, guest, "RESOURCE_LOCKED"],
      [{ type: "stack-onto", resourceType: "card", resourceId: privateCard.id, targetType: "deck", targetId: "main" }, guest, "NO_CONTROL"],
      [{ type: "stack-onto", resourceType: "deck", resourceId: "main", targetType: "deck", targetId: "main" }, guest, "SAME_PILE"],
      [{ type: "spread-deck", layout: "invalid" }, guest, "INVALID_LAYOUT"]
    ]) {
      assert.throws(() => command(value, actor), (error) => error.code === code);
      assert.equal(room.revision, revision); assert.equal(room.undoStack.length, undo);
      assert.deepEqual([...room.deckOrder], order);
    }
    command({ type: "lock-resource", resourceType: "deck", resourceId: "main" });
    drop("card", privateCard.id);
    assert.equal(state().decks[0].locked, true);
    assert.throws(() => drop("card", privateCard.id), (error) => error.code === "RESOURCE_HIDDEN");
    assert.throws(() => command({ type: "spread-deck" }), (error) => error.code === "RESOURCE_LOCKED");
  });

  test(`${mode}: old programmed tables migrate to ordinary resources without losing cards, hands or chip balances`, () => {
    const { room, host, guest, command, state } = setup();
    const original = JSON.stringify(legacy);
    core.restoreRoomGame(room, host.id, plain(legacy));
    assert.equal(JSON.stringify(legacy), original);
    assert.equal("holdem" in state(), false);
    assert.equal(room.cards.size, legacy.table.cards.length);
    const deck = state().decks.find((deck) => deck.id === legacy.holdem.deckId);
    const mat = state().objects.find((object) => object.id === legacy.holdem.matId);
    assert.equal(deck.locked, false); assert.equal(mat.locked, false);
    assert.equal(state().cards.filter((card) => card.zone === "hand").length, legacy.hands.length);
    assert.equal(state().tokens.filter((token) => token.key === "legacy-chips").reduce((sum, token) => sum + Number(token.symbol), 0), legacy.holdem.totalChips);
    const newGame = core.exportRoomGame(room, host.id);
    assert.equal("holdem" in newGame, false);
    core.validateRoomGame(newGame);
    const player = [...room.players.values()].find((player) => player.role === "guest");
    command({ type: "move-resource", resourceType: "object", resourceId: mat.id, x: 1600, y: 1000 }, player);
    command({ type: "draw", deckId: deck.id }, player);
    assert.throws(() => command({ type: "holdem-start" }), (error) => error.code === "UNKNOWN_COMMAND");
    assert.equal(state().objects.find((object) => object.id === mat.id).x, 1600);
  });
}
