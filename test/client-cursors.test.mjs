import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { createRoom } from "../src/room-engine.mjs";
import { loadClient } from "./helpers/client-dom.mjs";
import { createLocalStoreDouble } from "./helpers/local-store.mjs";
import { createRoomLink } from "./helpers/room-link.mjs";

// These run the production event handlers and room protocol with DOM and
// HTTP/SSE doubles. Native cursor rendering and browser hit testing need QA.
const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} should be close to ${expected}`);
async function until(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await pause(5);
  assert.ok(predicate(), message);
}
function cursorAt(client, clientX, clientY) {
  const root = client.$("local-cursor-root"), node = root.firstElementChild;
  assert.ok(node, "moving over the table should show the local name");
  assert.equal(root.parentElement.id, "viewport");
  assert.equal(node.parentElement.id, "local-cursor-root");
  assert.equal(client.$("world").contains(node), false, "the world transform must not clip the local name");
  const [x, y] = node.style.transform.match(/translate\(([^,]+)px, ([^)]+)px\)/).slice(1).map(Number);
  const rect = client.$("viewport").getBoundingClientRect();
  closeTo(x, clientX - rect.left); closeTo(y, clientY - rect.top);
}
function pointerFor(client, x, y) {
  const rect = client.$("viewport").getBoundingClientRect(), camera = client.app.camera;
  return { clientX: rect.left + camera.x + x * camera.scale, clientY: rect.top + camera.y + y * camera.scale };
}
function tableUncovered(client) {
  assert.equal(client.$("tools-backdrop").classList.contains("is-hidden"), true);
  assert.equal(client.document.querySelector(".aux-backdrop").classList.contains("is-hidden"), true);
  assert.equal(client.$("help-panel").classList.contains("is-hidden"), true);
}

for (const width of [1440, 390]) {
  test(`table cursor and actions survive navigation, panel close and focus changes at ${width}px`, async () => {
    const client = await loadClient({ width, height: 844 });
    const { app, $, document, dispatch } = client, viewport = $("viewport");
    assert.equal($("room-screen").classList.contains("is-hidden"), false);
    assert.equal(app.connectionOpen, true);
    tableUncovered(client);

    const start = { clientX: width / 2, clientY: 400 };
    await dispatch(viewport, "pointermove", start);
    cursorAt(client, start.clientX, start.clientY);
    const camera = { ...app.camera };
    const moved = { clientX: start.clientX + 24, clientY: start.clientY + 16 };
    await dispatch(viewport, "pointerdown", start);
    await dispatch(viewport, "pointermove", moved);
    await dispatch(viewport, "pointerup", moved);
    assert.equal(app.pan, null);
    closeTo(app.camera.x, camera.x + 24); closeTo(app.camera.y, camera.y + 16);
    cursorAt(client, moved.clientX, moved.clientY);
    await dispatch(viewport, "wheel", { ...moved, deltaX: 0, deltaY: -120 });
    cursorAt(client, moved.clientX, moved.clientY);

    for (const [open, close] of [["open-library", "close-library"], ["open-tools", "close-tools"], ["open-help", "close-help"]]) {
      await dispatch($(open), "click"); await dispatch($(close), "click");
    }
    await dispatch($("open-chat"), "click");
    await dispatch($("chat-panel").querySelector("[data-close-aux]"), "click");
    client.context.innerWidth = width - 20;
    viewport.rect.width = width - 20;
    await dispatch(document.body, "resize");
    tableUncovered(client);
    await dispatch(viewport, "pointermove", moved);
    cursorAt(client, moved.clientX, moved.clientY);

    for (const [target, event] of [[document.body, "blur"], [viewport, "pointerleave"]]) {
      await dispatch(target, event);
      assert.equal($("local-cursor-root").children.length, 0);
      assert.equal(app.pan, null); assert.equal(app.drag, null);
      await dispatch(viewport, "pointermove", moved);
      cursorAt(client, moved.clientX, moved.clientY);
    }

    client.fitCamera();
    const main = () => app.state.decks.find((deck) => deck.id === "main");
    const before = { ...main() }, node = document.querySelector('[data-deck-id="main"]');
    const from = pointerFor(client, before.x + 20, before.y + 20);
    const to = pointerFor(client, before.x + 140, before.y + 80);
    await dispatch(node, "pointerdown", from);
    await dispatch(node, "pointermove", to);
    assert.equal(app.drag?.activated, true);
    await dispatch(node, "pointerup", to);
    closeTo(main().x, before.x + 120); closeTo(main().y, before.y + 60);
    assert.equal(app.drag, null);
    assert.equal($("drag-root").children.length, 0);
    const draw = document.querySelector('[data-selection-action="draw"]');
    assert.ok(draw); assert.equal(draw.disabled, false);
    await dispatch(draw, "click");
    assert.equal(main().count, before.count - 1, "drawing must remain usable after returning to the table");
  });
}

async function roomFixture(t, wrapFetch = (fetch) => fetch) {
  const room = createRoom({ code: "CUR-123", pack, hostSecret: "cursor-test-secret", randomizeDeck: false });
  const link = createRoomLink(room), clients = [];
  t.after(() => {
    for (const client of clients) {
      client.app.closingStream = true;
      client.app.cursorRequestController?.abort();
      client.app.eventSource?.close();
    }
    link.transport.close();
  });
  const load = async (peer, query) => {
    const client = await loadClient({ indexedDB: createLocalStoreDouble(), storage: new Map(),
      url: `https://table.example/?room=${room.code}&${query}`, fetch: wrapFetch(peer.fetch), EventSource: peer.EventSource });
    clients.push(client);
    await until(() => client.app.connectionOpen, "the player should enter the room");
    return client;
  };
  const host = await load(link, `host=${room.hostSecret}`);
  return { room, link, host, guest: () => load(link.createPeer(), "fresh=1&autojoin=Guest") };
}

test("resizing keeps the viewed world point centered and cancels a drag without moving cards", async () => {
  const client = await loadClient({ width: 1440, height: 900 });
  const { app, $, document, dispatch } = client;
  await dispatch($("zoom-in"), "click");
  const center = () => {
    const rect = $("viewport").getBoundingClientRect();
    return { x: (rect.width / 2 - app.camera.x) / app.camera.scale, y: (rect.height / 2 - app.camera.y) / app.camera.scale };
  };
  const before = center(), scale = app.camera.scale, revision = app.state.revision;
  client.context.innerWidth = 390;
  Object.assign($("viewport").rect, { width: 390, height: 786 });
  await dispatch(document.body, "resize");
  closeTo(center().x, before.x); closeTo(center().y, before.y);
  assert.equal(app.camera.scale, scale);
  assert.equal($("zoom-value").textContent, `${Math.round(scale * 100)}%`);

  const deck = app.state.decks.find((item) => item.id === "main"), node = document.querySelector('[data-deck-id="main"]');
  const from = pointerFor(client, deck.x + 20, deck.y + 20), to = pointerFor(client, deck.x + 70, deck.y + 40);
  await dispatch(node, "pointerdown", from);
  await dispatch(node, "pointermove", to);
  assert.equal(app.drag?.activated, true);
  client.context.innerWidth = 320;
  Object.assign($("viewport").rect, { width: 320, height: 682 });
  await dispatch(document.body, "resize");
  await dispatch(node, "pointerup", to);
  assert.equal(app.drag, null);
  assert.equal($("drag-root").children.length, 0);
  assert.equal(app.state.revision, revision);
  closeTo(center().x, before.x); closeTo(center().y, before.y);
  await dispatch($("viewport"), "pointermove", { clientX: 200, clientY: 250 });
  cursorAt(client, 200, 250);
});

test("a transient event-stream loss preserves cursor sending and table commands, then restores remote cursors", async (t) => {
  const { room, link, host, guest: loadGuest } = await roomFixture(t), guest = await loadGuest();
  const previousSource = host.app.eventSource, hostId = host.app.state.you.id;
  previousSource.disconnect();
  assert.equal(link.online, true, "HTTP is still available during the SSE interruption");
  assert.equal(host.app.connectionOpen, true);
  assert.equal(host.$("draw-card").disabled, false);
  await host.dispatch(host.$("viewport"), "pointermove", { clientX: 640, clientY: 420 });
  await host.advanceTimers(100);
  await until(() => guest.app.remoteCursors.has(hostId), "the other player should still receive this player's cursor");
  cursorAt(host, 640, 420);
  assert.equal(guest.$("cursor-root").firstElementChild.dataset.playerId, hostId);

  const before = room.deckOrder.length;
  await host.dispatch(host.document.querySelector('[data-deck-id="main"]'), "dblclick");
  await until(() => room.deckOrder.length === before - 1 && host.app.pendingCommands.size === 0, "drawing should receive its normal acknowledgement");
  assert.equal(host.app.state.revision, room.revision, "the HTTP receipt should update the disconnected stream's table");
  assert.equal(guest.app.state.revision, room.revision);
  await host.advanceTimers(5000);
  await until(() => host.app.eventSource !== previousSource && host.app.eventSource.readyState === 1, "the stream should reconnect automatically");
  assert.equal(host.$("reconnect-banner").classList.contains("is-hidden"), true);

  await guest.dispatch(guest.$("viewport"), "pointermove", { clientX: 720, clientY: 450 });
  await guest.advanceTimers(100);
  await until(() => host.app.remoteCursors.has(guest.app.state.you.id), "incoming cursors should resume with the stream");
  assert.equal(host.$("cursor-root").firstElementChild.dataset.playerId, guest.app.state.you.id);
});

test("a stalled cursor request coalesces movement without blocking drawing and releases on timeout", async (t) => {
  const sent = [];
  let active = 0, peak = 0, stalledSignal;
  const { host, room } = await roomFixture(t, (fetch) => async (url, options = {}) => {
    const message = options.body ? JSON.parse(options.body).message : null;
    if (message?.type !== "cursor") return fetch(url, options);
    sent.push(message); active++; peak = Math.max(peak, active);
    try {
      if (sent.length === 1) {
        stalledSignal = options.signal;
        await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("Cursor request timed out")), { once: true }));
      }
      return await fetch(url, options);
    } finally { active--; }
  });
  await host.dispatch(host.$("viewport"), "pointermove", { clientX: 500, clientY: 400 });
  await host.advanceTimers(100);
  assert.equal(sent.length, 1);
  for (let index = 1; index <= 30; index++) {
    await host.dispatch(host.$("viewport"), "pointermove", { clientX: 500 + index, clientY: 400 + index });
  }
  cursorAt(host, 530, 430);
  assert.equal(sent.length, 1, "movement must not create overlapping requests");
  const before = room.deckOrder.length;
  await host.dispatch(host.document.querySelector('[data-deck-id="main"]'), "dblclick");
  await until(() => room.deckOrder.length === before - 1, "a slow cursor request must not block a card action");
  await host.advanceTimers(1900);
  await until(() => sent.length === 2 && !host.app.cursorSendInFlight, "the latest position should be sent after timeout");
  assert.equal(stalledSignal.aborted, true);
  assert.equal(peak, 1);
  closeTo(sent[1].x, Math.round(host.app.localCursor.x * 10) / 10);
  closeTo(sent[1].y, Math.round(host.app.localCursor.y * 10) / 10);
});
