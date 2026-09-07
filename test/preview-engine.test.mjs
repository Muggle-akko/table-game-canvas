import test from "node:test";
import assert from "node:assert/strict";
import { loadPreviewEngine } from "./helpers/preview.mjs";
const { engine } = await loadPreviewEngine();

test("offline demo projects a different private hand for host and guest", () => {
  const model = engine.createModel({ shareUrl: "https://table.example/?preview=1", now: 1_000_000 });
  const host = engine.project(model, "player_a", 1_000_000);
  const guest = engine.project(model, "player_b", 1_000_000);

  assert.equal(host.deck.count, 51);
  assert.equal(host.room.shareUrl, "https://table.example/?preview=1");
  assert.equal(host.cards.find((card) => card.ownerId === "player_a" && card.zone === "hand").face.label, "红桃 A");
  assert.equal(host.cards.find((card) => card.ownerId === "player_b" && card.zone === "hand").face, null);
  assert.equal(guest.cards.find((card) => card.ownerId === "player_a" && card.zone === "hand").face, null);
  assert.equal(guest.cards.find((card) => card.ownerId === "player_b" && card.zone === "hand").face.label, "黑桃 K");
  assert.equal(host.cards.find((card) => card.zone === "public").face.label, "方块 Q");
  assert.equal(guest.cards.find((card) => card.zone === "public").face.label, "方块 Q");
});

test("offline demo completes the draw, reveal, hide, and undo privacy loop", () => {
  const model = engine.createModel({ now: 2_000_000 });
  const drawnCardId = model.deckOrder.at(-1);

  let host = engine.applyCommand(model, "player_a", { type: "draw" }, { now: 2_000_100 });
  let guest = engine.project(model, "player_b", 2_000_100);
  assert.equal(host.deck.count, 50);
  assert.ok(host.cards.find((card) => card.id === drawnCardId).face?.label);
  assert.equal(guest.cards.find((card) => card.id === drawnCardId).face, null);

  host = engine.applyCommand(model, "player_a", {
    type: "move-card",
    cardId: drawnCardId,
    target: "public",
    x: 560,
    y: 380,
    rotation: 15,
    faceUp: true
  }, { now: 2_000_200 });
  guest = engine.project(model, "player_b", 2_000_200);
  assert.equal(host.cards.find((card) => card.id === drawnCardId).faceUp, true);
  assert.equal(guest.cards.find((card) => card.id === drawnCardId).face.label, host.cards.find((card) => card.id === drawnCardId).face.label);

  engine.applyCommand(model, "player_a", {
    type: "move-card",
    cardId: drawnCardId,
    target: "hand"
  }, { now: 2_000_300 });
  guest = engine.project(model, "player_b", 2_000_300);
  assert.equal(guest.cards.find((card) => card.id === drawnCardId).face, null);

  host = engine.applyCommand(model, "player_a", { type: "undo" }, { now: 2_000_400 });
  assert.equal(host.cards.find((card) => card.id === drawnCardId).zone, "public");
  assert.equal(host.cards.find((card) => card.id === drawnCardId).faceUp, true);
});

test("offline demo keeps shared tabletop tools open while protecting private resources", () => {
  const model = engine.createModel({ now: 3_000_000 });

  assert.doesNotThrow(() => engine.applyCommand(model, "player_b", { type: "shuffle" }));
  assert.throws(
    () => engine.applyCommand(model, "player_b", {
      type: "move-card",
      cardId: "card_demo_1",
      target: "hand",
      ownerId: "player_b"
    }),
    (error) => error instanceof engine.PreviewError && error.code === "NO_CONTROL"
  );

  const rolled = engine.applyCommand(model, "player_b", { type: "roll-die" }, {
    random: () => 0.5,
    now: 3_000_100
  });
  assert.ok(rolled.die.value >= 1 && rolled.die.value <= 6);
  assert.equal(rolled.die.lastRolledBy, "player_b");

  const counted = engine.applyCommand(model, "player_b", { type: "adjust-counter", delta: 1 }, { now: 3_000_200 });
  assert.equal(counted.counter.value, 2);

  const moved = engine.applyCommand(model, "player_b", {
    type: "move-token",
    tokenId: "token_focus",
    x: 900,
    y: 500
  }, { now: 3_000_300 });
  assert.equal(moved.tokens.find((token) => token.id === "token_focus").x, 900);
});

test("offline demo supports host dealing, turn control, and full reset", () => {
  const model = engine.createModel({ now: 4_000_000 });
  let state = engine.applyCommand(model, "player_a", { type: "deal-each", count: 2 }, { now: 4_000_100 });
  assert.equal(state.deck.count, 47);
  assert.equal(state.cards.filter((card) => card.zone === "hand" && card.ownerId === "player_a").length, 3);
  assert.equal(state.cards.filter((card) => card.zone === "hand" && card.ownerId === "player_b").length, 3);

  state = engine.applyCommand(model, "player_a", { type: "advance-turn" }, { now: 4_000_200 });
  assert.equal(state.turn.activePlayerId, "player_a");

  state = engine.applyCommand(model, "player_a", { type: "reset" }, {
    random: () => 0,
    now: 4_000_300
  });
  assert.equal(state.deck.count, 54);
  assert.equal(state.cards.length, 0);
  assert.equal(state.counter.value, state.counter.initial);
  assert.equal(state.turn.activePlayerId, null);
  assert.equal(state.die.value, null);
});

test("offline demo can switch to a complete UNO resource pack without adding game rules", () => {
  const model = engine.createModel({ packId: "uno", now: 7_000_000 });
  let state = engine.project(model, "player_a", 7_000_000);

  assert.equal(model.cards.length, 108);
  assert.equal(state.deck.count, 105);
  assert.equal(state.room.pack.id, "uno");
  assert.equal(model.cards.filter((card) => card.face.suit === "wild").length, 8);
  assert.equal(model.cards.filter((card) => card.face.suit === "red").length, 25);
  assert.match(model.cards.find((card) => card.face.suit === "blue").face.color, /^#[0-9a-f]{6}$/i);

  model.cards.forEach((card, index) => Object.assign(card, {
    zone: "public",
    ownerId: null,
    x: 720,
    y: 410,
    faceUp: false,
    z: index + 1
  }));
  model.deckOrder = [];
  state = engine.applyCommand(model, "player_a", {
    type: "spread-stack",
    cardId: model.cards.at(-1).id
  }, { now: 7_000_100 });
  assert.equal(new Set(state.cards.map((card) => `${card.x}:${card.y}`)).size, 108);
  const { publicZone, cardWidth, cardHeight } = state.room.geometry;
  assert.ok(state.cards.every((card) => (
    card.x >= publicZone.x
    && card.y >= publicZone.y
    && card.x + cardWidth <= publicZone.x + publicZone.width
    && card.y + cardHeight <= publicZone.y + publicZone.height
  )));
});

test("offline host can replace the live table with UNO while guests stay seated", () => {
  const model = engine.createModel({ now: 7_500_000 });
  assert.throws(
    () => engine.applyCommand(model, "player_b", { type: "replace-pack", packId: "uno" }),
    (error) => error instanceof engine.PreviewError && error.code === "HOST_ONLY"
  );

  const state = engine.applyCommand(model, "player_a", {
    type: "replace-pack",
    packId: "uno"
  }, { now: 7_500_100 });
  assert.equal(state.room.pack.id, "uno");
  assert.equal(state.room.packOptions.length, 4);
  assert.equal(state.players.length, 2);
  assert.equal(state.deck.count, 108);
  assert.equal(state.cards.length, 0);
  assert.match(state.history.at(-1).label, /UNO 经典 108 张/);
});

test("offline demo tidies and collects public cards without exposing private hands", () => {
  const model = engine.createModel({ now: 5_000_000 });
  engine.applyCommand(model, "player_a", { type: "draw-public", x: 700, y: 430 }, { now: 5_000_100 });
  let host = engine.applyCommand(model, "player_a", { type: "tidy-public" }, { now: 5_000_200 });
  assert.ok(host.cards.filter((card) => card.zone === "public").every((card) => card.rotation === 0));
  assert.throws(
    () => engine.applyCommand(model, "player_b", { type: "collect-public" }),
    (error) => error instanceof engine.PreviewError && error.code === "HOST_ONLY"
  );

  const privateHandCount = host.cards.filter((card) => card.zone === "hand").length;
  const knownPublicIds = new Set(host.cards.filter((card) => card.zone === "public").map((card) => card.id));
  host = engine.applyCommand(model, "player_a", { type: "collect-public" }, {
    random: () => 0.25,
    now: 5_000_300
  });
  assert.equal(host.cards.filter((card) => card.zone === "public").length, 0);
  assert.equal(host.cards.filter((card) => card.zone === "hand").length, privateHandCount);
  assert.ok([...knownPublicIds].every((cardId) => model.cards.some((card) => card.id === cardId && card.zone === "deck")));
  assert.equal(engine.project(model, "player_b", 5_000_300).cards.find((card) => card.ownerId === "player_a").face, null);

  host = engine.applyCommand(model, "player_a", { type: "undo" }, { now: 5_000_400 });
  assert.ok(host.cards.some((card) => card.zone === "public"));
  assert.deepEqual(new Set(host.cards.filter((card) => card.zone === "public").map((card) => card.id)), knownPublicIds);
});

test("offline demo recognizes, shuffles, draws, and spreads an overlapping stack", () => {
  const model = engine.createModel({ now: 6_000_000 });
  engine.applyCommand(model, "player_a", { type: "draw-public", x: 640, y: 390 }, { now: 6_000_100 });
  engine.applyCommand(model, "player_a", { type: "draw-public", x: 644, y: 394 }, { now: 6_000_150 });
  const firstPublic = engine.project(model, "player_a", 6_000_100).cards.filter((card) => card.zone === "public");
  engine.applyCommand(model, "player_a", {
    type: "move-card",
    cardId: firstPublic[0].id,
    target: "public",
    x: 642,
    y: 392,
    faceUp: true
  }, { now: 6_000_200 });
  const overlapping = engine.project(model, "player_a", 6_000_200).cards.filter((card) => card.zone === "public");
  const oldIds = new Set(overlapping.map((card) => card.id));

  let state = engine.applyCommand(model, "player_b", {
    type: "shuffle-stack",
    cardId: overlapping.at(-1).id
  }, { random: () => 0.25, now: 6_000_300 });
  const stack = state.cards.filter((card) => card.zone === "public");
  assert.ok(stack.every((card) => !oldIds.has(card.id)));
  assert.equal(stack.filter((card) => card.faceUp).length, overlapping.filter((card) => card.faceUp).length);

  state = engine.applyCommand(model, "player_b", { type: "draw-stack", cardId: stack.at(-1).id }, { now: 6_000_400 });
  assert.ok(state.cards.some((card) => card.zone === "hand" && card.ownerId === "player_b" && card.face));
  const remaining = state.cards.filter((card) => card.zone === "public");
  state = engine.applyCommand(model, "player_b", { type: "spread-stack", cardId: remaining.at(-1).id }, { now: 6_000_500 });
  assert.equal(new Set(state.cards.filter((card) => card.zone === "public").map((card) => `${card.x}:${card.y}`)).size, 2);
});
