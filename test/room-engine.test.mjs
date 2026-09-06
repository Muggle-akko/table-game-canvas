import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RoomError,
  applyCommand,
  createRoom,
  joinRoom,
  playerForSession,
  projectRoom,
  replaceRoomPack
} from "../src/room-engine.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pack = JSON.parse(await readFile(resolve(root, "game-packs", "parlor-eight.json"), "utf8"));
const unoPack = JSON.parse(await readFile(resolve(root, "game-packs", "uno.json"), "utf8"));

function setupRoom() {
  const room = createRoom({
    code: "INK-204",
    hostName: "房主A",
    hostSecret: "host-secret",
    pack,
    randomizeDeck: false
  });
  const host = joinRoom(room, { hostSecret: "host-secret" }).player;
  const guest = joinRoom(room, { displayName: "客人B" }).player;
  return { room, host, guest };
}

test("joins guests without login using a distinct color", () => {
  const { host, guest } = setupRoom();
  assert.equal(host.role, "host");
  assert.equal(guest.role, "guest");
  assert.notEqual(host.color, guest.color);
  assert.equal(guest.name, "客人B");
});

test("defaults the first guest name to 玩家2", () => {
  const room = createRoom({
    code: "INK-204",
    hostName: "玩家1",
    hostSecret: "host-secret",
    pack,
    randomizeDeck: false
  });
  joinRoom(room, { hostSecret: "host-secret" });
  const guest = joinRoom(room, {}).player;
  assert.equal(guest.name, "玩家2");
});

test("keeps Unicode and duplicate player names within twenty characters", () => {
  const room = createRoom({
    code: "INK-204",
    hostName: "🎲".repeat(24),
    hostSecret: "host-secret",
    pack,
    randomizeDeck: false
  });
  const host = joinRoom(room, { hostSecret: "host-secret" }).player;
  const duplicate = joinRoom(room, { displayName: "🎲".repeat(24) }).player;

  assert.equal(Array.from(host.name).length, 20);
  assert.equal(Array.from(duplicate.name).length, 20);
  assert.match(duplicate.name, / 2$/);
  assert.equal(duplicate.name.includes("�"), false);
});

test("never includes another player's private face in their projected JSON", () => {
  const { room, host, guest } = setupRoom();
  applyCommand(room, host.id, { type: "draw" });

  const hostView = projectRoom(room, host.id);
  const guestView = projectRoom(room, guest.id);
  const hostCard = hostView.cards.find((card) => card.ownerId === host.id);
  const guestPlaceholder = guestView.cards.find((card) => card.id === hostCard.id);

  assert.ok(hostCard.face?.label);
  assert.equal(guestPlaceholder.face, null);
  assert.equal(JSON.stringify(guestView).includes(hostCard.face.label), false);
  assert.match(hostCard.id, /^card_[a-f0-9]{32}$/);
  assert.equal(hostCard.id.includes(hostCard.face.suit), false);
});

test("reveals in public and filters again after returning to hand", () => {
  const { room, host, guest } = setupRoom();
  applyCommand(room, host.id, { type: "draw" });
  const cardId = projectRoom(room, host.id).cards[0].id;

  applyCommand(room, host.id, {
    type: "move-card",
    cardId,
    target: "public",
    x: 600,
    y: 400,
    rotation: 275
  });
  const publicGuestCard = projectRoom(room, guest.id).cards.find((card) => card.id === cardId);
  assert.ok(publicGuestCard.face?.label);
  assert.equal(publicGuestCard.zone, "public");
  assert.equal(publicGuestCard.rotation, 180);

  applyCommand(room, host.id, { type: "move-card", cardId, target: "hand" });
  const hiddenAgain = projectRoom(room, guest.id).cards.find((card) => card.id === cardId);
  assert.equal(hiddenAgain.zone, "hand");
  assert.equal(hiddenAgain.face, null);
  assert.equal(JSON.stringify(projectRoom(room, guest.id)).includes(publicGuestCard.face.label), false);
});

test("flips a public card face down without leaking its face", () => {
  const { room, host, guest } = setupRoom();
  applyCommand(room, host.id, { type: "draw" });
  const card = projectRoom(room, host.id).cards[0];
  applyCommand(room, host.id, {
    type: "move-card",
    cardId: card.id,
    target: "public",
    x: 620,
    y: 410
  });

  const revealed = projectRoom(room, guest.id).cards.find((candidate) => candidate.id === card.id);
  assert.ok(revealed.face?.label);
  assert.equal(revealed.faceUp, true);

  applyCommand(room, host.id, { type: "flip-card", cardId: card.id });
  const hiddenHost = projectRoom(room, host.id).cards.find((candidate) => candidate.id === card.id);
  const hiddenGuest = projectRoom(room, guest.id).cards.find((candidate) => candidate.id === card.id);
  assert.equal(hiddenHost.faceUp, false);
  assert.equal(hiddenHost.face, null);
  assert.equal(hiddenGuest.face, null);
  assert.equal(JSON.stringify(projectRoom(room, guest.id)).includes(revealed.face.label), false);
  applyCommand(room, guest.id, { type: "flip-card", cardId: card.id });
  assert.ok(projectRoom(room, guest.id).cards.find((candidate) => candidate.id === card.id).face);
  applyCommand(room, host.id, { type: "undo" });
  assert.equal(projectRoom(room, guest.id).cards.find((candidate) => candidate.id === card.id).face, null);
});

test("draws directly from the deck to a face-down public card without a reveal state", () => {
  const { room, host, guest } = setupRoom();
  applyCommand(room, host.id, { type: "draw-public", x: 710, y: 430 });

  const hostCard = projectRoom(room, host.id).cards[0];
  const guestCard = projectRoom(room, guest.id).cards[0];
  const hiddenLabel = room.cards.get(hostCard.id).face.label;
  assert.equal(projectRoom(room, host.id).deck.count, 7);
  assert.deepEqual({ x: hostCard.x, y: hostCard.y, faceUp: hostCard.faceUp }, { x: 710, y: 430, faceUp: false });
  assert.equal(hostCard.face, null);
  assert.equal(guestCard.face, null);
  assert.equal(JSON.stringify(projectRoom(room, guest.id)).includes(hiddenLabel), false);

  applyCommand(room, host.id, { type: "flip-card", cardId: hostCard.id });
  assert.ok(projectRoom(room, guest.id).cards[0].face?.label);
  applyCommand(room, host.id, { type: "undo" });
  assert.equal(projectRoom(room, guest.id).cards[0].face, null);
  applyCommand(room, host.id, { type: "undo" });
  assert.equal(projectRoom(room, host.id).deck.count, 8);
  assert.equal(projectRoom(room, host.id).cards.length, 0);
});

test("does not let a guest move the host's card", () => {
  const { room, host, guest } = setupRoom();
  applyCommand(room, host.id, { type: "draw" });
  const cardId = projectRoom(room, host.id).cards[0].id;

  assert.throws(
    () => applyCommand(room, guest.id, { type: "move-card", cardId, target: "public", x: 500, y: 400 }),
    (error) => error instanceof RoomError && error.code === "NO_CONTROL"
  );
});

test("lets every player arrange, flip, and freely take a public card into a hand", () => {
  const { room, host, guest } = setupRoom();
  applyCommand(room, host.id, { type: "draw" });
  const cardId = projectRoom(room, host.id).cards[0].id;
  applyCommand(room, host.id, {
    type: "move-card",
    cardId,
    target: "public",
    x: 500,
    y: 360
  });

  assert.equal(projectRoom(room, guest.id).cards.find((card) => card.id === cardId).canControl, true);
  applyCommand(room, guest.id, {
    type: "move-card",
    cardId,
    target: "public",
    x: 760,
    y: 490,
    rotation: 30
  });
  const moved = projectRoom(room, host.id).cards.find((card) => card.id === cardId);
  assert.deepEqual({ x: moved.x, y: moved.y, rotation: moved.rotation }, { x: 760, y: 490, rotation: 30 });

  applyCommand(room, guest.id, { type: "flip-card", cardId });
  assert.equal(projectRoom(room, host.id).cards.find((card) => card.id === cardId).face, null);
  applyCommand(room, guest.id, { type: "move-card", cardId, target: "hand" });
  const guestHand = projectRoom(room, guest.id).cards.find((card) => card.id === cardId);
  const hostView = projectRoom(room, host.id).cards.find((card) => card.id === cardId);
  assert.equal(guestHand.zone, "hand");
  assert.equal(guestHand.ownerId, guest.id);
  assert.ok(guestHand.face?.label);
  assert.equal(hostView.face, null);
});

test("lets only the host replace the table pack while preserving everyone at the table", () => {
  const { room, host, guest } = setupRoom();
  applyCommand(room, host.id, { type: "draw" });
  assert.throws(
    () => replaceRoomPack(room, guest.id, unoPack),
    (error) => error instanceof RoomError && error.code === "HOST_ONLY"
  );

  replaceRoomPack(room, host.id, unoPack, { randomizeDeck: false });
  const hostView = projectRoom(room, host.id);
  assert.equal(room.players.size, 2);
  assert.equal(hostView.room.pack.id, "uno");
  assert.equal(hostView.deck.count, 108);
  assert.equal(hostView.cards.length, 0);
  assert.equal(room.undoStack.length, 0);
  assert.match(hostView.history.at(-1).label, /UNO 经典 108 张/);
});

test("lets everyone shuffle through the authoritative host while keeping setup controls host-only", () => {
  const { room, host, guest } = setupRoom();
  assert.doesNotThrow(() => applyCommand(room, guest.id, { type: "shuffle" }));
  assert.throws(
    () => applyCommand(room, guest.id, { type: "deal-one-each" }),
    (error) => error instanceof RoomError && error.code === "HOST_ONLY"
  );
  assert.doesNotThrow(() => applyCommand(room, host.id, { type: "deal-one-each" }));

  const hostView = projectRoom(room, host.id);
  const guestView = projectRoom(room, guest.id);
  assert.equal(hostView.cards.filter((card) => card.zone === "hand").length, 2);
  assert.equal(guestView.cards.find((card) => card.ownerId === host.id).face, null);
  assert.ok(guestView.cards.find((card) => card.ownerId === guest.id).face);
});

test("tidies public cards around the deck as one undoable host action", () => {
  const { room, host, guest } = setupRoom();
  for (let index = 0; index < 3; index += 1) {
    applyCommand(room, host.id, { type: "draw-public", x: 690 + index * 8, y: 430 + index * 7 });
  }
  const before = projectRoom(room, host.id).cards.map(({ id, x, y, rotation }) => ({ id, x, y, rotation }));

  assert.throws(
    () => applyCommand(room, guest.id, { type: "tidy-public" }),
    (error) => error instanceof RoomError && error.code === "HOST_ONLY"
  );

  applyCommand(room, host.id, { type: "tidy-public" });
  const tidied = projectRoom(room, host.id).cards;
  assert.equal(new Set(tidied.map((card) => `${card.x}:${card.y}`)).size, 3);
  assert.ok(tidied.every((card) => card.rotation === 0));
  assert.ok(tidied.every((card) => card.y + 138 <= 407 || card.y >= 545));
  assert.match(projectRoom(room, host.id).history.at(-1).label, /整理了公共区的 3 张牌/);

  applyCommand(room, host.id, { type: "undo" });
  assert.deepEqual(
    projectRoom(room, host.id).cards.map(({ id, x, y, rotation }) => ({ id, x, y, rotation })),
    before
  );
});

test("collects only public cards into the deck without touching private hands", () => {
  const { room, host, guest } = setupRoom();
  applyCommand(room, host.id, { type: "draw" });
  applyCommand(room, guest.id, { type: "draw" });
  applyCommand(room, host.id, { type: "draw-public", x: 610, y: 350 });
  applyCommand(room, host.id, { type: "draw-public", x: 760, y: 350 });
  const before = projectRoom(room, host.id);
  const knownPublicIds = new Set(before.cards.filter((card) => card.zone === "public").map((card) => card.id));

  assert.throws(
    () => applyCommand(room, guest.id, { type: "collect-public" }),
    (error) => error instanceof RoomError && error.code === "HOST_ONLY"
  );

  applyCommand(room, host.id, { type: "collect-public" });
  const collected = projectRoom(room, host.id);
  assert.equal(collected.deck.count, before.deck.count + 2);
  assert.equal(collected.cards.filter((card) => card.zone === "public").length, 0);
  assert.equal(collected.cards.filter((card) => card.zone === "hand").length, 2);
  assert.ok([...knownPublicIds].every((cardId) => !room.cards.has(cardId) && !room.deckOrder.includes(cardId)));
  assert.equal(projectRoom(room, guest.id).cards.find((card) => card.ownerId === host.id).face, null);
  assert.match(collected.history.at(-1).label, /2 张公共牌洗回牌叠/);

  applyCommand(room, host.id, { type: "undo" });
  const restoredPublic = projectRoom(room, host.id).cards.filter((card) => card.zone === "public");
  assert.equal(restoredPublic.length, 2);
  assert.deepEqual(new Set(restoredPublic.map((card) => card.id)), knownPublicIds);
  assert.equal(projectRoom(room, host.id).cards.filter((card) => card.zone === "hand").length, 2);
});

test("treats two overlapping public cards as an authoritative shuffleable stack", () => {
  const { room, host, guest } = setupRoom();
  for (let index = 0; index < 3; index += 1) {
    applyCommand(room, host.id, { type: "draw" });
    const newest = projectRoom(room, host.id).cards
      .filter((candidate) => candidate.zone === "hand" && candidate.ownerId === host.id)
      .at(-1);
    applyCommand(room, host.id, {
      type: "move-card",
      cardId: newest.id,
      target: "public",
      x: 620 + index * 3,
      y: 380 + index * 3,
      faceUp: true
    });
  }
  const beforeShuffle = projectRoom(room, guest.id).cards.filter((card) => card.zone === "public");
  const knownIds = new Set(beforeShuffle.map((card) => card.id));
  assert.ok(beforeShuffle.every((card) => card.face));

  applyCommand(room, guest.id, { type: "shuffle-stack", cardId: beforeShuffle.at(-1).id });
  const shuffledView = projectRoom(room, guest.id);
  const shuffledCards = shuffledView.cards.filter((card) => card.zone === "public");
  assert.equal(shuffledCards.length, 3);
  assert.ok(shuffledCards.every((card) => card.face === null && card.faceUp === false));
  assert.ok(shuffledCards.every((card) => !knownIds.has(card.id)));
  assert.ok(shuffledCards.every((card) => Math.abs(card.x - shuffledCards[0].x) < 5));
  assert.match(shuffledView.history.at(-1).label, /洗了一个 3 张的牌堆/);

  const topCardId = [...shuffledCards].sort((left, right) => left.z - right.z).at(-1).id;
  applyCommand(room, guest.id, { type: "draw-stack", cardId: topCardId });
  const guestView = projectRoom(room, guest.id);
  const hostView = projectRoom(room, host.id);
  const guestPrivate = guestView.cards.find((card) => card.zone === "hand" && card.ownerId === guest.id);
  assert.ok(guestPrivate.face);
  assert.equal(hostView.cards.find((card) => card.id === guestPrivate.id).face, null);
  assert.equal(guestView.cards.filter((card) => card.zone === "public").length, 2);

  const remainingStack = guestView.cards.filter((card) => card.zone === "public");
  applyCommand(room, guest.id, { type: "spread-stack", cardId: remainingStack.at(-1).id });
  const spread = projectRoom(room, guest.id).cards.filter((card) => card.zone === "public");
  assert.equal(new Set(spread.map((card) => `${Math.round(card.x)}:${Math.round(card.y)}`)).size, 2);
});

test("deals a configurable opening hand atomically and keeps every hand private", () => {
  const { room, host, guest } = setupRoom();

  applyCommand(room, host.id, { type: "deal-each", count: 3 });
  const hostView = projectRoom(room, host.id);
  const guestView = projectRoom(room, guest.id);
  assert.equal(hostView.deck.count, 2);
  assert.equal(hostView.cards.filter((card) => card.ownerId === host.id).length, 3);
  assert.equal(hostView.cards.filter((card) => card.ownerId === guest.id && card.face === null).length, 3);
  assert.equal(guestView.cards.filter((card) => card.ownerId === guest.id && card.face).length, 3);
  assert.equal(guestView.cards.filter((card) => card.ownerId === host.id && card.face === null).length, 3);
  assert.match(hostView.history.at(-1).label, /每位玩家发了 3 张牌/);

  applyCommand(room, host.id, { type: "undo" });
  assert.equal(projectRoom(room, host.id).deck.count, 8);
  assert.equal(projectRoom(room, guest.id).cards.length, 0);

  assert.throws(
    () => applyCommand(room, host.id, { type: "deal-each", count: 0 }),
    (error) => error instanceof RoomError && error.code === "INVALID_DEAL_COUNT"
  );
  assert.throws(
    () => applyCommand(room, host.id, { type: "deal-each", count: 5 }),
    (error) => error instanceof RoomError && error.code === "NOT_ENOUGH_CARDS"
  );
  assert.equal(projectRoom(room, host.id).deck.count, 8);
});

test("keeps the shared turn marker host-controlled, synchronized, and undoable", () => {
  const { room, host, guest } = setupRoom();
  assert.equal(projectRoom(room, host.id).turn.activePlayerId, null);
  assert.throws(
    () => applyCommand(room, guest.id, { type: "set-turn", playerId: guest.id }),
    (error) => error instanceof RoomError && error.code === "HOST_ONLY"
  );

  applyCommand(room, host.id, { type: "set-turn", playerId: guest.id });
  assert.equal(projectRoom(room, host.id).turn.activePlayerId, guest.id);
  assert.equal(projectRoom(room, guest.id).turn.activePlayerId, guest.id);

  applyCommand(room, host.id, { type: "advance-turn" });
  assert.equal(projectRoom(room, guest.id).turn.activePlayerId, host.id);
  applyCommand(room, host.id, { type: "undo" });
  assert.equal(projectRoom(room, guest.id).turn.activePlayerId, guest.id);

  applyCommand(room, host.id, { type: "random-turn" });
  const randomPlayerId = projectRoom(room, guest.id).turn.activePlayerId;
  assert.ok([host.id, guest.id].includes(randomPlayerId));
  applyCommand(room, host.id, { type: "reset" });
  assert.equal(projectRoom(room, guest.id).turn.activePlayerId, null);
  applyCommand(room, host.id, { type: "undo" });
  assert.equal(projectRoom(room, guest.id).turn.activePlayerId, randomPlayerId);
});

test("lets anyone draw or pass a card to any chosen private hand", () => {
  const { room, host, guest } = setupRoom();

  applyCommand(room, host.id, { type: "draw", ownerId: guest.id });
  const guestCard = projectRoom(room, guest.id).cards.find((card) => card.ownerId === guest.id);
  assert.ok(guestCard.face?.label);
  assert.equal(projectRoom(room, host.id).cards.find((card) => card.id === guestCard.id).face, null);

  applyCommand(room, guest.id, { type: "draw", ownerId: host.id });
  assert.equal(projectRoom(room, host.id).cards.filter((card) => card.ownerId === host.id).length, 1);

  applyCommand(room, host.id, {
    type: "move-card",
    cardId: guestCard.id,
    target: "hand",
    ownerId: host.id
  });
  assert.ok(projectRoom(room, host.id).cards.find((card) => card.id === guestCard.id).face);
  assert.equal(projectRoom(room, guest.id).cards.find((card) => card.id === guestCard.id).face, null);
});

test("lets a card owner privately pass their own card to another player", () => {
  const { room, host, guest } = setupRoom();
  applyCommand(room, guest.id, { type: "draw" });
  const guestCard = projectRoom(room, guest.id).cards.find((card) => card.ownerId === guest.id);

  applyCommand(room, guest.id, {
    type: "move-card",
    cardId: guestCard.id,
    target: "hand",
    ownerId: host.id
  });

  const hostView = projectRoom(room, host.id).cards.find((card) => card.id === guestCard.id);
  const guestView = projectRoom(room, guest.id).cards.find((card) => card.id === guestCard.id);
  assert.equal(hostView.ownerId, host.id);
  assert.ok(hostView.face?.label);
  assert.equal(guestView.face, null);
});

test("keeps shared tokens and dice authoritative", () => {
  const { room, host, guest } = setupRoom();
  const token = projectRoom(room, guest.id).tokens[0];

  applyCommand(room, guest.id, {
    type: "move-token",
    tokenId: token.id,
    x: -99999,
    y: 99999
  });

  const hostToken = projectRoom(room, host.id).tokens.find((candidate) => candidate.id === token.id);
  const guestToken = projectRoom(room, guest.id).tokens.find((candidate) => candidate.id === token.id);
  assert.deepEqual(
    { x: hostToken.x, y: hostToken.y, z: hostToken.z },
    { x: guestToken.x, y: guestToken.y, z: guestToken.z }
  );
  assert.deepEqual({ x: hostToken.x, y: hostToken.y }, { x: -4482, y: 4010 });

  const previousRollId = projectRoom(room, host.id).die.rollId;
  applyCommand(room, guest.id, { type: "roll-die" });
  const hostDie = projectRoom(room, host.id).die;
  const guestDie = projectRoom(room, guest.id).die;
  assert.equal(hostDie.value, guestDie.value);
  assert.ok(hostDie.value >= 1 && hostDie.value <= 6);
  assert.equal(hostDie.rollId, previousRollId + 1);
  assert.equal(hostDie.lastRolledBy, guest.id);

  applyCommand(room, host.id, { type: "reset" });
  const resetView = projectRoom(room, guest.id);
  const resetToken = resetView.tokens.find((candidate) => candidate.id === token.id);
  assert.deepEqual({ x: resetToken.x, y: resetToken.y }, { x: 420, y: 560 });
  assert.equal(resetView.die.value, null);
  assert.equal(resetView.die.lastRolledBy, null);
});

test("keeps the shared counter authoritative, bounded, resettable, and undoable", () => {
  const { room, host, guest } = setupRoom();
  assert.equal(projectRoom(room, host.id).counter.value, 1);

  applyCommand(room, guest.id, { type: "adjust-counter", delta: 1 });
  assert.equal(projectRoom(room, host.id).counter.value, 2);
  assert.equal(projectRoom(room, guest.id).counter.value, 2);
  assert.throws(
    () => applyCommand(room, guest.id, { type: "adjust-counter", delta: 2 }),
    (error) => error instanceof RoomError && error.code === "INVALID_COUNTER_STEP"
  );

  applyCommand(room, host.id, { type: "undo" });
  assert.equal(projectRoom(room, guest.id).counter.value, 1);
  assert.throws(
    () => applyCommand(room, guest.id, { type: "adjust-counter", delta: -1 }),
    (error) => error instanceof RoomError && error.code === "COUNTER_LIMIT"
  );

  applyCommand(room, guest.id, { type: "adjust-counter", delta: 1 });
  applyCommand(room, host.id, { type: "reset" });
  assert.equal(projectRoom(room, guest.id).counter.value, 1);
});

test("lets only the host undo while preserving hidden-card privacy", () => {
  const { room, host, guest } = setupRoom();
  applyCommand(room, host.id, { type: "draw" });
  const privateCard = projectRoom(room, host.id).cards.find((card) => card.ownerId === host.id);
  applyCommand(room, host.id, {
    type: "move-card",
    cardId: privateCard.id,
    target: "public",
    x: 620,
    y: 410
  });

  assert.ok(projectRoom(room, guest.id).cards.find((card) => card.id === privateCard.id).face);
  assert.equal(projectRoom(room, host.id).canUndo, true);
  assert.equal(projectRoom(room, guest.id).canUndo, false);
  assert.throws(
    () => applyCommand(room, guest.id, { type: "undo" }),
    (error) => error instanceof RoomError && error.code === "HOST_ONLY"
  );

  applyCommand(room, host.id, { type: "undo" });
  const hiddenAgain = projectRoom(room, guest.id).cards.find((card) => card.id === privateCard.id);
  assert.equal(hiddenAgain.zone, "hand");
  assert.equal(hiddenAgain.face, null);

  applyCommand(room, host.id, { type: "undo" });
  assert.equal(projectRoom(room, host.id).cards.length, 0);
  assert.equal(projectRoom(room, host.id).deck.count, 8);
  assert.equal(projectRoom(room, host.id).canUndo, false);
  assert.throws(
    () => applyCommand(room, host.id, { type: "undo" }),
    (error) => error instanceof RoomError && error.code === "NOTHING_TO_UNDO"
  );
});

test("undo restores token positions and the previous die result", () => {
  const { room, host, guest } = setupRoom();
  const token = projectRoom(room, host.id).tokens[0];
  applyCommand(room, guest.id, { type: "move-token", tokenId: token.id, x: 780, y: 520 });
  applyCommand(room, guest.id, { type: "roll-die" });
  assert.ok(projectRoom(room, host.id).die.value);

  applyCommand(room, host.id, { type: "undo" });
  assert.equal(projectRoom(room, host.id).die.value, null);
  const movedToken = projectRoom(room, host.id).tokens.find((candidate) => candidate.id === token.id);
  assert.deepEqual(
    { x: movedToken.x, y: movedToken.y },
    { x: 780, y: 520 }
  );

  applyCommand(room, host.id, { type: "undo" });
  const restoredToken = projectRoom(room, host.id).tokens.find((candidate) => candidate.id === token.id);
  assert.deepEqual(
    { x: restoredToken.x, y: restoredToken.y },
    { x: 420, y: 560 }
  );
});

test("supports eight seats with a unique color and one private face per viewer", () => {
  const room = createRoom({
    code: "INK-204",
    hostName: "玩家1",
    hostSecret: "host-secret",
    pack,
    randomizeDeck: false
  });
  const host = joinRoom(room, { hostSecret: "host-secret" }).player;
  const players = [host];
  for (let index = 2; index <= 8; index += 1) {
    players.push(joinRoom(room, { displayName: `玩家${index}` }).player);
  }

  assert.equal(new Set(players.map((player) => player.color)).size, 8);
  assert.throws(
    () => joinRoom(room, { displayName: "玩家9" }),
    (error) => error instanceof RoomError && error.code === "ROOM_FULL"
  );

  applyCommand(room, host.id, { type: "deal-one-each" });
  for (const viewer of players) {
    const view = projectRoom(room, viewer.id);
    assert.equal(view.cards.length, 8);
    assert.equal(view.cards.filter((card) => card.face).length, 1);
    assert.ok(view.cards.find((card) => card.ownerId === viewer.id)?.face);
  }
});

test("resumes a refreshed player without creating another seat", () => {
  const room = createRoom({
    code: "INK-204",
    hostName: "玩家1",
    hostSecret: "host-secret",
    pack,
    randomizeDeck: false
  });
  joinRoom(room, { hostSecret: "host-secret" });
  const firstJoin = joinRoom(room, { displayName: "客人B" });
  const resumed = joinRoom(room, { resumeToken: firstJoin.sessionToken });

  assert.equal(resumed.resumed, true);
  assert.equal(resumed.player.id, firstJoin.player.id);
  assert.equal(resumed.player.color, firstJoin.player.color);
  assert.equal(room.players.size, 2);
});

test("releases a guest seat without orphaning private resources or stale sessions", () => {
  const room = createRoom({
    code: "INK-204",
    hostName: "房主A",
    hostSecret: "host-secret",
    pack,
    randomizeDeck: false
  });
  const hostJoin = joinRoom(room, { hostSecret: "host-secret" });
  const guestJoin = joinRoom(room, { displayName: "客人B" });
  const { player: host } = hostJoin;
  const { player: guest } = guestJoin;

  applyCommand(room, guest.id, { type: "draw" });
  applyCommand(room, guest.id, { type: "draw" });
  const [publicCard] = projectRoom(room, guest.id).cards;
  applyCommand(room, guest.id, {
    type: "move-card",
    cardId: publicCard.id,
    target: "public",
    x: 620,
    y: 410
  });
  const privateCardId = projectRoom(room, guest.id).cards.find((card) => card.zone === "hand").id;
  applyCommand(room, host.id, { type: "set-turn", playerId: guest.id });
  assert.equal(projectRoom(room, host.id).canUndo, true);

  applyCommand(room, guest.id, { type: "leave-seat" });
  const hostView = projectRoom(room, host.id);
  const sharedCard = hostView.cards.find((card) => card.id === publicCard.id);
  assert.equal(room.players.has(guest.id), false);
  assert.equal(playerForSession(room, guestJoin.sessionToken), null);
  assert.equal(hostView.deck.count, 7);
  assert.equal(room.cards.has(privateCardId), false);
  assert.equal(room.deckOrder.includes(privateCardId), false);
  assert.equal(sharedCard.zone, "public");
  assert.equal(sharedCard.ownerId, null);
  assert.equal(hostView.turn.activePlayerId, null);
  assert.equal(hostView.canUndo, false);

  const replacement = joinRoom(room, { displayName: "客人C" }).player;
  assert.equal(replacement.seatIndex, 1);
  assert.equal(replacement.color, guest.color);
  applyCommand(room, replacement.id, { type: "move-card", cardId: sharedCard.id, target: "hand" });
  assert.equal(projectRoom(room, replacement.id).cards.find((card) => card.id === sharedCard.id).ownerId, replacement.id);

  assert.throws(
    () => applyCommand(room, host.id, { type: "leave-seat" }),
    (error) => error instanceof RoomError && error.code === "HOST_CANNOT_LEAVE"
  );
});

test("lets the host clear disconnected guest seats", () => {
  const { room, host, guest } = setupRoom();
  host.connections = 1;
  guest.connections = 0;
  applyCommand(room, guest.id, { type: "draw" });

  applyCommand(room, host.id, { type: "cleanup-offline" });
  assert.equal(room.players.size, 1);
  assert.equal(room.players.has(guest.id), false);
  assert.equal(projectRoom(room, host.id).deck.count, 8);
  assert.equal(projectRoom(room, host.id).canUndo, false);
  assert.throws(
    () => applyCommand(room, host.id, { type: "cleanup-offline" }),
    (error) => error instanceof RoomError && error.code === "NO_OFFLINE_PLAYERS"
  );
});

test("loads a custom declarative pack without executing game code", () => {
  const customPack = {
    id: "moon-test",
    name: "月面试验包",
    tableTitle: "月面基地",
    version: 3,
    cardBack: { label: "MOON", theme: "silver", color: "#536a78" },
    die: { label: "公共 D20", sides: 20 },
    counter: { label: "氧气轮次", initial: 4, min: 0, max: 12 },
    tokens: [
      { key: "oxygen", label: "氧气", symbol: "O₂", color: "#25b8b0", x: 360, y: 520 }
    ],
    cards: [
      { key: "airlock", label: "气闸", rank: "01", suit: "module", symbol: "◇", tone: "black" }
    ]
  };
  const room = createRoom({
    code: "LUN-001",
    hostName: "基地长",
    hostSecret: "host-secret",
    pack: customPack,
    randomizeDeck: false
  });
  const host = joinRoom(room, { hostSecret: "host-secret" }).player;
  const view = projectRoom(room, host.id);

  assert.equal(view.room.title, "月面基地");
  assert.equal(view.room.pack.name, "月面试验包");
  assert.equal(view.room.pack.version, 3);
  assert.deepEqual(view.room.pack.cardBack, {
    label: "MOON",
    theme: "silver",
    color: "#536a78",
    hasImage: false
  });
  assert.equal(view.deck.count, 1);
  assert.equal(view.tokens[0].label, "氧气");
  assert.equal(view.die.sides, 20);
  assert.deepEqual(view.counter, { label: "氧气轮次", value: 4, initial: 4, min: 0, max: 12 });

  applyCommand(room, host.id, { type: "roll-die" });
  const rolled = projectRoom(room, host.id).die.value;
  assert.ok(rolled >= 1 && rolled <= 20);
  assert.equal(Object.hasOwn(customPack, "script"), false);
});

test("projects image availability without exposing local asset paths", () => {
  const imagePack = structuredClone(pack);
  imagePack.cardBack.image = "art/card-back.webp";
  imagePack.tokens[0].image = "art/first-player.png";
  for (const card of imagePack.cards) card.image = "art/heart-ace.avif";
  const room = createRoom({
    code: "ART-001",
    hostName: "房主A",
    hostSecret: "host-secret",
    pack: imagePack,
    randomizeDeck: false
  });
  const host = joinRoom(room, { hostSecret: "host-secret" }).player;
  const guest = joinRoom(room, { displayName: "客人B" }).player;

  applyCommand(room, host.id, { type: "draw" });
  const hostView = projectRoom(room, host.id);
  const guestView = projectRoom(room, guest.id);
  const hostCard = hostView.cards.find((card) => card.ownerId === host.id);

  assert.equal(hostView.room.pack.cardBack.hasImage, true);
  assert.equal(hostView.tokens[0].hasImage, true);
  assert.equal(hostCard.face.hasImage, true);
  assert.equal(guestView.cards.find((card) => card.id === hostCard.id).face, null);
  for (const localPath of ["art/card-back.webp", "art/first-player.png", "art/heart-ace.avif"]) {
    assert.equal(JSON.stringify(hostView).includes(localPath), false);
    assert.equal(JSON.stringify(guestView).includes(localPath), false);
  }
});

test("rejects unsafe or internally inconsistent game packs before room creation", () => {
  const withScript = structuredClone(pack);
  withScript.script = "do-something";
  assert.throws(
    () => createRoom({ code: "BAD-001", pack: withScript }),
    (error) => error instanceof RoomError && error.code === "INVALID_PACK" && /script/.test(error.message)
  );

  const duplicateCard = structuredClone(pack);
  duplicateCard.cards[1].key = duplicateCard.cards[0].key;
  assert.throws(
    () => createRoom({ code: "BAD-002", pack: duplicateCard }),
    (error) => error instanceof RoomError && error.code === "INVALID_PACK" && /重复/.test(error.message)
  );

  const invalidCounter = structuredClone(pack);
  invalidCounter.counter = { label: "回合", initial: 3, min: 8, max: 2 };
  assert.throws(
    () => createRoom({ code: "BAD-003", pack: invalidCounter }),
    (error) => error instanceof RoomError && error.code === "INVALID_PACK" && /min/.test(error.message)
  );

  const invalidColor = structuredClone(pack);
  invalidColor.cardBack.color = "red";
  assert.throws(
    () => createRoom({ code: "BAD-004", pack: invalidColor }),
    (error) => error instanceof RoomError && error.code === "INVALID_PACK" && /cardBack.color/.test(error.message)
  );

  for (const [index, image] of [
    "../secret.png",
    "/tmp/secret.png",
    "https://example.com/card.png",
    "art\\card.png",
    "art//card.png",
    "art/./card.png",
    "art/card.svg"
  ].entries()) {
    const invalidImage = structuredClone(pack);
    invalidImage.cards[0].image = image;
    assert.throws(
      () => createRoom({ code: `IMG-00${index}`, pack: invalidImage }),
      (error) => error instanceof RoomError && error.code === "INVALID_PACK" && /image|图片|路径|支持/.test(error.message)
    );
  }
});
