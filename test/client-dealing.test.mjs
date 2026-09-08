import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { createRoom } from "../src/room-engine.mjs";
import { loadClient } from "./helpers/client-dom.mjs";
import { createLocalStoreDouble } from "./helpers/local-store.mjs";
import { createRoomLink } from "./helpers/room-link.mjs";

// These use the production dialog handlers and room protocol. Native dialog
// focus, layout and hit-testing are verified separately in the isolated room.
const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const plain = (value) => JSON.parse(JSON.stringify(value));
const recipient = (client, id) => client.document.querySelector(`[data-deal-player="${id}"]`);
const action = (client, name) => client.document.querySelector(`[data-selection-action="${name}"]`);
const choice = (client, name, value) => client.dispatch(client.document.querySelector(`[data-deal-${name}="${value}"]`), "click");
async function check(client, input, value) { input.checked = value; await client.dispatch(input, "change"); }
async function amount(client, value) { client.$("deal-count").value = value; await client.dispatch(client.$("deal-count"), "input"); }
async function open(client) { client.selectResource("deck", "main"); const button = action(client, "deal-cards"); button.focus(); await client.dispatch(button, "click"); }
async function until(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await pause(5);
  assert.ok(predicate(), message);
}

test("the deal dialog calculates fixed and equal shares, reports invalid input, and cancels without changing cards", async () => {
  const client = await loadClient(), { $, app, document, dispatch } = client;
  const revision = app.state.revision;
  await open(client);
  assert.ok($("deal-dialog").hasAttribute("open")); assert.equal($("deal-recipient-count").textContent, "已选 2 / 2 人");
  assert.match($("deal-recipients").textContent, /手牌 1 张/); assert.equal($("deal-recipients").textContent.includes("undefined"), false);
  assert.equal($("deal-random").checked, true);
  assert.equal($("deal-each").textContent, "1 张"); assert.equal($("deal-total").textContent, "2 张"); assert.equal($("deal-remaining").textContent, "49 张");
  await choice(client, "count", "5"); assert.equal($("deal-count").value, "5"); assert.equal($("deal-total").textContent, "10 张");
  await choice(client, "step", "1"); assert.equal($("deal-count").value, "6");
  await choice(client, "step", "-1"); assert.equal($("deal-count").value, "5");
  await check(client, recipient(client, "player_a"), false);
  assert.equal($("deal-total").textContent, "5 张"); assert.equal($("deal-remaining").textContent, "46 张");
  for (const value of ["", "0", "1.5", "-1", "52"]) {
    await amount(client, value); assert.equal($("deal-submit").disabled, true); assert.ok($("deal-status").textContent);
  }
  await choice(client, "select", "none"); assert.match($("deal-status").textContent, /至少选择/);
  await choice(client, "select", "all"); await choice(client, "mode", "equal");
  assert.equal($("deal-count").disabled, true); assert.equal($("deal-quantity").classList.contains("is-hidden"), true);
  assert.equal($("deal-each").textContent, "25 张"); assert.equal($("deal-total").textContent, "50 张"); assert.equal($("deal-remaining").textContent, "1 张");
  await check(client, $("deal-remainder"), true);
  assert.equal($("deal-each").textContent, "25–26 张"); assert.equal($("deal-total").textContent, "51 张"); assert.equal($("deal-remaining").textContent, "0 张");
  assert.match($("deal-status").textContent, /随机 1 人/);
  const camera = plain(app.camera), intent = app.selectionIntent;
  await dispatch($("deal-cancel"), "keydown", { key: "Tab" });
  assert.equal(app.selectionIntent, intent); assert.deepEqual(plain(app.camera), camera);
  const cancelled = await dispatch($("deal-dialog"), "cancel"); assert.equal(cancelled.defaultPrevented, true);
  assert.equal($("deal-dialog").hasAttribute("open"), false); assert.equal(app.state.revision, revision);
  assert.equal(document.activeElement, action(client, "deal-cards"));
});

test("online defaults and common tools work for guests, and a local deal stays private with one visible actor entry", async () => {
  const client = await loadClient(), { $, app, dispatch } = client;
  app.previewModel.engineRoom.players.get("player_a").connections = 0;
  client.switchPreviewRole();
  await dispatch($("open-tools"), "click"); $("deal-cards").focus(); await dispatch($("deal-cards"), "click");
  assert.equal(recipient(client, "player_a").checked, false); assert.equal(recipient(client, "player_b").checked, true);
  await choice(client, "select", "all"); assert.equal(recipient(client, "player_a").checked, true);
  await choice(client, "select", "online"); assert.equal(recipient(client, "player_a").checked, false);
  await dispatch($("deal-cancel"), "click"); assert.equal(client.document.activeElement, $("open-tools"));
  await dispatch($("deal-cards"), "click"); await choice(client, "count", "5");
  const history = app.state.history.length, undo = app.previewModel.engineRoom.undoStack.length;
  await dispatch($("deal-form"), "submit");
  assert.equal($("deal-dialog").hasAttribute("open"), false);
  assert.equal(app.state.cards.filter((card) => card.ownerId === "player_b" && card.zone === "hand").length, 6);
  assert.equal(app.state.history.length, history + 1); assert.equal(app.previewModel.engineRoom.undoStack.length, undo + 1);
  assert.equal(app.state.history.at(-1).actorName, "客人B"); assert.match(app.state.history.at(-1).label, /客人B 5 张；余 46 张/);
  assert.equal(app.state.decks[0].count, 46);
  client.switchPreviewRole();
  assert.ok(app.state.cards.filter((card) => card.ownerId === "player_b").every((card) => card.face === null));
  await client.sendCommand({ type: "undo" }); assert.equal(app.state.decks[0].count, 51);
});

test("public piles and card-only bulk selections deal their own sources, respecting public locks and locked deck positions", async () => {
  const client = await loadClient(), { $, app, dispatch } = client;
  const card = app.state.cards.find((card) => card.zone === "public");
  await client.sendCommand({ type: "draw-public", x: card.x, y: card.y, faceUp: true });
  const cards = app.state.cards.filter((card) => card.zone === "public");
  client.selectResource("card", cards.at(-1).id); await dispatch(action(client, "deal-cards"), "click");
  assert.match($("deal-source").textContent, /公共牌堆 · 剩 2 张/);
  await choice(client, "select", "none"); await check(client, recipient(client, "player_b"), true);
  await check(client, $("deal-random"), false);
  const remainingId = cards[0].id, deckCount = app.state.decks[0].count;
  await dispatch($("deal-form"), "submit");
  assert.equal(app.state.decks[0].count, deckCount); assert.equal(app.selection.id, remainingId);
  assert.equal(app.state.cards.find((entry) => entry.id === remainingId).faceUp, true);
  await client.sendCommand({ type: "lock-resource", resourceType: "deck", resourceId: "main" });
  client.vm(`setGroupSelection(${JSON.stringify([{ type: "deck", id: "main" }, { type: "card", id: remainingId }])})`);
  assert.equal(action(client, "deal-cards").disabled, false);
  await client.sendCommand({ type: "lock-resource", resourceType: "card", resourceId: remainingId });
  assert.equal(action(client, "deal-cards").disabled, true);
  await client.sendCommand({ type: "lock-resource", resourceType: "card", resourceId: remainingId });
  await dispatch(action(client, "deal-cards"), "click"); await amount(client, "2");
  await dispatch($("deal-form"), "submit"); assert.equal(app.pendingCommands.size, 0);
  assert.equal(app.state.cards.filter((entry) => entry.zone === "hand").length, 7);
});

test("switching the preview identity closes an open deal draft", async () => {
  const client = await loadClient(); await open(client);
  client.switchPreviewRole();
  assert.equal(client.$("deal-dialog").hasAttribute("open"), false);
});

async function fixture(t) {
  const room = createRoom({ code: "DIA-020", hostSecret: "test-host", pack, randomizeDeck: false });
  const link = createRoomLink(room), indexedDB = createLocalStoreDouble(), storage = new Map();
  const f = { room, link, indexedDB, storage, clients: [], hold: false, held: [] };
  f.fetch = async (url, options = {}) => {
    const message = options.body ? JSON.parse(options.body).message : null;
    if (f.hold && message?.type === "command" && message.command.type === "deal-resources") await new Promise((resolve) => f.held.push(resolve));
    return link.fetch(url, options);
  };
  f.host = await loadClient({ indexedDB, storage, url: `https://table.example/?room=${room.code}&host=${room.hostSecret}`, fetch: f.fetch, EventSource: link.EventSource });
  f.clients.push(f.host); await until(() => f.host.app.connectionOpen, "host joined");
  f.addGuest = async (name) => {
    const peer = link.createPeer();
    const client = await loadClient({ indexedDB: createLocalStoreDouble(), url: `https://table.example/?room=${room.code}&fresh=1&autojoin=${encodeURIComponent(name)}`, fetch: peer.fetch, EventSource: peer.EventSource });
    f.clients.push(client); await until(() => client.app.connectionOpen, "guest joined"); return { client, peer };
  };
  const guest = await f.addGuest("朋友"); f.guest = guest.client; f.guestLink = guest.peer;
  t.after(() => { for (const client of f.clients) { client.app.closingStream = true; client.app.connectionOpen = false; client.app.eventSource?.close(); } f.held.forEach((resolve) => resolve()); link.transport.close(); });
  return f;
}

test("live source and participant updates retain the typed amount, checkbox nodes and deliberate recipients", async (t) => {
  const f = await fixture(t), { host, guest } = f;
  await open(host); await amount(host, "12"); host.$("deal-count").focus();
  const checkbox = recipient(host, guest.app.state.you.id);
  await guest.sendCommand({ type: "draw" });
  assert.equal(host.$("deal-count").value, "12"); assert.equal(host.document.activeElement, host.$("deal-count"));
  assert.equal(recipient(host, guest.app.state.you.id), checkbox);
  assert.match(checkbox.parentElement.textContent, /手牌 1 张/); assert.match(host.$("deal-source").textContent, /53 张/);
  assert.equal(host.$("deal-total").textContent, "24 张"); assert.equal(host.$("deal-remaining").textContent, "29 张");
  const { client: arrival } = await f.addGuest("新朋友");
  assert.equal(recipient(host, arrival.app.state.you.id).checked, false, "new arrivals must not silently receive cards");
  assert.equal(checkbox.checked, true); assert.equal(host.$("deal-recipient-count").textContent, "已选 2 / 3 人");
  await f.guestLink.fetch("https://table.example/api/message", { method: "POST", body: JSON.stringify({ roomCode: f.room.code, sessionToken: guest.app.sessionToken,
    message: { type: "command", command: { type: "leave-seat" } } }) });
  assert.equal(recipient(host, guest.app.state?.you.id || ""), null);
  assert.equal(host.$("deal-recipient-count").textContent, "已选 1 / 2 人"); assert.match(host.$("deal-status").textContent, /离席/);
  assert.equal(host.$("deal-count").value, "12");
});

test("a changed pile rejects the entire pending deal, then the same dialog can retry the new count", async (t) => {
  const f = await fixture(t), { host, guest, room } = f;
  await open(host); await amount(host, "5"); f.hold = true;
  const submission = host.dispatch(host.$("deal-form"), "submit");
  await until(() => f.held.length === 1, "deal waits for the server");
  assert.equal(host.$("deal-submit").disabled, true); assert.equal(host.$("draw-card").disabled, true);
  assert.equal(host.$("deal-count").disabled, true); assert.equal(recipient(host, guest.app.state.you.id).disabled, true);
  await host.dispatch(host.$("deal-form"), "submit"); assert.equal(f.held.length, 1);
  await guest.sendCommand({ type: "draw" });
  assert.equal(host.$("deal-total").textContent, "10 张", "the pending plan remains stable");
  const revision = room.revision; f.hold = false; f.held[0](); await submission;
  assert.equal(room.revision, revision); assert.equal(host.$("deal-dialog").hasAttribute("open"), true);
  assert.equal(host.$("deal-submit").disabled, false); assert.match(host.$("deal-status").textContent, /变化/);
  assert.equal(host.$("deal-count").value, "5"); assert.equal(host.$("deal-remaining").textContent, "43 张");
  await host.dispatch(host.$("deal-form"), "submit");
  assert.equal(room.deckOrder.length, 43); assert.equal(host.$("deal-dialog").hasAttribute("open"), false);
  assert.equal(room.history.filter((entry) => entry.label.includes("发牌：")).length, 1);
});

test("closing a pending deal and typing chat keeps focus when a lost receipt is retried", async (t) => {
  const f = await fixture(t), { host, room } = f;
  await host.dispatch(host.$("open-chat"), "click");
  await open(host); f.hold = true;
  const submission = host.dispatch(host.$("deal-form"), "submit");
  await until(() => f.held.length === 1, "deal is pending");
  assert.equal(host.$("deal-cancel").textContent, "收起");
  await host.dispatch(host.$("deal-cancel"), "click");
  host.$("quick-chat-input").value = "先等等"; host.$("quick-chat-input").focus();
  const revision = room.revision;
  f.hold = false; f.link.dropNextReceipt = true; f.held[0]();
  await until(() => host.recovery.pendingCount === 1 && !host.app.connectionOpen, "deal committed but its receipt was lost");
  assert.equal(room.deckOrder.length, 52); assert.ok(host.app.pendingCommands.has("drop:deck:main"));
  host.app.connectionOpen = true; host.recovery.retry(); await submission;
  assert.equal(room.revision, revision + 1); assert.equal(host.app.pendingCommands.size, 0);
  assert.equal(host.$("deal-dialog").hasAttribute("open"), false);
  assert.equal(host.document.activeElement, host.$("quick-chat-input")); assert.equal(host.$("quick-chat-input").value, "先等等");
  assert.equal(room.history.filter((entry) => entry.label.includes("发牌：")).length, 1);
});

test("a pending deal survives refresh with the source protected and a single allocation", async (t) => {
  const f = await fixture(t), { host, room } = f;
  await open(host); f.hold = true;
  const submission = host.dispatch(host.$("deal-form"), "submit");
  await until(() => f.held.length === 1, "first deal is waiting");
  host.app.closingStream = true; host.app.eventSource.close(); host.app.connectionOpen = false;
  const reloaded = await loadClient({ indexedDB: f.indexedDB, storage: f.storage, url: `https://table.example/?room=${room.code}`, fetch: f.fetch, EventSource: f.link.EventSource });
  f.clients.push(reloaded);
  await until(() => reloaded.recovery.pendingCount === 1 && f.held.length === 2, "saved deal resumes");
  assert.ok(reloaded.app.pendingCommands.has("drop:deck:main")); assert.equal(reloaded.$("deal-cards").disabled, true);
  assert.equal(reloaded.$("draw-card").disabled, true);
  const revision = room.revision; f.hold = false; f.held.forEach((resolve) => resolve());
  await submission; await until(() => reloaded.recovery.pendingCount === 0, "both receipts confirm the original deal");
  assert.equal(room.revision, revision + 1); assert.equal(room.deckOrder.length, 52); assert.equal(reloaded.app.pendingCommands.size, 0);
});
