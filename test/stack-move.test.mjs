import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadPreviewEngine } from "./helpers/preview.mjs";
import { applyCommand, createRoom, joinRoom, projectRoom } from "../src/room-engine.mjs";

const pack = JSON.parse(await readFile(new URL("../game-packs/parlor-eight.json", import.meta.url), "utf8"));
const { engine: preview } = await loadPreviewEngine();

test("preview: cards placed over the sample stack remain on top and draw in that order", () => {
  const model = preview.createModel();
  const original = preview.project(model, "player_a").cards.find((card) => card.zone === "public");
  const ids = [original.id];
  for (let index = 0; index < 2; index += 1) {
    ids.push(model.deckOrder.at(-1));
    preview.applyCommand(model, "player_a", { type: "draw-public", x: original.x, y: original.y });
  }
  preview.applyCommand(model, "player_a", { type: "move-stack", cardId: original.id, target: "public", x: 1000, y: 400 });
  const publicCards = preview.project(model, "player_a").cards.filter((card) => card.zone === "public");
  assert.deepEqual(Array.from(publicCards, (card) => card.id), ids);
  preview.applyCommand(model, "player_a", { type: "draw-stack", cardId: original.id });
  const top = preview.project(model, "player_a").cards.find((card) => card.id === ids.at(-1));
  assert.equal(top.zone, "hand");
  assert.equal(top.ownerId, "player_a");
});

function setup(mode) {
  let hostId, guestId, command, project, undoDepth;
  if (mode === "server") {
    const room = createRoom({ code: "STACK-TEST", hostName: "房主", hostSecret: "test", pack, randomizeDeck: false });
    hostId = joinRoom(room, { hostSecret: "test" }).player.id;
    guestId = joinRoom(room, { displayName: "客人" }).player.id;
    command = (actorId, value) => applyCommand(room, actorId, value);
    project = (viewerId) => projectRoom(room, viewerId);
    undoDepth = () => room.undoStack.length;
  } else {
    const model = preview.createModel();
    hostId = "player_a";
    guestId = "player_b";
    command = (actorId, value) => preview.applyCommand(model, actorId, value);
    project = (viewerId) => JSON.parse(JSON.stringify(preview.project(model, viewerId)));
    undoDepth = () => model.undo.length;
    command(hostId, { type: "reset" });
  }

  // The first and last cards only connect through the middle card.
  for (let index = 0; index < 3; index += 1) {
    command(hostId, { type: "draw-public", x: 500 + index * 40, y: 300 + index * 40, rotation: index * 15 - 15 });
  }
  const stack = project(hostId).cards.filter((card) => card.zone === "public").sort((a, b) => a.z - b.z);
  command(hostId, { type: "flip-card", cardId: stack[1].id });
  command(hostId, { type: "draw-public", x: 1050, y: 440 });
  command(hostId, { type: "draw" });
  command(guestId, { type: "draw" });
  return { hostId, guestId, command, project, undoDepth, ids: stack.map((card) => card.id) };
}

for (const mode of ["server", "preview"]) {
  test(`${mode}: moving a stack from a lower card preserves every offset, face, rotation, and order in one undo`, () => {
    const { hostId, guestId, command, project, undoDepth, ids } = setup(mode);
    const before = project(guestId);
    const previousUndoDepth = undoDepth();
    const anchor = before.cards.find((card) => card.id === ids[0]);
    command(guestId, { type: "move-stack", cardId: anchor.id, target: "public", x: anchor.x + 240, y: anchor.y + 90 });

    const after = project(guestId);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.history.length, before.history.length + 1);
    assert.equal(undoDepth(), previousUndoDepth + 1);
    assert.match(after.history.at(-1).label, /3 张的牌堆/);
    for (const original of before.cards) {
      const moved = after.cards.find((card) => card.id === original.id);
      if (!ids.includes(original.id)) {
        assert.deepEqual(moved, original);
        continue;
      }
      assert.deepEqual(moved, { ...original, x: original.x + 240, y: original.y + 90, z: moved.z });
      assert.ok(moved.z > Math.max(...before.cards.map((card) => card.z)));
    }
    assert.deepEqual(after.cards.filter((card) => ids.includes(card.id)).sort((a, b) => a.z - b.z).map((card) => card.id), ids);
    command(hostId, { type: "undo" });
    assert.deepEqual(project(guestId).cards, before.cards);
    assert.equal(undoDepth(), previousUndoDepth);
  });

  test(`${mode}: stack drops at all four edges keep the complete arrangement inside the table`, () => {
    const { guestId, command, project, ids } = setup(mode);
    const initial = project(guestId);
    const originals = initial.cards.filter((card) => ids.includes(card.id));
    const anchor = originals.find((card) => card.id === ids[1]);
    const { publicZone: zone, cardWidth, cardHeight } = initial.room.geometry;
    for (const [x, y] of [[-1000, -1000], [10000, 10000], [-1000, 10000], [10000, -1000]]) {
      command(guestId, { type: "move-stack", cardId: anchor.id, target: "public", x, y });
      const moved = project(guestId).cards.filter((card) => ids.includes(card.id));
      const movedAnchor = moved.find((card) => card.id === anchor.id);
      for (const card of moved) {
        const original = originals.find((candidate) => candidate.id === card.id);
        assert.equal(card.x - movedAnchor.x, original.x - anchor.x);
        assert.equal(card.y - movedAnchor.y, original.y - anchor.y);
        assert.ok(card.x >= zone.x + 18 && card.x + cardWidth <= zone.x + zone.width - 18);
        assert.ok(card.y >= zone.y + 28 && card.y + cardHeight <= zone.y + zone.height - 28);
      }
    }
  });

  test(`${mode}: collecting or passing a stack is atomic and exposes faces only to the recipient`, () => {
    for (const recipient of ["self", "other"]) {
      const { hostId, guestId, command, project, undoDepth, ids } = setup(mode);
      const ownerId = recipient === "self" ? guestId : hostId;
      const observerId = recipient === "self" ? hostId : guestId;
      const before = project(observerId);
      const previousUndoDepth = undoDepth();
      command(guestId, { type: "move-stack", cardId: ids.at(-1), target: "hand", ...(recipient === "other" ? { ownerId } : {}) });
      const received = project(ownerId);
      const observed = project(observerId);
      assert.equal(observed.revision, before.revision + 1);
      assert.equal(undoDepth(), previousUndoDepth + 1);
      assert.deepEqual(received.cards.filter((card) => ids.includes(card.id)).map((card) => card.id), ids);
      for (const id of ids) {
        const card = received.cards.find((candidate) => candidate.id === id);
        assert.equal(card.zone, "hand");
        assert.equal(card.ownerId, ownerId);
        assert.ok(card.face?.label);
        assert.equal(card.x, null);
        assert.equal(card.y, null);
        assert.equal(card.rotation, 0);
        assert.equal(observed.cards.find((candidate) => candidate.id === id).face, null);
      }
      assert.deepEqual(observed.cards.filter((card) => !ids.includes(card.id)), before.cards.filter((card) => !ids.includes(card.id)));
      command(hostId, { type: "undo" });
      assert.deepEqual(project(observerId).cards, before.cards);
    }
  });

  test(`${mode}: invalid stack moves never change cards, revision, or undo history`, () => {
    const { hostId, guestId, command, project, undoDepth, ids } = setup(mode);
    const before = project(guestId);
    const previousUndoDepth = undoDepth();
    const privateCard = before.cards.find((card) => card.ownerId === hostId && card.zone === "hand");
    const singleCard = before.cards.find((card) => card.zone === "public" && !ids.includes(card.id));
    const invalid = [
      [{ cardId: "missing", target: "public", x: 700, y: 400 }, "CARD_NOT_FOUND"],
      [{ cardId: privateCard.id, target: "hand" }, "CARD_NOT_PUBLIC"],
      [{ cardId: singleCard.id, target: "public", x: 700, y: 400 }, "STACK_TOO_SMALL"],
      [{ cardId: ids[0], target: "deck" }, "INVALID_TARGET"],
      [{ cardId: ids[0], target: "public", x: "invalid", y: 400 }, "INVALID_DROP"],
      [{ cardId: ids[0], target: "public", x: 700, y: Infinity }, "INVALID_DROP"],
      [{ cardId: ids[0], target: "hand", ownerId: "missing" }, "PLAYER_NOT_FOUND"]
    ];
    for (const [value, code] of invalid) {
      assert.throws(() => command(guestId, { type: "move-stack", ...value }), (error) => error.code === code);
      const after = project(guestId);
      assert.deepEqual({ ...after, serverTime: before.serverTime }, before);
      assert.equal(undoDepth(), previousUndoDepth);
    }
  });
}
