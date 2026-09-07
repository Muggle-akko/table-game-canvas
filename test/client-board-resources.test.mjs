import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { createRoom } from "../src/room-engine.mjs";
import { loadClient } from "./helpers/client-dom.mjs";
import { createLocalStoreDouble } from "./helpers/local-store.mjs";
import { createRoomLink } from "./helpers/room-link.mjs";

const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const plain = (value) => JSON.parse(JSON.stringify(value));
const addSet = async (client, id) => {
  await client.dispatch(client.document.querySelector('[data-category="sets"]'), "click");
  await client.dispatch(client.document.querySelector(`.asset-add[data-add-asset="set:${id}"]`), "click");
};

test("the shelf places all four sets and renders their real boards and individual pieces", async () => {
  const client = await loadClient(), { app, $ } = client;
  const initialTokens = app.state.tokens.length, initialObjects = app.state.objects.length;
  for (const id of ["chess", "xiangqi", "jungle", "aeroplane"]) {
    await addSet(client, id);
    const board = app.state.objects.find((object) => object.resourceId === `board-${id}`);
    assert.equal(app.selection.id, board.id);
    const node = $("objects-root").querySelector(`[data-object-id="${board.id}"]`);
    assert.ok(node.querySelector("svg.board-art"));
  }
  assert.equal(app.state.tokens.length - initialTokens, 96);
  assert.equal(app.state.objects.length - initialObjects, 9);
  assert.equal($("token-root").querySelectorAll(".table-token__face[data-piece-game]").length, 96);
  assert.equal($("objects-root").querySelectorAll('[data-flight-step]').length, 52);
  assert.equal($("objects-root").querySelectorAll('[data-home-step]').length, 24);
  assert.equal($("objects-root").querySelectorAll('[data-airport-slot]').length, 16);
  assert.equal($("objects-root").querySelectorAll('[data-takeoff-side]').length, 4);
  assert.match($("objects-root").textContent, /楚 河/);
  assert.match($("objects-root").textContent, /红方兽穴/);
  const face = $("token-root").querySelector('[data-piece-game="xiangqi"]').textContent;
  assert.ok(/[帅将士仕车马炮兵卒象相]/.test(face));
});

test("guests can fetch single replacement pieces, move freely and retain their appearance when saved", async () => {
  const client = await loadClient(), { app, $, document, dispatch } = client;
  client.switchPreviewRole();
  $("library-search").value = "chess-w-queen"; await dispatch($("library-search"), "input");
  const add = document.querySelector('.asset-add[data-add-asset="chess-w-queen"]');
  assert.equal(add.disabled, false); await dispatch(add, "click");
  const queen = app.state.tokens.at(-1), turn = plain(app.state.turn);
  const node = $("token-root").querySelector(`[data-token-id="${queen.id}"]`);
  const point = (x, y) => ({ clientX: app.camera.x + x * app.camera.scale, clientY: 58 + app.camera.y + y * app.camera.scale });
  await dispatch(node, "pointerdown", point(queen.x + 20, queen.y + 20));
  await dispatch(node, "pointermove", point(1800, 1000));
  assert.ok($("drag-root").querySelector('.piece-glyph'));
  await dispatch(node, "pointerup", point(1800, 1000));
  assert.equal(app.state.tokens.at(-1).x, 1780); assert.deepEqual(plain(app.state.turn), turn);
  assert.equal($("token-root").querySelector(`[data-token-id="${queen.id}"]`), node);
  client.switchPreviewRole();
  client.selectResource("token", queen.id);
  await client.runSelectionAction("resource-save");
  await client.settle();
  const template = app.state.templates.find((item) => item.label === queen.label); assert.ok(template);
  await client.sendCommand({ type: "spawn-template", templateId: template.id, x: 2400, y: 1200 });
  const copy = app.state.tokens.at(-1);
  assert.notEqual(copy.id, queen.id); assert.equal(copy.piece.role, "queen");
  assert.ok($("token-root").querySelector(`[data-token-id="${copy.id}"] .piece-glyph`));
});

test("two projected clients receive one complete set even when its creation receipt is retried", async (t) => {
  const room = createRoom({ code: "SET-123", hostSecret: "test-host", pack });
  const link = createRoomLink(room), peer = link.createPeer();
  const host = await loadClient({ indexedDB: createLocalStoreDouble(), url: `https://table.example/?room=${room.code}&host=${room.hostSecret}`, fetch: link.fetch, EventSource: link.EventSource });
  const guest = await loadClient({ indexedDB: createLocalStoreDouble(), url: `https://table.example/?room=${room.code}&fresh=1&autojoin=朋友`, fetch: peer.fetch, EventSource: peer.EventSource });
  t.after(() => { host.app.eventSource?.close(); guest.app.eventSource?.close(); link.transport.close(); });
  const until = async (predicate) => {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await pause(5);
    assert.ok(predicate());
  };
  await until(() => host.app.connectionOpen && guest.app.connectionOpen);
  peer.dropNextReceipt = true;
  await addSet(guest, "aeroplane");
  await until(() => host.app.state.tokens.length === 16 && guest.app.state.tokens.length === 16);
  const sent = peer.commands.find((message) => message.command.type === "spawn-set"); assert.ok(sent);
  const response = await peer.fetch("https://table.example/api/message", { method: "POST", body: JSON.stringify({ roomCode: room.code, sessionToken: guest.app.sessionToken, message: sent }) });
  const receipt = await response.json();
  assert.ok(response.ok); assert.equal(room.tokens.size, 16); assert.equal(room.objects.size, 3);
  assert.equal(room.history.filter((entry) => entry.action === "spawn-set").length, 1);
  assert.equal(receipt.createdResource.id, host.app.state.objects.find((object) => object.resourceId === "board-aeroplane").id);
  assert.deepEqual(plain(host.app.state.tokens), plain(guest.app.state.tokens));
});
