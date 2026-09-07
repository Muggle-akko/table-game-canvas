import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as server from "../src/room-engine.mjs";
import { loadPreviewEngine } from "./helpers/preview.mjs";

const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const { core: browser } = await loadPreviewEngine();
const plain = (value) => JSON.parse(JSON.stringify(value));
for (const [mode, core] of [["server", server], ["browser", browser]]) {
  const setup = () => {
    const room = core.createRoom({ code: "FREE-123", pack, hostSecret: "test-host", randomizeDeck: false });
    const host = core.joinRoom(room, { hostSecret: room.hostSecret }).player;
    const guest = core.joinRoom(room, { displayName: "朋友" }).player;
    const third = core.joinRoom(room, { displayName: "第三位" }).player;
    const command = (value, player = host) => core.applyCommand(room, player.id, value);
    const state = (player = host) => core.projectRoom(room, player.id);
    return { room, host, guest, third, command, state };
  };

  test(`${mode}: only the host and current player may pass the turn, including to a chosen seat`, () => {
    const { room, host, guest, third, command, state } = setup();
    command({ type: "set-turn", playerId: guest.id });
    const revision = room.revision;
    for (const type of ["set-turn", "advance-turn", "random-turn"]) assert.throws(() => command({ type, playerId: third.id }, third), { code: "NOT_YOUR_TURN" });
    assert.equal(room.revision, revision);
    command({ type: "set-turn", playerId: third.id }, guest);
    assert.equal(state(guest).turn.activePlayerId, third.id);
    assert.throws(() => command({ type: "advance-turn" }, guest), { code: "NOT_YOUR_TURN" });
    assert.throws(() => command({ type: "random-turn" }, third), { code: "NOT_YOUR_TURN" });
    command({ type: "advance-turn" }, third);
    assert.equal(state().turn.activePlayerId, host.id);
    command({ type: "set-turn", playerId: third.id });
    command({ type: "advance-turn" });
    assert.equal(state().turn.activePlayerId, host.id, "the host may still pass somebody else's turn");
    command({ type: "undo" });
    assert.equal(state().turn.activePlayerId, third.id);
  });

  test(`${mode}: revealing a hand changes visibility without changing ownership, position or order`, () => {
    const { host, guest, third, command, state } = setup();
    command({ type: "draw" }, guest);
    const card = state(guest).cards[0];
    assert.equal(state(host).cards[0].face, null);
    assert.throws(() => command({ type: "flip-card", cardId: card.id }), { code: "NO_CONTROL" });
    command({ type: "flip-card", cardId: card.id }, guest);
    const shown = state(guest).cards[0];
    for (const key of ["id", "zone", "ownerId", "x", "y", "rotation", "handOrder"]) assert.equal(shown[key], card[key]);
    for (const viewer of [host, third]) {
      assert.equal(state(viewer).cards[0].face.label, card.face.label);
      assert.equal(state(viewer).cards[0].canFlip, false);
    }
    command({ type: "move-card", cardId: card.id, target: "hand", x: card.x + 80, y: card.y + 40, rotation: 25 }, guest);
    command({ type: "arrange-hand" }, guest);
    assert.equal(state(third).cards[0].faceUp, true, "arranging a shown card must keep it shown");
    command({ type: "flip-card", cardId: card.id }, guest);
    assert.equal(state(third).cards[0].face, null);
    assert.equal(state(guest).cards[0].face.label, card.face.label);
    command({ type: "flip-card", cardId: card.id }, guest);
    command({ type: "move-card", cardId: card.id, target: "hand", ownerId: third.id }, guest);
    assert.equal(state(guest).cards[0].face, null, "handing over a card conceals it from the previous owner");
    assert.equal(state(third).cards[0].faceUp, false);
    assert.equal(state(third).cards[0].face.label, card.face.label);
  });

  test(`${mode}: archives and restarts preserve hand reveal state while old archives remain private`, () => {
    const { room, host, guest, command, state } = setup();
    command({ type: "draw" }, guest); command({ type: "draw" }, guest);
    const [shown, hidden] = state(guest).cards;
    command({ type: "flip-card", cardId: shown.id }, guest);
    const archive = core.exportRoomGame(room, host.id);
    assert.equal(archive.hands.find((hand) => hand.cardId === shown.id).faceUp, true);
    const restarted = core.roomFromCheckpoint(plain(core.exportRoomCheckpoint(room)));
    const view = core.projectRoom(restarted, host.id);
    assert.equal(view.cards.find((card) => card.id === shown.id).face.label, shown.face.label);
    assert.equal(view.cards.find((card) => card.id === hidden.id).face, null);
    core.restoreRoomGame(room, host.id, plain(archive));
    assert.equal(state().cards.filter((card) => card.face).length, 1);
    const bad = plain(archive); bad.hands[0].faceUp = "true";
    const snapshot = () => { const { serverTime, ...view } = state(); return JSON.stringify(view); };
    const before = snapshot();
    assert.throws(() => core.restoreRoomGame(room, host.id, bad), { code: "INVALID_GAME" });
    assert.equal(snapshot(), before);
    const legacy = plain(archive); legacy.hands.forEach((hand) => delete hand.faceUp);
    core.restoreRoomGame(room, host.id, legacy);
    assert.ok(state().cards.every((card) => card.face === null));
  });

  test(`${mode}: mixed chips merge, move, take, spread, bag and undo without changing their values`, () => {
    const { room, host, guest, command } = setup();
    const ids = ["chip-25", "chip-100", "chip-500", "token-black"].map((resourceId, index) => command({ type: "spawn-resource", resourceId, x: 200 + index * 190, y: 300 }, guest).createdResource.id);
    const original = ids.map((id) => { const token = room.tokens.get(id); return [id, token.symbol, token.color]; });
    const stack = (id) => core.tokenStackMembers(room.tokens.values(), id);
    const merge = (source, target, type = "token") => command({ type: "stack-onto", resourceType: type, resourceId: source, targetType: "token", targetId: target }, guest);
    merge(ids[0], ids[1]); merge(ids[2], ids[3]);
    const result = merge(ids[0], ids[2], "token-stack");
    assert.equal(result.createdResource.id, ids[0]);
    assert.deepEqual(plain(stack(ids[0]).map((token) => token.id)), [ids[3], ids[2], ids[1], ids[0]]);
    command({ type: "move-token-stack", tokenId: ids[0], x: 900, y: 620 }, guest);
    assert.equal(room.tokens.get(ids[0]).x, 900); assert.equal(room.tokens.get(ids[0]).y, 620);
    const saved = core.roomFromCheckpoint(plain(core.exportRoomCheckpoint(room)));
    assert.equal(core.tokenStackMembers(saved.tokens.values(), ids[0]).length, 4);
    command({ type: "take-token", tokenId: ids[1] }, guest);
    assert.equal(stack(ids[0]).length, 1); assert.equal(stack(ids[1]).length, 3);
    command({ type: "undo" });
    assert.equal(stack(ids[0]).length, 4);
    command({ type: "spread-token-stack", tokenId: ids[0], layout: "row" }, guest);
    assert.ok(ids.every((id) => stack(id).length === 1));
    assert.equal(new Set(ids.map((id) => room.tokens.get(id).y)).size, 1);
    command({ type: "undo" });
    const bag = command({ type: "spawn-resource", resourceId: "bag", x: 1200, y: 500 }).createdResource.id;
    command({ type: "bag-put", bagId: bag, resourceType: "token-stack", resourceId: ids[0] }, guest);
    assert.equal(room.objects.get(bag).contents.length, 4); assert.equal(stack(ids[0]).length, 0);
    command({ type: "undo" }, host);
    assert.equal(stack(ids[0]).length, 4);
    assert.deepEqual(ids.map((id) => { const token = room.tokens.get(id); return [id, token.symbol, token.color]; }), original);
  });

  test(`${mode}: locked or invalid chip operations reject atomically and stacks stay within the world`, () => {
    const { room, command } = setup();
    const ids = ["chip-25", "chip-100", "chip-500"].map((resourceId, index) => command({ type: "spawn-resource", resourceId, x: 400 + index * 160, y: 500 }).createdResource.id);
    const merge = (source, target) => command({ type: "stack-onto", resourceType: "token", resourceId: source, targetType: "token", targetId: target });
    merge(ids[0], ids[1]);
    command({ type: "lock-resource", resourceType: "token", resourceId: ids[1] });
    const snapshot = () => JSON.stringify([[...room.tokens], room.revision, room.undoStack.length]);
    let before = snapshot();
    for (const type of ["move-token-stack", "take-token", "spread-token-stack"]) assert.throws(() => command({ type, tokenId: ids[0], x: 800, y: 700 }), { code: "RESOURCE_LOCKED" });
    assert.throws(() => merge(ids[2], ids[0]), { code: "RESOURCE_LOCKED" });
    assert.equal(snapshot(), before);
    command({ type: "lock-resource", resourceType: "token", resourceId: ids[1] });
    before = snapshot();
    assert.throws(() => command({ type: "move-token-stack", tokenId: ids[0], x: NaN, y: 700 }), { code: "INVALID_DROP" });
    assert.throws(() => command({ type: "spread-token-stack", tokenId: ids[0], layout: "diagonal" }), { code: "INVALID_LAYOUT" });
    assert.throws(() => merge(ids[0], ids[1]), { code: "SAME_PILE" });
    assert.equal(snapshot(), before);
    command({ type: "move-token-stack", tokenId: ids[0], x: 99999, y: 99999 });
    const zone = core.TABLE_GEOMETRY.publicZone, stack = core.tokenStackMembers(room.tokens.values(), ids[0]);
    assert.equal(stack.length, 2);
    assert.ok(stack.every((token) => token.x + 62 <= zone.x + zone.width && token.y + 62 <= zone.y + zone.height));
  });
}
