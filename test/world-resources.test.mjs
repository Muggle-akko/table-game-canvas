import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as serverCore from "../src/room-engine.mjs";
import { loadPreviewEngine } from "./helpers/preview.mjs";

const standard = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const uno = JSON.parse(await readFile(new URL("../game-packs/uno.json", import.meta.url)));
const { core: browserCore } = await loadPreviewEngine();
const plain = (value) => JSON.parse(JSON.stringify(value));

for (const [mode, core] of [["server", serverCore], ["browser", browserCore]]) {
  const setup = () => {
    const room = core.createRoom({ code: "WORLD", pack: standard, hostSecret: "private-host-secret" });
    const host = core.joinRoom(room, { hostSecret: "private-host-secret" });
    const guest = core.joinRoom(room, { displayName: "朋友" });
    const command = (value, who = host) => core.applyCommand(room, who.player.id, value);
    const state = (who = host) => core.projectRoom(room, who.player.id);
    const spawn = (resourceId) => { command({ type: "spawn-resource", resourceId, x: 1200, y: 450 }); return state().objects.at(-1) || state().tokens.at(-1); };
    return { room, host, guest, command, state, spawn };
  };

  test(`${mode}: independent decks retain their backs, hands, and source when collected`, () => {
    const { room, host, guest, command, state } = setup();
    command({ type: "draw" });
    const own = state().cards[0];
    const deckId = core.addRoomPack(room, guest.player.id, uno, { x: -800, y: 1400 });
    assert.equal(state().decks.length, 2);
    assert.equal(state().deck.count, 53);
    assert.equal(state().cards.find((card) => card.id === own.id).face.label, own.face.label);
    command({ type: "draw", deckId }, guest);
    const guestCard = state(guest).cards.find((card) => card.ownerId === guest.player.id);
    assert.equal(guestCard.back.label, "UNO");
    assert.equal(state().cards.find((card) => card.id === guestCard.id).face, null);
    command({ type: "move-card", cardId: guestCard.id, target: "public", x: -600, y: 1450 }, guest);
    command({ type: "collect-public" });
    assert.equal(state().decks.find((deck) => deck.id === deckId).count, 108);
    assert.equal(state().deck.count, 53);
    assert.equal(state().cards[0].id, own.id);
    assert.equal(room.sessions.get(host.sessionToken), host.player.id);
  });

  test(`${mode}: bag insertion rekeys cards and never projects stored contents`, () => {
    const { room, guest, command, state, spawn } = setup();
    command({ type: "draw-public", x: 600, y: 400 });
    const card = state().cards[0];
    command({ type: "flip-card", cardId: card.id });
    const label = state().cards[0].face.label;
    const bag = spawn("bag");
    command({ type: "bag-put", bagId: bag.id, resourceType: "card", resourceId: card.id });
    assert.equal(state().cards.length, 0);
    assert.equal(room.cards.has(card.id), false);
    const wire = JSON.stringify(state(guest));
    assert.equal(wire.includes(label), false);
    assert.equal(wire.includes('"contents"'), false);
    assert.equal(state().objects.find((object) => object.id === bag.id).count, 1);
    command({ type: "bag-draw", bagId: bag.id }, guest);
    assert.equal(state(guest).cards[0].face.label, label);
    assert.equal(state().cards[0].face, null);
    command({ type: "undo" });
    assert.equal(state().cards.length, 0);
    assert.equal(state().objects[0].count, 1);
  });

  test(`${mode}: resource copy, locking, editing, dice and undo are atomic`, () => {
    const { room, guest, command, state, spawn } = setup();
    const note = spawn("note");
    command({ type: "edit-resource", resourceType: "object", resourceId: note.id, label: "约定", text: "下班前再来一局" }, guest);
    command({ type: "duplicate-resource", resourceType: "object", resourceId: note.id });
    assert.equal(state().objects.length, 2);
    assert.notEqual(state().objects[0].id, state().objects[1].id);
    command({ type: "lock-resource", resourceType: "object", resourceId: note.id });
    const revision = room.revision;
    assert.throws(() => command({ type: "move-resource", resourceType: "object", resourceId: note.id, x: 2000, y: 0 }), { code: "RESOURCE_LOCKED" });
    assert.throws(() => command({ type: "edit-resource", resourceType: "object", resourceId: note.id, text: "x".repeat(601) }), { code: "TEXT_TOO_LONG" });
    assert.equal(room.revision, revision);
    command({ type: "undo" });
    assert.equal(state().objects[0].locked, false);
    const die = spawn("die-d20");
    command({ type: "roll-resource", resourceType: "object", resourceId: die.id }, guest);
    const value = state().objects.find((object) => object.id === die.id).value;
    assert.ok(Number.isInteger(value) && value >= 1 && value <= 20);
    assert.equal(state(guest).objects.find((object) => object.id === die.id).value, value);
    command({ type: "delete-resource", resourceType: "object", resourceId: die.id });
    assert.equal(state().objects.length, 2);
    command({ type: "undo" });
    assert.equal(state().objects.find((object) => object.id === die.id).value, value);
  });

  test(`${mode}: saved resources spawn independent copies without disclosing definitions`, () => {
    const { room, command, state } = setup();
    command({ type: "save-template", resourceType: "deck", resourceId: "main", label: "周五扑克" });
    const template = state().templates[0];
    assert.equal(template.count, 54);
    assert.equal(Object.hasOwn(template, "cards"), false);
    assert.equal(Object.hasOwn(template, "resource"), false);
    command({ type: "spawn-template", templateId: template.id, x: 2200, y: 500 });
    const deck = state().decks.find((entry) => entry.id !== "main");
    assert.equal(deck.count, 54);
    assert.equal(room.cards.size, 108);
    assert.equal(new Set([...room.cards.keys()]).size, 108);
    command({ type: "draw", deckId: deck.id });
    assert.equal(state().deck.count, 54);
    assert.equal(state().decks.find((entry) => entry.id === deck.id).count, 53);
    command({ type: "undo" });
    command({ type: "undo" });
    assert.equal(room.cards.size, 54);
    assert.equal(state().templates.length, 1);
  });

  test(`${mode}: open-world motion crosses the old table boundary`, () => {
    const { guest, command, state, spawn } = setup();
    const note = spawn("note");
    command({ type: "move-resource", resourceType: "object", resourceId: note.id, x: -2300, y: 2700 }, guest);
    assert.deepEqual(plain(state().objects[0]), plain(state(guest).objects[0]));
    assert.equal(state().objects[0].x, -2300);
    command({ type: "move-resource", resourceType: "deck", resourceId: "main", x: 3200, y: 2000 });
    assert.equal(state().decks[0].x, 3200);
    command({ type: "draw-public", x: 3500, y: 2200 });
    assert.equal(state().cards[0].x, 3500);
    command({ type: "move-resource", resourceType: "object", resourceId: note.id, x: 99999, y: 99999 });
    assert.ok(state().objects[0].x + note.width <= 6300);
    assert.ok(state().objects[0].y + note.height <= 4100);
  });

  test(`${mode}: scene round trip preserves objects and sessions without exporting private hands`, () => {
    const { room, host, guest, command, state, spawn } = setup();
    core.addRoomPack(room, host.player.id, uno, { x: -700, y: 1200 });
    command({ type: "draw" }, guest);
    command({ type: "draw-public", x: 1100, y: 650 });
    const bag = spawn("bag");
    const publicId = state().cards.find((card) => card.zone === "public").id;
    command({ type: "bag-put", bagId: bag.id, resourceType: "card", resourceId: publicId });
    spawn("note");
    const scene = core.exportRoomScene(room, host.player.id, "下次接着玩");
    assert.ok(scene.cards.every((card) => !Object.hasOwn(card, "ownerId") && card.zone !== "hand"));
    const serialized = JSON.stringify(scene);
    for (const secret of [host.sessionToken, guest.sessionToken, room.hostSecret, host.player.id, guest.player.id]) assert.equal(serialized.includes(secret), false);
    assert.throws(() => core.exportRoomScene(room, guest.player.id), { code: "HOST_ONLY" });
    assert.throws(() => core.restoreRoomScene(room, guest.player.id, scene), { code: "HOST_ONLY" });
    const oldIds = new Set(room.cards.keys());
    core.restoreRoomScene(room, host.player.id, plain(scene));
    assert.equal(room.title, "下次接着玩");
    assert.equal(room.cards.size, 162);
    assert.equal(state().decks.length, 2);
    assert.equal(state().objects.length, 2);
    assert.ok([...room.cards.keys()].every((id) => !oldIds.has(id)));
    assert.equal(state(guest).cards.length, 0);
    assert.equal(room.sessions.get(guest.sessionToken), guest.player.id);
    command({ type: "bag-draw", bagId: bag.id }, guest);
    assert.ok(state(guest).cards[0].face);
    command({ type: "undo" });
    command({ type: "undo" });
    assert.equal(state(guest).cards.filter((card) => card.zone === "hand").length, 1);
  });

  test(`${mode}: malformed scene imports leave the complete room untouched`, () => {
    const { room, host, command, state, spawn } = setup();
    spawn("bag");
    const scene = plain(core.exportRoomScene(room, host.player.id));
    const before = JSON.stringify(state());
    for (const corrupt of [
      (value) => { value.decks = []; },
      (value) => { value.cards[0].deckId = "missing"; },
      (value) => { value.cards[0].face.image = "../secret.png"; },
      (value) => { value.decks[0].order.push(value.decks[0].order[0]); },
      (value) => { value.objects[0].contents.push({ type: "card", id: value.cards[0].id }); },
      (value) => { value.cards[0].id = value.cards[1].id; }
    ]) {
      const bad = plain(scene); corrupt(bad);
      assert.throws(() => core.restoreRoomScene(room, host.player.id, bad));
      assert.equal(room.revision, JSON.parse(before).revision);
      assert.deepEqual(plain(state()).objects, JSON.parse(before).objects);
    }
    command({ type: "draw" });
    assert.equal(state().deck.count, 53);
  });

  test(`${mode}: chat and presence do not consume tabletop undo`, () => {
    const { room, guest, command, state } = setup();
    command({ type: "draw" });
    const undoDepth = room.undoStack.length;
    command({ type: "chat", text: "等我两分钟" }, guest);
    command({ type: "set-presence", status: "摸鱼中" }, guest);
    assert.equal(room.undoStack.length, undoDepth);
    assert.equal(state().messages[0].text, "等我两分钟");
    assert.equal(state().players.find((player) => player.id === guest.player.id).status, "摸鱼中");
    assert.throws(() => command({ type: "chat", text: "太快" }, guest), { code: "CHAT_TOO_FAST" });
    command({ type: "undo" });
    assert.equal(state().messages.length, 1);
    assert.equal(state().deck.count, 54);
  });

  test(`${mode}: a locked card blocks stack and bulk operations without partial mutations`, () => {
    const { room, command, state } = setup();
    command({ type: "draw-public", x: 600, y: 400 });
    command({ type: "draw-public", x: 612, y: 412 });
    const [locked, top] = state().cards;
    command({ type: "lock-resource", resourceType: "card", resourceId: locked.id });
    const before = plain(state()), undoDepth = room.undoStack.length;
    delete before.serverTime;
    for (const type of ["move-stack", "shuffle-stack", "draw-stack", "spread-stack", "collect-deck", "tidy-public", "collect-public"]) {
      assert.throws(() => command({ type, cardId: top.id, target: "public", x: 900, y: 500 }), { code: "RESOURCE_LOCKED" });
      assert.equal(room.revision, before.revision);
      assert.equal(room.undoStack.length, undoDepth);
      const after = plain(state()); delete after.serverTime;
      assert.deepEqual(after, before);
    }
    command({ type: "lock-resource", resourceType: "card", resourceId: locked.id });
    command({ type: "spread-stack", cardId: top.id });
    assert.ok(Math.abs(state().cards[0].x - state().cards[1].x) > 47);
    command({ type: "tidy-public" });
    command({ type: "collect-public" });
    assert.equal(state().cards.length, 0);
    assert.equal(state().deck.count, 54);
    assert.ok([...room.cards.values()].every((card) => !card.locked));
  });

  test(`${mode}: reaching the deck limit still permits small objects but rejects one more deck atomically`, () => {
    const { room, host, command, state } = setup();
    const tiny = { ...standard, id: "single-card", cards: standard.cards.slice(0, 1), tokens: [] };
    for (let index = 0; index < 31; index++) core.addRoomPack(room, host.player.id, tiny);
    assert.equal(state().decks.length, 32);
    command({ type: "spawn-resource", resourceId: "die-d6", x: 500, y: 500 });
    assert.equal(state().objects.length, 1);
    const revision = room.revision, depth = room.undoStack.length;
    assert.throws(() => core.addRoomPack(room, host.player.id, tiny), { code: "TABLE_FULL" });
    assert.throws(() => command({ type: "duplicate-resource", resourceType: "deck", resourceId: "main" }), { code: "TABLE_FULL" });
    assert.equal(room.revision, revision);
    assert.equal(room.undoStack.length, depth);
  });

  test(`${mode}: scene restoration preserves shared counters and the ordering of high decks`, () => {
    const { room, host, command, state } = setup();
    room.decks.get("main").z = 9000;
    command({ type: "roll-die" });
    command({ type: "adjust-counter", delta: 1 });
    const scene = core.exportRoomScene(room, host.player.id);
    assert.equal(Object.hasOwn(scene.components.die, "lastRolledBy"), false);
    command({ type: "adjust-counter", delta: 1 });
    core.restoreRoomScene(room, host.player.id, plain(scene));
    assert.equal(state().counter.value, scene.components.counter.value);
    assert.equal(state().die.value, scene.components.die.value);
    command({ type: "spawn-resource", resourceId: "note", x: 700, y: 400 });
    assert.ok(state().objects[0].z > 9000);
    command({ type: "reset" });
    command({ type: "draw-public", x: 700, y: 400 });
    assert.ok(state().cards[0].z > state().objects[0].z);
  });
}
