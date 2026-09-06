import test from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./helpers/client-dom.mjs";
import { createLocalStoreDouble } from "./helpers/local-store.mjs";

test("the Hold'em panel deals, accepts legal actions and settles a complete heads-up hand at mobile width", async () => {
  const client = await loadClient({ width: 390, height: 844, indexedDB: createLocalStoreDouble() });
  const { $, dispatch, app } = client;
  await dispatch(client.document, "keydown", { key: "t" });
  assert.equal($("holdem-panel").getAttribute("aria-hidden"), "false");
  await dispatch($("holdem-setup-form"), "submit");
  assert.equal(app.state.holdem.phase, "waiting");
  for (const id of ["tidy-public", "collect-public", "reset-table", "turn-player-select", "random-turn", "next-turn"]) assert.equal($(id).disabled, true);
  assert.equal($("holdem-players").children.length, 2);
  await dispatch($("holdem-next"), "click");
  assert.equal(app.state.holdem.phase, "preflop");
  assert.equal($("holdem-hole-cards").children.length, 2);
  assert.equal($("holdem-call").textContent, "跟注 5");
  assert.equal($("holdem-pot").textContent, "15");
  assert.equal($("holdem-next").disabled, true);
  const otherId = app.state.holdem.players[1].holeCards[0];
  assert.equal(app.state.cards.find((card) => card.id === otherId).face, null);
  const closeRound = async () => {
    while (app.state.holdem.actorId) {
      if (app.state.you.id !== app.state.holdem.actorId) client.switchPreviewRole();
      await dispatch($("holdem-call"), "click");
    }
    if (app.state.you.role !== "host") client.switchPreviewRole();
  };
  await closeRound();
  for (const phase of ["flop", "turn", "river"]) {
    await dispatch($("holdem-next"), "click");
    assert.equal(app.state.holdem.phase, phase);
    assert.equal($("holdem-community").querySelectorAll(".poker-card:not(.is-back)").length, app.state.holdem.board.length);
    await closeRound();
  }
  await dispatch($("holdem-next"), "click");
  assert.equal(app.state.holdem.phase, "complete");
  assert.ok($("holdem-result").textContent.includes("+"));
  assert.ok(app.state.cards.find((card) => card.id === otherId).face);
  assert.equal(app.state.holdem.players.reduce((sum, player) => sum + player.stack, 0), 2000);
  await dispatch($("holdem-next"), "click");
  assert.equal(app.state.holdem.handNumber, 2);
  assert.equal(app.state.holdem.dealerId, "player_b");
});

test("poker input retains its draft across chat and controlled cards expose suitable actions", async () => {
  const client = await loadClient(); const { $, dispatch, app } = client;
  await dispatch($("holdem-setup-form"), "submit"); await dispatch($("holdem-next"), "click");
  $("holdem-raise-to").value = "175"; $("holdem-raise-to").focus();
  await client.sendCommand({ type: "chat", text: "我们慢慢玩" });
  assert.equal($("holdem-raise-to").value, "175");
  assert.equal(client.document.activeElement, $("holdem-raise-to"));
  const hole = app.state.holdem.players.find((player) => player.playerId === app.state.you.id).holeCards[0];
  client.selectResource("card", hole);
  assert.ok($("selection-actions").querySelector('[data-selection-action="open-holdem"]'));
  assert.equal($("selection-actions").querySelector('[data-selection-action="reveal-card"]'), null);
  assert.equal($("selection-actions").querySelector('[data-selection-action="resource-duplicate"]'), null);
  await dispatch($("holdem-action-form"), "submit");
  assert.equal(app.state.holdem.currentBet, 175);
  assert.equal($("holdem-action-form").classList.contains("is-hidden"), true);
  client.switchPreviewRole();
  assert.equal($("holdem-call").textContent, "跟注 165");
  await dispatch($("history-kind"), "change");
  $("history-kind").value = "holdem"; await dispatch($("history-kind"), "change");
  assert.ok($("activity-list").textContent.includes("175"));
  assert.equal($("activity-list").textContent.includes("我们慢慢玩"), false);
});

test("joining, sitting out, funding and closing the helper are available between hands", async () => {
  const client = await loadClient(); const { $, dispatch, app } = client;
  await dispatch($("holdem-setup-form"), "submit");
  await dispatch($("holdem-rebuy"), "click");
  assert.equal(app.state.holdem.players[0].stack, 2000);
  await dispatch($("holdem-sitout"), "click");
  assert.equal($("holdem-next").disabled, true);
  assert.equal($("holdem-sitout").textContent, "准备下一手");
  await dispatch($("holdem-sitout"), "click"); await dispatch($("holdem-next"), "click");
  await dispatch($("holdem-fold"), "click");
  assert.equal($("holdem-close").disabled, false);
  await dispatch($("holdem-close"), "click");
  assert.equal(app.state.holdem, null);
  assert.equal($("reset-table").disabled, false);
  assert.ok(app.state.decks.find((deck) => deck.packId === "holdem-52" && deck.canDraw));
  await client.sendCommand({ type: "undo" });
  assert.equal(app.state.holdem.phase, "complete");
});
