(function attachRecovery(root) {
  "use strict";
  const validKey = (key) => typeof key === "string" && /^[a-f0-9]{64}$/.test(key);
  function parseSeatKey(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    if (validKey(text)) return text;
    try { const key = new URL(text).searchParams.get("seat"); if (validKey(key)) return key; } catch { /* plain key input */ }
    throw new Error("请粘贴完整的个人续局链接或 64 位续局口令。");
  }
  function create(ui) {
    const vault = root.ParlorVault, app = ui.app;
    const pending = new Map();
    let snapshotTimer, retryTimer, recordId = null, lastSavedRevision = -1, restoring = false, warnedStorage = false;
    const referenceKey = () => `parlor-seat:${ui.endpoint?.origin || "preview"}:${ui.roomCode}`;
    const pendingKey = () => `parlor-pending:${recordId}`;
    const readSession = (key, fallback) => { try { return JSON.parse(root.sessionStorage.getItem(key)) || fallback; } catch { return fallback; } };
    const writeSession = (key, value) => { try { root.sessionStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
    const storeWarning = () => {
      if (warnedStorage) return;
      warnedStorage = true;
      ui.toast("浏览器未能保存续局信息，请在存档面板复制个人续局链接。", "error");
    };
    function joined(payload) {
      const player = payload.player;
      if (!player || !validKey(payload.recoveryKey)) return;
      const reference = { id: `${payload.gameId}:${player.id}`, gameId: payload.gameId, playerId: player.id, name: player.name,
        role: player.role, key: payload.recoveryKey, sessionToken: payload.sessionToken, roomCode: ui.roomCode, updatedAt: Date.now() };
      recordId = reference.id;
      writeSession(referenceKey(), reference);
      void vault.getSeat(recordId).then((previous) => vault.saveSeat({ ...previous, ...reference })).catch(storeWarning);
    }
    async function savedSeats(gameId) {
      return (await vault.listSeats().catch(() => [])).filter((record) => record.gameId === gameId && validKey(record.key)).sort((a, b) => b.updatedAt - a.updatedAt);
    }
    async function preferredSeat(gameId) {
      const reference = readSession(referenceKey(), null);
      if (reference?.gameId === gameId && validKey(reference.key)) return reference;
      const records = await savedSeats(gameId);
      return records.length === 1 ? records[0] : null;
    }
    async function cachedSeat() {
      const reference = readSession(referenceKey(), null);
      if (!reference?.id || !validKey(reference.key)) return null;
      const record = await vault.getSeat(reference.id).catch(() => null);
      if (!record?.state || record.state.you.id !== reference.playerId || record.state.room.gameId !== reference.gameId) return null;
      recordId = reference.id;
      return { ...record, ...reference };
    }
    async function savedCamera(gameId, playerId) {
      const record = await vault.getSeat(`${gameId}:${playerId}`).catch(() => null);
      return record?.gameId === gameId && record.playerId === playerId ? { camera: record.camera, viewport: record.viewport } : null;
    }
    function capture() {
      if (ui.previewMode || !app.state || !app.connectionOpen) return;
      clearTimeout(snapshotTimer);
      snapshotTimer = setTimeout(() => {
        const state = app.state;
        if (!state || !app.connectionOpen) return;
        const id = `${state.room.gameId}:${state.you.id}`;
        recordId = id;
        const record = { id, gameId: state.room.gameId, playerId: state.you.id, name: state.you.name, role: state.you.role,
          key: state.you.recoveryKey, sessionToken: app.sessionToken, roomCode: ui.roomCode, updatedAt: Date.now(),
          state: structuredClone(state), camera: { ...app.camera }, viewport: app.cameraViewport && { ...app.cameraViewport } };
        writeSession(referenceKey(), { ...record, state: undefined, camera: undefined, viewport: undefined });
        void vault.saveSeat(record).catch(storeWarning);
        lastSavedRevision = state.revision;
      }, lastSavedRevision === app.state.revision ? 500 : 200);
    }
    function personalLink(key = app.state?.you.recoveryKey) {
      if (ui.previewMode) throw new Error("试玩使用本机存档；真实开房后会有个人续局链接。");
      if (!validKey(key)) throw new Error("还没有收到个人续局口令，请等待连接。");
      const url = new URL(app.state?.room.shareUrl || root.location.href);
      for (const name of ["host", "fresh", "autojoin", "as", "preview"]) url.searchParams.delete(name);
      url.searchParams.set("seat", key);
      return url.toString();
    }
    const persistPendingFallback = () => writeSession(pendingKey(), [...pending.values()].map(({ record }) => record));
    const commandPendingKeys = (record) => [record.pendingKey || record.message.command.type,
      ...(Array.isArray(record.message.command.resources) ? record.message.command.resources.map((ref) => `drop:${ref.type}:${ref.id}`) : [])];
    const markPending = (record, active) => { for (const key of commandPendingKeys(record)) app.pendingCommands[active ? "add" : "delete"](key); };
    const notifyPending = () => ui.onPendingChange?.(pending.size);
    const schedule = () => {
      clearTimeout(retryTimer);
      if (pending.size) retryTimer = setTimeout(retry, app.connectionOpen ? 2000 : 8000);
    };
    async function transmit(item) {
      if (item.inFlight || !app.connectionOpen || item.record.playerId !== app.state?.you.id) return;
      item.inFlight = true;
      try {
        const result = await ui.postMessage(item.record.message);
        if (!result?.ok) throw new Error("操作回执尚未收到。");
        ui.receiveState?.(result.state);
        pending.delete(item.record.id); markPending(item.record, false);
        persistPendingFallback();
        await vault.deletePending(item.record.id).catch(() => {});
        item.resolve?.(result);
        if (item.retried) ui.toast("上一项操作已确认，桌面已同步。");
      } catch (error) {
        if (!error.status || error.status >= 500 || error.status === 408) {
          item.retried = true;
          if (!item.warned) { item.warned = true; ui.toast(error.code === "SAVE_FAILED" ? "操作已到房主桌面，正在等待自动存档。" : "操作正在确认，连接恢复后会继续核对。不会重复执行。", "info"); }
          ui.onUncertain?.(error);
        } else {
          pending.delete(item.record.id); markPending(item.record, false);
          persistPendingFallback(); await vault.deletePending(item.record.id).catch(() => {});
          item.onError?.(error); item.resolve?.(null); ui.toast(error.message, "error");
          if (error.status === 401) ui.onSessionExpired?.();
        }
      } finally { item.inFlight = false; notifyPending(); schedule(); }
    }
    function retry() {
      for (const item of pending.values()) void transmit(item);
      schedule();
    }
    async function restorePending() {
      if (restoring || !app.state || ui.previewMode) return;
      restoring = true;
      recordId = `${app.state.room.gameId}:${app.state.you.id}`;
      try {
        const saved = [...await vault.listPending().catch(() => []), ...readSession(pendingKey(), [])];
        for (const record of saved) {
          if (record.recordId !== recordId || record.playerId !== app.state.you.id || pending.has(record.id) || record.message?.type !== "command") continue;
          pending.set(record.id, { record, retried: true }); markPending(record, true);
        }
        notifyPending(); retry();
      } finally { restoring = false; }
    }
    async function send(command, { pendingKey = command.type, dragId, onError } = {}) {
      const state = app.state;
      recordId = `${state.room.gameId}:${state.you.id}`;
      const id = root.crypto.randomUUID();
      const record = { id, recordId, pendingKey, playerId: state.you.id, updatedAt: Date.now(), message: {
        type: "command", id, ...(dragId ? { dragId } : {}), gameId: state.room.gameId, epoch: state.room.epoch, baseRevision: state.revision, command: structuredClone(command)
      } };
      let resolve;
      const result = new Promise((done) => { resolve = done; });
      const item = { record, resolve, onError };
      pending.set(id, item); markPending(record, true); persistPendingFallback(); notifyPending();
      await vault.savePending(record).catch(() => {});
      void transmit(item); schedule();
      return result;
    }
    async function forget() {
      const id = recordId;
      try { root.sessionStorage.removeItem(referenceKey()); root.sessionStorage.removeItem(pendingKey()); } catch { /* storage may be disabled */ }
      await vault.deleteSeat(id).catch(() => {});
      for (const item of pending.values()) { item.resolve?.(null); await vault.deletePending(item.record.id).catch(() => {}); }
      pending.clear(); clearTimeout(retryTimer); clearTimeout(snapshotTimer); recordId = null;
    }
    return { joined, capture, cachedSeat, savedCamera, preferredSeat, savedSeats, personalLink, send, retry, restorePending, forget, get pendingCount() { return pending.size; } };
  }
  root.ParlorRecovery = Object.freeze({ create, parseSeatKey });
})(globalThis);
