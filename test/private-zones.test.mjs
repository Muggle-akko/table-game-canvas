import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as server from "../src/room-engine.mjs";
import { loadPreviewEngine } from "./helpers/preview.mjs";
import { loadClient } from "./helpers/client-dom.mjs";

const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const { core: browser } = await loadPreviewEngine();
const plain = (value) => JSON.parse(JSON.stringify(value));
for (const [mode, core] of [["server", server], ["browser", browser]]) {
  const setup = () => {
    const room = core.createRoom({ code: "PRIVATE", pack, hostSecret: "host" });
    const host = core.joinRoom(room, { hostSecret: "host" }).player;
    const guest = core.joinRoom(room, { displayName: "朋友" }).player;
    const command = (value, player = host) => core.applyCommand(room, player.id, value);
    const state = (player = host) => core.projectRoom(room, player.id);
    return { room, host, guest, command, state };
  };

  test(`${mode}: private cards keep free positions and rotation as players join, draw and reconnect`, () => {
    const { room, host, guest, command, state } = setup();
    command({ type: "draw" }, guest);
    const card = state(guest).cards[0], zone = state(guest).players.find((player) => player.id === guest.id).privateZone;
    command({ type: "move-card", cardId: card.id, target: "hand", x: zone.x + 220, y: zone.y + 125, rotation: 37 }, guest);
    const positioned = state(guest).cards[0];
    assert.equal(positioned.x, zone.x + 220); assert.equal(positioned.y, zone.y + 125); assert.equal(positioned.rotation, 37);
    assert.equal(positioned.handOrder, card.handOrder);
    assert.equal(state(host).cards[0].face, null);
    core.joinRoom(room, { displayName: "第三人" }); command({ type: "draw" }, guest);
    assert.deepEqual(plain(state(guest).cards.find((item) => item.id === card.id)), plain(positioned));
    assert.deepEqual(plain(state().players.find((player) => player.id === guest.id).privateZone), plain(zone));
    const before = JSON.stringify(state(guest).cards);
    assert.throws(() => command({ type: "move-card", cardId: card.id, target: "hand", ownerId: host.id, x: NaN, y: 1 }), { code: "INVALID_DROP" });
    assert.equal(JSON.stringify(state(guest).cards), before);
    const last = [...room.sessions].find(([, id]) => id === guest.id)[0];
    assert.equal(core.joinRoom(room, { resumeToken: last }).player.id, guest.id);
    assert.equal(JSON.stringify(state(guest).cards), before);
  });

  test(`${mode}: requesting several private cards is ephemeral and only their owner can deliver atomically`, () => {
    const { room, host, guest, command, state } = setup();
    command({ type: "deal-each", count: 2 });
    const cards = state(guest).cards.filter((card) => card.ownerId === guest.id);
    const revision = room.revision, undo = room.undoStack.length;
    const request = core.requestPrivateCards(room, host.id, cards.map((card) => card.id));
    assert.equal(request.expiresAt - request.at, 8000);
    assert.equal(request.color, host.color);
    assert.equal(room.revision, revision); assert.equal(room.undoStack.length, undo);
    for (const card of cards) assert.equal(JSON.stringify(request).includes(card.face.label), false);
    assert.throws(() => command({ type: "accept-card-request", requestId: request.id }), { code: "NO_CONTROL" });
    assert.equal(room.revision, revision);
    command({ type: "accept-card-request", requestId: request.id }, guest);
    assert.equal(room.undoStack.length, undo + 1);
    assert.ok(state().cards.filter((card) => request.cardIds.includes(card.id)).every((card) => card.ownerId === host.id && card.face));
    assert.ok(state(guest).cards.filter((card) => request.cardIds.includes(card.id)).every((card) => card.face === null));
    assert.equal(room.cardRequests.size, 0);
    command({ type: "undo" });
    assert.ok(state(guest).cards.filter((card) => request.cardIds.includes(card.id)).every((card) => card.ownerId === guest.id && card.face));
  });

  test(`${mode}: expired, mixed-owner and locked requests cannot partially transfer cards`, () => {
    const { room, host, guest, command, state } = setup();
    command({ type: "deal-each", count: 2 });
    const cards = state(guest).cards.filter((card) => card.ownerId === guest.id);
    const own = state().cards.find((card) => card.ownerId === host.id);
    assert.throws(() => core.requestPrivateCards(room, host.id, [cards[0].id, own.id]), { code: "INVALID_CARD_REQUEST" });
    const expired = core.requestPrivateCards(room, host.id, cards.map((card) => card.id), Date.now() - 9000);
    assert.throws(() => command({ type: "accept-card-request", requestId: expired.id }, guest), { code: "REQUEST_EXPIRED" });
    const request = core.requestPrivateCards(room, host.id, cards.map((card) => card.id));
    command({ type: "lock-resource", resourceType: "card", resourceId: cards[1].id }, guest);
    const before = JSON.stringify(state(guest).cards), revision = room.revision;
    assert.throws(() => command({ type: "accept-card-request", requestId: request.id }, guest), { code: "RESOURCE_LOCKED" });
    assert.equal(JSON.stringify(state(guest).cards), before); assert.equal(room.revision, revision);
    core.cancelPrivateCardRequest(room, host.id); assert.equal(room.cardRequests.size, 0);
  });
}

const pointer = (client, x, y) => ({ clientX: client.app.camera.x + x * client.app.camera.scale, clientY: 58 + client.app.camera.y + y * client.app.camera.scale });
test("dragging and rotating within the private zone retains privacy and new cards leave the layout alone", async () => {
  const client = await loadClient(), { app, document, dispatch } = client;
  const card = app.state.cards.find((card) => card.ownerId === "player_a" && card.zone === "hand");
  const zone = app.handLayouts.get("player_a");
  const node = document.querySelector(`#cards-root [data-card-id="${card.id}"]`);
  await dispatch(node, "pointerdown", pointer(client, card.x + 10, card.y + 10));
  await dispatch(node, "pointermove", pointer(client, zone.x + 280, zone.y + 150));
  await dispatch(node, "pointerup", pointer(client, zone.x + 280, zone.y + 150));
  const moved = app.state.cards.find((item) => item.id === card.id);
  assert.equal(moved.zone, "hand"); assert.ok(Math.abs(moved.x - (zone.x + 270)) < .001);
  const x = moved.x, y = moved.y;
  await dispatch(node, "keydown", { key: "e" });
  assert.equal(app.state.cards.find((item) => item.id === card.id).rotation, 15);
  assert.equal(app.state.cards.find((item) => item.id === card.id).zone, "hand", "rotation must not reveal a private card");
  await client.sendCommand({ type: "draw" });
  assert.equal(app.state.cards.find((item) => item.id === card.id).x, x);
  assert.equal(app.state.cards.find((item) => item.id === card.id).y, y);
  client.switchPreviewRole();
  assert.equal(document.querySelector(`#cards-root [data-card-id="${card.id}"] .card-face`), null);
});

test("clicking a friend's cards highlights multiple backs, offers delivery, and clears after eight seconds", async () => {
  const client = await loadClient(), { app, document, dispatch, $ } = client;
  await client.sendCommand({ type: "draw", ownerId: "player_b" });
  const cards = app.state.cards.filter((card) => card.ownerId === "player_b" && card.zone === "hand");
  const revision = app.state.revision;
  for (const card of cards) await dispatch(document.querySelector(`#cards-root [data-card-id="${card.id}"]`), "pointerdown", pointer(client, card.x + 20, card.y + 20));
  assert.equal(app.drag, null);
  assert.equal(app.state.revision, revision);
  assert.equal(document.querySelectorAll("#cards-root .is-requested-card").length, 2);
  for (const card of cards) assert.equal(document.querySelector(`#cards-root [data-card-id="${card.id}"]`).style["--request-color"], app.state.you.color);
  client.switchPreviewRole();
  assert.match($("room-notices").textContent, /房主A 想选 2 张牌/);
  await dispatch(document.querySelector(".card-request-accept"), "click");
  assert.ok(cards.every((card) => app.state.cards.find((item) => item.id === card.id).ownerId === "player_a"));
  assert.equal(document.querySelectorAll(".is-requested-card").length, 0);
  const target = app.state.cards.find((card) => card.zone === "hand" && card.ownerId === "player_a");
  await dispatch(document.querySelector(`#cards-root [data-card-id="${target.id}"]`), "pointerdown", pointer(client, target.x + 20, target.y + 20));
  assert.ok(document.querySelectorAll(".is-requested-card").length > 0);
  await client.advanceTimers(8100);
  assert.equal(document.querySelectorAll(".is-requested-card").length, 0);
});

test("remote drag positions reuse DOM and render only the viewer's allowed card face", async () => {
  const client = await loadClient();
  client.vm(`
    const privateCard = app.state.cards.find(card => card.ownerId === "player_b");
    app.remoteDrags.set("player_b", { sourceType: "card", resourceId: privateCard.id, playerId: "player_b", color: "#4388ff", name: "朋友", x: 700, y: 400 });
    renderRemoteDrags();
  `);
  const node = client.$("remote-drag-root").firstElementChild;
  assert.equal(node.querySelector(".card-face"), null);
  client.vm('app.remoteDrags.get("player_b").x = 950; renderRemoteDrags();');
  assert.equal(client.$("remote-drag-root").firstElementChild, node);
  assert.match(node.style.transform, /950px/);
  client.vm('app.remoteDrags.clear(); renderRemoteDrags();');
  assert.equal(client.$("remote-drag-root").children.length, 0);
});
