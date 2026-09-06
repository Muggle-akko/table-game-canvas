import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as serverCore from "../src/room-engine.mjs";
import * as serverRules from "../src/holdem-rules.mjs";
import { loadPreviewEngine } from "./helpers/preview.mjs";

const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const preview = await loadPreviewEngine(), plain = (value) => JSON.parse(JSON.stringify(value));
const face = (value) => ({ rank: value.slice(0, -1), suit: { s: "spades", h: "hearts", d: "diamonds", c: "clubs" }[value.at(-1)] });

for (const [mode, core, rules] of [["server", serverCore, serverRules], ["browser", preview.core, preview.holdem]]) {
  const setup = (count = 2, options = {}) => {
    const room = core.createRoom({ code: "TEX-123", pack, hostSecret: "holdem-test-secret" });
    const players = [core.joinRoom(room, { hostSecret: room.hostSecret, displayName: "房主" }).player];
    for (let index = 1; index < count; index++) players.push(core.joinRoom(room, { displayName: `朋友${index}` }).player);
    const command = (command, playerId = players[0].id) => core.applyCommand(room, playerId, command);
    const state = (viewerId = players[0].id) => core.projectRoom(room, viewerId);
    command({ type: "holdem-setup", ...options });
    const act = (action, extra = {}) => command({ type: "holdem-action", action, ...extra }, room.holdem.actorId);
    const closeRound = () => { for (let i = 0; room.holdem.actorId && i < 20; i++) act(rules.holdemLegalActions(room.holdem, room.holdem.actorId).canCheck ? "check" : "call"); assert.equal(room.holdem.actorId, null); };
    const validArchive = () => core.validateRoomGame(core.exportRoomGame(room, players[0].id));
    return { room, players, command, state, act, closeRound, validArchive };
  };
  const rigHoleCards = (room, desired) => {
    for (const [index, values] of desired.entries()) for (const [offset, value] of values.entries()) {
      const target = room.cards.get(room.holdem.players[index].holeCards[offset]), wanted = face(value);
      const source = [...room.cards.values()].find((card) => card.deckId === room.holdem.deckId && card.face.rank === wanted.rank && card.face.suit === wanted.suit);
      [target.face, source.face] = [source.face, target.face];
    }
  };
  const rigBoard = (room, desired) => {
    const deck = room.decks.get(room.holdem.deckId);
    const board = desired.map((value) => { const wanted = face(value); return deck.order.find((id) => room.cards.get(id).face.rank === wanted.rank && room.cards.get(id).face.suit === wanted.suit); });
    assert.ok(board.every(Boolean));
    const spare = deck.order.filter((id) => !board.includes(id)), burns = spare.splice(-3);
    deck.order = [...spare, ...[burns[0], ...board.slice(0, 3), burns[1], board[3], burns[2], board[4]].reverse()];
  };

  test(`${mode}: best five of seven ranks straights, kickers, full houses and shared-board ties`, () => {
    const evaluate = (values) => rules.evaluateHoldem(values.split(" ").map(face));
    assert.deepEqual(plain(evaluate("As 2h 3c 4d 5s Kh Qh").score), [4, 5]);
    assert.deepEqual(plain(evaluate("As Ks Qs Js 10s 2h 3d").score), [8, 14]);
    assert.deepEqual(plain(evaluate("Ac Ah As Kc Kh Ks 2h").score), [6, 14, 13]);
    assert.deepEqual(plain(evaluate("9c 9h 9s 9d Ah 2d 3c").score), [7, 9, 14]);
    assert.ok(rules.compareHoldemRanks(evaluate("Ah Ad Kc 8c 7c 3d 2h"), evaluate("As Ac Qc 8h 7h 3c 2d")) > 0);
    assert.equal(rules.compareHoldemRanks(evaluate("As Ks Qs Js 10s 2h 3h"), evaluate("As Ks Qs Js 10s Ac Ad")), 0);
    assert.throws(() => evaluate("As As Qs Js 10s"), { code: "INVALID_HOLDEM" });
  });

  test(`${mode}: heads-up blinds, four betting rounds and showdown form a complete private-to-public hand`, () => {
    const f = setup();
    const originalCards = f.room.cards.size - 52;
    f.command({ type: "holdem-start" });
    assert.equal(f.room.holdem.smallBlindId, f.players[0].id);
    assert.equal(f.room.holdem.bigBlindId, f.players[1].id);
    assert.equal(f.room.holdem.actorId, f.players[0].id);
    assert.equal(f.room.decks.get(f.room.holdem.deckId).order.length, 48);
    const other = f.room.holdem.players[1].holeCards[0];
    assert.equal(f.state().cards.find((card) => card.id === other).face, null);
    assert.ok(f.state(f.players[1].id).cards.find((card) => card.id === other).face);
    assert.equal(JSON.stringify(f.state()).includes('"burns"'), false);
    assert.throws(() => f.command({ type: "holdem-advance" }), { code: "HOLDEM_ROUND_OPEN" });
    f.validArchive(); f.closeRound();
    for (const [phase, boardCount, burnCount] of [["flop", 3, 1], ["turn", 4, 2], ["river", 5, 3]]) {
      f.command({ type: "holdem-advance" });
      assert.equal(f.room.holdem.phase, phase); assert.equal(f.room.holdem.board.length, boardCount); assert.equal(f.room.holdem.burns.length, burnCount);
      assert.equal(f.room.holdem.actorId, f.players[1].id, "the non-dealer acts first after the flop heads-up");
      f.validArchive(); f.closeRound();
    }
    f.command({ type: "holdem-advance" });
    assert.equal(f.room.holdem.phase, "complete"); assert.equal(f.room.holdem.showdown, true);
    assert.ok(f.state().cards.find((card) => card.id === other).face);
    assert.equal(f.room.holdem.players.reduce((sum, player) => sum + player.stack, 0), 2000);
    const previousCards = f.room.holdem.players.flatMap((player) => [...player.holeCards]);
    f.validArchive(); f.command({ type: "holdem-start" });
    assert.equal(f.room.holdem.dealerId, f.players[1].id); assert.equal(f.room.holdem.handNumber, 2);
    assert.ok(previousCards.every((id) => !f.room.cards.has(id)), "a new deal rotates all identifiers before drawing");
    assert.equal(f.room.cards.size, originalCards + 52);
  });

  test(`${mode}: different all-in amounts create side pots, return excess and conserve every chip`, () => {
    const f = setup(3, { buyIn: 100 });
    f.command({ type: "holdem-rebuy", playerId: f.players[0].id, amount: 200 });
    f.command({ type: "holdem-rebuy", playerId: f.players[1].id, amount: 100 });
    f.command({ type: "holdem-start" });
    rigHoleCards(f.room, [["Qh", "Qd"], ["Kh", "Kd"], ["Ah", "Ad"]]); rigBoard(f.room, ["2c", "3d", "4h", "8s", "9c"]);
    f.act("all-in"); f.act("all-in"); f.act("all-in");
    assert.equal(f.room.holdem.actorId, null);
    assert.deepEqual(plain(rules.holdemPots(f.room.holdem.players).map((pot) => pot.amount)), [300, 200]);
    assert.equal(f.room.holdem.refunds[0].amount, 100);
    f.validArchive();
    for (let stage = 0; stage < 4; stage++) f.command({ type: "holdem-advance" });
    assert.deepEqual(plain(f.room.holdem.players.map((player) => player.stack)), [100, 200, 300]);
    assert.equal(f.room.holdem.lastPot, 500);
    assert.equal(f.room.holdem.payouts.length, 2); f.validArchive();
  });

  test(`${mode}: a short all-in does not reopen a previous full raise and failed actions are atomic`, () => {
    const f = setup(4, { buyIn: 150 });
    for (const player of [f.players[0], f.players[2], f.players[3]]) f.command({ type: "holdem-rebuy", playerId: player.id, amount: 850 });
    f.command({ type: "holdem-start" });
    assert.equal(f.room.holdem.actorId, f.players[3].id);
    const unchanged = JSON.stringify(f.room.holdem), revision = f.room.revision;
    assert.throws(() => f.act("raise", { to: 15 }), { code: "HOLDEM_MIN_RAISE" });
    assert.equal(JSON.stringify(f.room.holdem), unchanged); assert.equal(f.room.revision, revision);
    f.act("raise", { to: 100 }); f.act("call"); f.act("all-in"); f.act("call");
    assert.equal(f.room.holdem.actorId, f.players[3].id);
    assert.equal(f.state(f.players[3].id).holdem.legal.canRaise, false);
    assert.throws(() => f.act("raise", { to: 240 }), { code: "HOLDEM_RAISE_CLOSED" });
    f.act("call"); f.act("call"); assert.equal(f.room.holdem.actorId, null); f.validArchive();
  });

  test(`${mode}: a short heads-up big blind runs out directly and a lone funded player cannot create a dry side pot`, () => {
    const f = setup(2, { buyIn: 100 });
    f.room.holdem.players[0].stack = 197; f.room.holdem.players[1].stack = 3;
    f.command({ type: "holdem-start" });
    assert.equal(f.room.holdem.actorId, null, "the small blind already covers the opponent's entire stack");
    assert.equal(f.room.holdem.refunds[0].amount, 2);
    assert.equal(f.state().holdem.pot, 6);
    for (let street = 0; street < 4; street++) { f.validArchive(); f.command({ type: "holdem-advance" }); }
    assert.equal(f.room.holdem.players.reduce((sum, player) => sum + player.stack, 0), 200);
    f.validArchive();

    const g = setup(3, { buyIn: 100 });
    g.command({ type: "holdem-rebuy", playerId: g.players[2].id, amount: 200 });
    g.command({ type: "holdem-start" }); g.act("all-in"); g.act("all-in");
    assert.equal(g.room.holdem.actorId, g.players[2].id);
    const legal = g.state(g.players[2].id).holdem.legal;
    assert.equal(legal.callAmount, 90); assert.equal(legal.canRaise, false); assert.equal(legal.canAllIn, false);
    assert.throws(() => g.act("raise", { to: 200 }), { code: "HOLDEM_RAISE_CLOSED" });
    g.act("call"); assert.equal(g.room.holdem.actorId, null); g.validArchive();

    const h = setup(3, { buyIn: 100 });
    [292, 3, 5].forEach((stack, index) => { h.room.holdem.players[index].stack = stack; });
    h.command({ type: "holdem-start" });
    assert.equal(h.state().holdem.legal.callAmount, 5, "only the actual opposing all-in needs matching");
    h.act("call"); assert.equal(h.state().holdem.pot, 13); assert.equal(h.room.holdem.actorId, null); h.validArchive();
  });

  test(`${mode}: odd chips go clockwise from the dealer, and folded players cannot win a shared board`, () => {
    const f = setup(3);
    f.command({ type: "holdem-start" });
    rigHoleCards(f.room, [["2h", "3h"], ["4h", "5h"], ["6h", "7h"]]);
    rigBoard(f.room, ["As", "Ks", "Qs", "Js", "10s"]);
    f.act("call"); f.act("fold"); f.act("check");
    for (let stage = 0; stage < 3; stage++) { f.command({ type: "holdem-advance" }); f.closeRound(); }
    f.command({ type: "holdem-advance" });
    assert.deepEqual(plain(f.room.holdem.players.map((player) => player.stack)), [1002, 995, 1003]);
    assert.equal(f.room.holdem.payouts.find((entry) => entry.playerId === f.players[1].id), undefined);
    assert.equal(f.state().cards.find((card) => card.id === f.room.holdem.players[1].holeCards[0]).face, null); f.validArchive();
  });

  test(`${mode}: a fold awards the pot without revealing the winner and the host can undo the whole action`, () => {
    const f = setup(); f.command({ type: "holdem-start" });
    f.act("fold");
    assert.equal(f.room.holdem.phase, "complete"); assert.equal(f.room.holdem.showdown, false);
    assert.deepEqual(plain(f.room.holdem.players.map((player) => player.stack)), [995, 1005]);
    const winnerCard = f.room.holdem.players[1].holeCards[0];
    assert.equal(f.state().cards.find((card) => card.id === winnerCard).face, null);
    f.command({ type: "undo" });
    assert.equal(f.room.holdem.phase, "preflop"); assert.equal(f.room.holdem.actorId, f.players[0].id);
    assert.equal(f.state().holdem.pot, 15); f.validArchive();
  });

  test(`${mode}: poker cards keep private movement but reject manual draws, transfers and premature departure`, () => {
    const f = setup(); f.command({ type: "holdem-start" });
    const hand = f.room.holdem.players[0].holeCards[0], other = f.room.holdem.players[1].holeCards[0];
    f.command({ type: "move-card", cardId: hand, target: "hand", x: 460, y: 940, rotation: 15 });
    assert.equal(f.room.cards.get(hand).x, 460);
    for (const command of [
      { type: "draw", deckId: f.room.holdem.deckId }, { type: "move-card", cardId: hand, target: "public", x: 700, y: 400 },
      { type: "move-card", cardId: other, target: "hand", ownerId: f.players[0].id }, { type: "reset" },
      { type: "delete-resource", resourceType: "object", resourceId: f.room.holdem.matId }
    ]) assert.throws(() => f.command(command), { code: "HOLDEM_MANAGED" });
    assert.throws(() => f.command({ type: "leave-seat" }, f.players[1].id), { code: "HOLDEM_SEAT" });
    assert.throws(() => f.command({ type: "holdem-action", action: "check" }, f.players[1].id), { code: "HOLDEM_TURN" });
    f.validArchive();
  });

  test(`${mode}: archive and restart restore an unfinished betting decision and reject corrupted chips`, () => {
    const f = setup(3); f.command({ type: "holdem-start" }); f.act("raise", { to: 40 });
    const expected = plain(f.state(f.players[1].id).holdem), game = core.exportRoomGame(f.room, f.players[0].id);
    const restarted = core.roomFromCheckpoint(plain(core.exportRoomCheckpoint(f.room)));
    assert.deepEqual(plain(core.projectRoom(restarted, f.players[1].id).holdem), expected);
    f.act("call"); core.restoreRoomGame(f.room, f.players[0].id, plain(game));
    assert.equal(f.room.holdem.currentBet, 40); assert.equal(f.room.holdem.actorId, expected.actorId);
    assert.equal(f.state(f.players[1].id).holdem.legal.callAmount, expected.legal.callAmount);
    f.validArchive();
    const corrupt = plain(core.exportRoomGame(f.room, f.players[0].id)); corrupt.holdem.players[0].stack += 1;
    const revision = f.room.revision;
    assert.throws(() => core.restoreRoomGame(f.room, f.players[0].id, corrupt), { code: "INVALID_GAME" }); assert.equal(f.room.revision, revision);
  });

  test(`${mode}: varied two-to-eight-player hands preserve chip totals and valid archives at every decision`, () => {
    let seed = 48271;
    const next = (maximum) => { seed = (seed * 16807) % 2147483647; return seed % maximum; };
    for (let count = 2; count <= 8; count++) {
      const f = setup(count, { buyIn: 200 });
      for (const player of f.players) f.command({ type: "holdem-rebuy", playerId: player.id, amount: next(5) * 37 + 1 });
      for (let hand = 0; hand < 3; hand++) {
        for (const player of f.room.holdem.players) if (player.stack === 0) f.command({ type: "holdem-rebuy", playerId: player.playerId, amount: 200 });
        f.command({ type: "holdem-start" });
        for (let step = 0; step < 160 && f.room.holdem.phase !== "complete"; step++) {
          const poker = f.room.holdem;
          if (!poker.actorId) f.command({ type: "holdem-advance" });
          else {
            const legal = rules.holdemLegalActions(poker, poker.actorId), choice = next(10);
            if (choice === 0) f.act("fold");
            else if (choice === 1 && legal.canAllIn) f.act("all-in");
            else if (choice < 4 && legal.canRaise && legal.maxRaiseTo >= legal.minRaiseTo) f.act("raise", { to: Math.min(legal.maxRaiseTo, legal.minRaiseTo + next(3) * 10) });
            else f.act(legal.canCheck ? "check" : "call");
          }
          f.validArchive();
          assert.equal(f.room.holdem.players.reduce((sum, player) => sum + player.stack + player.committed, 0), f.room.holdem.totalChips);
        }
        assert.equal(f.room.holdem.phase, "complete", `hand ${hand} for ${count} players must finish`);
      }
    }
  });

  test(`${mode}: stale decisions are refused and only the host can fold an offline current player`, () => {
    const f = setup(); f.command({ type: "holdem-start" });
    const oldDecision = f.room.holdem.decision;
    f.closeRound(); f.command({ type: "holdem-advance" });
    assert.throws(() => f.act("check", { decision: oldDecision }), { code: "HOLDEM_STALE" });
    const target = f.room.players.get(f.room.holdem.actorId);
    target.connections = 1;
    assert.throws(() => f.command({ type: "holdem-fold-offline", playerId: target.id }), { code: "HOLDEM_PLAYER_ONLINE" });
    target.connections = 0;
    assert.throws(() => f.command({ type: "holdem-fold-offline", playerId: target.id }, target.id), { code: "HOST_ONLY" });
    f.command({ type: "holdem-fold-offline", playerId: target.id });
    assert.equal(f.room.holdem.phase, "complete");
    assert.ok(f.room.history.at(-1).label.includes("由房主代为弃牌"));
    assert.equal(f.room.history.at(-1).actorId, f.players[0].id); f.validArchive();
    assert.throws(() => f.command({ type: "holdem-close", decision: oldDecision }), { code: "HOLDEM_STALE" });
    assert.equal(f.room.holdem.phase, "complete", "a delayed close must not dismantle a later hand");
  });

  test(`${mode}: a poker layout template releases helper locks while a full game retains control`, () => {
    const f = setup(); f.command({ type: "holdem-start" });
    const { deckId, matId } = f.room.holdem;
    const scene = core.exportRoomScene(f.room, f.players[0].id);
    assert.equal(f.room.decks.get(deckId).locked, true, "export cannot change the live table");
    core.restoreRoomScene(f.room, f.players[0].id, scene);
    assert.equal(f.room.holdem, null);
    assert.equal(f.room.decks.get(deckId).locked, false);
    assert.equal(f.room.objects.get(matId).locked, false);
    assert.ok(f.state().decks.find((deck) => deck.id === deckId).canDraw);
    const epoch = f.room.epoch;
    f.command({ type: "undo" });
    assert.equal(f.room.holdem.phase, "preflop");
    assert.equal(f.room.decks.get(deckId).locked, true);
    assert.notEqual(f.room.epoch, epoch, "undo invalidates unknown operations from the old table");
    f.validArchive();
  });
}
