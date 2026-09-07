(function attachPreviewRecovery(root) {
  "use strict";
  function create(ui) {
    const app = ui.app, vault = root.ParlorVault;
    const reference = ui.query.get("local"), validReference = typeof reference === "string" && /^[\w-]{1,80}$/.test(reference);
    let id = `preview:${validReference ? reference : ui.packId}`, generation = 0, ready = false, timer, writing = null;
    let savedSignature = "", installedSignature = "", warned = false;
    const status = app.previewPersistence = { id, pending: false, savedAt: null, error: null };
    const signature = () => JSON.stringify([app.state?.room.gameId, app.state?.revision, app.state?.you.id, app.camera.x, app.camera.y, app.camera.scale]);
    const changed = () => ui.onStatus?.();
    function warn(message) { if (!warned) { warned = true; ui.toast(message, "error"); } }
    function fork() {
      const reference = root.crypto.randomUUID();
      id = `preview:${reference}`; generation = 0; status.id = id;
      const url = new URL(root.location.href); url.searchParams.set("local", reference);
      try { root.history.replaceState(null, "", url); } catch { /* The table can still be exported if URL updates are unavailable. */ }
    }
    async function load() {
      let record;
      try {
        record = await vault.getPreview(id);
        if (!record) return null;
        if (record.format !== "parlor.preview" || record.version !== 1 || !Number.isSafeInteger(record.generation) || record.generation < 1) throw new Error("试玩自动存档格式无效。");
        const model = root.ParlorPreview.restoreModel(record.checkpoint, { shareUrl: ui.shareUrl() });
        generation = record.generation; status.savedAt = Number.isFinite(record.updatedAt) ? record.updatedAt : null;
        const camera = record.camera;
        const validCamera = camera && [camera.x, camera.y, camera.scale].every(Number.isFinite)
          && Math.abs(camera.x) <= 100000 && Math.abs(camera.y) <= 100000 && camera.scale >= .015 && camera.scale <= 3;
        return { model, viewerId: record.viewerId, camera: validCamera ? { ...camera } : null, viewport: record.viewport };
      } catch (error) {
        fork();
        status.error = error.message;
        warn(record ? "无法读取试玩自动存档，原记录已保留。本页使用独立桌面，可以导出文件备份。" : "本机存储暂时不可用，试玩仍可继续。请导出文件保留桌面。");
        return null;
      }
    }
    function capture() {
      if (!ready || !app.previewModel || !app.state) return;
      if (signature() === savedSignature) return;
      if (!status.pending) { status.pending = true; changed(); }
      clearTimeout(timer); timer = setTimeout(() => void flush(), 300);
    }
    function flush() {
      clearTimeout(timer);
      if (!ready || !app.previewModel || !app.state) return Promise.resolve(false);
      if (writing) return writing;
      writing = (async () => {
        while (signature() !== savedSignature) {
          const capturedSignature = signature();
          status.pending = true; changed();
          try {
            const record = { id, format: "parlor.preview", version: 1, packId: ui.packId, updatedAt: Date.now(),
              checkpoint: root.ParlorEngine.exportRoomCheckpoint(app.previewModel.engineRoom), viewerId: app.state.you.id,
              camera: { ...app.camera }, viewport: app.cameraViewport && { ...app.cameraViewport } };
            let saved;
            try { saved = await vault.commitPreview(record, generation); }
            catch (error) {
              if (error.code !== "PREVIEW_CHANGED") throw error;
              fork(); record.id = id;
              saved = await vault.commitPreview(record, generation);
              ui.toast("另一页也在使用这张桌面，已为本页保存独立试玩。可从存档面板切换。");
            }
            generation = saved.generation; savedSignature = capturedSignature;
            status.savedAt = saved.updatedAt; status.error = null; warned = false;
          } catch (error) {
            status.error = error.message || "试玩自动保存没有成功。";
            warn("桌面已更新，但自动保存没有成功。可在存档面板重试或导出文件。");
            return false;
          }
        }
        return true;
      })().finally(() => { writing = null; status.pending = signature() !== savedSignature; changed(); });
      return writing;
    }
    function activate(restored) {
      ready = true; installedSignature = signature();
      if (restored) { savedSignature = installedSignature; status.error = null; status.pending = false; changed(); return Promise.resolve(true); }
      savedSignature = ""; return flush();
    }
    function hasUnsavedChanges() {
      return ready && signature() !== savedSignature && (Boolean(savedSignature) || signature() !== installedSignature);
    }
    return { load, activate, capture, flush, hasUnsavedChanges };
  }
  root.ParlorPreviewRecovery = Object.freeze({ create });
})(globalThis);
