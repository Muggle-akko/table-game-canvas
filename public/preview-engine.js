(function attachParlorPreview(root) {
  "use strict";
  const core = globalThis.ParlorEngine;
  if (!core) throw new Error("桌面引擎没有加载成功。");
  const builtinPacks = globalThis.ParlorPacks;

  function getPack(id) {
    const pack = builtinPacks.find((entry) => entry.id === id);
    if (!pack) throw new core.RoomError("PACK_NOT_AVAILABLE", "没有找到这个牌盒。", 404);
    return structuredClone(pack);
  }

  function createModel({ shareUrl = "", packId = "standard-54", now = Date.now(), empty = false } = {}) {
    const pack = getPack(packId);
    const featured = packId === "standard-54" ? ["hearts-a", "spades-k", "diamonds-q"]
      : packId === "uno" ? ["red-0", "blue-5-a", "yellow-skip-a"] : pack.cards.slice(0, 3).map((card) => card.key);
    pack.cards.sort((a, b) => {
      const left = featured.indexOf(a.key), right = featured.indexOf(b.key);
      return (left < 0 ? 999 : left) - (right < 0 ? 999 : right);
    });
    const room = core.createRoom({ code: "PREVIEW", hostName: "房主A", hostSecret: "local-preview", pack, randomizeDeck: false });
    for (const [index, player] of [
      core.joinRoom(room, { hostSecret: "local-preview" }).player,
      core.joinRoom(room, { displayName: "客人B" }).player
    ].entries()) {
      room.players.delete(player.id);
      player.id = index === 0 ? "player_a" : "player_b";
      player.connections = 1;
      room.players.set(player.id, player);
    }
    room.sessions.clear();
    const cards = [...room.cards.values()];
    room.cards.clear();
    cards.forEach((card, index) => {
      card.id = `card_demo_${index + 1}`;
      if (!empty && index < 3) Object.assign(card, {
        zone: index < 2 ? "hand" : "public", ownerId: index < 2 ? index === 1 ? "player_b" : "player_a" : null,
        x: index === 2 ? 650 : null, y: index === 2 ? 390 : null,
        rotation: index === 2 ? -4 : 0, faceUp: index === 2, z: index === 2 ? 3 : 0,
        handOrder: index < 2 ? index + 1 : 0
      });
      room.cards.set(card.id, card);
    });
    room.deckOrder = cards.filter((card) => card.zone === "deck").map((card) => card.id);
    room.nextZ = 4;
    room.nextHandOrder = 3;
    room.shareUrl = shareUrl;
    room.packOptions = builtinPacks.map((entry) => ({ id: entry.id, name: entry.name, cardCount: entry.cards.length }));
    if (!empty) room.tokens.set("token_focus", {
      id: "token_focus", key: "focus", label: "自由标记", symbol: "◆", color: "#4388ff",
      x: 470, y: 560, homeX: 470, homeY: 560, z: 1, locked: false
    });
    room.updatedAt = now;
    room.history = [];
    return modelForRoom(room);
  }

  function modelForRoom(room) {
    const model = { engineRoom: room };
    for (const key of ["cards", "tokens", "players", "objects"]) {
      Object.defineProperty(model, key, {
        get: () => [...room[key].values()],
        set: (values) => { room[key] = new Map(values.map((value) => [value.id, value])); }
      });
    }
    for (const key of ["deckOrder", "die", "counter", "turn", "nextZ", "nextHandOrder", "history", "revision"]) {
      Object.defineProperty(model, key, { get: () => room[key], set: (value) => { room[key] = value; } });
    }
    Object.defineProperty(model, "undo", { get: () => room.undoStack });
    Object.defineProperty(model, "room", { get: () => core.projectRoom(room, [...room.players.values()].find((player) => player.role === "host").id).room });
    return model;
  }

  function restoreModel(checkpoint, { shareUrl = "" } = {}) {
    if (checkpoint?.code !== "PREVIEW") throw new core.RoomError("INVALID_PREVIEW", "这不是本机试玩的自动存档。");
    const room = core.roomFromCheckpoint(checkpoint);
    if (![...room.players.values()].some((player) => player.role === "host")) throw new core.RoomError("INVALID_PREVIEW", "试玩存档缺少房主席位。");
    room.sessions.clear();
    for (const player of room.players.values()) player.connections = 1;
    room.shareUrl = shareUrl;
    room.packOptions = builtinPacks.map((entry) => ({ id: entry.id, name: entry.name, cardCount: entry.cards.length }));
    return modelForRoom(room);
  }

  function project(model, viewerId, now = Date.now()) {
    return { ...core.projectRoom(model.engineRoom, viewerId), serverTime: now };
  }

  function applyCommand(model, viewerId, command, { now = Date.now(), withReceipt = false } = {}) {
    const room = model.engineRoom;
    let createdResource, selectedResources;
    if (command.type === "replace-pack") core.replaceRoomPack(room, viewerId, getPack(command.packId));
    else if (command.type === "add-pack") createdResource = { type: "deck", id: core.addRoomPack(room, viewerId, getPack(command.packId), command) };
    else if (command.type === "import-pack") {
      if (room.players.get(viewerId).role !== "host") throw new core.RoomError("HOST_ONLY", "只有房主可以导入牌盒。", 403);
      core.validatePortablePack(command.pack);
      createdResource = { type: "deck", id: core.addRoomPack(room, viewerId, command.pack, command) };
    } else if (command.type === "restore-scene") core.restoreRoomScene(room, viewerId, command.scene);
    else if (command.type === "restore-game") {
      core.restoreRoomGame(room, viewerId, command.game);
      for (const player of room.players.values()) player.connections = 1;
    }
    else ({ createdResource, selectedResources } = core.applyCommand(room, viewerId, command) || {});
    const state = project(model, viewerId, now);
    return withReceipt ? { ok: true, revision: state.revision, state, ...(createdResource ? { createdResource } : {}), ...(selectedResources ? { selectedResources } : {}) } : state;
  }

  root.ParlorPreview = Object.freeze({ createModel, restoreModel, project, applyCommand, PreviewError: core.RoomError });
})(typeof window !== "undefined" ? window : globalThis);
