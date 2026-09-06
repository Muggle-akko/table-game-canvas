import test from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./helpers/client-dom.mjs";

const touch = (pointerId, clientX, clientY) => ({ pointerId, clientX, clientY, pointerType: "touch", isPrimary: pointerId === 1 });
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} should be close to ${expected}`);
const mobileClient = () => loadClient({ width: 390, height: 844 });

test("two fingers navigate around their world anchor, switch fingers without jumps, and never play a card", async () => {
  const { app, document, dispatch, $ } = await mobileClient();
  const deck = document.querySelector('[data-deck-id="main"]');
  const revision = app.state.revision;
  const start = { ...app.camera };
  await dispatch(deck, "pointerdown", touch(1, 100, 300));
  await dispatch(deck, "pointermove", touch(1, 112, 304));
  assert.equal(app.drag.activated, true);
  await dispatch($("viewport"), "pointerdown", touch(2, 252, 304));
  assert.equal(app.drag, null, "a second finger cancels the pending object move");
  assert.equal($("drag-root").children.length, 0);
  assert.equal(deck.classList.contains("is-source"), false);

  const anchor = { x: (182 - start.x) / start.scale, y: (304 - 58 - start.y) / start.scale };
  await dispatch($("viewport"), "pointermove", touch(1, 80, 314));
  await dispatch($("viewport"), "pointermove", touch(2, 284, 334));
  closeTo(app.camera.scale, start.scale * Math.hypot(204, 20) / 140);
  closeTo((182 - app.camera.x) / app.camera.scale, anchor.x);
  closeTo((324 - 58 - app.camera.y) / app.camera.scale, anchor.y);

  const beforeThird = { ...app.camera };
  await dispatch($("viewport"), "pointerdown", touch(3, 190, 550));
  await dispatch($("viewport"), "pointermove", touch(3, 210, 560));
  for (const key of ["x", "y", "scale"]) closeTo(app.camera[key], beforeThird[key]);
  await dispatch($("viewport"), "pointerup", touch(1, 80, 314));
  await dispatch($("viewport"), "pointerup", touch(3, 210, 560));
  for (const key of ["x", "y", "scale"]) closeTo(app.camera[key], beforeThird[key]);
  await dispatch($("viewport"), "pointermove", touch(2, 304, 344));
  closeTo(app.camera.x, beforeThird.x + 20);
  closeTo(app.camera.y, beforeThird.y + 10);
  closeTo(app.camera.scale, beforeThird.scale);
  await dispatch($("viewport"), "pointerup", touch(2, 304, 344));
  assert.equal(app.touchNavigation, null);
  assert.equal(app.tableTouches.size, 0);
  await dispatch(deck, "dblclick", { detail: 2 });
  assert.equal(app.state.revision, revision, "pinch completion cannot synthesize a draw or move");
});

test("camera touch cancellation clears gestures and leaves the next pan usable", async () => {
  for (const ending of ["escape", "blur", "capture-loss", "pointer-cancel"]) {
    const { app, document, dispatch, $ } = await mobileClient();
    const viewport = $("viewport"), revision = app.state.revision;
    await dispatch(viewport, "pointerdown", touch(1, 70, 240));
    await dispatch(viewport, "pointerdown", touch(2, 170, 240));
    await dispatch(viewport, "pointermove", touch(2, 270, 250));
    const beforeCancel = { ...app.camera };
    if (ending === "escape") await dispatch(document.body, "keydown", { key: "Escape" });
    else if (ending === "blur") await dispatch(document.body, "blur");
    else if (ending === "capture-loss") await dispatch(viewport, "lostpointercapture", touch(1, 70, 240));
    else {
      await dispatch(viewport, "pointercancel", touch(1, 70, 240));
      await dispatch(viewport, "pointercancel", touch(2, 270, 250));
    }
    await dispatch(viewport, "pointermove", touch(2, 320, 280));
    await dispatch(viewport, "pointerup", touch(2, 320, 280));
    assert.equal(app.touchNavigation, null, ending);
    assert.equal(app.tableTouches.size, 0, ending);
    assert.equal(app.pan, null, ending);
    assert.equal(app.drag, null, ending);
    assert.equal(viewport.classList.contains("is-panning"), false, ending);
    for (const key of ["x", "y", "scale"]) closeTo(app.camera[key], beforeCancel[key]);
    await dispatch(viewport, "pointerdown", touch(1, 60, 350));
    await dispatch(viewport, "pointermove", touch(1, 90, 360));
    await dispatch(viewport, "pointerup", touch(1, 90, 360));
    closeTo(app.camera.x, beforeCancel.x + 30);
    closeTo(app.camera.y, beforeCancel.y + 10);
    assert.equal(app.state.revision, revision, ending);
  }
});

test("capture loss cancels a resource drag without a late move command", async () => {
  for (const pointerType of ["mouse", "touch"]) {
    const { app, document, dispatch, $ } = await mobileClient();
    const deck = document.querySelector('[data-deck-id="main"]');
    const revision = app.state.revision;
    await dispatch(deck, "pointerdown", { ...touch(1, 140, 300), pointerType });
    await dispatch(deck, "pointermove", { ...touch(1, 210, 360), pointerType });
    assert.equal(app.drag.activated, true);
    await dispatch(deck, "lostpointercapture", { pointerId: 1, pointerType });
    await dispatch(deck, "pointerup", { ...touch(1, 210, 360), pointerType });
    assert.equal(app.drag, null);
    assert.equal(app.tableTouches.size, 0);
    assert.equal($("drag-root").children.length, 0);
    assert.equal(deck.classList.contains("is-source"), false);
    assert.equal(app.state.revision, revision);
  }
});

test("hand swipes leave horizontal scrolling available while a tap selects the card", async () => {
  const { app, document, dispatch, $ } = await mobileClient();
  await dispatch($("open-hand"), "click");
  const card = app.state.cards.find((item) => item.zone === "hand" && item.ownerId === app.state.you.id);
  const node = document.querySelector(`#hand-cards [data-card-id="${card.id}"]`);
  node.rect = { left: 40, top: 600, width: 94, height: 138 };
  const revision = app.state.revision;
  const down = await dispatch(node, "pointerdown", touch(1, 68, 630));
  const move = await dispatch(node, "pointermove", touch(1, 140, 632));
  assert.equal(Boolean(down.defaultPrevented), false);
  assert.equal(Boolean(move.defaultPrevented), false);
  assert.equal(app.drag, null);
  await dispatch(node, "pointerup", touch(1, 140, 632));
  assert.equal(app.handTouch, null);
  assert.equal(app.selection, null);
  await dispatch(node, "pointerdown", touch(1, 68, 630));
  await dispatch(node, "pointermove", touch(1, 130, 632));
  await dispatch(node, "pointercancel", touch(1, 130, 632));
  await dispatch(node, "pointerup", touch(1, 130, 632));
  assert.equal(app.selection, null);
  await dispatch(node, "pointerdown", touch(1, 68, 630));
  await dispatch(node, "pointerup", touch(1, 69, 631));
  assert.equal(app.selection.id, card.id);
  assert.equal(app.state.revision, revision);
});

test("vertical hand drags survive incoming cards, preserve focus and scroll, and play once", async () => {
  const client = await mobileClient();
  const { app, document, dispatch, $ } = client;
  for (let index = 0; index < 5; index++) await client.sendCommand({ type: "draw", deckId: "main" });
  await dispatch($("open-hand"), "click");
  const card = app.state.cards.find((item) => item.zone === "hand" && item.ownerId === app.state.you.id);
  const node = document.querySelector(`#hand-cards [data-card-id="${card.id}"]`);
  node.rect = { left: 40, top: 600, width: 94, height: 138 };
  node.focus(); $("hand-cards").scrollLeft = 106;
  await dispatch(node, "pointerdown", touch(1, 68, 630));
  const move = await dispatch(node, "pointermove", touch(1, 69, 614));
  assert.equal(move.defaultPrevented, true);
  assert.equal(app.drag.activated, true);
  assert.equal(app.drag.fromPocket, true);
  await client.sendCommand({ type: "draw", deckId: "main" });
  assert.equal(document.querySelector(`#hand-cards [data-card-id="${card.id}"]`), node);
  assert.equal(app.drag.sourceNode, node);
  assert.equal(document.activeElement, node);
  assert.equal($("hand-cards").scrollLeft, 106);
  const revision = app.state.revision;
  await dispatch(node, "pointermove", touch(1, 168, 420));
  await dispatch(node, "pointerup", touch(1, 168, 420));
  const placed = app.state.cards.find((item) => item.id === card.id);
  assert.equal(placed.zone, "public");
  assert.equal(placed.faceUp, true);
  closeTo(app.camera.x + (placed.x + 28) * app.camera.scale, 168);
  closeTo(58 + app.camera.y + (placed.y + 30) * app.camera.scale, 420);
  assert.equal(app.state.revision, revision + 1);
  assert.equal(app.drag, null);
  assert.equal($("drag-root").children.length, 0);
});

test("closing the hand or adding a second finger cancels pending and active hand drags", async () => {
  for (const ending of ["close-pending", "close-active", "second-finger"]) {
    const { app, document, dispatch, $ } = await mobileClient();
    await dispatch($("open-hand"), "click");
    const card = app.state.cards.find((item) => item.zone === "hand" && item.ownerId === app.state.you.id);
    const node = document.querySelector(`#hand-cards [data-card-id="${card.id}"]`);
    node.rect = { left: 40, top: 600, width: 94, height: 138 };
    const revision = app.state.revision;
    await dispatch(node, "pointerdown", touch(1, 68, 630));
    if (ending !== "close-pending") await dispatch(node, "pointermove", touch(1, 70, 610));
    if (ending === "second-finger") await dispatch(node, "pointerdown", touch(2, 100, 660));
    else await dispatch($("close-hand"), "click");
    await dispatch(node, "pointermove", touch(1, 168, 420));
    await dispatch(node, "pointerup", touch(1, 168, 420));
    assert.equal(app.handTouch, null, ending);
    assert.equal(app.drag, null, ending);
    assert.equal($("drag-root").children.length, 0, ending);
    assert.equal(app.state.revision, revision, ending);
    await dispatch(node, "dblclick", { detail: 2 });
    assert.equal($("card-inspector").hasAttribute("open"), false, ending);
    if (ending !== "second-finger") assert.equal(document.activeElement, $("open-hand"));
  }
});
