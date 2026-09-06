(function attachVault(root) {
  "use strict";
  let opening;
  function database() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!root.indexedDB) { reject(new Error("这个浏览器不支持本机存档，请使用导出文件。")); return; }
      const request = root.indexedDB.open("parlor-vault", 1);
      request.onupgradeneeded = () => {
        for (const name of ["scenes", "packs"]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
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
    favorites, toggleFavorite
  });
})(globalThis);
