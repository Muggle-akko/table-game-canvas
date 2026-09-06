import {
  RoomError,
  TABLE_GEOMETRY,
  applyCommand,
  addRoomPack,
  exportRoomScene,
  restoreRoomScene,
  joinRoom,
  playerForSession,
  publicStackForCard,
  projectRoom,
  replaceRoomPack,
  roomSummary,
  setPlayerConnection,
  validatePortablePack
} from "./room-engine.mjs";
import { RoomAssetError } from "./room-assets.mjs";

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

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) throw new RoomError("BODY_TOO_LARGE", "请求超过 1 MB，请缩小资源包或存档。", 413);
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

function sanitizeDragPreview(room, player, value) {
  if (!value || typeof value !== "object") return null;
  const sourceType = String(value.sourceType || "");
  if (!["card", "stack", "deck", "token", "object"].includes(sourceType)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  let resourceId = null;
  let cardIds = null;
  if (sourceType === "stack") {
    resourceId = String(value.resourceId || "");
    try {
      const cards = publicStackForCard(room, resourceId);
      if (cards.some((card) => card.locked)) return null;
      cardIds = cards.map((card) => card.id);
    } catch (error) {
      if (error instanceof RoomError) return null;
      throw error;
    }
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
    if (!room.decks.has(resourceId) || room.decks.get(resourceId).locked) return null;
  }

  return {
    sourceType,
    resourceId,
    ...(cardIds ? { cardIds } : {}),
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

export function createRoomTransport(room, { loadAsset = null, loadPack = null } = {}) {
  const streams = new Set();
  const lastCursorAt = new Map();
  const lastPingAt = new Map();
  let nextPingId = 1;

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
      broadcastCursorLeave(stream.playerId);
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

  const broadcastCursorLeave = (playerId) => {
    for (const stream of streams) writeEvent(stream, { type: "cursor-leave", playerId });
  };

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
          reference = deck?.back.image;
          packId = deck?.packId;
        } else if (kind === "token") {
          const token = room.tokens.get(resourceId);
          reference = token && !token.bagId ? token.image : null;
          packId = token?.packId || room.pack.id;
        } else if (kind === "card") {
          const player = playerForSession(room, requestUrl.searchParams.get("session") || "");
          if (!player) throw new RoomError("SESSION_EXPIRED", "玩家身份已失效，请重新加入。", 401);
          const card = room.cards.get(resourceId);
          if (!card) throw new RoomError("ASSET_NOT_FOUND", "图片资源不存在。", 404);
          const canSeeFace = (card.zone === "public" && card.faceUp)
            || (card.zone === "hand" && card.ownerId === player.id);
          if (!canSeeFace) throw new RoomError("ASSET_FORBIDDEN", "你无权查看这张牌的正面。", 403);
          reference = card.face.image;
          packId = room.decks.get(card.deckId)?.packId;
          privateAsset = true;
        } else {
          throw new RoomError("ASSET_NOT_FOUND", "图片资源不存在。", 404);
        }

        if (!reference) throw new RoomError("ASSET_NOT_FOUND", "图片资源不存在。", 404);
        sendAsset(request, response, await loadAsset(reference, packId), { privateAsset });
        return true;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/save") {
        if (!safeRoomMatch(room, requestUrl.searchParams.get("room"))) throw new RoomError("ROOM_NOT_FOUND", "房间不在。", 404);
        const player = playerForSession(room, requestUrl.searchParams.get("session") || "");
        if (!player) throw new RoomError("SESSION_EXPIRED", "请重新加入房间。", 401);
        sendJson(request, response, 200, exportRoomScene(room, player.id, requestUrl.searchParams.get("name") || room.title));
        return true;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/join") {
        const body = await readJsonBody(request);
        if (!safeRoomMatch(room, body.roomCode)) {
          throw new RoomError("ROOM_NOT_FOUND", "房间不在。请向房主重新索取链接。", 404);
        }
        const result = joinRoom(room, {
          displayName: body.displayName,
          hostSecret: body.hostSecret,
          resumeToken: body.resumeToken
        });
        sendJson(request, response, 200, {
          ok: true,
          player: {
            id: result.player.id,
            name: result.player.name,
            color: result.player.color,
            role: result.player.role
          },
          sessionToken: result.sessionToken,
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
        broadcastState();

        request.once("close", () => removeStream(stream));
        return true;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/message") {
        const body = await readJsonBody(request);
        if (!safeRoomMatch(room, body.roomCode)) {
          throw new RoomError("ROOM_NOT_FOUND", "房间不在。", 404);
        }
        const player = playerForSession(room, String(body.sessionToken || ""));
        if (!player) throw new RoomError("SESSION_EXPIRED", "玩家身份已失效，请重新加入。", 401);
        const message = body.message;
        if (!message || typeof message.type !== "string") {
          throw new RoomError("INVALID_MESSAGE", "无法识别这次操作。");
        }

        if (message.type === "cursor") {
          const now = Date.now();
          if (now - (lastCursorAt.get(player.id) || 0) >= 36) {
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
                drag: sanitizeDragPreview(room, player, message.drag)
              };
              for (const stream of streams) {
                if (stream.playerId !== player.id) writeEvent(stream, payload);
              }
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

        if (message.type === "drag-end") {
          for (const stream of streams) {
            if (stream.playerId !== player.id) writeEvent(stream, { type: "drag-end", playerId: player.id });
          }
          sendJson(request, response, 200, { ok: true });
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
            for (const stream of streams) writeEvent(stream, payload);
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
          const playerIdsBeforeCommand = new Set(room.players.keys());
          if (["replace-pack", "add-pack"].includes(message.command?.type)) {
            if (typeof loadPack !== "function") {
              throw new RoomError("PACK_NOT_AVAILABLE", "这个房间没有可更换的牌盒。", 404);
            }
            const packId = String(message.command.packId || "").slice(0, 40);
            const pack = await loadPack(packId);
            if (message.command.type === "add-pack") addRoomPack(room, player.id, pack, message.command);
            else replaceRoomPack(room, player.id, pack);
          } else if (message.command?.type === "import-pack") {
            if (player.role !== "host") throw new RoomError("HOST_ONLY", "只有房主可以导入牌盒。", 403);
            const pack = validatePortablePack(message.command.pack);
            addRoomPack(room, player.id, pack, message.command);
          } else if (message.command?.type === "restore-scene") {
            restoreRoomScene(room, player.id, message.command.scene);
          } else {
            applyCommand(room, player.id, message.command);
          }
          for (const playerId of playerIdsBeforeCommand) {
            if (!room.players.has(playerId)) broadcastCursorLeave(playerId);
          }
          if (message.command?.type === "leave-seat") {
            sendJson(request, response, 200, { ok: true, revision: room.revision });
            broadcastState();
            return true;
          }
          broadcastState();
          sendJson(request, response, 200, { ok: true, revision: room.revision, state: projectRoom(room, player.id) });
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
    const stale = [];
    for (const stream of streams) {
      if (stream.closed || stream.response.destroyed) stale.push(stream);
      else {
        try {
          stream.response.write(": keep-alive\n\n");
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
    close() {
      clearInterval(heartbeat);
      for (const stream of [...streams]) {
        stream.closed = true;
        stream.response.end();
        removeStream(stream, { announce: false });
      }
      streams.clear();
    }
  };
}
