import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { createRoom, quickPhraseSignal, QUICK_PHRASE_LIFETIME } from "../src/room-engine.mjs";
import { loadClient } from "./helpers/client-dom.mjs";
import { createRoomLink } from "./helpers/room-link.mjs";
import { createLocalStoreDouble } from "./helpers/local-store.mjs";

const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const speech = (client, id = client.app.state.you.id) => client.$("cursor-phrase-root").querySelector(`[data-player-id="${id}"]`);
const textOf = (node) => node?.querySelector(".cursor-phrase__text").textContent;
const key = (client, key, extra = {}) => client.dispatch(client.document.activeElement, "keydown", { key, ...extra });
const choose = (client, id, extra = {}) => client.dispatch(client.$("phrase-options").querySelector(`[data-phrase-id="${id}"]`), "click", extra);
const open = (client) => client.dispatch(client.$("open-phrases"), "click");
const receive = (client, signal) => client.vm(`receiveRoomEvent(${JSON.stringify(signal)})`);
const position = (node) => node.style.transform.match(/translate\(([^,]+)px, ([^)]+)px\)/).slice(1).map(Number);
async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await pause(5);
  assert.ok(predicate(), "the room signal should arrive");
}

test("T and a number send a cursor phrase without changing selected resources, cards or undo", async () => {
  const client = await loadClient(), { app, $, dispatch } = client;
  client.selectResource("deck", "main");
  const before = structuredClone(app.previewModel.engineRoom), selection = JSON.stringify(app.selection);
  await dispatch($("viewport"), "pointermove", { clientX: 640, clientY: 420 });
  await key(client, "t");
  assert.equal($("open-phrases").getAttribute("aria-expanded"), "true");
  assert.equal($("phrase-options").children.length, 9);
  await key(client, "5");
  assert.equal($("open-phrases").getAttribute("aria-expanded"), "false");
  assert.equal(textOf(speech(client)), "ALL IN！");
  assert.equal($("phrase-announcement").textContent, `${app.state.you.name}：ALL IN！`);
  assert.equal(speech(client).parentElement.parentElement.id, "viewport");
  assert.equal($("world").contains(speech(client)), false, "bubbles stay readable outside the world zoom");
  assert.equal(JSON.stringify(app.selection), selection);
  assert.deepEqual(structuredClone(app.previewModel.engineRoom), before);
  const node = speech(client), first = position(node);
  await dispatch($("viewport"), "pointermove", { clientX: 690, clientY: 450 });
  assert.equal(speech(client), node, "moving should reuse the bubble DOM");
  assert.deepEqual(position(node), [first[0] + 50, first[1] + 30]);
  await client.advanceTimers(QUICK_PHRASE_LIFETIME + 1);
  assert.equal(speech(client), null);
});

test("phrase palette keyboard focus, Escape, typing and outside clicks preserve table interactions", async () => {
  const client = await loadClient(), { app, $, dispatch, document } = client;
  client.selectResource("deck", "main");
  await key(client, "t", { isComposing: true });
  await key(client, "t", { ctrlKey: true });
  assert.equal($("open-phrases").getAttribute("aria-expanded"), "false");
  $("quick-chat-input").focus();
  await key(client, "t"); await key(client, "5");
  assert.equal(speech(client), null);
  await open(client);
  await key(client, "ArrowDown"); assert.equal(document.activeElement.dataset.phraseId, "check");
  await key(client, "End"); assert.equal(document.activeElement.dataset.phraseId, "your-turn");
  await key(client, "Home"); assert.equal(document.activeElement.dataset.phraseId, "hello");
  const count = app.state.deck.count;
  await key(client, "d"); await key(client, "1", { repeat: true });
  assert.equal(app.state.deck.count, count); assert.equal(speech(client), null);
  await key(client, "Escape");
  assert.equal(app.selection.id, "main"); assert.equal(document.activeElement, $("open-phrases"));
  await open(client);
  await dispatch($("quick-chat-input"), "pointerdown");
  assert.equal($("open-phrases").getAttribute("aria-expanded"), "false");
  assert.equal(app.selection.id, "main"); assert.equal(app.pan, null);
  $("deal-dialog").showModal(); document.body.focus();
  await key(client, "t");
  assert.equal($("open-phrases").getAttribute("aria-expanded"), "false");
});

test("clicks use the actual mouse position, clamp at viewport edges and never start a table gesture", async () => {
  const client = await loadClient(), { app, $, dispatch } = client;
  await open(client);
  const button = $("phrase-options").querySelector('[data-phrase-id="hurry"]');
  await dispatch(button, "pointermove", { clientX: 320, clientY: 240 });
  await dispatch(button, "pointerdown", { clientX: 320, clientY: 240 });
  await choose(client, "hurry", { detail: 1, clientX: 320, clientY: 240 });
  assert.equal(textOf(speech(client)), "快点，等到花都谢了");
  assert.equal(app.pan, null); assert.equal(app.drag, null);
  const node = speech(client);
  node.rect = { left: 0, top: 0, width: 160, height: 60 };
  await dispatch(client.document.body, "resize");
  let measures = 0, original = node.getBoundingClientRect.bind(node);
  node.getBoundingClientRect = () => { measures++; return original(); };
  for (const [x, y] of [[2, 60], [1438, 60], [1438, 898], [2, 898], [640, 420]]) {
    await dispatch($("viewport"), "pointermove", { clientX: x, clientY: y });
    const [left, top] = position(node);
    assert.ok(left >= 8 && top >= 8);
    assert.ok(left + 160 <= 1440 - 8 && top + 60 <= 842 - 8);
  }
  assert.equal(measures, 0, "pointer movement must not measure bubble layout");
  const beforeZoom = position(node);
  await dispatch($("zoom-in"), "click");
  assert.notDeepEqual(position(node), beforeZoom, "camera changes reposition speech with its cursor");
});

test("one bubble per player ignores duplicate, reordered, expired and foreign-context signals", async () => {
  const client = await loadClient(), room = client.app.previewModel.engineRoom;
  const other = client.app.state.players.find((player) => player.id !== client.app.state.you.id).id;
  const now = client.app.state.serverTime;
  const first = quickPhraseSignal(room, other, { phraseId: "hello", x: 800, y: 400 }, now);
  receive(client, first);
  const node = speech(client, other);
  assert.equal(textOf(node), "你好！");
  await client.advanceTimers(1000);
  receive(client, first); assert.equal(speech(client, other), node, "SSE/HTTP duplicate must not restart the animation or timer");
  const next = quickPhraseSignal(room, other, { phraseId: "call", x: 850, y: 400 }, now + 800);
  receive(client, next);
  const replacement = speech(client, other);
  receive(client, first);
  receive(client, { ...next, id: "wrong-epoch", epoch: "old-game", at: now + 900 });
  receive(client, { ...next, id: "expired", at: now - 6000, expiresAt: now - 1000 });
  assert.equal(speech(client, other), replacement); assert.equal(textOf(replacement), "跟注");
  receive(client, quickPhraseSignal(room, client.app.state.you.id, { phraseId: "check", x: 720, y: 500 }, now));
  assert.equal(client.$("cursor-phrase-root").children.length, 2);
  await client.advanceTimers(QUICK_PHRASE_LIFETIME + 1);
  assert.equal(client.$("cursor-phrase-root").children.length, 0);
  receive(client, next); assert.equal(speech(client, other), null, "a repeated signal cannot resurrect expired speech");
});

test("remote phrases follow fresh cursors, remain at the last point on leave, and clear when changing seats", async () => {
  const client = await loadClient(), room = client.app.previewModel.engineRoom;
  const other = client.app.state.players.find((player) => player.id !== client.app.state.you.id);
  receive(client, quickPhraseSignal(room, other.id, { phraseId: "wait", x: 760, y: 440 }));
  const node = speech(client, other.id), before = position(node);
  receive(client, { type: "cursor", playerId: other.id, name: other.name, color: other.color, x: 840, y: 480 });
  assert.notDeepEqual(position(node), before);
  const moved = position(node);
  receive(client, { type: "cursor-leave", playerId: other.id });
  assert.deepEqual(position(node), moved);
  await open(client);
  client.switchPreviewRole();
  assert.equal(client.$("cursor-phrase-root").children.length, 0);
  assert.equal(client.$("open-phrases").getAttribute("aria-expanded"), "false");
});

test("speech lifetime uses the room clock even when the viewer's wall clock differs", async () => {
  const client = await loadClient(), room = client.app.previewModel.engineRoom;
  const serverTime = Date.now() + 3600_000;
  client.app.state = { ...client.app.state, serverTime };
  client.vm("renderRoom()");
  const own = client.app.state.you.id;
  receive(client, quickPhraseSignal(room, own, { phraseId: "hello", x: 720, y: 430 }, serverTime - 3000));
  assert.ok(speech(client));
  await client.advanceTimers(2100);
  assert.equal(speech(client), null, "a late delivery has only its remaining lifetime");
});

async function roomFixture(t, { polling = false, wrap = (fetch) => fetch } = {}) {
  const room = createRoom({ code: "SAY-456", pack, hostSecret: "phrase-host" });
  const link = createRoomLink(room), peer = link.createPeer(), clients = [];
  link.stallEvents = peer.stallEvents = polling;
  t.after(() => { for (const c of clients) { c.app.closingStream = true; c.app.eventSource?.close(); } link.transport.close(); });
  const load = async (connection, suffix) => {
    const client = await loadClient({ indexedDB: createLocalStoreDouble(), fetch: wrap(connection.fetch), EventSource: connection.EventSource,
      url: `https://table.example/?room=${room.code}&${suffix}` });
    clients.push(client); return client;
  };
  const host = await load(link, `host=${room.hostSecret}`), guest = await load(peer, "fresh=1&autojoin=小王");
  await host.advanceTimers(1); await guest.advanceTimers(1);
  return { room, host, guest, link, peer };
}

for (const polling of [false, true]) {
  test(`two clients receive one phrase each via ${polling ? "HTTP fallback" : "SSE"}, without changing private cards or history`, async (t) => {
    const { room, host, guest, link, peer } = await roomFixture(t, { polling });
    const before = structuredClone(room), guestId = guest.app.state.you.id;
    await guest.dispatch(guest.$("viewport"), "pointermove", { clientX: 720, clientY: 440 });
    await open(guest); await choose(guest, "reveal");
    if (polling) await host.advanceTimers(1100);
    await until(() => speech(host, guestId));
    assert.equal(textOf(speech(host, guestId)), "开牌！");
    assert.equal(textOf(speech(guest)), "开牌！");
    assert.equal(host.$("cursor-phrase-root").children.length, 1);
    assert.equal(guest.$("cursor-phrase-root").children.length, 1);
    assert.equal(link.commands.length, 0); assert.equal(peer.commands.length, 0);
    assert.deepEqual(structuredClone(room), before);
    const node = speech(host, guestId);
    await host.advanceTimers(2100);
    const same = peer.responses.find((response) => response.payload.signal?.type === "quick-phrase").payload.signal;
    receive(host, same); assert.equal(speech(host, guestId), node);
    await host.advanceTimers(3000);
    assert.equal(speech(host, guestId), null);
  });
}

test("a failed phrase request produces no ghost bubble, clears busy state and keeps a newly focused chat draft", async (t) => {
  let rejectSpeech;
  const { host } = await roomFixture(t, { wrap: (fetch) => (url, options) => {
    if (options?.body && JSON.parse(options.body).message?.type === "quick-phrase") return new Promise((_, reject) => { rejectSpeech = reject; });
    return fetch(url, options);
  } });
  await open(host); await choose(host, "hello");
  assert.equal(host.$("open-phrases").getAttribute("aria-busy"), "true");
  host.$("quick-chat-input").value = "保留草稿"; host.$("quick-chat-input").focus();
  rejectSpeech(new TypeError("测试连接中断")); await host.settle();
  assert.equal(speech(host), null);
  assert.equal(host.$("open-phrases").getAttribute("aria-busy"), "false");
  assert.equal(host.document.activeElement, host.$("quick-chat-input"));
  assert.equal(host.$("quick-chat-input").value, "保留草稿");
  assert.ok(host.$("toast-region").textContent.includes("测试连接中断"));
  await host.advanceTimers(801); await open(host);
  assert.equal(host.$("phrase-options").children[0].disabled, false);
});

test("an accepted SSE echo releases the sender even if its HTTP receipt is lost", async (t) => {
  const { host, guest } = await roomFixture(t, { wrap: (fetch) => async (url, options) => {
    const response = await fetch(url, options);
    if (options?.body && JSON.parse(options.body).message?.type === "quick-phrase") throw new TypeError("回执丢失");
    return response;
  } });
  await open(host); await choose(host, "hello");
  await until(() => speech(guest, host.app.state.you.id));
  assert.equal(textOf(speech(host)), "你好！");
  assert.equal(host.$("open-phrases").getAttribute("aria-busy"), "false");
  assert.equal(host.$("toast-region").textContent.includes("回执丢失"), false, "delivery has already been confirmed by the room");
  await host.advanceTimers(801); await open(host);
  assert.equal(host.$("phrase-options").children[0].disabled, false);
});
