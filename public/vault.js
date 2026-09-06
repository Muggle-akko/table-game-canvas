(function attachVault(root) {
  "use strict";
  let opening;
  function database() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!root.indexedDB) { reject(new Error("这个浏览器不支持本机存档，请使用导出文件。")); return; }
      const request = root.indexedDB.open("parlor-vault", 2);
      request.onupgradeneeded = () => {
        for (const name of ["scenes", "packs", "seats", "pending", "previews"]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" });
      };
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); opening = null; }; resolve(request.result); };
      request.onerror = () => { opening = null; reject(new Error("本机存储暂时不可用，可以先导出文件。")); };
      request.onblocked = () => { opening = null; reject(new Error("请关闭旧版本的 Parlor 页面后再保存。")); };
    });
    return opening;
  }
  async function run(store, mode, operation) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = operation(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () => reject(new Error("没有保存成功，存储可能已满。请导出文件保留桌面。"));
    });
  }
  const list = (store) => run(store, "readonly", (data) => data.getAll());
  const put = (store, item) => run(store, "readwrite", (data) => data.put(item));
  const remove = (store, id) => run(store, "readwrite", (data) => data.delete(id));
  const get = (store, id) => run(store, "readonly", (data) => data.get(id));
  async function commitPreview(record, generation) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("previews", "readwrite"), data = transaction.objectStore("previews");
      const request = data.get(record.id);
      let saved, failure;
      request.onsuccess = () => {
        if ((request.result?.generation || 0) !== generation) {
          failure = new Error("另一页已经保存了这张试玩桌面。"); failure.code = "PREVIEW_CHANGED";
          transaction.abort(); return;
        }
        saved = { ...record, generation: generation + 1 };
        data.put(saved);
      };
      transaction.oncomplete = () => resolve(saved);
      transaction.onabort = transaction.onerror = () => reject(failure || new Error("自动保存没有成功，存储可能已满。请导出文件保留桌面。"));
    });
  }
  function favorites() {
    try { const value = JSON.parse(localStorage.getItem("parlor-favorites") || "[]"); return new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string") : []); }
    catch { return new Set(); }
  }
  function toggleFavorite(id) {
    const set = favorites();
    if (set.has(id)) set.delete(id); else set.add(id);
    try { localStorage.setItem("parlor-favorites", JSON.stringify([...set])); }
    catch { throw new Error("浏览器未允许保存收藏。请检查本机存储权限。"); }
    return set;
  }
  root.ParlorVault = Object.freeze({
    listScenes: async () => (await list("scenes")).sort((a, b) => b.updatedAt - a.updatedAt),
    saveScene: async (scene, id = crypto.randomUUID()) => {
      const item = { id, name: scene.name, updatedAt: Date.now(), scene };
      await put("scenes", item); return item;
    },
    deleteScene: (id) => remove("scenes", id),
    listPacks: () => list("packs"),
    savePack: async (pack) => {
      const item = { id: crypto.randomUUID(), pack, updatedAt: Date.now() };
      await put("packs", item); return item;
    },
    deletePack: (id) => remove("packs", id),
    listSeats: () => list("seats"),
    getSeat: (id) => get("seats", id),
    saveSeat: (record) => put("seats", record),
    deleteSeat: (id) => remove("seats", id),
    listPending: () => list("pending"),
    savePending: (record) => put("pending", record),
    deletePending: (id) => remove("pending", id),
    getPreview: (id) => get("previews", id),
    listPreviews: async () => (await list("previews"))
      .filter((record) => record.format === "parlor.preview" && record.version === 1 && record.checkpoint?.game)
      .map((record) => ({ id: record.id, name: record.checkpoint.game.name, packId: record.packId, updatedAt: record.updatedAt,
        playerCount: record.checkpoint.game.players?.length || 0 }))
      .sort((left, right) => right.updatedAt - left.updatedAt),
    commitPreview,
    favorites, toggleFavorite
  });
})(globalThis);
