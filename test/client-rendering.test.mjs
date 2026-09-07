import test from "node:test";
import assert from "node:assert/strict";
import { tokenStackIndex, TABLE_GEOMETRY } from "../src/room-engine.mjs";
import { loadClient } from "./helpers/client-dom.mjs";

const tokenNode = (client, id) => client.$("token-root").querySelector(`[data-token-id="${id}"]`);
const objectNode = (client, id) => client.$("objects-root").querySelector(`[data-object-id="${id}"]`);

test("unrelated room updates retain focused objects, players, hand zones and chip artwork", async () => {
  const client = await loadClient(), { app, $, document } = client;
  await client.sendCommand({ type: "spawn-resource", resourceId: "chip-25", x: 520, y: 480 });
  const token = app.state.tokens.at(-1), note = app.state.objects.find((object) => object.kind === "note");
  const before = {
    token: tokenNode(client, token.id), note: objectNode(client, note.id),
    player: $("player-list").firstElementChild, zone: $("hand-zones").firstElementChild,
    pocket: $("hand-cards").firstElementChild
  };
  before.note.focus();
  await client.sendCommand({ type: "move-resource", resourceType: "token", resourceId: token.id, x: 800, y: 700 });
  assert.equal(tokenNode(client, token.id), before.token);
  assert.equal(before.token.style.left, "800px"); assert.equal(before.token.style.top, "700px");
  await client.sendCommand({ type: "move-resource", resourceType: "object", resourceId: note.id, x: 1200, y: 700 });
  assert.equal(objectNode(client, note.id), before.note);
  assert.equal(before.note.style.left, "1200px"); assert.equal(document.activeElement, before.note);
  await client.sendCommand({ type: "chat", text: "仍在同一张桌上" });
  assert.equal($("player-list").firstElementChild, before.player);
  assert.equal($("hand-zones").firstElementChild, before.zone);
  assert.equal($("hand-cards").firstElementChild, before.pocket);
  await client.sendCommand({ type: "edit-resource", resourceType: "object", resourceId: note.id, label: "新的便签", text: "同步更新" });
  assert.match(objectNode(client, note.id).textContent, /新的便签同步更新/);
  assert.equal(document.activeElement, objectNode(client, note.id));
  await client.sendCommand({ type: "lock-resource", resourceType: "token", resourceId: token.id });
  assert.ok(tokenNode(client, token.id).querySelector(".resource-lock"));
  await client.sendCommand({ type: "set-turn", playerId: "player_b" });
  assert.equal($("hand-zones").querySelector(".is-turn").dataset.playerId, "player_b");
  assert.equal($("mobile-player-strip").querySelector(".is-turn").dataset.playerId, "player_b");
});

test("a stack badge survives unrelated updates and its old pile title clears after spreading", async () => {
  const client = await loadClient(), { app } = client;
  const first = app.state.cards.find((card) => card.zone === "public");
  await client.sendCommand({ type: "draw-public", deckId: "main", x: first.x + 8, y: first.y + 8 });
  const pile = client.visibleStackForCard(first.id);
  assert.equal(pile.length, 2);
  const top = pile.at(-1), node = client.$("cards-root").querySelector(`[data-card-id="${top.id}"]`);
  const badge = node.querySelector(".card-stack-count"); assert.ok(badge);
  await client.sendCommand({ type: "chat", text: "牌堆旁边聊天" });
  assert.equal(node.querySelector(".card-stack-count"), badge);
  await client.sendCommand({ type: "spread-stack", cardId: first.id, layout: "row" });
  assert.equal(node.querySelector(".card-stack-count"), null);
  assert.doesNotMatch(node.title, /张牌堆/);
  assert.match(node.title, /双击翻面/);
});

test("a busy table redraw does not allocate replacement resource and player elements", async () => {
  const client = await loadClient();
  const room = client.app.previewModel.engineRoom;
  for (let index = 0; index < 180; index++) room.tokens.set(`bench_${index}`, {
    id: `bench_${index}`, label: "筹码", symbol: "5", color: "#568775",
    x: 300 + index % 20 * 84, y: 300 + Math.floor(index / 20) * 90,
    z: 100 + index, homeX: 300, homeY: 300, locked: false
  });
  client.syncPreviewState();
  let created = 0;
  const create = client.document.createElement;
  client.document.createElement = (...args) => { created++; return create(...args); };
  client.vm("renderRoom()");
  assert.ok(created < 5, `unchanged redraw allocated ${created} elements`);
  const node = tokenNode(client, "bench_0");
  created = 0;
  await client.sendCommand({ type: "move-resource", resourceType: "token", resourceId: "bench_0", x: 400, y: 1200 });
  assert.equal(tokenNode(client, "bench_0"), node);
  assert.ok(created < 16, `one chip move allocated ${created} elements`);
});

test("spatial chip groups preserve transitive overlap, layer order and hidden-container boundaries", async () => {
  const client = await loadClient();
  const browserIndex = client.vm("ParlorEngine.tokenStackIndex");
  const threshold = TABLE_GEOMETRY.tokenSize * .4;
  const tokens = [
    { id: "a", x: -threshold, y: 0, z: 3 }, { id: "b", x: 0, y: 0, z: 1 },
    { id: "c", x: threshold, y: 0, z: 2 },
    { id: "hidden", x: threshold * 2, y: 0, z: 5, bagId: "bag" },
    { id: "d", x: threshold * 3, y: 0, z: 4 }, { id: "e", x: 300, y: 300, z: 0 }
  ];
  for (const build of [tokenStackIndex, browserIndex]) {
    const index = build(tokens);
    assert.deepEqual(Array.from(index.get("a"), (token) => token.id), ["b", "c", "a"]);
    assert.equal(index.get("a"), index.get("c"));
    assert.equal(index.has("hidden"), false);
    assert.deepEqual(Array.from(index.get("d"), (token) => token.id), ["d"]);
    assert.equal(index.size, 5);
    let reads = 0;
    const separate = Array.from({ length: 240 }, (_, i) => ({ id: String(i), z: i,
      get x() { reads++; return (i % 20) * 80; }, get y() { reads++; return Math.floor(i / 20) * 80; }
    }));
    assert.equal(build(separate).size, 240);
    assert.ok(reads < 3000, `separate chips required ${reads} coordinate reads`);
  }
});
