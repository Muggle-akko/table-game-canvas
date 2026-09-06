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
  projectRoom,
  validateGamePack
} from "../src/room-engine.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readPack(name) {
  return JSON.parse(await readFile(resolve(root, "game-packs", name), "utf8"));
}

test("ships one complete standard 54-card deck with unique resources", async () => {
  const pack = await readPack("standard-54.json");
  assert.doesNotThrow(() => validateGamePack(pack));
  assert.equal(pack.cards.length, 54);
  assert.equal(new Set(pack.cards.map((card) => card.key)).size, 54);
  assert.equal(pack.cards.filter((card) => card.suit === "joker").length, 2);
  for (const suit of ["hearts", "diamonds", "clubs", "spades"]) {
    assert.equal(pack.cards.filter((card) => card.suit === suit).length, 13);
  }
});

test("ships the classic 108-card UNO structure as rule-free colored resources", async () => {
  const pack = await readPack("uno.json");
  assert.doesNotThrow(() => validateGamePack(pack));
  assert.equal(pack.cards.length, 108);
  assert.equal(new Set(pack.cards.map((card) => card.key)).size, 108);
  for (const color of ["red", "yellow", "green", "blue"]) {
    const cards = pack.cards.filter((card) => card.suit === color);
    assert.equal(cards.length, 25);
    assert.equal(cards.filter((card) => card.rank === "0").length, 1);
    assert.equal(cards.filter((card) => card.rank === "+2").length, 2);
  }
  assert.equal(pack.cards.filter((card) => card.suit === "wild").length, 8);
  assert.equal(pack.cards.filter((card) => card.rank === "+4").length, 4);
  assert.ok(pack.cards.every((card) => /^#[0-9a-f]{6}$/i.test(card.color)));
});

test("rejects invalid custom face colors before opening a room", async () => {
  const pack = await readPack("uno.json");
  pack.cards[0].color = "red";
  assert.throws(
    () => validateGamePack(pack),
    (error) => error instanceof RoomError && error.code === "INVALID_PACK" && /cards\[0\]\.color/.test(error.message)
  );

  const secondPack = await readPack("uno.json");
  secondPack.cards[0].textColor = "rgb(0,0,0)";
  assert.throws(
    () => validateGamePack(secondPack),
    (error) => error instanceof RoomError && error.code === "INVALID_PACK" && /cards\[0\]\.textColor/.test(error.message)
  );
});

test("spreads all 108 UNO cards inside the public zone without recreating accidental stacks", async () => {
  const pack = await readPack("uno.json");
  const room = createRoom({
    code: "UNO-108",
    hostName: "房主A",
    hostSecret: "host-secret",
    pack,
    randomizeDeck: false
  });
  const host = joinRoom(room, { hostSecret: "host-secret" }).player;
  while (room.deckOrder.length > 0) {
    applyCommand(room, host.id, { type: "draw-public", x: 720, y: 410 });
  }
  const stacked = projectRoom(room, host.id).cards;
  applyCommand(room, host.id, { type: "spread-stack", cardId: stacked.at(-1).id });

  const view = projectRoom(room, host.id);
  const { publicZone, cardWidth, cardHeight } = view.room.geometry;
  assert.equal(view.cards.length, 108);
  assert.equal(new Set(view.cards.map((card) => `${card.x}:${card.y}`)).size, 108);
  assert.ok(view.cards.every((card) => (
    card.x >= publicZone.x
    && card.y >= publicZone.y
    && card.x + cardWidth <= publicZone.x + publicZone.width
    && card.y + cardHeight <= publicZone.y + publicZone.height
  )));
  for (let leftIndex = 0; leftIndex < view.cards.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < view.cards.length; rightIndex += 1) {
      const left = view.cards[leftIndex];
      const right = view.cards[rightIndex];
      const mistakenForStack = Math.abs(left.x - right.x) <= cardWidth * 0.5
        && Math.abs(left.y - right.y) <= cardHeight * 0.5;
      assert.equal(mistakenForStack, false);
    }
  }
});
