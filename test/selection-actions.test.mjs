import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as server from "../src/room-engine.mjs";
import { loadPreviewEngine } from "./helpers/preview.mjs";

const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const otherPack = JSON.parse(await readFile(new URL("../game-packs/uno.json", import.meta.url)));
const { core: browser } = await loadPreviewEngine();
const plain = (value) => JSON.parse(JSON.stringify(value));
const refs = (...entries) => entries.map(([type, value]) => ({ type, id: typeof value === "string" ? value : value.id }));
const physical = (cards) => plain(cards.map(({ key, face, source, faceUp, rotation }) => ({ key, face, source, faceUp, rotation }))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

for (const [mode, core] of [["server", server], ["browser", browser]]) {
  const snapshot = (room) => {
    const value = core.exportRoomCheckpoint(room); delete value.savedAt; delete value.game.savedAt;
    return JSON.stringify(value);
  };
  function setup() {
    const room = core.createRoom({ code: "ACT-019", hostSecret: "test-host", pack, randomizeDeck: false });
    const host = core.joinRoom(room, { hostSecret: room.hostSecret }).player;
    const guest = core.joinRoom(room, { displayName: "朋友" }).player;
    const command = (value, player = guest) => core.applyCommand(room, player.id, value);
    const spawn = (resourceId, x = 900, y = 400) => {
      const { createdResource } = command({ type: "spawn-resource", resourceId, x, y });
      return (createdResource.type === "token" ? room.tokens : room.objects).get(createdResource.id);
    };
    const draw = (x = 300, y = 300, faceUp = false, deckId = "main") => {
      const id = room.decks.get(deckId).order.at(-1);
      command({ type: "draw-public", deckId, x, y, faceUp });
      return room.cards.get(id);
    };
    return { room, host, guest, command, spawn, draw };
  }

  test(`${mode}: returning a mixed selection keeps reusable content, skips duplicate presets and undoes once`, () => {
    const { room, host, guest, command, spawn, draw } = setup();
    const up = draw(300, 300, true), down = draw(500, 300), chip = spawn("chip-25"), note = spawn("note");
    up.rotation = 35; down.rotation = -15;
    command({ type: "edit-resource", resourceType: "object", resourceId: note.id, label: "今晚规则", text: "赢三局后交换座位" });
    command({ type: "draw" });
    const hand = [...room.cards.values()].find((card) => card.zone === "hand"), privateBefore = plain(hand);
    const selected = refs(["card", up], ["card", down], ["token", chip], ["object", note]);
    const original = plain(core.tableSelectionResources(room, selected)), undo = room.undoStack.length, deckOrder = [...room.deckOrder];
    const result = command({ type: "return-resources", resources: [...selected, selected[0]] });
    assert.deepEqual(plain(result.selectedResources), []);
    assert.equal(room.undoStack.length, undo + 1);
    assert.equal(room.cards.has(up.id), false); assert.equal(room.tokens.has(chip.id), false); assert.equal(room.objects.has(note.id), false);
    assert.deepEqual(plain(hand), privateBefore); assert.deepEqual([...room.deckOrder], deckOrder);
    assert.equal(room.templates.size, 2, "built-in chips already exist in the shelf; edited notes and selected cards are retained");
    const restored = core.roomFromCheckpoint(plain(core.exportRoomCheckpoint(room)));
    const savedNote = [...restored.templates.values()].find((entry) => entry.kind === "note");
    const savedCards = [...restored.templates.values()].find((entry) => entry.type === "deck");
    const noteCopy = core.applyCommand(restored, guest.id, { type: "spawn-template", templateId: savedNote.id, x: 800, y: 500 });
    assert.equal(restored.objects.get(noteCopy.createdResource.id).text, note.text);
    const deckCopy = core.applyCommand(restored, guest.id, { type: "spawn-template", templateId: savedCards.id, x: 1100, y: 500 });
    const recovered = restored.decks.get(deckCopy.createdResource.id).order.map((id) => restored.cards.get(id));
    assert.deepEqual(physical(recovered), physical([up, down]));
    command({ type: "undo" }, host);
    assert.deepEqual(plain(core.tableSelectionResources(room, selected)), original);
    assert.equal(room.templates.size, 0);
  });

  test(`${mode}: whole decks can return while unselected cards keep valid homes and private faces`, () => {
    const { room, host, guest, command, draw } = setup();
    const selected = draw(300, 300, true), outside = draw(600, 300);
    command({ type: "draw" });
    const hand = [...room.cards.values()].find((card) => card.zone === "hand"), beforeHand = plain(hand);
    const second = core.addRoomPack(room, host.id, otherPack);
    const storedCount = room.deckOrder.length + 1 + room.decks.get(second).order.length;
    command({ type: "return-resources", resources: refs(["deck", "main"], ["deck", second], ["card", selected]) });
    assert.equal(room.decks.get("main").hidden, true); assert.equal(room.deckOrder.length, 0);
    assert.equal(room.decks.has(second), false);
    assert.deepEqual(plain(room.cards.get(hand.id)), beforeHand);
    assert.ok(room.cards.has(outside.id));
    assert.equal([...room.templates.values()].reduce((sum, entry) => sum + entry.cards.length, 0), storedCount);
    const restored = core.roomFromCheckpoint(plain(core.exportRoomCheckpoint(room)));
    assert.equal(core.projectRoom(restored, guest.id).cards.find((card) => card.id === hand.id).face.label, hand.face.label);
    assert.equal(core.projectRoom(restored, host.id).cards.find((card) => card.id === hand.id).face, null);
    core.applyCommand(restored, host.id, { type: "collect-public" });
    assert.equal(restored.decks.get("main").hidden, false, "an outside card can still be put back in its original home");
  });

  test(`${mode}: return failures are atomic, and equivalent customs do not fill the shelf repeatedly`, () => {
    const { room, host, command, spawn, draw } = setup();
    const chip = spawn("chip-25"), note = spawn("note");
    command({ type: "edit-resource", resourceType: "object", resourceId: note.id, text: "保留这段内容" });
    command({ type: "save-template", resourceType: "object", resourceId: note.id });
    const selection = refs(["token", chip], ["object", note]);
    command({ type: "lock-resource", resourceType: "token", resourceId: chip.id });
    let before = snapshot(room);
    assert.throws(() => command({ type: "return-resources", resources: selection }), { code: "RESOURCE_LOCKED" });
    assert.equal(snapshot(room), before);
    command({ type: "lock-resource", resourceType: "token", resourceId: chip.id });
    command({ type: "return-resources", resources: selection });
    assert.equal(room.templates.size, 1);
    command({ type: "undo" }, host);
    const bag = spawn("bag"), card = draw();
    command({ type: "bag-put", bagId: bag.id, resourceType: "card", resourceId: card.id });
    before = snapshot(room);
    assert.throws(() => command({ type: "return-resources", resources: [...selection, ...refs(["object", bag])] }), { code: "BAG_NOT_EMPTY" });
    assert.equal(snapshot(room), before);
    for (let i = room.templates.size; i < 40; i++) command({ type: "save-template", resourceType: "object", resourceId: note.id, label: `规则 ${i}` });
    command({ type: "edit-resource", resourceType: "object", resourceId: note.id, text: "新版本，需要另存" });
    before = snapshot(room);
    assert.throws(() => command({ type: "return-resources", resources: selection }), { code: "LIBRARY_FULL" });
    assert.equal(snapshot(room), before);
    command({ type: "return-resources", resources: refs(["token", chip]) });
    assert.equal(room.templates.size, 40, "built-in pieces can return even when saved-template slots are full");
  });

  test(`${mode}: shuffling selected loose cards retains faces, backs and angles without touching other cards`, () => {
    const { room, host, command, draw } = setup();
    const a = draw(300, 300, true), b = draw(550, 350), untouched = draw(1200, 800, true);
    a.rotation = 35; b.rotation = -20;
    const selected = refs(["card", a], ["card", b]), state = plain(core.tableSelectionResources(room, selected));
    const before = physical([a, b]), oldIds = selected.map((ref) => ref.id), other = plain(untouched), undo = room.undoStack.length;
    const receipt = command({ type: "shuffle-resources", resources: selected });
    const shuffled = receipt.selectedResources.map((ref) => room.cards.get(ref.id));
    assert.equal(shuffled.length, 2); assert.deepEqual(physical(shuffled), before);
    assert.ok(shuffled.every((card) => !oldIds.includes(card.id)));
    assert.equal(core.publicStackForCard(room, shuffled[0].id).length, 2);
    assert.deepEqual(plain(room.cards.get(untouched.id)), other);
    assert.equal(room.undoStack.length, undo + 1); assert.equal(room.history.at(-1).effect.type, "shuffle");
    command({ type: "undo" }, host);
    assert.deepEqual(plain(core.tableSelectionResources(room, selected)), state);
  });

  test(`${mode}: deck-and-card selection shuffles into one pile and keeps outside hands private`, () => {
    const { room, host, guest, command, draw } = setup();
    const up = draw(300, 300, true); up.rotation = 25;
    command({ type: "draw" });
    const hand = [...room.cards.values()].find((card) => card.zone === "hand");
    const second = core.addRoomPack(room, host.id, otherPack);
    const original = [...room.cards.values()].filter((card) => card.id !== hand.id), before = physical(original);
    const oldIds = new Set(original.map((card) => card.id));
    const receipt = command({ type: "shuffle-resources", resources: refs(["deck", "main"], ["deck", second], ["card", up]) });
    assert.deepEqual(plain(receipt.selectedResources), [{ type: "deck", id: second }]);
    const merged = room.decks.get(second).order.map((id) => room.cards.get(id));
    assert.deepEqual(physical(merged), before); assert.ok(merged.every((card) => !oldIds.has(card.id)));
    assert.equal(room.decks.get("main").hidden, true); assert.equal(hand.deckId, second);
    assert.equal(core.projectRoom(room, guest.id).cards.find((card) => card.id === hand.id).face.label, hand.face.label);
    assert.equal(core.projectRoom(room, host.id).cards.find((card) => card.id === hand.id).face, null);
    const restored = core.roomFromCheckpoint(plain(core.exportRoomCheckpoint(room)));
    assert.equal(restored.decks.get(second).order.length, original.length);
  });

  test(`${mode}: selection spread and gathering preserve identity and offer consistent facing and locking`, () => {
    const { room, command, draw } = setup();
    const a = draw(300, 300, true), b = draw(550, 400), c = draw(750, 500, true);
    a.rotation = 15; b.rotation = -15;
    const selection = refs(["card", a], ["card", b], ["card", c]), before = physical([a, b, c]);
    command({ type: "gather-resources", resources: selection });
    assert.deepEqual(physical([a, b, c]), before); assert.equal(core.publicStackForCard(room, a.id).length, 3);
    command({ type: "spread-resources", resources: selection, layout: "row" });
    assert.deepEqual(physical([a, b, c]), before); assert.notEqual(a.x, b.x);
    command({ type: "lock-resources", resources: selection, locked: true });
    assert.ok([a, b, c].every((card) => card.locked));
    let snapshotBefore = snapshot(room);
    assert.throws(() => command({ type: "gather-resources", resources: selection }), { code: "RESOURCE_LOCKED" });
    assert.equal(snapshot(room), snapshotBefore);
    command({ type: "flip-resources", resources: selection, faceUp: false });
    assert.ok([a, b, c].every((card) => !card.faceUp), "position locks retain the existing permission to flip in place");
    command({ type: "lock-resources", resources: selection, locked: false });
    command({ type: "flip-resources", resources: selection, faceUp: true });
    assert.ok([a, b, c].every((card) => card.faceUp && !card.locked));
    snapshotBefore = snapshot(room);
    assert.throws(() => command({ type: "spread-resources", resources: selection, layout: "unknown" }), { code: "INVALID_LAYOUT" });
    assert.equal(snapshot(room), snapshotBefore);
  });

  test(`${mode}: token batches gather and spread at boundaries and reject private or stale selections atomically`, () => {
    const { room, host, command, spawn, draw } = setup();
    const a = spawn("chip-25", 6200, 3900), b = spawn("chip-100", 6000, 3800), c = spawn("chess-w-pawn", 5900, 3700);
    const selection = refs(["token", a], ["token", b], ["token", c]);
    const original = plain([a, b, c]);
    command({ type: "gather-resources", resources: selection });
    assert.equal(core.tokenStackMembers(room.tokens.values(), a.id).length, 3);
    command({ type: "spread-resources", resources: selection, layout: "grid" });
    for (const [index, value] of [a, b, c].entries()) {
      const bounds = core.tableResourceBounds("token", value), zone = core.TABLE_GEOMETRY.publicZone;
      assert.ok(bounds.x + bounds.width <= zone.x + zone.width - 18);
      assert.equal(value.resourceId, original[index].resourceId); assert.equal(value.symbol, original[index].symbol);
    }
    let before = snapshot(room);
    assert.throws(() => command({ type: "shuffle-resources", resources: selection }), { code: "CARDS_ONLY" });
    assert.equal(snapshot(room), before);
    const stale = selection.map((ref) => ({ ...ref, x: room.tokens.get(ref.id).x, y: room.tokens.get(ref.id).y }));
    command({ type: "move-token", tokenId: a.id, x: 1000, y: 500 });
    before = snapshot(room);
    assert.throws(() => command({ type: "return-resources", resources: stale }), { code: "SELECTION_CHANGED" });
    assert.equal(snapshot(room), before);
    command({ type: "draw" });
    const hand = [...room.cards.values()].find((card) => card.zone === "hand"), publicCard = draw();
    before = snapshot(room);
    for (const actor of [undefined, host]) for (const type of ["return-resources", "shuffle-resources", "flip-resources", "lock-resources"]) {
      assert.throws(() => command({ type, resources: refs(["card", publicCard], ["card", hand]), faceUp: true, locked: false }, actor), { code: "PRIVATE_SELECTION" });
      assert.equal(snapshot(room), before);
    }
  });
}
