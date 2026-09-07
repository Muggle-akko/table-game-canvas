import {
  RoomError,
  TABLE_GEOMETRY,
  applyCommand,
  addRoomPack,
  exportRoomScene,
  exportRoomGame,
  restoreRoomScene,
  restoreRoomGame,
  validateRoomGame,
  joinRoom,
  playerForSession,
  publicStackForCard,
  tokenStackMembers,
  cardSource,
  isExposedDeckCard,
  projectRoom,
  replaceRoomPack,
  roomSummary,
  setPlayerConnection,
  requestPrivateCards,
  cancelPrivateCardRequest,
  validatePortablePack
} from "./room-engine.mjs";
import { RoomAssetError } from "./room-assets.mjs";
import { createHash, randomUUID } from "node:crypto";

function corsHeaders(request) {
  return {
    "Access-Control-Allow-Origin": request.headers.origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function sendJson(request, response, statusCode, payload) {
  response.writeHead(statusCode, {
    ...corsHeaders(request),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function sendAsset(request, response, asset, { privateAsset = false } = {}) {
  response.writeHead(200, {
    ...corsHeaders(request),
    "Content-Type": asset.contentType,
    "Content-Length": String(asset.size ?? asset.bytes.length),
    "Cache-Control": privateAsset ? "private, no-store" : "public, max-age=86400, immutable",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(asset.bytes);
}

function writeEvent(stream, payload) {
  if (stream.closed || stream.response.destroyed) return false;
  try {
    stream.response.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    stream.closed = true;
    return false;
  }
}

async function readJsonBody(request, limit = 1_048_576) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RoomError("BODY_TOO_LARGE", `请求超过 ${limit / 1_048_576} MB，请缩小资源包或存档。`, 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RoomError("INVALID_JSON", "请求格式不正确。");
  }
}

function safeRoomMatch(room, value) {
  return String(value ?? "").toUpperCase() === room.code;
}

const validDragId = (value) => typeof value === "string" && /^[\w-]{1,80}$/.test(value);

function sanitizeDragPreview(room, player, value, stackCache) {
  if (!value || typeof value !== "object") return null;
  const sourceType = String(value.sourceType || "");
  if (!["card", "stack", "deck", "token", "token-stack", "object"].includes(sourceType)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  let resourceId = null;
  let cardCount = null;
  let tokenCount = null;
  if (sourceType === "stack") {
    resourceId = String(value.resourceId || "");
    try {
      let cached = stackCache.get(player.id);
      if (!cached || cached.revision !== room.revision || cached.resourceId !== resourceId) {
        cached = { revision: room.revision, resourceId, cards: publicStackForCard(room, resourceId) };
        stackCache.set(player.id, cached);
      }
      const cards = cached.cards;
      if (cards.some((card) => card.locked)) return null;
      cardCount = cards.length;
    } catch (error) {
      if (error instanceof RoomError) return null;
      throw error;
    }
  } else if (sourceType === "token-stack") {
    resourceId = String(value.resourceId || "");
    const tokens = tokenStackMembers(room.tokens.values(), resourceId);
    if (tokens.length < 2 || tokens.some((token) => token.locked)) return null;
    tokenCount = tokens.length;
  } else if (sourceType === "card") {
    resourceId = String(value.resourceId || "");
    const card = room.cards.get(resourceId);
    const canControl = card && !["deck", "bag"].includes(card.zone)
      && (player.role === "host" || card.zone === "public" || card.ownerId === player.id);
    if (!canControl || card.locked) return null;
  } else if (sourceType === "token") {
    resourceId = String(value.resourceId || "");
    const token = room.tokens.get(resourceId);
    if (!token || token.bagId || token.locked) return null;
  } else if (sourceType === "object") {
    resourceId = String(value.resourceId || "");
    const object = room.objects.get(resourceId);
    if (!object || object.bagId || object.locked) return null;
  } else {
    resourceId = String(value.resourceId || "main");
    if (!room.decks.has(resourceId) || room.decks.get(resourceId).hidden || room.decks.get(resourceId).locked) return null;
  }

  return {
    sourceType,
    resourceId,
    ...(cardCount ? { cardCount } : {}),
    ...(tokenCount ? { tokenCount } : {}),
    ...(typeof value.dragId === "string" && /^[\w-]{1,80}$/.test(value.dragId) ? { dragId: value.dragId } : {}),
    x: clampWorld(x, "x"),
    y: clampWorld(y, "y"),
    rotation: Math.max(-180, Math.min(180, Number(value.rotation) || 0)),
    placeFaceDown: sourceType !== "stack" && value.placeFaceDown === true
  };
}

function clampWorld(value, axis) {
  const zone = TABLE_GEOMETRY.publicZone;
  return Math.max(zone[axis], Math.min(zone[axis] + zone[axis === "x" ? "width" : "height"], value));
}

export function createRoomTransport(room, { loadAsset = null, loadPack = null, persistence = null } = {}) {
  const streams = new Set();
  const lastCursorAt = new Map();
  const lastPingAt = new Map();
  const stackCache = new Map(), endedDrags = new Map();
  const syncId = randomUUID(), signals = [], pollingSessions = new Map();
  let signalSequence = 0;
  let nextPingId = 1;
  let commandQueue = Promise.resolve();
  const operations = new Set();
  let closing = false;
  const tracked = (promise) => {
    operations.add(promise);
    promise.then(() => operations.delete(promise), () => operations.delete(promise));
    return promise;
  };
  const serialize = (operation) => {
    const next = commandQueue.catch(() => {}).then(operation);
    commandQueue = next;
    return next;
  };
  const persist = () => persistence?.save();
  const packLoads = new Map();

  const executeCommand = async (playerId, message) => {
    const command = message.command;
    const commandId = message.id;
    if (commandId !== undefined && (typeof commandId !== "string" || !/^[\w-]{8,80}$/.test(commandId))) throw new RoomError("INVALID_COMMAND_ID", "操作编号无效。");
    if (!command || typeof command.type !== "string") throw new RoomError("INVALID_COMMAND", "无法识别这次操作。");
    const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const receiptKey = commandId ? `${playerId}:${commandId}` : null;
    let loadedPack;
    if (["replace-pack", "add-pack"].includes(command.type) && !room.commandReceipts.has(receiptKey)) {
      if (typeof loadPack !== "function") throw new RoomError("PACK_NOT_AVAILABLE", "这个房间没有可更换的牌盒。", 404);
      const id = String(command.packId || "").slice(0, 40);
      if (!packLoads.has(id)) packLoads.set(id, Promise.resolve().then(() => loadPack(id)));
      try { loadedPack = await packLoads.get(id); }
      finally { packLoads.delete(id); }
    }
    return serialize(async () => {
    const player = room.players.get(playerId);
    if (!player) throw new RoomError("SESSION_EXPIRED", "这个席位已离开，请重新入座。", 401);
    const previous = receiptKey ? room.commandReceipts.get(receiptKey) : null;
    if (previous && previous.fingerprint !== fingerprint) throw new RoomError("COMMAND_ID_REUSED", "这次操作编号已被用于另一项操作，请刷新页面。", 409);
    let createdResource = previous?.createdResource;
    if (!previous) {
      if (message.gameId && message.gameId !== room.gameId) throw new RoomError("GAME_CHANGED", "房主已经切换对局，这次旧操作没有执行。", 409);
      if (message.epoch && message.epoch !== room.epoch) throw new RoomError("GAME_CHANGED", "房主已经撤销操作或恢复存档，这次旧操作没有执行。", 409);
      if (Number.isSafeInteger(message.baseRevision) && message.baseRevision <= room.receiptFloorRevision) throw new RoomError("RECEIPT_EXPIRED", "这次操作的回执已过期，请检查桌面后重新操作。", 409);
      const beforePlayers = new Set(room.players.keys());
      if (["replace-pack", "add-pack"].includes(command.type)) {
        if (command.type === "add-pack") createdResource = { type: "deck", id: addRoomPack(room, player.id, loadedPack, command) };
        else replaceRoomPack(room, player.id, loadedPack);
      } else if (command.type === "import-pack") {
        if (player.role !== "host") throw new RoomError("HOST_ONLY", "只有房主可以导入牌盒。", 403);
        createdResource = { type: "deck", id: addRoomPack(room, player.id, validatePortablePack(command.pack), command) };
      } else if (command.type === "restore-scene") {
        restoreRoomScene(room, player.id, command.scene);
      } else if (command.type === "restore-game") {
        if (player.role !== "host") throw new RoomError("HOST_ONLY", "只有房主可以恢复完整对局。", 403);
        validateRoomGame(command.game);
        await persistence?.backup();
        restoreRoomGame(room, player.id, command.game);
      } else createdResource = applyCommand(room, player.id, command)?.createdResource;
      if (receiptKey) {
        room.commandReceipts.set(receiptKey, { fingerprint, revision: room.revision, ...(createdResource ? { createdResource } : {}) });
        while (room.commandReceipts.size > 1024) {
          const oldest = room.commandReceipts.keys().next().value;
          room.receiptFloorRevision = Math.max(room.receiptFloorRevision, room.commandReceipts.get(oldest).revision);
          room.commandReceipts.delete(oldest);
        }
      }
      for (const id of beforePlayers) if (!room.players.has(id)) broadcastCursorLeave(id);
    }
    try { await persist(); }
    catch (error) { broadcastState(); finishDragSignal(playerId, message.dragId, room.revision); throw error; }
    broadcastState();
    finishDragSignal(playerId, message.dragId, room.revision);
    return {
      ok: true, revision: room.revision, duplicate: Boolean(previous), durable: Boolean(persistence),
      ...(room.players.has(playerId) ? { state: projectRoom(room, playerId) } : {}),
      ...(createdResource ? { createdResource } : {})
    };
    });
  };

  const removeStream = (stream, { announce = true } = {}) => {
    if (!streams.has(stream)) return;
    stream.closed = true;
    streams.delete(stream);
    try {
      setPlayerConnection(room, stream.playerId, -1);
    } catch {
      // A stale stream cannot outlive the room process.
    }
    if (announce) {
      if (!room.players.get(stream.playerId)?.connections) broadcastCursorLeave(stream.playerId);
      broadcastState();
    }
  };

  const broadcastState = () => {
    const stale = [];
    for (const stream of streams) {
      try {
        if (!writeEvent(stream, projectRoom(room, stream.playerId))) stale.push(stream);
      } catch {
        stale.push(stream);
      }
    }
    for (const stream of stale) {
      stream.response.end();
      removeStream(stream, { announce: false });
    }
  };

  const broadcastSignal = (payload, exceptPlayerId = null) => {
    signals.push({ sequence: ++signalSequence, at: Date.now(), payload, exceptPlayerId });
    if (signals.length > 512) signals.splice(0, signals.length - 512);
    for (const stream of streams) if (stream.playerId !== exceptPlayerId) writeEvent(stream, payload);
  };

  const finishDragSignal = (playerId, dragId, revision) => {
    if (!validDragId(dragId)) return;
    const key = `${playerId}:${dragId}`;
    revision ??= endedDrags.get(key)?.revision;
    endedDrags.set(key, { at: Date.now(), revision });
    if (endedDrags.size > 256) endedDrags.delete(endedDrags.keys().next().value);
    broadcastSignal({ type: "drag-end", playerId, dragId, ...(Number.isSafeInteger(revision) ? { revision } : {}) });
  };

  const broadcastCursorLeave = (playerId) => broadcastSignal({ type: "cursor-leave", playerId });

  const handle = async (request, response) => {
    const requestUrl = new URL(request.url || "/", "http://room.local");

    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders(request));
      response.end();
      return true;
    }

    if (!requestUrl.pathname.startsWith("/api/")) return false;

    try {
      if (request.method === "GET" && requestUrl.pathname === "/api/health") {
        sendJson(request, response, 200, { ok: true, roomCode: room.code, revision: room.revision });
        return true;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/room") {
        if (!safeRoomMatch(room, requestUrl.searchParams.get("room"))) {
          throw new RoomError("ROOM_NOT_FOUND", "房间不在。请确认房主仍在开房。", 404);
        }
        sendJson(request, response, 200, roomSummary(room));
        return true;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/asset") {
        if (!safeRoomMatch(room, requestUrl.searchParams.get("room"))) {
          throw new RoomError("ROOM_NOT_FOUND", "房间不在。", 404);
        }
        if (typeof loadAsset !== "function") {
          throw new RoomError("ASSET_NOT_FOUND", "这个房间没有可读取的图片资源。", 404);
        }

        const kind = requestUrl.searchParams.get("kind") || "";
        const resourceId = requestUrl.searchParams.get("id") || "";
        let reference = null;
        let privateAsset = false;
        let packId = room.pack.id;

        if (kind === "back") {
          const deck = room.decks.get(resourceId || "main");
          reference = !deck?.hidden ? deck?.back.image : null;
          packId = deck?.packId;
        } else if (kind === "token") {
          const token = room.tokens.get(resourceId);
          reference = token && !token.bagId ? token.image : null;
          packId = token?.packId || room.pack.id;
        } else if (kind === "card" || kind === "card-back") {
          const player = playerForSession(room, requestUrl.searchParams.get("session") || "");
          if (!player) throw new RoomError("SESSION_EXPIRED", "玩家身份已失效，请重新加入。", 401);
          const card = room.cards.get(resourceId);
          if (!card) throw new RoomError("ASSET_NOT_FOUND", "图片资源不存在。", 404);
          const canSeeFace = ((card.zone === "public" || isExposedDeckCard(room, card)) && card.faceUp)
            || (card.zone === "hand" && (card.ownerId === player.id || card.faceUp));
          const canSeeBack = ["public", "hand"].includes(card.zone) || isExposedDeckCard(room, card);
          if (kind === "card" ? !canSeeFace : !canSeeBack) throw new RoomError("ASSET_FORBIDDEN", "你无权查看这张牌的图片。", 403);
          const source = cardSource(room, card);
          reference = kind === "card-back" ? source.back.image : card.face.image;
          packId = source.packId;
          privateAsset = true;
        } else {
          throw new RoomError("ASSET_NOT_FOUND", "图片资源不存在。", 404);
        }

        if (!reference) throw new RoomError("ASSET_NOT_FOUND", "图片资源不存在。", 404);
        sendAsset(request, response, await loadAsset(reference, packId), { privateAsset });
        return true;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/sync") {
        if (closing) throw new RoomError("ROOM_CLOSING", "房主正在保存并关闭这桌，请稍后续局。", 503);
        if (!safeRoomMatch(room, requestUrl.searchParams.get("room"))) throw new RoomError("ROOM_NOT_FOUND", "房间不在。", 404);
        const sessionToken = requestUrl.searchParams.get("session") || "";
        const player = playerForSession(room, sessionToken);
        if (!player) throw new RoomError("SESSION_EXPIRED", "玩家身份已失效，请重新加入。", 401);
        if (!pollingSessions.has(sessionToken)) {
          setPlayerConnection(room, player.id, 1);
          broadcastState();
        }
        pollingSessions.set(sessionToken, { playerId: player.id, at: Date.now() });
        const cursor = Number(requestUrl.searchParams.get("cursor"));
        const reset = requestUrl.searchParams.get("sync") !== syncId || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > signalSequence;
        const pending = reset ? [] : signals.filter((signal) => signal.sequence > cursor
          && signal.at > Date.now() - 15000 && signal.exceptPlayerId !== player.id);
        // A slow connection needs only each player's latest pointer position.
        const latestCursor = new Map(pending.filter(({ payload }) => payload.type === "cursor").map((signal) => [signal.payload.playerId, signal]));
        const events = pending.filter((signal) => signal.payload.type !== "cursor" || latestCursor.get(signal.payload.playerId) === signal).map(({ payload }) => payload);
        if (reset) for (const signal of room.cardRequests.values()) if (signal.expiresAt > Date.now()) events.push(signal);
        const changed = reset || Number(requestUrl.searchParams.get("revision")) !== room.revision
          || requestUrl.searchParams.get("epoch") !== room.epoch;
        sendJson(request, response, 200, { type: "room-sync", sync: syncId, cursor: signalSequence, reset,
          state: changed ? projectRoom(room, player.id) : null, events });
        return true;
      }

      if (request.method === "GET" && ["/api/save", "/api/game", "/api/state", "/api/seat"].includes(requestUrl.pathname)) {
        if (!safeRoomMatch(room, requestUrl.searchParams.get("room"))) throw new RoomError("ROOM_NOT_FOUND", "房间不在。", 404);
        const player = playerForSession(room, requestUrl.searchParams.get("session") || "");
        if (!player) throw new RoomError("SESSION_EXPIRED", "请重新加入房间。", 401);
        let result;
        if (requestUrl.pathname === "/api/state") result = projectRoom(room, player.id);
        else if (requestUrl.pathname === "/api/seat") {
          const targetId = requestUrl.searchParams.get("player") || player.id;
          if (player.role !== "host" && targetId !== player.id) throw new RoomError("NO_CONTROL", "你只能领取自己的续局口令。", 403);
          const target = room.players.get(targetId);
          if (!target) throw new RoomError("PLAYER_NOT_FOUND", "没有这个席位。", 404);
          result = { playerId: target.id, name: target.name, recoveryKey: target.recoveryKey, gameId: room.gameId };
        } else {
          const exportGame = requestUrl.pathname === "/api/game" ? exportRoomGame : exportRoomScene;
          result = exportGame(room, player.id, requestUrl.searchParams.get("name") || room.title);
        }
        sendJson(request, response, 200, result);
        return true;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/join") {
        if (closing) throw new RoomError("ROOM_CLOSING", "房主正在保存并关闭这桌，请稍后续局。", 503);
        const body = await readJsonBody(request);
        if (!safeRoomMatch(room, body.roomCode)) {
          throw new RoomError("ROOM_NOT_FOUND", "房间不在。请向房主重新索取链接。", 404);
        }
        const result = await tracked(serialize(async () => {
          const joined = joinRoom(room, {
          displayName: body.displayName,
          hostSecret: body.hostSecret,
          resumeToken: body.resumeToken,
          seatKey: body.seatKey
          });
          // Return the new credentials even if disk storage fails, so the browser can retry the same seat.
          try { await persist(); } catch { /* persistence status is sent with the join acknowledgement */ }
          return joined;
        }));
        sendJson(request, response, 200, {
          ok: true,
          player: {
            id: result.player.id,
            name: result.player.name,
            color: result.player.color,
            role: result.player.role
          },
          sessionToken: result.sessionToken,
          recoveryKey: result.player.recoveryKey,
          gameId: room.gameId,
          persistence: { ...room.persistence },
          state: projectRoom(room, result.player.id),
          resumed: result.resumed
        });
        broadcastState();
        return true;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/events") {
        if (!safeRoomMatch(room, requestUrl.searchParams.get("room"))) {
          throw new RoomError("ROOM_NOT_FOUND", "房间不在。", 404);
        }
        const sessionToken = requestUrl.searchParams.get("session") || "";
        const player = playerForSession(room, sessionToken);
        if (!player) throw new RoomError("SESSION_EXPIRED", "玩家身份已失效，请重新加入。", 401);

        response.writeHead(200, {
          ...corsHeaders(request),
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no"
        });
        response.write("retry: 1200\n\n");
        response.flushHeaders?.();

        const stream = { response, playerId: player.id, closed: false };
        streams.add(stream);
        setPlayerConnection(room, player.id, 1);
        writeEvent(stream, projectRoom(room, player.id));
        for (const signal of room.cardRequests.values()) if (signal.expiresAt > Date.now()) writeEvent(stream, signal);
        broadcastState();

        request.once("close", () => removeStream(stream));
        return true;
      }

      if (request.method === "POST" && ["/api/message", "/api/game/restore"].includes(requestUrl.pathname)) {
        const restoreRoute = requestUrl.pathname === "/api/game/restore";
        const body = await readJsonBody(request, restoreRoute ? 12 * 1_048_576 : 1_048_576);
        if (!safeRoomMatch(room, body.roomCode)) {
          throw new RoomError("ROOM_NOT_FOUND", "房间不在。", 404);
        }
        const player = playerForSession(room, String(body.sessionToken || ""));
        if (!player) throw new RoomError("SESSION_EXPIRED", "玩家身份已失效，请重新加入。", 401);
        const message = body.message;
        if (!message || typeof message.type !== "string") {
          throw new RoomError("INVALID_MESSAGE", "无法识别这次操作。");
        }
        if (restoreRoute && (message.type !== "command" || message.command?.type !== "restore-game")) throw new RoomError("INVALID_COMMAND", "这个入口仅接受完整对局存档。");

        if (message.type === "cursor") {
          const now = Date.now();
          if (now - (lastCursorAt.get(player.id) || 0) >= 70) {
            lastCursorAt.set(player.id, now);
            const x = Number(message.x);
            const y = Number(message.y);
            if (Number.isFinite(x) && Number.isFinite(y)) {
              const payload = {
                type: "cursor",
                playerId: player.id,
                name: player.name,
                color: player.color,
                x: clampWorld(x, "x"),
                y: clampWorld(y, "y"),
                drag: endedDrags.has(`${player.id}:${message.drag?.dragId}`) ? null : sanitizeDragPreview(room, player, message.drag, stackCache)
              };
              broadcastSignal(payload, player.id);
            }
          }
          sendJson(request, response, 200, { ok: true });
          return true;
        }

        if (message.type === "cursor-leave") {
          broadcastCursorLeave(player.id);
          sendJson(request, response, 200, { ok: true });
          return true;
        }

        if (message.type === "drag-drop") {
          const drag = !endedDrags.has(`${player.id}:${message.drag?.dragId}`) && sanitizeDragPreview(room, player, message.drag, stackCache);
          if (drag && validDragId(drag.dragId)) broadcastSignal({ type: "drag-drop", playerId: player.id, name: player.name, color: player.color, drag }, player.id);
          sendJson(request, response, 200, { ok: true });
          return true;
        }

        if (message.type === "drag-end") {
          if (validDragId(message.dragId)) finishDragSignal(player.id, message.dragId);
          else broadcastSignal({ type: "drag-end", playerId: player.id }, player.id);
          sendJson(request, response, 200, { ok: true });
          return true;
        }

        if (message.type === "card-request" || message.type === "card-request-end") {
          const signal = message.type === "card-request"
            ? requestPrivateCards(room, player.id, message.cardIds)
            : cancelPrivateCardRequest(room, player.id);
          broadcastSignal(signal);
          sendJson(request, response, 200, { ok: true, signal });
          return true;
        }

        if (message.type === "ping") {
          const now = Date.now();
          const x = Number(message.x);
          const y = Number(message.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new RoomError("INVALID_PING", "没有收到有效的桌面标记位置。");
          }
          if (now - (lastPingAt.get(player.id) || 0) >= 500) {
            lastPingAt.set(player.id, now);
            const payload = {
              type: "ping",
              id: `ping_${nextPingId}`,
              playerId: player.id,
              name: player.name,
              color: player.color,
              x: clampWorld(x, "x"),
              y: clampWorld(y, "y")
            };
            nextPingId += 1;
            broadcastSignal(payload);
          }
          sendJson(request, response, 200, { ok: true });
          return true;
        }

        if (message.type === "state-request") {
          for (const stream of streams) {
            if (stream.playerId === player.id) writeEvent(stream, projectRoom(room, player.id));
          }
          sendJson(request, response, 200, { ok: true, revision: room.revision });
          return true;
        }

        if (message.type === "command") {
          if (closing) throw new RoomError("ROOM_CLOSING", "房主正在保存并关闭这桌，请稍后续局。", 503);
          try { sendJson(request, response, 200, await tracked(executeCommand(player.id, message))); }
          catch (error) {
            if ((error instanceof RoomError || error instanceof RoomAssetError) && error.status < 500 && error.status !== 408) finishDragSignal(player.id, message.dragId);
            throw error;
          }
          return true;
        }

        throw new RoomError("UNKNOWN_MESSAGE", "这个版本还不支持该操作。");
      }

      throw new RoomError("NOT_FOUND", "没有这个入口。", 404);
    } catch (error) {
      const expectedError = error instanceof RoomError || error instanceof RoomAssetError;
      const statusCode = expectedError ? error.status : 500;
      sendJson(request, response, statusCode, {
        ok: false,
        code: expectedError ? error.code : "SERVER_ERROR",
        message: expectedError ? error.message : "房间服务遇到问题，请稍后重试。"
      });
      return true;
    }
  };

  const heartbeat = setInterval(() => {
    for (const [id, ended] of endedDrags) if (ended.at < Date.now() - 15000) endedDrags.delete(id);
    while (signals.length && signals[0].at < Date.now() - 15000) signals.shift();
    for (const [session, polling] of pollingSessions) {
      if (polling.at >= Date.now() - 30000 && room.players.has(polling.playerId)) continue;
      pollingSessions.delete(session);
      if (room.players.has(polling.playerId)) {
        setPlayerConnection(room, polling.playerId, -1);
        if (!room.players.get(polling.playerId).connections) broadcastCursorLeave(polling.playerId);
        broadcastState();
      }
    }
    const stale = [];
    for (const stream of streams) {
      if (stream.closed || stream.response.destroyed) stale.push(stream);
      else {
        try {
          if (!writeEvent(stream, { type: "heartbeat" })) stale.push(stream);
        } catch {
          stale.push(stream);
        }
      }
    }
    for (const stream of stale) removeStream(stream);
  }, 12_000);
  heartbeat.unref();

  return {
    handle,
    get streamCount() {
      return streams.size;
    },
    async flush() {
      closing = true;
      while (operations.size) await Promise.allSettled([...operations]);
      await commandQueue.catch(() => {});
    },
    close() {
      clearInterval(heartbeat);
      for (const stream of [...streams]) {
        stream.closed = true;
        stream.response.end();
        removeStream(stream, { announce: false });
      }
      streams.clear();
      for (const { playerId } of pollingSessions.values()) if (room.players.has(playerId)) setPlayerConnection(room, playerId, -1);
      pollingSessions.clear();
      signals.length = 0;
    }
  };
}
