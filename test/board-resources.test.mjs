import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as server from "../src/room-engine.mjs";
import { loadPreviewEngine } from "./helpers/preview.mjs";

const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const { core: browser } = await loadPreviewEngine();
const plain = (value) => JSON.parse(JSON.stringify(value));
const expected = { chess: [32, 34], xiangqi: [32, 34], jungle: [16, 18], aeroplane: [16, 19] };

for (const [mode, core] of [["server", server], ["browser", browser]]) {
  const fixture = () => {
    const room = core.createRoom({ code: "BOARDS", pack, hostSecret: "test-host" });
    const host = core.joinRoom(room, { hostSecret: "test-host" }).player, guest = core.joinRoom(room, { displayName: "客人" }).player;
    const command = (value, actor = host) => core.applyCommand(room, actor.id, value);
    const state = (actor = host) => core.projectRoom(room, actor.id);
    return { room, host, guest, command, state };
  };

  test(`${mode}: four complete board sets can be placed by guests as ordinary independent resources`, () => {
    for (const [setId, [pieceCount, total]] of Object.entries(expected)) {
      const { room, guest, command, state } = fixture();
      const undo = room.undoStack.length, receipt = command({ type: "spawn-set", setId, x: 1200, y: 1000 }, guest);
      const view = state(), board = view.objects.find((object) => object.id === receipt.createdResource.id);
      assert.equal(board.resourceId, `board-${setId}`); assert.equal(board.kind, "mat");
      assert.equal(view.tokens.length, pieceCount); assert.equal(view.tokens.length + view.objects.length, total);
      assert.equal(view.objects.filter((object) => object.kind === "note").length, 1);
      assert.ok(view.tokens.every((piece) => piece.piece.game === setId && piece.canControl));
      assert.equal(core.tokenStackIndex(view.tokens).size, pieceCount);
      assert.ok([...core.tokenStackIndex(view.tokens).values()].every((group) => group.length === 1), "initial pieces must not accidentally form stacks");
      assert.equal(room.undoStack.length, undo + 1);
      const oldIds = new Set(view.tokens.map((piece) => piece.id));
      const second = command({ type: "spawn-set", setId, x: -1800, y: -1800 });
      assert.notEqual(second.createdResource.id, board.id);
      assert.equal(state().tokens.filter((piece) => !oldIds.has(piece.id)).length, pieceCount);
      command({ type: "undo" }); assert.equal(state().tokens.length, pieceCount);
      assert.ok(state().tokens.every((piece) => oldIds.has(piece.id)));
      command({ type: "undo" }); assert.equal(state().tokens.length + state().objects.length, 0);
    }
  });

  test(`${mode}: familiar chess, xiangqi, animal and aircraft setups match their board coordinates`, () => {
    const { command, state } = fixture();
    const origin = { x: 100, y: 200 };
    for (const setId of Object.keys(expected)) command({ type: "spawn-set", setId, ...origin });
    const pieces = state().tokens;
    const locate = (id) => pieces.find((piece) => piece.resourceId === id);
    const chess = core.BOARD_LAYOUTS.chess;
    assert.equal(locate("chess-w-queen").x + 31, origin.x + chess.inset + 3.5 * chess.cell);
    assert.equal(locate("chess-w-queen").y + 31, origin.y + chess.inset + 7.5 * chess.cell);
    assert.equal(locate("chess-b-king").x + 31, origin.x + chess.inset + 4.5 * chess.cell);
    assert.equal(pieces.filter((piece) => piece.piece.game === "chess" && piece.piece.role === "pawn").length, 16);
    const xiangqi = core.BOARD_LAYOUTS.xiangqi;
    assert.equal(locate("xiangqi-r-king").x + 31, origin.x + xiangqi.inset + 4 * xiangqi.cell);
    assert.equal(locate("xiangqi-r-king").y + 31, origin.y + xiangqi.inset + 9 * xiangqi.cell);
    assert.equal(pieces.filter((piece) => piece.piece.game === "xiangqi" && piece.piece.role === "pawn").length, 10);
    for (const side of ["r", "b"]) assert.deepEqual(plain(pieces.filter((piece) => piece.piece.game === "jungle" && piece.piece.side === side).map((piece) => piece.piece.rank).sort()), [1, 2, 3, 4, 5, 6, 7, 8]);
    for (const side of ["red", "yellow", "blue", "green"]) assert.equal(pieces.filter((piece) => piece.resourceId === `plane-${side}`).length, 4);
    const flight = core.BOARD_LAYOUTS.aeroplane;
    assert.equal(flight.path.length, 52); assert.equal(new Set(flight.path.map((point) => point.join(":"))).size, 52);
    assert.equal(flight.teams.length, 4);
    for (const team of flight.teams) { assert.equal(team.home.length, 6); assert.equal(team.side, flight.teams[team.start % 4].side); }
    assert.equal(core.BOARD_LAYOUTS.jungle.rivers.length, 12);
    assert.equal(core.BOARD_LAYOUTS.jungle.traps.length, 6); assert.equal(core.BOARD_LAYOUTS.jungle.dens.length, 2);
  });

  test(`${mode}: adding a set validates capacity and the shared boundary before making any change`, () => {
    const { room, command, state } = fixture();
    for (let i = 0; i < 208; i++) room.tokens.set(`existing_${i}`, { id: `existing_${i}`, x: 0, y: 0, z: i, color: "#445544", label: "已有棋子", symbol: "" });
    const snapshot = () => JSON.stringify(core.exportRoomCheckpoint(room), (key, value) => key === "savedAt" ? 0 : value);
    const before = snapshot(), undo = room.undoStack.length;
    assert.throws(() => command({ type: "spawn-set", setId: "chess", x: 0, y: 0 }), (error) => error.code === "TABLE_FULL");
    assert.equal(snapshot(), before); assert.equal(room.undoStack.length, undo);
    room.tokens.clear();
    assert.throws(() => command({ type: "spawn-set", setId: "missing", x: 0, y: 0 }), (error) => error.code === "RESOURCE_NOT_FOUND");
    assert.throws(() => command({ type: "spawn-set", setId: "chess", x: NaN, y: 0 }), (error) => error.code === "INVALID_DROP");
    assert.equal(room.undoStack.length, undo);
    command({ type: "spawn-set", setId: "aeroplane", x: 6300, y: 4100 });
    const zone = core.TABLE_GEOMETRY.publicZone;
    for (const [type, resources] of [["token", state().tokens], ["object", state().objects]]) for (const value of resources) {
      const bounds = core.tableResourceBounds(type, value);
      assert.ok(bounds.x >= zone.x && bounds.y >= zone.y);
      assert.ok(bounds.x + bounds.width <= zone.x + zone.width && bounds.y + bounds.height <= zone.y + zone.height);
    }
  });

  test(`${mode}: the aeroplane reference has a continuous colored loop and four correctly directed cross-board flights`, () => {
    const flight = core.BOARD_LAYOUTS.aeroplane;
    const reference = {
      red: { airport: [0, 13], from: [5.5, 4.5], to: [11.5, 4.5], crosses: "green" },
      yellow: { airport: [0, 0], from: [12.5, 5.5], to: [12.5, 11.5], crosses: "blue" },
      green: { airport: [13, 0], from: [11.5, 12.5], to: [5.5, 12.5], crosses: "red" },
      blue: { airport: [13, 13], from: [4.5, 11.5], to: [4.5, 5.5], crosses: "yellow" }
    };
    assert.equal(flight.track.length, 52);
    assert.equal(flight.track.filter((tile) => tile.polygon.length === 3).length, 16, "outer and inner corners are actual triangular cells");
    for (const [index, tile] of flight.track.entries()) {
      const next = flight.track[(index + 1) % 52];
      const shared = tile.polygon.filter((a) => next.polygon.some((b) => a[0] === b[0] && a[1] === b[1]));
      assert.equal(shared.length, 2, `track cells ${index + 1} and ${(index + 1) % 52 + 1} share a complete edge`);
      assert.equal(tile.side, ["blue", "red", "yellow", "green"][index % 4]);
      assert.ok(tile.polygon.every(([x, y]) => x >= 0 && y >= 0 && x <= 17 && y <= 17));
      const signs = tile.polygon.map(([x, y], vertex) => {
        const [nx, ny] = tile.polygon[(vertex + 1) % tile.polygon.length];
        return (nx - x) * (tile.center[1] - y) - (ny - y) * (tile.center[0] - x);
      });
      assert.ok(signs.every((value) => value > 0) || signs.every((value) => value < 0), "each landing spot is inside its colored cell");
    }
    for (const team of flight.teams) {
      const expected = reference[team.side], [from, to] = team.flight.map((index) => flight.path[index]);
      assert.deepEqual(plain(team.airport), expected.airport);
      assert.deepEqual(plain(from), expected.from); assert.deepEqual(plain(to), expected.to);
      assert.equal((team.flight[1] - team.flight[0] + 52) % 52, 12);
      assert.equal(flight.track[team.flight[0]].side, team.side); assert.equal(flight.track[team.flight[1]].side, team.side);
      assert.equal(flight.track[team.entry].side, team.side);
      const midpoint = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
      assert.deepEqual(midpoint, plain(flight.teams.find((other) => other.side === expected.crosses).home[2]));
      const pieces = core.BOARD_GAME_SETS.find((set) => set.id === "aeroplane").members.filter((piece) => piece.resourceId === `plane-${team.side}`);
      for (const [index, piece] of pieces.entries()) {
        const [x, y] = flight.airportSlots[index];
        assert.equal(piece.x + 31, flight.inset + (team.airport[0] + x) * flight.cell);
        assert.equal(piece.y + 31, flight.inset + (team.airport[1] + y) * flight.cell);
      }
    }
  });

  test(`${mode}: pieces can be moved, copied and bagged without enforcing game rules`, () => {
    const { command, state, guest } = fixture();
    command({ type: "spawn-set", setId: "chess", x: 0, y: 0 });
    const knight = state().tokens.find((piece) => piece.resourceId === "chess-b-knight"), turn = plain(state().turn);
    command({ type: "move-resource", resourceType: "token", resourceId: knight.id, x: -1200, y: 1800 }, guest);
    assert.equal(state().tokens.find((piece) => piece.id === knight.id).x, -1200);
    assert.deepEqual(plain(state().turn), turn);
    const copy = command({ type: "duplicate-resource", resourceType: "token", resourceId: knight.id }, guest).createdResource;
    assert.deepEqual(plain(state().tokens.find((piece) => piece.id === copy.id).piece), plain(knight.piece));
    const bag = command({ type: "spawn-resource", resourceId: "bag", x: -600, y: 600 }).createdResource;
    command({ type: "bag-put", resourceType: "token", resourceId: copy.id, bagId: bag.id }, guest);
    assert.equal(state().tokens.some((piece) => piece.id === copy.id), false);
    command({ type: "bag-draw", bagId: bag.id }, guest);
    assert.ok(state().tokens.some((piece) => piece.id === copy.id && piece.piece.role === "knight"));
  });

  test(`${mode}: saves and checkpoints retain board art, piece identities and free placement`, () => {
    const { room, command, state, host } = fixture();
    for (const setId of Object.keys(expected)) command({ type: "spawn-set", setId, x: -1000, y: -1000 });
    const piece = state().tokens.find((token) => token.piece.game === "xiangqi");
    command({ type: "move-resource", resourceType: "token", resourceId: piece.id, x: 2100, y: 1600 });
    command({ type: "lock-resource", resourceType: "token", resourceId: piece.id });
    const saved = core.exportRoomGame(room, host.id), prior = plain(state().tokens);
    core.restoreRoomGame(room, host.id, saved);
    assert.deepEqual(plain(state().tokens), prior);
    const restart = core.roomFromCheckpoint(core.exportRoomCheckpoint(room));
    assert.deepEqual(plain(core.projectRoom(restart, host.id).tokens), prior);
    const scene = core.exportRoomScene(room, host.id), validated = core.validateRoomScene(scene);
    assert.equal(validated.objects.filter((object) => core.BOARD_LAYOUTS[object.pattern]).length, 4);
    assert.equal(validated.tokens.filter((token) => token.piece).length, 96);
    const tampered = structuredClone(scene), token = tampered.tokens.find((token) => token.resourceId === piece.resourceId);
    token.piece = { game: "unknown", role: "script", rank: 99 };
    const safe = core.validateRoomScene(tampered).tokens.find((candidate) => candidate.id === token.id);
    assert.notEqual(safe.piece.game, "unknown", "appearance comes from a declared resource, never executable imported data");
  });
}

test("browser and server expose the same immutable resource definitions", () => {
  assert.deepEqual(plain(browser.BOARD_GAME_SETS), plain(server.BOARD_GAME_SETS));
  assert.deepEqual(plain(browser.BOARD_LAYOUTS), plain(server.BOARD_LAYOUTS));
  const ids = server.RESOURCE_CATALOG.map((resource) => resource.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const resource of server.BOARD_RESOURCES) {
    if (resource.kind === "token") assert.ok(resource.id.length <= 20, "token keys survive existing scene name limits");
    if (resource.kind === "note") assert.ok(resource.text.length <= 600);
  }
  for (const set of server.BOARD_GAME_SETS) {
    assert.ok(Object.isFrozen(set));
    assert.ok(set.members.every((member) => ids.includes(member.resourceId)));
  }
});
