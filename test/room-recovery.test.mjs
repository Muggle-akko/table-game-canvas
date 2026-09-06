import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoom, joinRoom, applyCommand, exportRoomCheckpoint, exportRoomGame, roomFromCheckpoint } from "../src/room-engine.mjs";
import { createRoomPersistence, latestRoomPath, readRoomCheckpoint } from "../src/room-persistence.mjs";
import { createRoomServer } from "../src/server.mjs";

const pack = JSON.parse(await readFile(new URL("../game-packs/standard-54.json", import.meta.url)));
const setupRoom = () => createRoom({ code: "SAV-123", hostSecret: "recovery-test-secret", pack, randomizeDeck: false });

test("automatic checkpoints are private, atomic, retain the previous file and recover after a write failure", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "parlor-storage-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, "rooms"), room = setupRoom(), host = joinRoom(room, { hostSecret: room.hostSecret });
  const persistence = await createRoomPersistence(room, { directory });
  t.after(() => persistence.close());
  await assert.rejects(createRoomPersistence(room, { directory }), { code: "ROOM_IN_USE" });
  await persistence.save();
  const first = await readFile(persistence.path, "utf8");
  applyCommand(room, host.player.id, { type: "draw" });
  await persistence.save();
  assert.equal(await readFile(`${persistence.path}.bak`, "utf8"), first);
  assert.equal((await readRoomCheckpoint(await latestRoomPath(directory))).deckOrder.length, 53);
  assert.equal((await stat(persistence.path)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const backup = await persistence.backup();
  assert.equal((await readRoomCheckpoint(backup)).deckOrder.length, 53);
  await rename(directory, `${directory}-away`);
  applyCommand(room, host.player.id, { type: "draw" });
  await assert.rejects(persistence.save(), { code: "SAVE_FAILED" });
  assert.ok(room.persistence.error);
  assert.equal(room.deckOrder.length, 52, "a failed disk write never rolls back the live table silently");
  await rename(`${directory}-away`, directory);
  await persistence.save();
  assert.equal(room.persistence.error, null);
  assert.equal((await readRoomCheckpoint(persistence.path)).deckOrder.length, 52);
  assert.equal((await readdir(directory)).some((file) => file.endsWith(".tmp")), false);
  await writeFile(persistence.path, "{truncated", { mode: 0o600 });
  await assert.rejects(readRoomCheckpoint(persistence.path), { code: "INVALID_CHECKPOINT" });
  const oldBackup = await readFile(`${persistence.path}.bak`, "utf8");
  await persistence.save();
  assert.equal(await readFile(`${persistence.path}.bak`, "utf8"), oldBackup, "a corrupt primary must not replace the last valid backup");
});

async function subscribe(baseUrl, room, session) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/events?room=${room.code}&session=${session}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let text = "";
  return {
    async until(predicate) {
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        while (true) {
          let end;
          while ((end = text.indexOf("\n\n")) >= 0) {
            const event = text.slice(0, end); text = text.slice(end + 2);
            if (!event.startsWith("data: ")) continue;
            const value = JSON.parse(event.slice(6));
            if (predicate(value)) return value;
          }
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Event stream ended before the expected state");
          text += new TextDecoder().decode(chunk.value);
        }
      } finally { clearTimeout(timer); }
    },
    close() { controller.abort(); return reader.cancel().catch(() => {}); }
  };
}

test("real HTTP/SSE: lost receipts and process restart preserve a single draw, private faces and the same seats", { timeout: 15000, skip: process.env.PARLOR_HTTP_TESTS !== "1" && "Run npm run test:network with permission to listen on loopback" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "parlor-http-recovery-"));
  let room = setupRoom(), persistence = await createRoomPersistence(room, { directory });
  let server;
  const streams = [];
  t.after(async () => { await Promise.all(streams.map((stream) => stream.close())); await server?.close(); await rm(directory, { recursive: true, force: true }); });
  server = await createRoomServer(room, 0, { persistence, packLibrary: [{ pack }] });
  let baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  const request = async (path, body) => {
    const response = await fetch(`${baseUrl}${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    return { status: response.status, payload: await response.json() };
  };
  const host = (await request("/api/join", { roomCode: room.code, hostSecret: room.hostSecret })).payload;
  const guest = (await request("/api/join", { roomCode: room.code, displayName: "明天继续" })).payload;
  const hostStream = await subscribe(baseUrl, room, host.sessionToken), guestStream = await subscribe(baseUrl, room, guest.sessionToken);
  streams.push(hostStream, guestStream);
  await hostStream.until((state) => state.type === "room-state");
  await guestStream.until((state) => state.type === "room-state");
  const body = { roomCode: room.code, sessionToken: guest.sessionToken,
    message: { type: "command", id: "draw-once-0001", gameId: room.gameId, epoch: room.epoch, baseRevision: room.revision, command: { type: "draw" } } };
  const first = await request("/api/message", body); // Simulates a mutation whose acknowledgement did not reach the UI.
  assert.equal(first.payload.durable, true);
  const duplicate = await request("/api/message", body);
  assert.equal(duplicate.payload.duplicate, true);
  assert.equal(room.deckOrder.length, 53);
  const hostState = await hostStream.until((state) => state.type === "room-state" && state.deck.count === 53);
  const guestState = await guestStream.until((state) => state.type === "room-state" && state.deck.count === 53);
  const ownCard = guestState.cards.find((card) => card.ownerId === guest.player.id);
  assert.ok(ownCard.face); assert.equal(hostState.cards.find((card) => card.id === ownCard.id).face, null);
  assert.equal(JSON.stringify(hostState).includes(guest.recoveryKey), false);
  const mismatch = structuredClone(body); mismatch.message.command = { type: "draw-public", x: 600, y: 400 };
  assert.equal((await request("/api/message", mismatch)).payload.code, "COMMAND_ID_REUSED");
  assert.equal((await request(`/api/game?room=${room.code}&session=${guest.sessionToken}`)).status, 403);
  assert.equal((await request(`/api/seat?room=${room.code}&session=${guest.sessionToken}&player=${host.player.id}`)).status, 403);
  assert.equal((await request(`/api/seat?room=${room.code}&session=${host.sessionToken}&player=${guest.player.id}`)).payload.recoveryKey, guest.recoveryKey);
  await Promise.all(streams.splice(0).map((stream) => stream.close()));
  await server.close();
  room = await readRoomCheckpoint(persistence.path);
  persistence = await createRoomPersistence(room, { directory });
  server = await createRoomServer(room, 0, { persistence, packLibrary: [{ pack }] });
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  const rejoin = await request("/api/join", { roomCode: room.code, resumeToken: guest.sessionToken });
  assert.equal(rejoin.payload.player.id, guest.player.id);
  const resumed = await request("/api/join", { roomCode: room.code, seatKey: guest.recoveryKey });
  assert.equal(resumed.payload.player.id, guest.player.id);
  const retried = await request("/api/message", { ...body, sessionToken: resumed.payload.sessionToken });
  assert.equal(retried.payload.duplicate, true); assert.equal(retried.payload.state.deck.count, 53);
  assert.equal(retried.payload.state.cards[0].id, ownCard.id); assert.deepEqual(retried.payload.state.cards[0].face, ownCard.face);
  const archive = (await request(`/api/game?room=${room.code}&session=${host.sessionToken}`)).payload;
  const restore = await request("/api/game/restore", { roomCode: room.code, sessionToken: host.sessionToken,
    message: { type: "command", id: "restore-once-0001", command: { type: "restore-game", game: archive } } });
  assert.equal(restore.status, 200);
  assert.ok((await readdir(directory)).some((file) => file.includes("-before-")));
  const stale = structuredClone(body); stale.message.id = "stale-command-001";
  assert.equal((await request("/api/message", stale)).payload.code, "GAME_CHANGED");
  assert.equal(room.deckOrder.length, 53);
});
