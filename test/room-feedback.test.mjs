import test from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./helpers/client-dom.mjs";

test("actions and remote chat surface once, remain text-only, and expire without changing the table", async () => {
  const client = await loadClient();
  const { app, $, context, document } = client;
  assert.equal($("room-notices").children.length, 0, "joining must not replay initial history");
  await client.sendCommand({ type: "shuffle" });
  assert.equal($("room-notices").children.length, 1);
  assert.equal($("table-effects").children.length, 1);
  assert.deepEqual(Object.keys(app.state.history.at(-1).effect).sort(), ["type", "x", "y"]);
  const revision = app.state.revision;
  client.vm("renderRoom(); renderRoom();");
  assert.equal($("room-notices").children.length, 1, "SSE and command receipts must not duplicate feedback");
  await client.advanceTimers(900);
  assert.equal($("table-effects").children.length, 0);
  await client.advanceTimers(3400);
  assert.equal($("room-notices").children.length, 0);
  assert.equal(app.state.revision, revision, "animations are local and do not send table mutations");
  context.ParlorEngine.applyCommand(app.previewModel.engineRoom, "player_b", { type: "chat", text: "<img src=x> 出哪张？" });
  client.syncPreviewState("player_a");
  assert.equal($("chat-panel").classList.contains("is-open"), false);
  assert.match($("room-notices").textContent, /客人B.*<img src=x> 出哪张？/);
  assert.equal($("room-notices").querySelector("img"), null);
  await client.dispatch(document.querySelector(".room-notice.is-chat"), "click");
  assert.equal($("chat-panel").classList.contains("is-open"), true);
  assert.equal($("room-notices").children.length, 0);
});

test("history filters by stable player identity across renames, by category and by search", async () => {
  const client = await loadClient();
  const { app, context, $ } = client;
  await client.sendCommand({ type: "draw" });
  context.ParlorEngine.applyCommand(app.previewModel.engineRoom, "player_b", { type: "draw" });
  context.ParlorEngine.applyCommand(app.previewModel.engineRoom, "player_b", { type: "rename-player", name: "小鱼" });
  client.syncPreviewState("player_a");
  $("history-player").value = "player_b";
  await client.dispatch($("history-player"), "change");
  assert.equal($("activity-list").children.length, 2);
  assert.ok($("activity-list").children.every((item) => item.dataset.actorId === "player_b"));
  assert.match($("history-player").textContent, /小鱼/);
  $("history-kind").value = "cards";
  await client.dispatch($("history-kind"), "change");
  assert.equal($("activity-list").children.length, 1);
  assert.match($("activity-list").textContent, /客人B.*抽了一张牌/);
  $("history-search").value = "不存在的操作";
  await client.dispatch($("history-search"), "input");
  assert.match($("activity-list").textContent, /没有符合筛选/);
  assert.equal($("export-history").disabled, true);
  $("history-search").value = ""; $("history-kind").value = "";
  await client.dispatch($("history-search"), "input");
  await client.sendCommand({ type: "roll-die" });
  assert.equal($("history-player").value, "player_b");
  assert.equal($("activity-list").children.length, 2);
  await client.dispatch($("viewport"), "keydown", { key: "l" });
  assert.equal($("history-panel").classList.contains("is-open"), true);
  await client.dispatch($("close-history"), "click");
  assert.equal(client.document.activeElement, $("open-history"));
});

test("nickname edits preserve seat and hand ownership and duplicate names are disambiguated", async () => {
  const client = await loadClient();
  const { app, $, context } = client;
  const before = app.state.cards.filter((card) => card.ownerId === "player_a").map((card) => card.id);
  const undoDepth = app.previewModel.engineRoom.undoStack.length;
  await client.dispatch($("identity-chip"), "click");
  assert.equal($("nickname-editor").hasAttribute("open"), true);
  $("nickname-input").value = "客人B";
  await client.dispatch($("nickname-form"), "submit");
  assert.equal(app.state.you.name, "客人B 2");
  assert.equal($("nickname-editor").hasAttribute("open"), false);
  assert.equal($("presence-select"), null);
  assert.deepEqual(app.state.cards.filter((card) => card.ownerId === "player_a").map((card) => card.id), before);
  assert.equal(app.previewModel.engineRoom.undoStack.length, undoDepth);
  const revision = app.state.revision;
  assert.throws(() => context.ParlorEngine.applyCommand(app.previewModel.engineRoom, "player_a", { type: "rename-player", name: "  " }), { code: "INVALID_NAME" });
  assert.equal(app.previewModel.revision, revision);
});

test("the audit retains 500 entries and never logs private face data or supplied metadata", async () => {
  const client = await loadClient();
  const { app, context } = client;
  const core = context.ParlorEngine, room = app.previewModel.engineRoom;
  const card = [...room.cards.values()].find((card) => card.ownerId === "player_b");
  for (let index = 0; index < 505; index++) core.applyCommand(room, "player_a", { type: "roll-die", label: card.face.label, effect: { face: card.face } });
  const projection = core.projectRoom(room, "player_a");
  assert.equal(projection.history.length, 500);
  assert.ok(projection.history.every((entry) => entry.action === "roll-die" && entry.actorColor === projection.you.color));
  assert.equal(JSON.stringify(projection.history).includes(card.face.label), false);
  assert.ok(projection.history.every((entry) => !entry.effect));
});

test("undo appends an audit event and keeps the original action available for review", async () => {
  const client = await loadClient();
  await client.sendCommand({ type: "draw" });
  const action = client.app.state.history.at(-1);
  await client.sendCommand({ type: "rename-player", name: "新昵称" });
  await client.sendCommand({ type: "undo" });
  assert.equal(client.app.state.history.length, 3);
  assert.equal(client.app.state.history[0].id, action.id);
  assert.equal(client.app.state.history.at(-1).undoOf, action.id);
  assert.equal(client.app.state.you.name, "新昵称");
});

test("UNO numeric, skip, reverse and wild faces use symbols while keeping accessible Chinese labels", async () => {
  const client = await loadClient();
  client.vm(`
    const unoCards = ParlorPacks.find(pack => pack.id === "uno").cards;
    const samples = ["red-0", "red-skip-a", "red-reverse-a", "wild-1", "wild-draw-four-1"];
    for (const key of samples) {
      const face = unoCards.find(card => card.key === key);
      if (!face) throw new Error("Missing fixture " + key);
      const node = makeCardNode({ id: key, face, zone: "public" }, { x: 0, y: 0 });
      document.body.append(node);
    }
  `);
  for (const key of ["red-0", "red-skip-a", "red-reverse-a", "wild-1", "wild-draw-four-1"]) {
    const card = client.document.querySelector(`[data-card-id="${key}"]`);
    assert.doesNotMatch(card.textContent, /SKIP|REV|WILD|W/);
    assert.ok(card.querySelector(".is-symbol-card"));
    assert.match(card.getAttribute("aria-label"), /红色|万能/);
    assert.equal(card.querySelector(".card-caption"), null);
  }
});
