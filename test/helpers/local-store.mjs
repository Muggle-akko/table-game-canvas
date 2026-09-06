// A storage double for exercising production vault and UI record lifecycles.
// This does not model real IndexedDB transactions, permissions, quota, or durability.
export function createLocalStoreDouble({ packs = [], scenes = [] } = {}) {
  const stores = new Map(Object.entries({ packs, scenes }).map(([name, items]) => [name, new Map(items.map((item) => [item.id, structuredClone(item)]))]));
  const database = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name) { stores.set(name, new Map()); },
    transaction(name) {
      const records = stores.get(name), transaction = {};
      const request = (operation) => {
        const result = {};
        queueMicrotask(() => {
          try { result.result = structuredClone(operation()); transaction.oncomplete?.(); }
          catch (error) { transaction.error = error; transaction.onerror?.(); }
        });
        return result;
      };
      transaction.objectStore = () => ({
        getAll: () => request(() => [...records.values()]),
        put: (item) => request(() => { records.set(item.id, structuredClone(item)); return item.id; }),
        delete: (id) => request(() => { records.delete(id); })
      });
      return transaction;
    }
  };
  return {
    open() {
      const request = { result: database };
      queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess?.(); });
      return request;
    }
  };
}
