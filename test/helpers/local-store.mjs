// A storage double for exercising production vault and UI record lifecycles.
// Serializes requests and rolls back aborted writes; this is still not real
// IndexedDB, browser quota, storage permission, or durable-disk verification.
export function createLocalStoreDouble({ packs = [], scenes = [], seats = [], pending = [], previews = [] } = {}) {
  const stores = new Map(Object.entries({ packs, scenes, seats, pending, previews }).map(([name, items]) => [name, new Map(items.map((item) => [item.id, structuredClone(item)]))]));
  const queues = new Map();
  const api = { failWrites: false, beforeWrite: null };
  const database = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name) { stores.set(name, new Map()); },
    transaction(name, mode = "readonly") {
      let records, pending = 0, started = false, finished = false, finishing = false;
      const transaction = {}, waiting = [];
      const queue = queues.get(name) || []; queues.set(name, queue);
      const finish = (error) => {
        if (finished) return;
        finished = true;
        if (error) { transaction.error = error; transaction.onabort?.(); }
        else { if (mode === "readwrite") stores.set(name, records); transaction.oncomplete?.(); }
        queue.shift(); if (queue.length) queueMicrotask(queue[0]);
      };
      transaction.abort = () => finish(new Error("Transaction aborted"));
      const complete = () => {
        if (finished || finishing || pending) return;
        const completeWrite = () => finish(mode === "readwrite" && api.failWrites ? new Error("Storage unavailable") : null);
        if (mode === "readwrite" && api.beforeWrite) {
          finishing = true;
          Promise.resolve().then(() => api.beforeWrite(name)).then(completeWrite, finish);
        } else completeWrite();
      };
      const request = (operation) => {
        const result = {}; pending++;
        const execute = () => {
          if (finished) return;
          try { result.result = structuredClone(operation(records)); result.onsuccess?.(); }
          catch (error) { result.error = error; result.onerror?.(); finish(error); }
          pending--; queueMicrotask(complete);
        };
        if (started) queueMicrotask(execute); else waiting.push(execute);
        return result;
      };
      transaction.objectStore = () => ({
        getAll: () => request((records) => [...records.values()]),
        get: (id) => request((records) => records.get(id)),
        put: (item) => request((records) => { records.set(item.id, structuredClone(item)); return item.id; }),
        delete: (id) => request((records) => { records.delete(id); })
      });
      queue.push(() => { records = structuredClone(stores.get(name)); started = true; waiting.forEach((execute) => queueMicrotask(execute)); queueMicrotask(complete); });
      if (queue.length === 1) queueMicrotask(queue[0]);
      return transaction;
    }
  };
  api.open = () => {
      const request = { result: database };
      queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess?.(); });
      return request;
  };
  return api;
}
