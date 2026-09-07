import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as server from "../src/room-engine.mjs";
import { loadPreviewEngine } from "./helpers/preview.mjs";

const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const { core: browser } = await loadPreviewEngine();
const plain = (value) => JSON.parse(JSON.stringify(value));
const layout = (members) => plain(members.map(({ type, value }) => ({ type, ...Object.fromEntries(["id", "x", "y", "z", "rotation", "faceUp", "zone", "face", "symbol", "color", "text", "width", "height", "locked", "order"].map((key) => [key, value[key]])) })));
for (const [mode, core] of [["server", server], ["browser", browser]]) {
  const snapshot = (room) => {
    const checkpoint = core.exportRoomCheckpoint(room);
    delete checkpoint.savedAt; delete checkpoint.game.savedAt;
    return createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex");
  };
  function setup() {
    const room = core.createRoom({ code: "MULTI-1", pack, hostSecret: "test-host", randomizeDeck: false });
    const host = core.joinRoom(room, { hostSecret: room.hostSecret }).player;
    const guest = core.joinRoom(room, { displayName: "朋友" }).player;
    const command = (value, player = guest) => core.applyCommand(room, player.id, value);
    command({ type: "draw-public", x: 250, y: 300 });
    command({ type: "draw-public", x: 450, y: 350 });
    const cards = [...room.cards.values()].filter((card) => card.zone === "public");
    command({ type: "move-card", cardId: cards[0].id, target: "public", x: 250, y: 300, faceUp: true, rotation: 25 });
    command({ type: "spawn-resource", resourceId: "chip-25", x: 650, y: 300 });
    command({ type: "spawn-resource", resourceId: "note", x: 750, y: 350 });
    const token = [...room.tokens.values()].at(-1), object = [...room.objects.values()].at(-1);
    object.rotation = -17; // Imported scenes may contain rotated objects.
    const refs = [{ type: "deck", id: "main" }, ...cards.map((card) => ({ type: "card", id: card.id })), { type: "token", id: token.id }, { type: "object", id: object.id }];
    return { room, host, guest, command, cards, token, object, refs };
  }

  test(`${mode}: a mixed selection translates once, preserves physical state and undoes as one operation`, () => {
    const { room, host, guest, command, refs } = setup();
    const members = core.tableSelectionResources(room, refs);
    const before = plain(members), order = [...room.deckOrder], revision = room.revision, undoCount = room.undoStack.length;
    command({ type: "move-resources", resources: [...refs, refs[0]], dx: 220, dy: -120 });
    assert.equal(room.revision, revision + 1);
    assert.equal(room.undoStack.length, undoCount + 1);
    const moved = plain(core.tableSelectionResources(room, refs));
    assert.deepEqual(moved, before.map((entry) => ({ ...entry, value: { ...entry.value, x: entry.value.x + 220, y: entry.value.y - 120 } })), "faces, rotations, ownership, layers and deck contents must stay intact");
    assert.deepEqual([...room.deckOrder], order);
    assert.match(room.history.at(-1).label, /5 件/);
    const restored = core.roomFromCheckpoint(plain(core.exportRoomCheckpoint(room)));
    assert.deepEqual(layout(core.tableSelectionResources(restored, refs)), layout(moved));
    assert.equal(core.projectRoom(restored, guest.id).cards.filter((card) => card.face).length, 1);
    command({ type: "undo" }, host);
    assert.deepEqual(plain(core.tableSelectionResources(room, refs)), before);
  });

  test(`${mode}: bulk movement validates the whole selection before changing anything`, () => {
    const { room, host, command, refs, token } = setup();
    command({ type: "lock-resource", resourceType: "token", resourceId: token.id });
    let before = snapshot(room);
    assert.throws(() => command({ type: "move-resources", resources: refs, dx: 100, dy: 100 }), { code: "RESOURCE_LOCKED" });
    assert.equal(snapshot(room), before);
    command({ type: "lock-resource", resourceType: "token", resourceId: token.id });
    command({ type: "draw" });
    const hand = [...room.cards.values()].find((card) => card.zone === "hand");
    before = snapshot(room);
    for (const player of [undefined, host]) {
      assert.throws(() => command({ type: "move-resources", resources: [...refs, { type: "card", id: hand.id }], dx: 100, dy: 100 }, player), { code: "PRIVATE_SELECTION" });
      assert.equal(snapshot(room), before);
    }
    for (const resources of [[], [...refs, { type: "token", id: "missing" }], [{ type: "player", id: host.id }], Array(1801).fill(refs[0])]) {
      assert.throws(() => command({ type: "move-resources", resources, dx: 100, dy: 100 }));
      assert.equal(snapshot(room), before);
    }
    assert.throws(() => command({ type: "move-resources", resources: refs, dx: NaN, dy: 100 }), { code: "INVALID_DROP" });
    assert.equal(snapshot(room), before);
  });

  test(`${mode}: batch edge clamping keeps the formation and stale origins reject atomically`, () => {
    const { room, command, refs } = setup();
    const members = core.tableSelectionResources(room, refs), before = plain(members);
    const originRefs = members.map(({ type, value }) => ({ type, id: value.id, x: value.x, y: value.y }));
    command({ type: "move-resources", resources: originRefs, dx: 100000, dy: -100000 });
    const moved = core.tableSelectionResources(room, refs);
    const dx = moved[0].value.x - before[0].value.x, dy = moved[0].value.y - before[0].value.y;
    moved.forEach(({ type, value }, index) => {
      assert.ok(Math.abs(value.x - before[index].value.x - dx) < .000001);
      assert.ok(Math.abs(value.y - before[index].value.y - dy) < .000001);
      const bounds = core.tableResourceBounds(type, value), zone = core.TABLE_GEOMETRY.publicZone;
      assert.ok(bounds.x + bounds.width <= zone.x + zone.width - 18 + .000001);
      assert.ok(bounds.y >= zone.y + 28 - .000001);
    });
    const checkpoint = snapshot(room);
    assert.throws(() => command({ type: "move-resources", resources: originRefs, dx: 10, dy: 10 }), { code: "SELECTION_CHANGED" });
    assert.equal(snapshot(room), checkpoint);
  });

  test(`${mode}: hidden container contents cannot be moved by a batch`, () => {
    const { room, command, refs, token } = setup();
    command({ type: "spawn-resource", resourceId: "bag", x: 1200, y: 550 });
    const bag = [...room.objects.values()].at(-1);
    command({ type: "bag-put", bagId: bag.id, resourceType: "token", resourceId: token.id });
    const before = snapshot(room);
    const deckCard = room.deckOrder[0];
    for (const resources of [refs, [refs[0], { type: "card", id: deckCard }]]) {
      assert.throws(() => command({ type: "move-resources", resources, dx: 50, dy: 60 }), { code: "RESOURCE_HIDDEN" });
      assert.equal(snapshot(room), before);
    }
  });
}
