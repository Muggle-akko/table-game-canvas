// The Node server and static build inject matching public resources here.
const SHELL = /* PARLOR_SHELL_MANIFEST */ null;

if (SHELL) {
  const scope = new URL(self.registration.scope);
  const prefix = `parlor-shell:${scope.pathname}:`;
  const cacheName = `${prefix}${SHELL.version}`;
  const documentUrl = new URL("./", scope).href;
  const entryPaths = new Set([scope.pathname, `${scope.pathname}index.html`, `${scope.pathname}index`]);
  const assetPaths = new Set(SHELL.resources.filter((resource) => resource.type !== "html").map((resource) => new URL(resource.url, scope).pathname));

  async function verifiedResource(resource) {
    const url = new URL(resource.url, scope).href;
    const response = await fetch(url, { cache: "reload", credentials: "omit", redirect: "error" });
    const contentType = response.headers.get("Content-Type") || "";
    const expectedType = resource.type === "html" ? /text\/html/i : resource.type === "css" ? /text\/css/i : /(?:java|ecma)script/i;
    if (!response.ok || !expectedType.test(contentType)) throw new Error("Incomplete offline shell");
    const bytes = await response.clone().arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== resource.hash) throw new Error("Offline shell changed during update");
    return [url, response];
  }

  async function installShell() {
    try {
      // Validate the entire set before writing; never cache a room URL or API.
      const resources = await Promise.all(SHELL.resources.map(verifiedResource));
      const cache = await caches.open(cacheName);
      for (const [url, response] of resources) await cache.put(url, response);
    } catch (error) {
      await caches.delete(cacheName);
      throw error;
    }
    await self.skipWaiting();
  }

  async function activateShell() {
    const older = (await caches.keys()).filter((key) => key.startsWith(prefix) && key !== cacheName);
    // Keep one previous complete version for tabs opened before this update.
    await Promise.all(older.slice(0, -1).map((key) => caches.delete(key)));
    await self.clients.claim();
  }

  async function navigate(request) {
    const cache = await caches.open(cacheName);
    const fallback = await cache.match(documentUrl);
    const controller = new AbortController();
    const timeout = fallback ? setTimeout(() => controller.abort(), 3000) : null;
    try {
      const response = await fetch(request, { signal: controller.signal, cache: "no-cache" });
      if (response.status >= 500 && fallback) return fallback;
      return response;
    } catch (error) {
      if (fallback) return fallback;
      throw error;
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }

  async function asset(request) {
    const current = await caches.open(cacheName);
    const cached = await current.match(request);
    if (cached) return cached;
    const older = (await caches.keys()).filter((key) => key.startsWith(prefix) && key !== cacheName).reverse();
    for (const key of older) {
      const previous = await (await caches.open(key)).match(request);
      if (previous) return previous;
    }
    return fetch(request);
  }

  self.addEventListener("install", (event) => event.waitUntil(installShell()));
  self.addEventListener("activate", (event) => event.waitUntil(activateShell()));
  self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== scope.origin) return;
    if (request.mode === "navigate" && entryPaths.has(url.pathname)) {
      event.respondWith(navigate(request));
    } else if (assetPaths.has(url.pathname) && /^\?v=[a-f0-9]{16}$/.test(url.search)) {
      event.respondWith(asset(request));
    }
  });
}
