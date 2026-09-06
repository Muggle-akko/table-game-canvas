import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as serverCore from "../src/room-engine.mjs";
import { loadPreviewEngine } from "./helpers/preview.mjs";

const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const { core: browserCore } = await loadPreviewEngine();
const plain = (value) => JSON.parse(JSON.stringify(value));
for (const [mode, core] of [["server", serverCore], ["browser", browserCore]]) {
  const setup = () => {
    const room = core.createRoom({ code: "RES-UME", pack, hostSecret: "private-host-secret", randomizeDeck: false });
    const host = core.joinRoom(room, { hostSecret: room.hostSecret, displayName: "房主" });
    const guest = core.joinRoom(room, { displayName: "朋友" });
    const command = (value, actor = host) => core.applyCommand(room, actor.player.id, value);
    return { room, host, guest, command };
  };
  const faceOrder = (room) => plain([...room.decks.values()].map((deck) => deck.order.map((id) => room.cards.get(id).face)));
  const hands = (room) => plain([...room.cards.values()].filter((card) => card.zone === "hand").map(({ id, ...card }) => card));

  test(`${mode}: full game roundtrip preserves hands, exact hidden order, bags, templates and components`, () => {
    const { room, host, guest, command } = setup();
    command({ type: "draw" }, guest);
    command({ type: "draw" });
    const card = [...room.cards.values()].find((card) => card.ownerId === guest.player.id);
    command({ type: "move-card", cardId: card.id, target: "hand", ownerId: guest.player.id, x: 1100, y: 930, rotation: 17 }, guest);
    command({ type: "set-turn", playerId: guest.player.id });
    command({ type: "adjust-counter", delta: 1 });
    command({ type: "roll-die" });
    const bag = command({ type: "spawn-resource", resourceId: "bag", x: 1000, y: 500 }).createdResource;
    command({ type: "draw-public", x: 600, y: 400 });
    const publicCard = [...room.cards.values()].find((item) => item.zone === "public");
    command({ type: "bag-put", bagId: bag.id, resourceType: "card", resourceId: publicCard.id });
    command({ type: "save-template", resourceType: "deck", resourceId: "main" });
    command({ type: "chat", text: "明晚从这里接着玩" }, guest);
    const order = faceOrder(room), privateCards = hands(room), previousIds = [...room.cards.keys()];
    const archive = core.exportRoomGame(room, host.player.id, "周五牌局");
    assert.equal(JSON.stringify(archive).includes(host.sessionToken), false);
    assert.equal(JSON.stringify(archive).includes(room.hostSecret), false);
    const key = guest.player.recoveryKey, die = room.die.value, counter = room.counter.value;
    command({ type: "draw" });
    core.restoreRoomGame(room, host.player.id, plain(archive));
    assert.deepEqual(faceOrder(room), order);
    assert.deepEqual(hands(room), privateCards);
    assert.ok([...room.cards.keys()].every((id) => !previousIds.includes(id)), "portable restore changes card identifiers without shuffling faces");
    assert.equal(room.die.value, die); assert.equal(room.counter.value, counter);
    assert.equal(room.templates.size, 1); assert.equal(room.objects.get(bag.id).contents.length, 1);
    assert.equal(room.turn.activePlayerId, guest.player.id);
    assert.equal(room.messages[0].text, "明晚从这里接着玩");
    assert.equal(core.joinRoom(room, { seatKey: key }).player.id, guest.player.id);
    assert.equal(core.playerForSession(room, guest.sessionToken).id, guest.player.id);
    assert.equal(room.history.at(-1).action, "restore-game");
    const hostView = core.projectRoom(room, host.player.id), guestView = core.projectRoom(room, guest.player.id);
    assert.equal(hostView.cards.find((item) => item.ownerId === guest.player.id).face, null);
    assert.ok(guestView.cards.find((item) => item.ownerId === guest.player.id).face);
  });

  test(`${mode}: personal keys resume only their own seat and are excluded from others' projections`, () => {
    const { room, host, guest } = setup();
    const view = core.projectRoom(room, guest.player.id);
    assert.equal(view.you.recoveryKey, guest.player.recoveryKey);
    assert.equal(JSON.stringify(view).includes(host.player.recoveryKey), false);
    assert.ok(view.players.every((player) => !Object.hasOwn(player, "recoveryKey")));
    assert.throws(() => core.exportRoomGame(room, guest.player.id), { code: "HOST_ONLY" });
    assert.throws(() => core.joinRoom(room, { resumeToken: "expired-token" }), { code: "SESSION_EXPIRED" });
    assert.throws(() => core.joinRoom(room, { seatKey: "invalid-key" }), { code: "INVALID_SEAT_LINK" });
    assert.equal(room.players.size, 2, "invalid credentials never create a replacement identity");
  });

  test(`${mode}: repeated personal-link joins keep recent sessions and a restartable bounded checkpoint`, () => {
    const { room, host, guest } = setup();
    let latest;
    for (let index = 0; index < 80; index++) {
      core.joinRoom(room, { resumeToken: host.sessionToken });
      latest = core.joinRoom(room, { seatKey: guest.player.recoveryKey });
    }
    assert.equal(room.sessions.size, 17);
    assert.equal(core.playerForSession(room, guest.sessionToken), null);
    const restarted = core.roomFromCheckpoint(plain(core.exportRoomCheckpoint(room)));
    assert.equal(core.joinRoom(restarted, { resumeToken: latest.sessionToken }).player.id, guest.player.id);
    assert.equal(core.joinRoom(restarted, { resumeToken: host.sessionToken }).player.id, host.player.id);
    assert.equal(core.joinRoom(restarted, { seatKey: guest.player.recoveryKey }).player.id, guest.player.id);
    assert.equal(restarted.players.size, 2);
  });

  test(`${mode}: restart checkpoint preserves exact card ids and valid sessions with all players offline`, () => {
    const { room, host, guest, command } = setup();
    command({ type: "draw" }, guest);
    const key = `${guest.player.id}:command-one`;
    room.commandReceipts.set(key, { fingerprint: "a".repeat(64), revision: room.revision });
    const checkpoint = core.exportRoomCheckpoint(room), restored = core.roomFromCheckpoint(plain(checkpoint));
    assert.deepEqual([...restored.cards.keys()], [...room.cards.keys()]);
    assert.deepEqual(faceOrder(restored), faceOrder(room));
    assert.deepEqual(hands(restored), hands(room));
    assert.equal(restored.gameId, room.gameId); assert.equal(restored.code, room.code);
    assert.equal(restored.commandReceipts.get(key).fingerprint, "a".repeat(64));
    assert.ok([...restored.players.values()].every((player) => player.connections === 0));
    assert.equal(core.joinRoom(restored, { resumeToken: host.sessionToken }).player.id, host.player.id);
    assert.equal(core.joinRoom(restored, { seatKey: guest.player.recoveryKey }).player.id, guest.player.id);
    assert.ok(restored.revision > room.revision);
  });

  test(`${mode}: malformed full archives fail before changing any live state`, () => {
    const { room, host, guest, command } = setup();
    command({ type: "draw" }, guest);
    const archive = core.exportRoomGame(room, host.player.id);
    for (const corrupt of [
      (game) => { game.players[1].recoveryKey = game.players[0].recoveryKey; },
      (game) => { game.hands[0].ownerId = "missing"; },
      (game) => { game.players[1].seatIndex = 0; },
      (game) => { game.table.decks[0].order.push(game.table.decks[0].order[0]); },
      (game) => { game.table.cards[0].face.image = "../../secret.png"; },
      (game) => { game.templates = [null]; }
    ]) {
      const invalid = plain(archive); corrupt(invalid);
      const before = JSON.stringify(core.exportRoomGame(room, host.player.id)), revision = room.revision;
      assert.throws(() => core.restoreRoomGame(room, host.player.id, invalid), { code: "INVALID_GAME" });
      const after = core.exportRoomGame(room, host.player.id), expected = JSON.parse(before); delete after.savedAt; delete expected.savedAt;
      assert.deepEqual(plain(after), expected); assert.equal(room.revision, revision);
    }
    const checkpoint = core.exportRoomCheckpoint(room); checkpoint.commandReceipts = [null];
    assert.throws(() => core.roomFromCheckpoint(checkpoint), { code: "INVALID_CHECKPOINT" });
  });

  test(`${mode}: a checkpoint is valid before the host has joined and restore resolves nickname conflicts`, () => {
    const room = core.createRoom({ code: "BEFORE", pack, hostSecret: "before-host-secret" });
    core.roomFromCheckpoint(core.exportRoomCheckpoint(room));
    const guest = core.joinRoom(room, { displayName: "客人" });
    assert.equal(core.roomFromCheckpoint(core.exportRoomCheckpoint(room)).players.size, 1);
    const host = core.joinRoom(room, { hostSecret: room.hostSecret, displayName: "房主" });
    const saved = core.exportRoomGame(room, host.player.id);
    core.applyCommand(room, guest.player.id, { type: "rename-player", name: "朋友" });
    core.applyCommand(room, host.player.id, { type: "rename-player", name: "客人" });
    core.restoreRoomGame(room, host.player.id, saved);
    assert.equal(new Set([...room.players.values()].map((player) => player.name)).size, 2);
    core.validateRoomGame(core.exportRoomGame(room, host.player.id));
  });
}
