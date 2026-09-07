import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { createRoom, projectRoom } from "../src/room-engine.mjs";
import { createRoomLink } from "./helpers/room-link.mjs";
import { createLocalStoreDouble } from "./helpers/local-store.mjs";
import { loadClient } from "./helpers/client-dom.mjs";

const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
async function fixture(t, stallEvents = true) {
  const room = createRoom({ code: "WEB-123", pack, hostSecret: "sync-test-host" });
  const link = createRoomLink(room), guestLink = link.createPeer();
  link.stallEvents = guestLink.stallEvents = stallEvents;
  const clients = [];
  t.after(() => { for (const client of clients) { client.app.closingStream = true; client.app.eventSource?.close(); } link.transport.close(); });
  const load = async (connection, suffix) => {
    const client = await loadClient({ indexedDB: createLocalStoreDouble(), fetch: connection.fetch, EventSource: connection.EventSource,
      url: `https://table.example/?room=${room.code}&${suffix}` });
    clients.push(client); return client;
  };
  const host = await load(link, `host=${room.hostSecret}`), guest = await load(guestLink, "fresh=1&autojoin=朋友");
  const message = (client, connection, value) => connection.fetch("https://table.example/api/message", { method: "POST",
    body: JSON.stringify({ roomCode: room.code, sessionToken: client.app.sessionToken, message: value }) });
  const sync = async (client, connection, previous = null) => {
    const state = projectRoom(room, client.app.player.id);
    const url = new URL("https://table.example/api/sync");
    for (const [key, value] of Object.entries({ room: room.code, session: client.app.sessionToken, revision: state.revision,
      epoch: state.room.epoch, sync: previous?.sync || "", cursor: previous?.cursor || 0 })) url.searchParams.set(key, value);
    return (await connection.fetch(url)).json();
  };
  return { room, link, guestLink, host, guest, message, sync };
}

test("joining a tunnel with an indefinitely pending event stream immediately supplies the table and library", async (t) => {
  const { host } = await fixture(t);
  assert.equal(host.app.eventSource.readyState, 0);
  assert.equal(host.app.connectionOpen, true);
  assert.equal(host.app.state.decks[0].count, 54);
  await host.dispatch(host.$("open-library"), "click");
  assert.ok(host.$("pack-library").children.length > 10);
  await host.dispatch(host.document.querySelector('[data-add-asset="chip-100"]'), "click");
  assert.equal(host.app.state.tokens[0].symbol, "100");
});

test("HTTP fallback keeps two silent-stream clients in sync and preserves private faces", async (t) => {
  const { host, guest, room } = await fixture(t);
  await host.advanceTimers(1); await guest.advanceTimers(1);
  await guest.sendCommand({ type: "draw" });
  const privateCard = guest.app.state.cards.find((card) => card.ownerId === guest.app.player.id);
  await host.advanceTimers(1100);
  assert.equal(host.app.state.cards.find((card) => card.id === privateCard.id).face, null);
  await guest.sendCommand({ type: "spawn-resource", resourceId: "chip-25", x: 850, y: 450 });
  await host.advanceTimers(1100);
  assert.equal(host.app.state.tokens[0].symbol, "25");
  assert.equal(host.app.state.revision, room.revision);
  assert.equal(host.app.connectionOpen, true);
});

test("HTTP fallback carries pointer previews, pings, card requests and chat without exposing a private face", async (t) => {
  const f = await fixture(t), { host, guest, link, guestLink, message } = f;
  await host.advanceTimers(1); await guest.advanceTimers(1);
  await guest.sendCommand({ type: "draw" });
  await host.advanceTimers(1100);
  const card = guest.app.state.cards.find((card) => card.ownerId === guest.app.player.id);
  await message(guest, guestLink, { type: "cursor", x: 700, y: 420,
    drag: { sourceType: "card", resourceId: card.id, dragId: "private-preview", x: 700, y: 420 } });
  await message(guest, guestLink, { type: "ping", x: 720, y: 430 });
  await host.advanceTimers(1100);
  assert.equal(host.app.remoteCursors.get(guest.app.player.id).x, 700);
  assert.equal(host.app.remoteDrags.get(guest.app.player.id).resourceId, card.id);
  assert.equal(host.document.querySelector(".remote-drag .card-face"), null);
  assert.ok(host.document.querySelector(".table-ping"));
  await message(host, link, { type: "card-request", cardIds: [card.id] });
  await guest.advanceTimers(1100);
  const packet = guestLink.responses.filter((entry) => entry.path === "/api/sync").at(-1).payload;
  assert.ok(packet.events.some((event) => event.type === "card-request"));
  await guest.sendCommand({ type: "chat", text: "可以看到资源了" });
  await host.advanceTimers(1100);
  assert.ok(host.app.state.messages.some((entry) => entry.text === "可以看到资源了"));
});

test("sync sends no unchanged table, coalesces pointers, and rejects an unauthenticated reader", async (t) => {
  const { host, guest, link, guestLink, message, sync } = await fixture(t);
  const first = await sync(host, link);
  assert.equal(first.state.type, "room-state");
  const idle = await sync(host, link, first);
  assert.equal(idle.state, null); assert.deepEqual(idle.events, []);
  await message(guest, guestLink, { type: "cursor", x: 500, y: 400 });
  await pause(80);
  await message(guest, guestLink, { type: "cursor", x: 650, y: 440 });
  const moved = await sync(host, link, idle);
  assert.equal(moved.state, null);
  assert.equal(moved.events.filter((event) => event.type === "cursor").length, 1);
  assert.equal(moved.events[0].x, 650);
  const denied = await link.fetch("https://table.example/api/sync?room=WEB-123&session=wrong");
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).state, undefined);
});

test("an OPEN stream with no data falls back, then a healthy stream resumes without an old table replacing it", async (t) => {
  const { host, guest, link } = await fixture(t, "open");
  const stalled = host.app.eventSource;
  await host.advanceTimers(4500);
  assert.equal(stalled.closed, true);
  await guest.sendCommand({ type: "draw" });
  await host.advanceTimers(1100);
  assert.equal(host.app.state.decks[0].count, 53);
  link.stallEvents = false;
  await host.advanceTimers(30000);
  assert.notEqual(host.app.eventSource, stalled);
  assert.equal(host.app.eventSource.readyState, 1);
  assert.equal(host.app.syncPolling, false);
  const before = link.responses.filter((entry) => entry.path === "/api/sync").length;
  await host.advanceTimers(1000);
  assert.equal(link.responses.filter((entry) => entry.path === "/api/sync").length, before);
});

test("HTTP-only clients retain their table offline and reconnect to the same seat", async (t) => {
  const { host, guest, link } = await fixture(t);
  await host.sendCommand({ type: "draw" });
  await host.advanceTimers(1);
  const playerId = host.app.state.you.id, cardId = host.app.state.cards[0].id;
  link.disconnect();
  await host.advanceTimers(1500);
  assert.equal(host.app.connectionOpen, false);
  assert.equal(host.app.state.cards[0].id, cardId);
  assert.equal(host.$("draw-card").disabled, true);
  await guest.sendCommand({ type: "draw" });
  link.online = true;
  await host.advanceTimers(5000);
  assert.equal(host.app.connectionOpen, true);
  assert.equal(host.app.state.you.id, playerId);
  assert.equal(host.app.state.decks[0].count, 52);
});

test("a delayed first HTTP snapshot cannot undo a newer command receipt", async (t) => {
  const { host, link } = await fixture(t);
  let release;
  host.context.fetch = async (url, options) => {
    const response = await link.fetch(url, options);
    if (new URL(url).pathname !== "/api/sync") return response;
    const payload = await response.json();
    return new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => payload }); });
  };
  await host.advanceTimers(1);
  assert.equal(typeof release, "function");
  await host.sendCommand({ type: "draw" });
  assert.equal(host.app.state.decks[0].count, 53);
  release(); await host.settle();
  assert.equal(host.app.state.decks[0].count, 53);
});

test("an older running server without join snapshots or the new sync route still loads its library", async (t) => {
  const room = createRoom({ code: "OLD-123", pack, hostSecret: "old-sync-test" }), link = createRoomLink(room);
  link.stallEvents = true;
  t.after(() => link.transport.close());
  const client = await loadClient({ indexedDB: createLocalStoreDouble(), EventSource: link.EventSource,
    url: `https://table.example/?room=${room.code}&host=${room.hostSecret}`,
    fetch: async (url, options) => {
      if (new URL(url).pathname === "/api/sync") return { ok: false, status: 404, json: async () => ({ code: "NOT_FOUND", message: "没有这个入口。" }) };
      const response = await link.fetch(url, options), payload = await response.json();
      if (new URL(url).pathname === "/api/join") delete payload.state;
      return { ok: response.ok, status: response.status, json: async () => payload };
    } });
  assert.equal(client.app.state, null);
  await client.advanceTimers(1);
  assert.equal(client.app.connectionOpen, true);
  assert.equal(client.app.state.decks[0].count, 54);
  assert.ok(client.$("pack-library").children.length > 10);
  client.app.closingStream = true; client.app.eventSource.close();
});
