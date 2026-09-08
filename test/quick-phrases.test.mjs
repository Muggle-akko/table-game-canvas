import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createRoom, joinRoom, quickPhraseSignal, QUICK_PHRASES,
  QUICK_PHRASE_LIFETIME, QUICK_PHRASE_COOLDOWN, TABLE_GEOMETRY, projectRoom
} from "../src/room-engine.mjs";
import { createRoomLink } from "./helpers/room-link.mjs";

const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
function fixture(t) {
  const room = createRoom({ code: "SAY-123", pack, hostSecret: "phrase-test-host" });
  const host = joinRoom(room, { hostSecret: room.hostSecret, displayName: "房主" });
  const guest = joinRoom(room, { displayName: "小王" });
  const link = createRoomLink(room);
  t.after(() => link.transport.close());
  const send = (seat, message) => link.fetch("https://table.example/api/message", { method: "POST",
    body: JSON.stringify({ roomCode: room.code, sessionToken: seat.sessionToken, message }) });
  const sync = async (seat, previous = null) => {
    const state = projectRoom(room, seat.player.id);
    const url = new URL("https://table.example/api/sync");
    for (const [key, value] of Object.entries({ room: room.code, session: seat.sessionToken, revision: state.revision,
      epoch: state.room.epoch, sync: previous?.sync || "", cursor: previous?.cursor || 0 })) url.searchParams.set(key, value);
    return (await link.fetch(url)).json();
  };
  return { room, host, guest, link, send, sync };
}

test("quick phrases use the exact preset text and authenticated identity without changing the game", (t) => {
  const { room, host, guest } = fixture(t), before = structuredClone(room);
  assert.deepEqual(QUICK_PHRASES.slice(0, 7).map((phrase) => phrase.text), ["你好！", "过牌！", "跟注", "加注", "ALL IN！", "快点，等到花都谢了", "开牌！"]);
  for (const phrase of QUICK_PHRASES) {
    const signal = quickPhraseSignal(room, guest.player.id, { phraseId: phrase.id, x: -1e9, y: 1e9,
      playerId: host.player.id, name: "冒充房主", color: "red", text: "<img src=x>" }, 5000);
    assert.equal(signal.text, phrase.text); assert.equal(signal.name, "小王");
    assert.equal(signal.playerId, guest.player.id); assert.equal(signal.color, guest.player.color);
    assert.equal(signal.at, 5000); assert.equal(signal.expiresAt, 5000 + QUICK_PHRASE_LIFETIME);
    assert.equal(signal.x, TABLE_GEOMETRY.publicZone.x);
    assert.equal(signal.y, TABLE_GEOMETRY.publicZone.y + TABLE_GEOMETRY.publicZone.height);
    assert.equal(signal.epoch, room.epoch);
    assert.deepEqual(structuredClone(room), before, "speech must not alter cards, turns, history, undo or persistence");
  }
});

test("phrase requests validate presets, coordinates and sessions, and throttle per authenticated player", async (t) => {
  const { room, guest, host, send } = fixture(t);
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const phrase = { type: "quick-phrase", phraseId: "hello", x: 720, y: 400 };
  for (const invalid of [{ phraseId: "missing" }, { phraseId: "<script>" }, { x: null }, { y: "400" }, { x: {} }]) {
    assert.equal((await send(guest, { ...phrase, ...invalid })).status, 400);
  }
  assert.equal((await send({ sessionToken: "invalid" }, phrase)).status, 401);
  const before = structuredClone(room);
  const sent = await send(guest, { ...phrase, playerId: host.player.id });
  assert.equal(sent.status, 200); assert.equal((await sent.json()).signal.playerId, guest.player.id);
  assert.equal((await send(guest, phrase)).status, 429);
  assert.equal((await send(host, phrase)).status, 200, "another player's shortcut remains available");
  now += QUICK_PHRASE_COOLDOWN;
  assert.equal((await send(guest, { ...phrase, phraseId: "call" })).status, 200);
  assert.deepEqual(structuredClone(room), before);
});

test("polling delivers only the latest unexpired phrase per player and never replays speech on reconnect", async (t) => {
  const { host, guest, link, send, sync } = fixture(t);
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const first = await sync(host);
  await send(guest, { type: "quick-phrase", phraseId: "hello", x: 720, y: 400 });
  now += QUICK_PHRASE_COOLDOWN;
  await send(guest, { type: "quick-phrase", phraseId: "all-in", x: 760, y: 450 });
  const recent = await sync(host, first);
  assert.equal(recent.state, null, "speech should not broadcast a full table");
  assert.deepEqual(recent.events.map((signal) => signal.text), ["ALL IN！"]);
  assert.deepEqual((await sync(host, recent)).events, []);
  assert.deepEqual((await sync(host)).events, [], "a reset must not replay old speech");
  const stream = new link.EventSource(`https://table.example/api/events?room=SAY-123&session=${host.sessionToken}`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(link.events.some((event) => event.type === "quick-phrase"), false, "a new SSE connection must not replay old speech");
  now += QUICK_PHRASE_LIFETIME;
  assert.deepEqual((await sync(host, first)).events, [], "expired speech is excluded even with an old polling cursor");
  stream.close();
});
