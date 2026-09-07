import test from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./helpers/client-dom.mjs";

function holdSpawns(client) {
  client.vm(`
    globalThis.originalPreview = ParlorPreview;
    globalThis.heldSpawns = [];
    globalThis.ParlorPreview = { ...ParlorPreview, applyCommand(model, viewer, command, options) {
      if (options?.withReceipt && ["add-pack", "spawn-resource", "spawn-set"].includes(command.type)) {
        return new Promise((resolve, reject) => heldSpawns.push({
          command, resolve: () => resolve(originalPreview.applyCommand(model, viewer, command, options)), reject
        }));
      }
      return originalPreview.applyCommand(model, viewer, command, options);
    }};
  `);
}

async function release(client, fail = false) {
  client.vm(fail ? 'heldSpawns.shift().reject(new Error("暂时没有取到"))' : "heldSpawns.shift().resolve()");
  await client.settle();
}

test("library queues rapid takes, reserves separate positions, and preserves its pending button", async () => {
  const client = await loadClient();
  holdSpawns(client);
  await client.dispatch(client.$("open-library"), "click");
  const button = client.document.querySelector('.asset-add[data-add-asset="pack:uno"]');
  for (let index = 0; index < 3; index++) await client.dispatch(button, "click");
  assert.equal(client.context.heldSpawns.length, 1, "only one request is in flight");
  assert.equal(button.dataset.pendingCount, "3");
  assert.equal(button.disabled, false);
  for (let index = 0; index < 3; index++) await release(client);
  const added = client.app.state.decks.filter((deck) => deck.id !== "main");
  assert.equal(added.length, 3);
  assert.equal(new Set(added.map((deck) => `${deck.x},${deck.y}`)).size, 3);
  assert.equal(client.app.selection.id, added.at(-1).id);
  assert.equal(button.dataset.pendingCount, undefined);
  assert.equal(client.document.querySelector('.asset-add[data-add-asset="pack:uno"]'), button);
});

test("an intervening remote spawn cannot become the local request's selection", async () => {
  const client = await loadClient();
  holdSpawns(client);
  await client.dispatch(client.$("open-library"), "click");
  await client.dispatch(client.document.querySelector('.asset-add[data-add-asset="note"]'), "click");
  client.vm('originalPreview.applyCommand(app.previewModel, "player_b", { type: "spawn-resource", resourceId: "die-d20", x: 900, y: 400 })');
  client.syncPreviewState();
  assert.equal(client.app.selection, null);
  await release(client);
  const selected = client.app.state.objects.find((object) => object.id === client.app.selection.id);
  assert.equal(selected.kind, "note");
  assert.equal(selected.id, client.app.state.objects.at(-1).id);
});

test("late resource receipts respect a newer selection and an open mobile chat composer", async () => {
  const client = await loadClient({ width: 390, height: 844 });
  holdSpawns(client);
  await client.dispatch(client.$("open-library"), "click");
  await client.dispatch(client.document.querySelector('.asset-add[data-add-asset="pack:uno"]'), "click");
  client.selectResource("deck", "main");
  await client.dispatch(client.$("open-chat"), "click");
  await release(client);
  assert.equal(client.app.selection.id, "main");
  assert.equal(client.$("quick-chat").classList.contains("is-hidden"), false);
  assert.equal(client.$("chat-panel").classList.contains("is-open"), false);
  assert.equal(client.document.activeElement, client.$("quick-chat-input"));
  assert.equal(client.app.state.decks.length, 2);
  await client.dispatch(client.$("close-quick-chat"), "click");
  await client.dispatch(client.document.querySelector('.asset-add[data-add-asset="note"]'), "click");
  await client.dispatch(client.$("open-chat"), "click");
  await release(client);
  assert.equal(client.app.selection.id, "main", "opening chat alone must keep a late receipt from selecting its resource");
  assert.equal(client.document.activeElement, client.$("quick-chat-input"));
});

test("failed requests clear their pending quantity and do not strand later requests", async () => {
  const client = await loadClient();
  holdSpawns(client);
  await client.dispatch(client.$("open-library"), "click");
  const button = client.document.querySelector('.asset-add[data-add-asset="pack:uno"]');
  await client.dispatch(button, "click");
  await client.dispatch(button, "click");
  await release(client, true);
  assert.equal(button.dataset.pendingCount, "1");
  assert.equal(client.context.heldSpawns.length, 1);
  await release(client);
  assert.equal(client.app.state.decks.length, 2);
  assert.equal(button.dataset.pendingCount, undefined);
  assert.equal(client.app.pendingCommands.size, 0);
});

test("identity changes cancel unsent resource takes and never restore the prior private projection", async () => {
  const client = await loadClient();
  holdSpawns(client);
  await client.dispatch(client.$("open-library"), "click");
  const button = client.document.querySelector('.asset-add[data-add-asset="pack:uno"]');
  await client.dispatch(button, "click");
  await client.dispatch(button, "click");
  client.switchPreviewRole();
  await release(client);
  assert.equal(client.app.state.you.id, "player_b");
  assert.ok(client.app.state.cards.filter((card) => card.ownerId === "player_a" && card.zone === "hand").every((card) => card.face === null));
  assert.equal(client.app.previewModel.engineRoom.decks.size, 2, "the already sent take may finish; the unsent one is cancelled");
  assert.equal(client.context.heldSpawns.length, 0);
  assert.equal(client.document.querySelector('.asset-add[data-add-asset="pack:uno"]').dataset.pendingCount, undefined);
  assert.equal(client.app.selection, null);
});

test("queued sets reserve their full footprint through failures and clear the pending quantity", async () => {
  const client = await loadClient(); holdSpawns(client);
  await client.dispatch(client.$("open-library"), "click");
  const button = client.document.querySelector('.asset-add[data-add-asset="set:chess"]');
  for (let index = 0; index < 3; index++) await client.dispatch(button, "click");
  assert.equal(button.dataset.pendingCount, "3"); assert.equal(client.context.heldSpawns.length, 1);
  await release(client, true); await release(client); await release(client);
  const boards = client.app.state.objects.filter((object) => object.resourceId === "board-chess");
  assert.equal(boards.length, 2);
  const [a, b] = boards, set = client.context.ParlorEngine.BOARD_GAME_SETS.find((set) => set.id === "chess");
  assert.ok(a.x + set.width <= b.x || b.x + set.width <= a.x || a.y + set.height <= b.y || b.y + set.height <= a.y, "boards and guides never overlap each other");
  assert.equal(button.dataset.pendingCount, undefined);
  assert.equal(client.document.querySelector('.asset-add[data-add-asset="set:chess"]'), button);
  assert.equal(client.app.selection.id, b.id);
});

test("late set receipts do not take over camera navigation or an already-open chat input", async () => {
  for (const action of ["zoom", "return-to-view", "chat"]) {
    const client = await loadClient(); holdSpawns(client);
    if (action === "chat") await client.dispatch(client.$("open-chat"), "click");
    await client.dispatch(client.$("open-library"), "click");
    const button = client.document.querySelector('.asset-add[data-add-asset="set:aeroplane"]'); button.focus();
    await client.dispatch(button, "click");
    const initial = { ...client.app.camera };
    if (action === "chat") {
      client.$("quick-chat-input").focus();
      await client.advanceTimers(50);
      assert.equal(client.document.activeElement, client.$("quick-chat-input"), "the library's opening timer cannot steal an intervening chat focus");
    }
    else {
      await client.dispatch(client.$("zoom-in"), "click");
      if (action === "return-to-view") client.vm(`app.camera = ${JSON.stringify(initial)}; applyCamera();`);
    }
    const camera = { ...client.app.camera };
    await release(client);
    assert.deepEqual({ ...client.app.camera }, camera, action);
    assert.equal(client.$("library-panel").classList.contains("is-open"), true);
    assert.ok(client.app.state.objects.some((object) => object.resourceId === "board-aeroplane"));
    if (action === "chat") {
      assert.equal(client.document.activeElement, client.$("quick-chat-input"));
      assert.equal(client.app.selection, null);
    }
  }
});
