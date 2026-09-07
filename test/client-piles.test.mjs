import test from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./helpers/client-dom.mjs";
import { createLocalStoreDouble } from "./helpers/local-store.mjs";

function pointer(client, x, y) {
  const rect = client.$("viewport").getBoundingClientRect(), camera = client.app.camera;
  return { clientX: rect.left + camera.x + x * camera.scale, clientY: rect.top + camera.y + y * camera.scale };
}
async function drag(client, type, resource, target, { drop = true, pointerType = "mouse" } = {}) {
  const node = client.document.querySelector(`[data-${type}-id="${resource.id}"]`);
  await client.dispatch(node, "pointerdown", { ...pointer(client, resource.x + 25, resource.y + 30), pointerType });
  await client.dispatch(node, "pointermove", { ...pointer(client, target.x + 35, target.y + 45), pointerType });
  if (drop) await client.dispatch(node, "pointerup", { ...pointer(client, target.x + 35, target.y + 45), pointerType });
  return node;
}

test("a card drop highlights the pile and preserves its face at the top through real pointer handlers", async () => {
  const client = await loadClient();
  const { app, document, dispatch } = client;
  const card = app.state.cards.find((card) => card.zone === "public"), deck = app.state.decks[0];
  const before = app.state.revision;
  const source = await drag(client, "card", card, deck, { drop: false });
  assert.ok(document.querySelector('[data-deck-id="main"]').classList.contains("is-drop-target"));
  assert.equal(document.querySelector(".pile-drop-hint").classList.contains("is-hidden"), false);
  await dispatch(source, "pointerup", pointer(client, deck.x + 35, deck.y + 45));
  assert.equal(app.state.revision, before + 1);
  assert.equal(app.state.decks[0].count, deck.count + 1);
  assert.equal(app.state.decks[0].top.face.label, card.face.label);
  assert.equal(app.state.decks[0].top.faceUp, card.faceUp);
  assert.equal(document.querySelector(`#cards-root [data-card-id="${card.id}"]`), null);
  assert.ok(document.querySelector('[data-deck-id="main"] .card-face'));
  assert.equal(app.selection.type, "deck");
  assert.equal(document.querySelector(".is-drop-target"), null);
  const deckNode = await drag(client, "deck", app.state.decks[0], { x: 900, y: 550 }, { drop: false });
  assert.equal(app.drag.ghost.style.transform, `rotate(${card.rotation}deg)`, "lifting a pile keeps the top card's angle");
  await dispatch(deckNode, "pointercancel");
  await dispatch(document.querySelector('[data-selection-action="draw-public"]'), "click");
  assert.equal(app.state.cards.find((item) => item.id === card.id).faceUp, true);
  assert.equal(app.state.cards.find((item) => item.id === card.id).rotation, card.rotation, "taking the top card to the table keeps its angle");
});

test("touch returning a private card does not turn its hidden face up", async () => {
  const client = await loadClient({ width: 390, height: 844 });
  const card = client.app.state.cards.find((card) => card.ownerId === "player_a");
  const label = card.face.label, deck = client.app.state.decks[0];
  await drag(client, "card", card, deck, { pointerType: "touch" });
  assert.equal(client.app.state.decks[0].top.faceUp, false);
  assert.equal(client.app.state.decks[0].top.face, null);
  client.switchPreviewRole();
  assert.equal(JSON.stringify(client.app.state.decks).includes(label), false);
  assert.ok(client.document.querySelector('[data-deck-id="main"] .card-back'));
});

test("two deck drops merge into one and tools continue to use it after the main pile is gone", async () => {
  const client = await loadClient();
  await client.sendCommand({ type: "add-pack", packId: "holdem-52", x: 1180, y: 440 });
  const [main, target] = client.app.state.decks;
  await drag(client, "deck", main, target);
  assert.equal(client.app.state.decks.length, 1);
  assert.equal(client.app.state.decks[0].id, target.id);
  assert.equal(client.app.state.decks[0].count, main.count + target.count);
  assert.equal(client.app.selection.id, target.id);
  assert.equal(client.document.querySelector('[data-deck-id="main"]'), null);
  client.vm("clearSelection()");
  await client.dispatch(client.$("draw-card"), "click");
  assert.equal(client.app.state.decks[0].count, main.count + target.count - 1);
});

test("dropping onto a loose card creates a selectable pile with row, column and grid actions", async () => {
  const client = await loadClient();
  const target = client.app.state.cards.find((card) => card.zone === "public");
  await client.sendCommand({ type: "draw-public", x: 1100, y: 350 });
  const source = client.app.state.cards.filter((card) => card.zone === "public").at(-1);
  await drag(client, "card", source, target);
  const pile = client.app.state.decks.at(-1);
  assert.equal(pile.count, 2);
  assert.equal(pile.top.id, source.id);
  assert.equal(client.app.selection.id, pile.id);
  for (const suffix of ["", "-column", "-grid"]) {
    client.selectResource("deck", pile.id);
    await client.dispatch(client.document.querySelector(`[data-selection-action="spread-deck${suffix}"]`), "click");
    const cards = client.app.state.cards.filter((card) => card.zone === "public");
    assert.equal(cards.length, 2);
    assert.equal(cards[0].id, source.id);
    assert.equal(cards[0].faceUp, false);
    assert.equal(cards[1].faceUp, true);
    if (!suffix) assert.equal(cards[0].y, cards[1].y);
    if (suffix === "-column") assert.equal(cards[0].x, cards[1].x);
    await client.sendCommand({ type: "undo" });
  }
});

test("locked cards, piles, tokens and mats have a noninteractive lock icon and an accessible status", async () => {
  const client = await loadClient();
  await client.sendCommand({ type: "spawn-resource", resourceId: "holdem-mat", x: 1500, y: 500 });
  const resources = [
    ["card", client.app.state.cards.find((card) => card.zone === "public")],
    ["deck", client.app.state.decks[0]], ["token", client.app.state.tokens[0]],
    ["object", client.app.state.objects.find((object) => object.kind === "mat")]
  ];
  for (const [type, resource] of resources) {
    await client.sendCommand({ type: "lock-resource", resourceType: type, resourceId: resource.id });
    const node = client.document.querySelector(`[data-${type}-id="${resource.id}"]`);
    assert.ok(node.querySelector(".resource-lock .ph-icon"));
    assert.equal(node.querySelector(".resource-lock").getAttribute("aria-hidden"), "true");
    assert.match(node.getAttribute("aria-label"), /已锁定/);
    const revision = client.app.state.revision;
    await drag(client, type, resource, { x: 1300, y: 650 });
    assert.equal(client.app.state.revision, revision);
    await client.sendCommand({ type: "lock-resource", resourceType: type, resourceId: resource.id });
    assert.equal(client.document.querySelector(`[data-${type}-id="${resource.id}"] .resource-lock`), null);
  }
});

test("Hold'em is ordinary library resources that anyone can deal, copy, edit and move", async () => {
  const client = await loadClient({ width: 390, height: 844, indexedDB: createLocalStoreDouble() });
  const { app, document, dispatch, $ } = client;
  assert.equal($("holdem-panel"), null);
  assert.equal($("open-holdem"), null);
  client.switchPreviewRole();
  await dispatch($("open-library"), "click");
  await dispatch(document.querySelector('[data-add-asset="pack:holdem-52"]'), "click");
  const deck = app.state.decks.at(-1);
  assert.equal(deck.count, 52);
  for (const id of ["holdem-guide", "holdem-mat", "chip-100", "dealer-button"]) {
    await dispatch(document.querySelector(`[data-add-asset="${id}"]`), "click");
  }
  const guide = app.state.objects.find((object) => object.resourceId === "holdem-guide");
  assert.match(guide.text, /同花顺/);
  await client.sendCommand({ type: "edit-resource", resourceType: "object", resourceId: guide.id, text: "今晚大家自己约定规则。" });
  const chip = app.state.tokens.find((token) => token.symbol === "100");
  await client.sendCommand({ type: "duplicate-resource", resourceType: "token", resourceId: chip.id });
  assert.equal(app.state.tokens.filter((token) => token.symbol === "100").length, 2);
  await client.sendCommand({ type: "move-token", tokenId: chip.id, x: 920, y: 670 });
  await client.sendCommand({ type: "draw", deckId: deck.id });
  assert.equal(app.state.decks.find((entry) => entry.id === deck.id).count, 51);
  assert.equal(app.state.holdem, undefined);
  assert.equal(app.state.turn.activePlayerId, null);
});
