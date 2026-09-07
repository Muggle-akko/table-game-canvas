import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { createRoom } from "../src/room-engine.mjs";
import { loadClient } from "./helpers/client-dom.mjs";
import { createLocalStoreDouble } from "./helpers/local-store.mjs";
import { createRoomLink } from "./helpers/room-link.mjs";

// Production UI and protocol with a DOM/network double; layout and pointer
// hit-testing are also checked separately in the isolated browser room.
const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const plain = (value) => JSON.parse(JSON.stringify(value));
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < .000001, `${actual} should be close to ${expected}`);
async function until(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await pause(5);
  assert.ok(predicate(), message);
}
const pointer = (client, x, y) => ({ clientX: client.app.camera.x + x * client.app.camera.scale, clientY: 58 + client.app.camera.y + y * client.app.camera.scale });
async function drag(client, type, resource, x, y) {
  const node = client.document.querySelector(`[data-${type}-id="${resource.id}"]`);
  await client.dispatch(node, "pointerdown", pointer(client, resource.x + 15, resource.y + 15));
  await client.dispatch(node, "pointermove", pointer(client, x + 15, y + 15));
  const id = client.app.drag?.dragId;
  await client.dispatch(node, "pointerup", pointer(client, x + 15, y + 15));
  return id;
}

test("the current guest can pass the turn and reveal or conceal a card inside the hand drawer", async () => {
  const client = await loadClient(), { app, $, document, dispatch } = client;
  await client.sendCommand({ type: "set-turn", playerId: "player_b" });
  client.switchPreviewRole();
  assert.equal($("next-turn").disabled, false);
  assert.equal($("pass-turn").classList.contains("is-hidden"), false);
  const card = app.state.cards.find((card) => card.ownerId === "player_b"), original = plain(card);
  await dispatch($("open-hand"), "click");
  client.selectResource("card", card.id);
  assert.match($("selection-actions").textContent, /展示手牌/);
  await dispatch(document.querySelector('[data-selection-action="flip-card"]'), "click");
  assert.equal(app.state.cards.find((entry) => entry.id === card.id).zone, "hand");
  assert.equal(app.state.cards.find((entry) => entry.id === card.id).x, original.x);
  assert.ok(document.querySelector(`#hand-cards [data-card-id="${card.id}"] .card-visibility`));
  assert.match($("selection-actions").textContent, /收回展示/);
  client.switchPreviewRole();
  assert.equal(app.state.cards.find((entry) => entry.id === card.id).face.label, original.face.label);
  assert.equal(document.querySelector(`#cards-root [data-card-id="${card.id}"] [data-card-action="flip"]`), null);
  client.switchPreviewRole();
  await dispatch(document.querySelector(`#hand-cards [data-card-id="${card.id}"]`), "dblclick");
  await dispatch($("pass-turn"), "click");
  assert.equal(app.state.turn.activePlayerId, "player_a");
  assert.equal($("next-turn").disabled, true);
  assert.equal($("pass-turn").classList.contains("is-hidden"), true);
  client.switchPreviewRole();
  assert.equal(app.state.cards.find((entry) => entry.id === card.id).face, null);
});

test("chip pointer drops stack, move the full group and expose take and spread actions", async () => {
  const client = await loadClient(), { app, document, dispatch } = client;
  for (const [resourceId, x] of [["chip-25", 450], ["chip-100", 1150]]) await client.sendCommand({ type: "spawn-resource", resourceId, x, y: 450 });
  const [source, target] = app.state.tokens.slice(-2);
  await drag(client, "token", source, target.x, target.y);
  assert.ok(document.querySelector(`[data-token-id="${source.id}"] .token-stack-count`));
  assert.equal(app.selection.id, source.id);
  const stacked = app.state.tokens.find((token) => token.id === source.id);
  await drag(client, "token", stacked, 700, 660);
  const moved = app.state.tokens.filter((token) => [source.id, target.id].includes(token.id));
  assert.ok(moved.every((token) => Math.abs(token.x - 700) < .001));
  await dispatch(document.querySelector('[data-selection-action="token-take"]'), "click");
  assert.equal(app.selection.id, source.id);
  assert.equal(document.querySelector(".token-stack-count"), null);
  await client.sendCommand({ type: "undo" });
  client.selectResource("token", source.id);
  await dispatch(document.querySelector('[data-selection-action="token-spread"]'), "click");
  assert.equal(document.querySelector(".token-stack-count"), null);
  assert.deepEqual(plain(app.state.tokens.filter((token) => [source.id, target.id].includes(token.id)).map((token) => token.symbol)), ["25", "100"]);
});

test("compact chat keeps drafts and can be moved, clamped and cancelled without moving the table", async () => {
  const client = await loadClient({ width: 390, height: 844 }), { app, $, document, dispatch } = client;
  $("quick-chat").rect = { left: 56, top: 560, width: 280, height: 110 };
  await dispatch($("open-chat"), "click");
  assert.equal($("quick-chat").classList.contains("is-hidden"), false);
  assert.equal($("chat-panel").classList.contains("is-open"), false);
  assert.equal(document.querySelector(".aux-backdrop").classList.contains("is-hidden"), true);
  const camera = plain(app.camera), revision = app.state.revision;
  const handle = $("chat-drag-handle"), start = { ...$("quick-chat").style };
  await dispatch(handle, "pointerdown", { clientX: 120, clientY: 580 });
  await dispatch(handle, "pointermove", { clientX: -1000, clientY: 1800 });
  assert.equal($("quick-chat").style.left, "8px");
  assert.ok(Number.parseFloat($("quick-chat").style.top) <= 844 - 58 - 110 - 8);
  await dispatch(handle, "pointercancel");
  assert.equal($("quick-chat").style.left, start.left); assert.equal($("quick-chat").style.top, start.top);
  await dispatch(handle, "keydown", { key: "ArrowRight" });
  assert.equal(Number.parseFloat($("quick-chat").style.left), Number.parseFloat(start.left) + 8);
  assert.deepEqual(plain(app.camera), camera); assert.equal(app.state.revision, revision);
  $("quick-chat-input").value = "发牌以后聊";
  await dispatch($("quick-chat-input"), "input");
  await dispatch($("close-quick-chat"), "click"); await dispatch($("open-chat"), "click");
  assert.equal($("quick-chat-input").value, "发牌以后聊");
  await dispatch($("open-chat-history"), "click");
  assert.equal($("quick-chat").classList.contains("is-hidden"), true);
  assert.equal($("chat-panel").classList.contains("is-open"), true);
  assert.equal($("chat-input").value, "发牌以后聊");
  await dispatch($("chat-form"), "submit");
  assert.equal(app.state.messages.at(-1).text, "发牌以后聊");
  assert.equal($("quick-chat-input").value, "");
  assert.match($("quick-chat-message").textContent, /发牌以后聊/);
  assert.equal(app.previewModel.engineRoom.undoStack.length, 0, "chat should not alter the physical undo chain");
});

async function fixture(t) {
  const room = createRoom({ code: "DRP-123", hostSecret: "test-host", pack, randomizeDeck: false });
  const link = createRoomLink(room), guestLink = link.createPeer(), held = [], sent = [];
  const f = { room, link, guestLink, held, sent, holdTypes: new Set() };
  const wrappedFetch = async (url, options = {}) => {
    const message = options.body ? JSON.parse(options.body).message : null;
    if (message) sent.push(plain(message));
    if (message?.type === "command" && f.holdTypes.has(message.command.type)) await new Promise((resolve) => held.push({ resolve, message }));
    return link.fetch(url, options);
  };
  const host = await loadClient({ indexedDB: createLocalStoreDouble(), url: `https://table.example/?room=${room.code}&host=${room.hostSecret}`, fetch: wrappedFetch, EventSource: link.EventSource });
  await until(() => host.app.connectionOpen, "host joined");
  const guest = await loadClient({ indexedDB: createLocalStoreDouble(), url: `https://table.example/?room=${room.code}&fresh=1&autojoin=朋友`, fetch: guestLink.fetch, EventSource: guestLink.EventSource });
  await until(() => guest.app.connectionOpen, "guest joined");
  t.after(() => { for (const client of [host, guest]) { client.app.closingStream = true; client.app.connectionOpen = false; client.app.eventSource?.close(); } link.transport.close(); });
  return Object.assign(f, { host, guest });
}

test("delayed drops hold their destination across state updates and allow another card to move", async (t) => {
  const f = await fixture(t), { host, guest, room } = f;
  for (const x of [450, 1150]) await host.sendCommand({ type: "draw-public", x, y: 400, faceUp: false });
  const [first, second] = host.app.state.cards;
  f.holdTypes.add("move-card");
  const firstId = await drag(host, "card", first, 570, 580);
  await until(() => f.held.length === 1 && guest.app.remoteDrops.size === 1, "drop preview reaches the other player before the command");
  assert.equal(host.app.drag, null);
  assert.equal(host.app.pendingDrops.size, 1);
  assert.equal(room.cards.get(first.id).x, first.x, "the authoritative move is still waiting");
  closeTo(Number.parseFloat(host.$("drag-root").firstElementChild.style.left), 570);
  assert.ok(host.document.querySelector(`[data-card-id="${first.id}"]`).classList.contains("is-drop-source"));
  assert.equal(guest.$("remote-drag-root").querySelector(".card-face"), null, "released previews cannot reveal a covered card");
  await host.dispatch(host.$("viewport"), "pointermove", { clientX: 200, clientY: 200 }); await host.advanceTimers(100);
  assert.equal(guest.app.remoteDrops.size, 1, "a cursor update without an active drag must not revert a dropped card");
  await host.dispatch(host.$("viewport"), "pointerleave");
  await until(() => !guest.app.remoteCursors.has(host.app.state.you.id), "cursor leaves the table");
  assert.equal(guest.app.remoteDrops.size, 1, "leaving the table does not cancel an already released drop");
  await guest.sendCommand({ type: "chat", text: "这一手我看看" });
  assert.ok(host.document.querySelector(`[data-card-id="${first.id}"]`).classList.contains("is-drop-source"));
  const secondId = await drag(host, "card", second, 1260, 600);
  await until(() => f.held.length === 2 && guest.app.remoteDrops.size === 2, "two independent drops may be waiting at once");
  assert.equal(host.$("drag-root").children.length, 2);
  f.held[0].resolve();
  await until(() => !host.app.pendingDrops.has(firstId), "first move confirmed");
  closeTo(room.cards.get(first.id).x, 570);
  assert.equal(host.$("drag-root").children.length, 1);
  assert.equal(host.app.pendingDrops.has(secondId), true);
  f.held[1].resolve();
  await until(() => host.app.pendingDrops.size === 0 && guest.app.remoteDrops.size === 0, "all drop previews hand off to authoritative resources");
  assert.equal(host.$("drag-root").children.length, 0); assert.equal(guest.$("remote-drag-root").children.length, 0);
  assert.equal(host.document.querySelector(".is-drop-source"), null);
  closeTo(room.cards.get(second.id).x, 1260);
  const completed = f.guestLink.events.filter((event) => event.type === "drag-end" && Number.isSafeInteger(event.revision));
  assert.ok(completed.some((event) => event.dragId === firstId));
});

test("a rejected drop rolls back and a lost receipt retries once without resurrecting the old position", async (t) => {
  const f = await fixture(t), { host, guest, room } = f;
  await host.sendCommand({ type: "draw-public", x: 450, y: 400 });
  const card = host.app.state.cards[0];
  f.holdTypes.add("move-card");
  await drag(host, "card", card, 570, 580);
  await until(() => f.held.length === 1, "move is delayed");
  await guest.sendCommand({ type: "lock-resource", resourceType: "card", resourceId: card.id });
  f.held[0].resolve();
  await until(() => host.app.pendingDrops.size === 0, "rejected move releases the preview");
  assert.equal(room.cards.get(card.id).x, card.x);
  assert.equal(host.$("drag-root").children.length, 0); assert.equal(guest.$("remote-drag-root").children.length, 0);
  assert.equal(host.document.querySelector(".is-drop-source"), null);
  await guest.sendCommand({ type: "lock-resource", resourceType: "card", resourceId: card.id });
  f.holdTypes.clear(); f.link.dropNextReceipt = true;
  const revision = room.revision;
  const dragId = await drag(host, "card", host.app.state.cards[0], 590, 600);
  await until(() => host.recovery.pendingCount === 1 && !host.app.connectionOpen, "missing receipt is queued for recovery");
  assert.equal(room.revision, revision + 1); assert.equal(room.cards.get(card.id).x, 590);
  assert.equal(host.$("drag-root").children.length, 0, "a committed stream update can finish the visual before receipt recovery");
  host.app.connectionOpen = true; host.recovery.retry();
  await until(() => host.recovery.pendingCount === 0 && host.app.pendingDrops.size === 0, "retry confirms the same move");
  assert.equal(room.revision, revision + 1);
  const late = f.sent.find((message) => message.type === "drag-drop" && message.drag.dragId === dragId);
  await f.link.fetch("https://table.example/api/message", { method: "POST", body: JSON.stringify({ roomCode: room.code, sessionToken: host.app.sessionToken, message: late }) });
  assert.equal(guest.$("remote-drag-root").children.length, 0, "a late drop signal cannot resurrect a finished gesture");
});

test("compact chat disables duplicate sends and preserves a newer draft while a message is pending", async (t) => {
  const f = await fixture(t), { host, room } = f, input = host.$("quick-chat-input");
  await host.dispatch(host.$("open-chat"), "click");
  f.holdTypes.add("chat");
  input.value = "第一句"; await host.dispatch(input, "input");
  await host.dispatch(host.$("quick-chat-form"), "submit");
  await until(() => f.held.length === 1, "chat send is pending");
  input.value = "下一句草稿"; await host.dispatch(input, "input");
  await host.dispatch(host.$("quick-chat-form"), "submit");
  assert.equal(f.held.length, 1); assert.equal(host.$("quick-chat-form").querySelector("button").disabled, true);
  f.held[0].resolve();
  await until(() => room.messages.length === 1 && host.app.pendingCommands.size === 0, "first message confirmed");
  assert.equal(input.value, "下一句草稿");
  f.holdTypes.clear();
  input.value = "x".repeat(281); await host.dispatch(input, "input");
  await host.dispatch(host.$("quick-chat-form"), "submit");
  await until(() => host.app.pendingCommands.size === 0, "invalid message rejected");
  assert.equal(input.value, "x".repeat(281), "a rejected message keeps the draft");
  assert.equal(room.messages.length, 1);
});

test("a completion signal waits for its snapshot and delayed cursor signals cannot restore the old card", async () => {
  const client = await loadClient(), card = client.app.state.cards.find((card) => card.zone === "public");
  const message = { playerId: "player_b", name: "朋友", color: "#4388ff", drag: { sourceType: "card", resourceId: card.id, dragId: "ordered-drop", x: 1000, y: 520 } };
  client.context.dropMessage = message;
  client.vm('receiveRoomEvent({ ...dropMessage, type: "drag-drop" })');
  assert.equal(client.$("remote-drag-root").children.length, 1);
  client.vm('receiveRoomEvent({ type: "drag-end", playerId: "player_b", dragId: "ordered-drop", revision: app.state.revision + 1 })');
  client.vm('receiveRoomEvent({ type: "drag-end", playerId: "player_b", dragId: "ordered-drop" })');
  assert.equal(client.$("remote-drag-root").children.length, 1, "an unversioned end cannot overtake the authoritative snapshot");
  const state = plain(client.app.state);
  state.revision++; Object.assign(state.cards.find((item) => item.id === card.id), { x: 1000, y: 520 });
  client.context.nextSnapshot = state; client.vm('receiveRoomEvent(nextSnapshot)');
  assert.equal(client.$("remote-drag-root").children.length, 0);
  assert.equal(client.document.querySelector(`[data-card-id="${card.id}"]`).style.left, "1000px");
  client.vm('receiveRoomEvent({ ...dropMessage, type: "cursor", x: 1000, y: 520 })');
  client.vm('receiveRoomEvent({ ...dropMessage, type: "drag-drop" })');
  assert.equal(client.$("remote-drag-root").children.length, 0);
});
