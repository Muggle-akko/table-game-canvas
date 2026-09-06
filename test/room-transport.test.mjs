import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoom } from "../src/room-engine.mjs";
import { createRoomTransport } from "../src/room-transport.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pack = JSON.parse(await readFile(resolve(root, "game-packs", "parlor-eight.json"), "utf8"));
const unoPack = JSON.parse(await readFile(resolve(root, "game-packs", "uno.json"), "utf8"));

class MockRequest extends EventEmitter {
  constructor({ method = "GET", url = "/", headers = {}, body = null } = {}) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.body = body;
  }

  async *[Symbol.asyncIterator]() {
    if (this.body !== null) yield Buffer.from(typeof this.body === "string" ? this.body : JSON.stringify(this.body));
  }
}

class MockResponse {
  constructor() {
    this.statusCode = null;
    this.headers = {};
    this.chunks = [];
    this.ended = false;
    this.destroyed = false;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end(chunk = "") {
    if (chunk) this.chunks.push(String(chunk));
    this.ended = true;
    return this;
  }

  flushHeaders() {}

  text() {
    return this.chunks.join("");
  }

  json() {
    return JSON.parse(this.text());
  }
}

async function call(transport, options) {
  const request = new MockRequest(options);
  const response = new MockResponse();
  const handled = await transport.handle(request, response);
  return { request, response, handled };
}

function eventPayloads(response) {
  return response.text()
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice(6)));
}

function lastRoomState(response) {
  return eventPayloads(response).reverse().find((payload) => payload.type === "room-state");
}

function messageBody(roomCode, sessionToken, message) {
  return { roomCode, sessionToken, message };
}

test("the authoritative transport filters private faces across join, move, and refresh", async () => {
  const room = createRoom({
    code: "INK-204",
    hostName: "房主A",
    hostSecret: "host-secret",
    pack,
    randomizeDeck: false
  });
  room.shareUrl = "https://table.example/?room=INK-204";
  const transport = createRoomTransport(room);

  try {
    const hostJoin = await call(transport, {
      method: "POST",
      url: "/api/join",
      headers: { origin: "https://table.example" },
      body: { roomCode: room.code, hostSecret: "host-secret" }
    });
    const guestJoin = await call(transport, {
      method: "POST",
      url: "/api/join",
      headers: { origin: "https://table.example" },
      body: { roomCode: room.code, displayName: "客人B" }
    });

    assert.equal(hostJoin.response.statusCode, 200);
    assert.equal(guestJoin.response.statusCode, 200);
    assert.notEqual(hostJoin.response.json().player.color, guestJoin.response.json().player.color);

    const hostSession = hostJoin.response.json().sessionToken;
    const guestSession = guestJoin.response.json().sessionToken;
    const hostEvents = await call(transport, {
      url: `/api/events?room=${room.code}&session=${hostSession}`,
      headers: { origin: "https://table.example" }
    });
    const guestEvents = await call(transport, {
      url: `/api/events?room=${room.code}&session=${guestSession}`,
      headers: { origin: "https://table.example" }
    });

    assert.equal(transport.streamCount, 2);
    assert.match(hostEvents.response.headers["Content-Type"], /text\/event-stream/);

    await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, hostSession, { type: "command", command: { type: "draw" } })
    });

    const hostPrivateState = lastRoomState(hostEvents.response);
    const guestPrivateState = lastRoomState(guestEvents.response);
    const hostPrivateCard = hostPrivateState.cards.find((card) => card.ownerId === hostPrivateState.you.id);
    const guestPlaceholder = guestPrivateState.cards.find((card) => card.id === hostPrivateCard.id);
    assert.ok(hostPrivateCard.face?.label);
    assert.equal(guestPlaceholder.face, null);
    assert.equal(JSON.stringify(guestPrivateState).includes(hostPrivateCard.face.label), false);

    await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, hostSession, {
        type: "command",
        command: { type: "move-card", cardId: hostPrivateCard.id, target: "public", x: 540, y: 390 }
      })
    });
    const guestPublicCard = lastRoomState(guestEvents.response).cards.find((card) => card.id === hostPrivateCard.id);
    assert.equal(guestPublicCard.face.label, hostPrivateCard.face.label);

    await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, hostSession, {
        type: "command",
        command: { type: "flip-card", cardId: hostPrivateCard.id }
      })
    });
    const faceDownPublicCard = lastRoomState(guestEvents.response).cards.find((card) => card.id === hostPrivateCard.id);
    assert.equal(faceDownPublicCard.faceUp, false);
    assert.equal(faceDownPublicCard.face, null);
    assert.equal(JSON.stringify(lastRoomState(guestEvents.response)).includes(hostPrivateCard.face.label), false);

    await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, hostSession, {
        type: "command",
        command: { type: "flip-card", cardId: hostPrivateCard.id }
      })
    });
    assert.equal(
      lastRoomState(guestEvents.response).cards.find((card) => card.id === hostPrivateCard.id).face.label,
      hostPrivateCard.face.label
    );

    await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, hostSession, {
        type: "command",
        command: { type: "move-card", cardId: hostPrivateCard.id, target: "hand" }
      })
    });
    const hiddenAgain = lastRoomState(guestEvents.response).cards.find((card) => card.id === hostPrivateCard.id);
    assert.equal(hiddenAgain.face, null);
    assert.equal(JSON.stringify(lastRoomState(guestEvents.response)).includes(hostPrivateCard.face.label), false);

    guestEvents.request.emit("close");
    assert.equal(transport.streamCount, 1);

    const resumedJoin = await call(transport, {
      method: "POST",
      url: "/api/join",
      body: { roomCode: room.code, resumeToken: guestSession }
    });
    assert.equal(resumedJoin.response.json().resumed, true);
    const refreshedGuest = await call(transport, {
      url: `/api/events?room=${room.code}&session=${guestSession}`
    });
    const refreshedCard = lastRoomState(refreshedGuest.response).cards.find((card) => card.id === hostPrivateCard.id);
    assert.equal(refreshedCard.face, null);
    assert.equal(JSON.stringify(lastRoomState(refreshedGuest.response)).includes(hostPrivateCard.face.label), false);

    await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, hostSession, { type: "cursor", x: 702, y: 418 })
    });
    const cursor = eventPayloads(refreshedGuest.response).reverse().find((payload) => payload.type === "cursor");
    assert.deepEqual(
      { name: cursor.name, color: cursor.color, x: cursor.x, y: cursor.y },
      { name: "房主A", color: hostJoin.response.json().player.color, x: 702, y: 418 }
    );

    const sharedTokenId = lastRoomState(refreshedGuest.response).tokens[0].id;
    await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, guestSession, {
        type: "command",
        command: { type: "move-token", tokenId: sharedTokenId, x: 740, y: 510 }
      })
    });
    const hostToken = lastRoomState(hostEvents.response).tokens.find((token) => token.id === sharedTokenId);
    const guestToken = lastRoomState(refreshedGuest.response).tokens.find((token) => token.id === sharedTokenId);
    assert.deepEqual({ x: hostToken.x, y: hostToken.y }, { x: 740, y: 510 });
    assert.deepEqual({ x: guestToken.x, y: guestToken.y }, { x: 740, y: 510 });

    await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, guestSession, {
        type: "command",
        command: { type: "roll-die" }
      })
    });
    const hostDie = lastRoomState(hostEvents.response).die;
    const guestDie = lastRoomState(refreshedGuest.response).die;
    assert.equal(hostDie.value, guestDie.value);
    assert.ok(hostDie.value >= 1 && hostDie.value <= hostDie.sides);
    assert.equal(hostDie.lastRolledBy, guestJoin.response.json().player.id);
  } finally {
    transport.close();
  }
});

test("serves mapped artwork while enforcing current card visibility", async () => {
  const artworkPack = structuredClone(pack);
  artworkPack.cardBack.image = "art/back.png";
  artworkPack.tokens[0].image = "art/token.png";
  for (const card of artworkPack.cards) card.image = "art/front.png";
  const room = createRoom({
    code: "ART-204",
    hostName: "房主A",
    hostSecret: "host-secret",
    pack: artworkPack,
    randomizeDeck: false
  });
  const loadedReferences = [];
  const transport = createRoomTransport(room, {
    loadAsset: async (reference) => {
      loadedReferences.push(reference);
      const bytes = Buffer.from(`asset:${reference}`);
      return { bytes, contentType: "image/png", size: bytes.length };
    }
  });

  try {
    const back = await call(transport, { url: `/api/asset?room=${room.code}&kind=back&id=main` });
    assert.equal(back.response.statusCode, 200);
    assert.equal(back.response.text(), "asset:art/back.png");
    assert.match(back.response.headers["Cache-Control"], /immutable/);
    assert.equal(back.response.headers["Cross-Origin-Resource-Policy"], "cross-origin");
    const missingBack = await call(transport, { url: `/api/asset?room=${room.code}&kind=back&id=missing` });
    assert.equal(missingBack.response.statusCode, 404);

    const tokenId = [...room.tokens.keys()][0];
    const token = await call(transport, { url: `/api/asset?room=${room.code}&kind=token&id=${tokenId}` });
    assert.equal(token.response.statusCode, 200);
    assert.equal(token.response.text(), "asset:art/token.png");

    const hostJoin = await call(transport, {
      method: "POST",
      url: "/api/join",
      body: { roomCode: room.code, hostSecret: "host-secret" }
    });
    const guestJoin = await call(transport, {
      method: "POST",
      url: "/api/join",
      body: { roomCode: room.code, displayName: "客人B" }
    });
    const hostSession = hostJoin.response.json().sessionToken;
    const guestSession = guestJoin.response.json().sessionToken;
    const hostEvents = await call(transport, {
      url: `/api/events?room=${room.code}&session=${hostSession}`
    });
    const guestEvents = await call(transport, {
      url: `/api/events?room=${room.code}&session=${guestSession}`
    });

    await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, hostSession, { type: "command", command: { type: "draw" } })
    });
    const hostCard = lastRoomState(hostEvents.response).cards.find((card) => card.ownerId === lastRoomState(hostEvents.response).you.id);
    assert.equal(hostCard.face.hasImage, true);
    assert.equal(lastRoomState(guestEvents.response).cards.find((card) => card.id === hostCard.id).face, null);
    assert.equal(JSON.stringify(lastRoomState(hostEvents.response)).includes("art/front.png"), false);

    const missingSession = await call(transport, {
      url: `/api/asset?room=${room.code}&kind=card&id=${hostCard.id}`
    });
    assert.equal(missingSession.response.statusCode, 401);

    const forbidden = await call(transport, {
      url: `/api/asset?room=${room.code}&kind=card&id=${hostCard.id}&session=${guestSession}`
    });
    assert.equal(forbidden.response.statusCode, 403);
    assert.equal(loadedReferences.filter((reference) => reference === "art/front.png").length, 0);

    const privateFace = await call(transport, {
      url: `/api/asset?room=${room.code}&kind=card&id=${hostCard.id}&session=${hostSession}`
    });
    assert.equal(privateFace.response.statusCode, 200);
    assert.equal(privateFace.response.text(), "asset:art/front.png");
    assert.equal(privateFace.response.headers["Cache-Control"], "private, no-store");

    await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, hostSession, {
        type: "command",
        command: { type: "move-card", cardId: hostCard.id, target: "public", x: 540, y: 390 }
      })
    });
    const publicFace = await call(transport, {
      url: `/api/asset?room=${room.code}&kind=card&id=${hostCard.id}&session=${guestSession}`
    });
    assert.equal(publicFace.response.statusCode, 200);

    await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, hostSession, {
        type: "command",
        command: { type: "flip-card", cardId: hostCard.id }
      })
    });
    const hiddenAgain = await call(transport, {
      url: `/api/asset?room=${room.code}&kind=card&id=${hostCard.id}&session=${guestSession}`
    });
    assert.equal(hiddenAgain.response.statusCode, 403);
  } finally {
    transport.close();
  }
});

test("broadcasts rate-limited attention pings without changing room state", async () => {
  const room = createRoom({
    code: "INK-204",
    hostName: "房主A",
    hostSecret: "host-secret",
    pack,
    randomizeDeck: false
  });
  const transport = createRoomTransport(room);

  try {
    const hostJoin = await call(transport, {
      method: "POST",
      url: "/api/join",
      body: { roomCode: room.code, hostSecret: "host-secret" }
    });
    const guestJoin = await call(transport, {
      method: "POST",
      url: "/api/join",
      body: { roomCode: room.code, displayName: "客人B" }
    });
    const hostSession = hostJoin.response.json().sessionToken;
    const guestSession = guestJoin.response.json().sessionToken;
    const hostEvents = await call(transport, {
      url: `/api/events?room=${room.code}&session=${hostSession}`
    });
    const guestEvents = await call(transport, {
      url: `/api/events?room=${room.code}&session=${guestSession}`
    });
    const revisionBeforePing = room.revision;

    const result = await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, hostSession, { type: "ping", x: 9999, y: -50 })
    });
    assert.equal(result.response.statusCode, 200);
    const hostPing = eventPayloads(hostEvents.response).reverse().find((payload) => payload.type === "ping");
    const guestPing = eventPayloads(guestEvents.response).reverse().find((payload) => payload.type === "ping");
    assert.deepEqual(
      { playerId: guestPing.playerId, name: guestPing.name, color: guestPing.color, x: guestPing.x, y: guestPing.y },
      {
        playerId: hostJoin.response.json().player.id,
        name: "房主A",
        color: hostJoin.response.json().player.color,
      x: 6300,
      y: -50
      }
    );
    assert.equal(hostPing.id, guestPing.id);
    assert.equal(room.revision, revisionBeforePing);

    const invalid = await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, guestSession, { type: "ping", x: "nope", y: 100 })
    });
    assert.equal(invalid.response.statusCode, 400);
    assert.equal(invalid.response.json().code, "INVALID_PING");
  } finally {
    transport.close();
  }
});

test("streams sanitized drag previews while keeping private card faces off the wire", async () => {
  const room = createRoom({
    code: "INK-204",
    hostName: "房主A",
    hostSecret: "host-secret",
    pack,
    randomizeDeck: false
  });
  const transport = createRoomTransport(room);

  try {
    const hostJoin = await call(transport, {
      method: "POST",
      url: "/api/join",
      body: { roomCode: room.code, hostSecret: "host-secret" }
    });
    const guestJoin = await call(transport, {
      method: "POST",
      url: "/api/join",
      body: { roomCode: room.code, displayName: "客人B" }
    });
    const hostSession = hostJoin.response.json().sessionToken;
    const guestSession = guestJoin.response.json().sessionToken;
    const hostEvents = await call(transport, {
      url: `/api/events?room=${room.code}&session=${hostSession}`
    });
    const guestEvents = await call(transport, {
      url: `/api/events?room=${room.code}&session=${guestSession}`
    });

    await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, hostSession, { type: "command", command: { type: "draw" } })
    });
    const privateCard = lastRoomState(hostEvents.response).cards.find(
      (card) => card.ownerId === hostJoin.response.json().player.id
    );
    const privateLabel = privateCard.face.label;

    await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, hostSession, {
        type: "cursor",
        x: 620,
        y: 430,
        drag: {
          sourceType: "card",
          resourceId: privateCard.id,
          x: 590,
          y: 390,
          rotation: 999,
          placeFaceDown: true,
          face: { label: privateLabel }
        }
      })
    });
    const hostDrag = eventPayloads(guestEvents.response).reverse().find(
      (payload) => payload.type === "cursor" && payload.playerId === hostJoin.response.json().player.id
    );
    assert.deepEqual(hostDrag.drag, {
      sourceType: "card",
      resourceId: privateCard.id,
      x: 590,
      y: 390,
      rotation: 180,
      placeFaceDown: true
    });
    assert.equal(JSON.stringify(hostDrag).includes(privateLabel), false);
    assert.equal(Object.hasOwn(hostDrag.drag, "face"), false);

    await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, guestSession, {
        type: "cursor",
        x: 700,
        y: 470,
        drag: {
          sourceType: "card",
          resourceId: privateCard.id,
          x: 680,
          y: 440
        }
      })
    });
    const spoofedDrag = eventPayloads(hostEvents.response).reverse().find(
      (payload) => payload.type === "cursor" && payload.playerId === guestJoin.response.json().player.id
    );
    assert.equal(spoofedDrag.drag, null);

    await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, hostSession, { type: "drag-end" })
    });
    const dragEnd = eventPayloads(guestEvents.response).reverse().find((payload) => payload.type === "drag-end");
    assert.equal(dragEnd.playerId, hostJoin.response.json().player.id);
  } finally {
    transport.close();
  }
});

test("streams the complete authoritative stack and broadcasts its move atomically", async () => {
  const room = createRoom({ code: "INK-204", hostName: "房主A", hostSecret: "host-secret", pack, randomizeDeck: false });
  const transport = createRoomTransport(room);
  try {
    const hostJoin = await call(transport, {
      method: "POST", url: "/api/join", body: { roomCode: room.code, hostSecret: "host-secret" }
    });
    const guestJoin = await call(transport, {
      method: "POST", url: "/api/join", body: { roomCode: room.code, displayName: "客人B" }
    });
    const hostSession = hostJoin.response.json().sessionToken;
    const guestSession = guestJoin.response.json().sessionToken;
    const hostEvents = await call(transport, { url: `/api/events?room=${room.code}&session=${hostSession}` });
    const guestEvents = await call(transport, { url: `/api/events?room=${room.code}&session=${guestSession}` });
    const send = (session, message) => call(transport, {
      method: "POST", url: "/api/message", body: messageBody(room.code, session, message)
    });
    for (let index = 0; index < 3; index += 1) {
      await send(hostSession, { type: "command", command: { type: "draw-public", x: 500 + index * 30, y: 300 + index * 30 } });
    }
    await send(hostSession, { type: "command", command: { type: "draw" } });
    const before = lastRoomState(guestEvents.response);
    const stack = before.cards.filter((card) => card.zone === "public");
    const privateCard = lastRoomState(hostEvents.response).cards.find((card) => card.zone === "hand");
    const anchor = stack[0];
    await send(hostSession, {
      type: "cursor", x: 710, y: 420,
      drag: {
        sourceType: "stack", resourceId: anchor.id, x: 700, y: 400,
        cardIds: [privateCard.id], face: privateCard.face, placeFaceDown: true
      }
    });
    const remoteDrag = eventPayloads(guestEvents.response).filter((event) => event.type === "cursor").at(-1).drag;
    assert.deepEqual(remoteDrag, {
      sourceType: "stack", resourceId: anchor.id, cardIds: stack.map((card) => card.id),
      x: 700, y: 400, rotation: 0, placeFaceDown: false
    });
    assert.equal(JSON.stringify(remoteDrag).includes(privateCard.face.label), false);
    assert.equal(JSON.stringify(remoteDrag).includes(privateCard.id), false);
    assert.equal(lastRoomState(guestEvents.response).revision, before.revision);

    await send(guestSession, {
      type: "cursor", x: 710, y: 420,
      drag: { sourceType: "stack", resourceId: privateCard.id, cardIds: stack.map((card) => card.id), x: 700, y: 400 }
    });
    const invalidDrag = eventPayloads(hostEvents.response).filter((event) => event.type === "cursor").at(-1).drag;
    assert.equal(invalidDrag, null);

    const previousStates = eventPayloads(guestEvents.response).filter((event) => event.type === "room-state").length;
    await send(guestSession, { type: "command", command: { type: "move-stack", cardId: anchor.id, target: "public", x: 700, y: 400 } });
    const after = lastRoomState(guestEvents.response);
    assert.equal(eventPayloads(guestEvents.response).filter((event) => event.type === "room-state").length, previousStates + 1);
    assert.equal(after.revision, before.revision + 1);
    for (const original of stack) {
      const moved = after.cards.find((card) => card.id === original.id);
      assert.equal(moved.x, original.x + 200);
      assert.equal(moved.y, original.y + 100);
      assert.equal(moved.face, null);
      assert.deepEqual(moved, lastRoomState(hostEvents.response).cards.find((card) => card.id === original.id));
    }
    assert.equal(after.cards.find((card) => card.id === privateCard.id).face, null);
  } finally {
    transport.close();
  }
});

test("releases a leaving guest session and immediately frees the seat for the room", async () => {
  const room = createRoom({
    code: "INK-204",
    hostName: "房主A",
    hostSecret: "host-secret",
    pack,
    randomizeDeck: false
  });
  const transport = createRoomTransport(room);

  try {
    const hostJoin = await call(transport, {
      method: "POST",
      url: "/api/join",
      body: { roomCode: room.code, hostSecret: "host-secret" }
    });
    const guestJoin = await call(transport, {
      method: "POST",
      url: "/api/join",
      body: { roomCode: room.code, displayName: "客人B" }
    });
    const hostSession = hostJoin.response.json().sessionToken;
    const guestSession = guestJoin.response.json().sessionToken;
    const hostEvents = await call(transport, {
      url: `/api/events?room=${room.code}&session=${hostSession}`
    });
    await call(transport, {
      url: `/api/events?room=${room.code}&session=${guestSession}`
    });

    const leave = await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, guestSession, { type: "command", command: { type: "leave-seat" } })
    });
    assert.equal(leave.response.statusCode, 200);
    assert.equal(lastRoomState(hostEvents.response).players.length, 1);
    assert.ok(eventPayloads(hostEvents.response).some(
      (payload) => payload.type === "cursor-leave" && payload.playerId === guestJoin.response.json().player.id
    ));

    const staleSession = await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, guestSession, { type: "state-request" })
    });
    assert.equal(staleSession.response.statusCode, 401);
    assert.equal(staleSession.response.json().code, "SESSION_EXPIRED");

    const summary = await call(transport, { url: `/api/room?room=${room.code}` });
    assert.equal(summary.response.json().playerCount, 1);
    const replacement = await call(transport, {
      method: "POST",
      url: "/api/join",
      body: { roomCode: room.code, displayName: "客人C" }
    });
    assert.equal(replacement.response.statusCode, 200);
    assert.equal(room.players.size, 2);
  } finally {
    transport.close();
  }
});

test("broadcasts an overlapping stack shuffle as one private, undoable host-state transition", async () => {
  const room = createRoom({
    code: "INK-204",
    hostName: "房主A",
    hostSecret: "host-secret",
    pack,
    randomizeDeck: false
  });
  const transport = createRoomTransport(room);

  try {
    const hostJoin = await call(transport, {
      method: "POST",
      url: "/api/join",
      body: { roomCode: room.code, hostSecret: "host-secret" }
    });
    const guestJoin = await call(transport, {
      method: "POST",
      url: "/api/join",
      body: { roomCode: room.code, displayName: "客人B" }
    });
    const hostSession = hostJoin.response.json().sessionToken;
    const guestSession = guestJoin.response.json().sessionToken;
    const hostEvents = await call(transport, { url: `/api/events?room=${room.code}&session=${hostSession}` });
    const guestEvents = await call(transport, { url: `/api/events?room=${room.code}&session=${guestSession}` });

    for (const offset of [0, 4]) {
      await call(transport, {
        method: "POST",
        url: "/api/message",
        body: messageBody(room.code, hostSession, {
          type: "command",
          command: { type: "draw-public", x: 640 + offset, y: 390 + offset }
        })
      });
    }
    const before = lastRoomState(hostEvents.response).cards.filter((card) => card.zone === "public");
    const oldIds = new Set(before.map((card) => card.id));

    const shuffled = await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, guestSession, {
        type: "command",
        command: { type: "shuffle-stack", cardId: before.at(-1).id }
      })
    });
    assert.equal(shuffled.response.statusCode, 200);

    const hostStack = lastRoomState(hostEvents.response).cards.filter((card) => card.zone === "public");
    const guestStack = lastRoomState(guestEvents.response).cards.filter((card) => card.zone === "public");
    assert.equal(hostStack.length, 2);
    assert.deepEqual(hostStack.map((card) => card.id), guestStack.map((card) => card.id));
    assert.ok(hostStack.every((card) => card.face === null && card.ownerId === null && !oldIds.has(card.id)));
    assert.ok(guestStack.every((card) => card.face === null));

    await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, hostSession, { type: "command", command: { type: "undo" } })
    });
    const restoredIds = new Set(lastRoomState(hostEvents.response).cards.map((card) => card.id));
    assert.deepEqual(restoredIds, oldIds);
  } finally {
    transport.close();
  }
});

test("broadcasts a host-selected UNO pack without replacing player sessions", async () => {
  const room = createRoom({
    code: "INK-204",
    hostName: "房主A",
    hostSecret: "host-secret",
    pack,
    randomizeDeck: false
  });
  room.packOptions = [
    { id: pack.id, name: pack.name, cardCount: pack.cards.length },
    { id: unoPack.id, name: unoPack.name, cardCount: unoPack.cards.length }
  ];
  const transport = createRoomTransport(room, {
    loadPack: (packId) => {
      if (packId !== "uno") throw new Error("unexpected pack");
      return unoPack;
    }
  });

  try {
    const hostJoin = await call(transport, {
      method: "POST",
      url: "/api/join",
      body: { roomCode: room.code, hostSecret: "host-secret" }
    });
    const guestJoin = await call(transport, {
      method: "POST",
      url: "/api/join",
      body: { roomCode: room.code, displayName: "客人B" }
    });
    const hostSession = hostJoin.response.json().sessionToken;
    const guestSession = guestJoin.response.json().sessionToken;
    const hostEvents = await call(transport, { url: `/api/events?room=${room.code}&session=${hostSession}` });
    const guestEvents = await call(transport, { url: `/api/events?room=${room.code}&session=${guestSession}` });

    const denied = await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, guestSession, {
        type: "command",
        command: { type: "replace-pack", packId: "uno" }
      })
    });
    assert.equal(denied.response.statusCode, 403);
    assert.equal(denied.response.json().code, "HOST_ONLY");

    const replaced = await call(transport, {
      method: "POST",
      url: "/api/message",
      body: messageBody(room.code, hostSession, {
        type: "command",
        command: { type: "replace-pack", packId: "uno" }
      })
    });
    assert.equal(replaced.response.statusCode, 200);
    const hostState = lastRoomState(hostEvents.response);
    const guestState = lastRoomState(guestEvents.response);
    assert.equal(hostState.room.pack.id, "uno");
    assert.equal(hostState.room.packOptions.length, 2);
    assert.equal(hostState.players.length, 2);
    assert.equal(hostState.deck.count, 108);
    assert.equal(guestState.deck.count, 108);
  } finally {
    transport.close();
  }
});

test("returns a clear room-not-found response and ignores non-API paths", async () => {
  const room = createRoom({
    code: "INK-204",
    hostName: "房主A",
    hostSecret: "host-secret",
    pack,
    randomizeDeck: false
  });
  const transport = createRoomTransport(room);
  try {
    const missing = await call(transport, { url: "/api/room?room=BAD-ROOM" });
    assert.equal(missing.response.statusCode, 404);
    assert.equal(missing.response.json().code, "ROOM_NOT_FOUND");
    assert.match(missing.response.json().message, /房间不在/);

    const staticPath = await call(transport, { url: "/styles.css" });
    assert.equal(staticPath.handled, false);
  } finally {
    transport.close();
  }
});

test("supports a separately deployed frontend without exposing private room state", async () => {
  const room = createRoom({
    code: "INK-204",
    hostName: "房主A",
    hostSecret: "host-secret",
    pack,
    randomizeDeck: false
  });
  room.shareUrl = "https://table.example/?room=INK-204&endpoint=https%3A%2F%2Froom.example";
  const transport = createRoomTransport(room);
  const frontendOrigin = "https://table.example";

  try {
    const preflight = await call(transport, {
      method: "OPTIONS",
      url: "/api/join",
      headers: {
        origin: frontendOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type"
      }
    });
    assert.equal(preflight.response.statusCode, 204);
    assert.equal(preflight.response.headers["Access-Control-Allow-Origin"], frontendOrigin);
    assert.match(preflight.response.headers["Access-Control-Allow-Methods"], /POST/);
    assert.match(preflight.response.headers["Access-Control-Allow-Headers"], /Content-Type/i);

    const summary = await call(transport, {
      url: "/api/room?room=INK-204",
      headers: { origin: frontendOrigin }
    });
    assert.equal(summary.response.statusCode, 200);
    assert.equal(summary.response.headers["Access-Control-Allow-Origin"], frontendOrigin);
    assert.equal(summary.response.headers.Vary, "Origin");
    assert.deepEqual(Object.keys(summary.response.json()).sort(), [
      "defaultGuestName",
      "maxPlayers",
      "packName",
      "playerCount",
      "roomAvailable",
      "roomCode",
      "roomTitle",
      "shareUrl"
    ]);
    assert.equal(summary.response.json().defaultGuestName, "玩家2");
    assert.equal(JSON.stringify(summary.response.json()).includes(pack.cards[0].label), false);

    const guestJoin = await call(transport, {
      method: "POST",
      url: "/api/join",
      headers: { origin: frontendOrigin },
      body: { roomCode: room.code, displayName: "客人B" }
    });
    const guestSession = guestJoin.response.json().sessionToken;
    assert.equal(guestJoin.response.headers["Access-Control-Allow-Origin"], frontendOrigin);

    const guestEvents = await call(transport, {
      url: `/api/events?room=${room.code}&session=${guestSession}`,
      headers: { origin: frontendOrigin }
    });
    assert.equal(guestEvents.response.headers["Access-Control-Allow-Origin"], frontendOrigin);
    assert.match(guestEvents.response.headers["Content-Type"], /text\/event-stream/);
    assert.equal(JSON.stringify(lastRoomState(guestEvents.response)).includes(pack.cards[0].label), false);
  } finally {
    transport.close();
  }
});

async function resourceTransportFixture(loadPack) {
  const room = createRoom({ code: "BOX-303", hostSecret: "host-secret", pack, randomizeDeck: false });
  const transport = createRoomTransport(room, { loadPack: loadPack || (async (id) => {
    if (id === unoPack.id) return unoPack;
    throw new Error("Unexpected pack request");
  }) });
  const join = async (body) => (await call(transport, { method: "POST", url: "/api/join", body: { roomCode: room.code, ...body } })).response.json();
  const host = await join({ hostSecret: "host-secret" }), guest = await join({ displayName: "朋友" });
  const message = (who, value) => call(transport, { method: "POST", url: "/api/message", body: messageBody(room.code, who.sessionToken, value) });
  const command = async (who, value) => {
    const result = await message(who, { type: "command", command: value });
    assert.equal(result.response.statusCode, 200, result.response.text());
    return result.response.json();
  };
  const hostStream = await call(transport, { url: `/api/events?room=${room.code}&session=${host.sessionToken}` });
  const guestStream = await call(transport, { url: `/api/events?room=${room.code}&session=${guest.sessionToken}` });
  return { room, transport, host, guest, hostStream, guestStream, message, command };
}

test("delayed pack loading returns its own creation receipt after a different player's spawn", async () => {
  let resolvePack;
  const waitingPack = new Promise((resolve) => { resolvePack = resolve; });
  const f = await resourceTransportFixture(() => waitingPack);
  try {
    const pending = f.command(f.guest, { type: "add-pack", packId: "uno", x: 1400, y: 600 });
    const intervening = await f.command(f.host, { type: "spawn-resource", resourceId: "note", x: 1000, y: 500 });
    resolvePack(unoPack);
    const added = await pending;
    assert.deepEqual(intervening.createdResource, { type: "object", id: intervening.state.objects.at(-1).id });
    assert.deepEqual(added.createdResource, { type: "deck", id: added.state.decks.at(-1).id });
    assert.notEqual(added.createdResource.id, intervening.createdResource.id);
    assert.equal(added.state.you.id, f.guest.player.id);
    assert.deepEqual(Object.keys(added.createdResource).sort(), ["id", "type"]);
    assert.equal(JSON.stringify(added).includes(unoPack.cards[0].label), false);
  } finally { f.transport.close(); }
});

test("multiple packs synchronize with private command receipts and containers hide both objects and cards", async () => {
  const f = await resourceTransportFixture();
  try {
    const added = await f.command(f.guest, { type: "add-pack", packId: unoPack.id, x: 1800, y: 900 });
    assert.equal(added.state.decks.length, 2);
    const deckId = added.state.decks.at(-1).id;
    const drawn = await f.command(f.guest, { type: "draw", deckId, ownerId: f.host.player.id });
    const card = drawn.state.cards.at(-1);
    assert.equal(card.face, null, "the command receipt must use the requesting guest's projection");
    assert.equal(card.back.label, "UNO");
    assert.ok(lastRoomState(f.hostStream.response).cards.find((item) => item.id === card.id).face);
    assert.equal(lastRoomState(f.guestStream.response).cards.find((item) => item.id === card.id).face, null);
    const spawned = await f.command(f.host, { type: "spawn-resource", resourceId: "bag", x: 1200, y: 500 });
    const bag = spawned.state.objects.at(-1);
    await f.command(f.host, { type: "bag-put", bagId: bag.id, resourceType: "card", resourceId: card.id });
    const noteState = await f.command(f.host, { type: "spawn-resource", resourceId: "note", x: 1100, y: 500 });
    const note = noteState.state.objects.find((item) => item.kind === "note");
    await f.command(f.host, { type: "bag-put", bagId: bag.id, resourceType: "object", resourceId: note.id });
    const guestView = lastRoomState(f.guestStream.response);
    assert.equal(guestView.objects.length, 1);
    assert.equal(guestView.objects[0].count, 2);
    assert.equal(JSON.stringify(guestView).includes('"contents"'), false);
    await f.message(f.guest, { type: "cursor", x: 4000, y: -500, drag: { sourceType: "object", resourceId: note.id, x: 4000, y: -500 } });
    const hiddenDrag = eventPayloads(f.hostStream.response).filter((event) => event.type === "cursor").at(-1);
    assert.equal(hiddenDrag.drag, null);
    assert.equal(hiddenDrag.x, 4000);
    await f.message(f.host, { type: "cursor", x: 2000, y: -400, drag: { sourceType: "deck", resourceId: deckId, x: 2000, y: -400 } });
    const deckDrag = eventPayloads(f.guestStream.response).filter((event) => event.type === "cursor").at(-1);
    assert.equal(deckDrag.drag.resourceId, deckId);
    assert.equal(Object.hasOwn(deckDrag.drag, "face"), false);
  } finally { f.transport.close(); }
});

test("scene API enforces host permissions, validates before replacement, and retains live sessions", async () => {
  const f = await resourceTransportFixture();
  try {
    await f.command(f.guest, { type: "draw" });
    await f.command(f.host, { type: "spawn-resource", resourceId: "counter", x: 1600, y: -300 });
    const guestSave = await call(f.transport, { url: `/api/save?room=${f.room.code}&session=${f.guest.sessionToken}` });
    assert.equal(guestSave.response.statusCode, 403);
    const exported = await call(f.transport, { url: `/api/save?room=${f.room.code}&session=${f.host.sessionToken}&name=Saved` });
    assert.equal(exported.response.statusCode, 200);
    const scene = exported.response.json();
    assert.equal(scene.format, "parlor.scene");
    for (const value of [f.host.sessionToken, f.guest.sessionToken, f.host.player.id, f.guest.player.id, f.room.hostSecret]) assert.equal(exported.response.text().includes(value), false);
    assert.ok(scene.cards.every((card) => card.zone !== "hand" && !Object.hasOwn(card, "ownerId")));
    const revision = f.room.revision;
    const bad = structuredClone(scene); bad.cards[0].deckId = "missing";
    const rejected = await f.message(f.host, { type: "command", command: { type: "restore-scene", scene: bad } });
    assert.equal(rejected.response.statusCode, 400);
    assert.equal(f.room.revision, revision);
    const denied = await f.message(f.guest, { type: "command", command: { type: "restore-scene", scene } });
    assert.equal(denied.response.statusCode, 403);
    const restored = await f.command(f.host, { type: "restore-scene", scene });
    assert.equal(restored.state.room.title, "Saved");
    assert.equal(restored.state.cards.length, 0);
    assert.equal(restored.state.objects[0].kind, "counter");
    const after = await f.command(f.guest, { type: "draw" });
    assert.ok(after.state.cards[0].face, "guest can keep using the same session after restoration");
    assert.equal(lastRoomState(f.hostStream.response).cards[0].face, null);
  } finally { f.transport.close(); }
});

test("portable pack imports reject guests and local artwork while body limits remain enforced", async () => {
  const f = await resourceTransportFixture();
  try {
    const denied = await f.message(f.guest, { type: "command", command: { type: "import-pack", pack: unoPack } });
    assert.equal(denied.response.statusCode, 403);
    const withArtwork = structuredClone(unoPack); withArtwork.cards[0].image = "face.png";
    const rejected = await f.message(f.host, { type: "command", command: { type: "import-pack", pack: withArtwork } });
    assert.equal(rejected.response.statusCode, 400);
    assert.equal(rejected.response.json().code, "PACK_LOCAL_ASSETS");
    const imported = await f.command(f.host, { type: "import-pack", pack: unoPack, x: 2200, y: 1700 });
    assert.equal(imported.state.decks.length, 2);
    const oversized = await call(f.transport, { method: "POST", url: "/api/message", body: " ".repeat(1_048_577) });
    assert.equal(oversized.response.statusCode, 413);
  } finally { f.transport.close(); }
});
