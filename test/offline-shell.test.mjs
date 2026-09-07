import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { buildClientShell } from "../src/client-assets.mjs";

const workerTemplate = await readFile(new URL("../public/service-worker.js", import.meta.url), "utf8");
const registrationScript = await readFile(new URL("../public/offline-client.js", import.meta.url), "utf8");
const base = "https://parlor.example/table/";

class CacheStorage {
  stores = new Map();
  failWrites = false;
  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    const records = this.stores.get(name);
    return {
      match: async (request) => records.get(typeof request === "string" ? request : request.url)?.clone(),
      put: async (request, response) => {
        if (this.failWrites) throw new Error("QuotaExceededError");
        records.set(typeof request === "string" ? request : request.url, response.clone());
      }
    };
  }
  async keys() { return [...this.stores.keys()]; }
  async delete(name) { return this.stores.delete(name); }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "parlor-offline-shell-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "index.html"), '<!doctype html><title>Parlor</title><link rel="stylesheet" href="./styles.css"><script src="./app.js"></script>');
  await writeFile(join(directory, "styles.css"), "body { color: green; }");
  await writeFile(join(directory, "app.js"), "const version = 1;");
  await writeFile(join(directory, "service-worker.js"), workerTemplate);
  return directory;
}

async function networkFor(directory, shell) {
  const files = new Map([[base, { body: shell.html, type: "text/html" }]]);
  for (const match of shell.html.matchAll(/(?:src|href)="(\.\/[^\"]+)"/g)) {
    const url = new URL(match[1], base);
    const file = url.pathname.split("/").pop();
    files.set(url.href, { body: await readFile(join(directory, file)), type: file.endsWith("css") ? "text/css" : "text/javascript" });
  }
  return files;
}

function worker(shell, files, caches = new CacheStorage()) {
  const listeners = new Map();
  const state = { offline: false, navigationStatus: 200, calls: [], claimed: 0, skipped: 0 };
  vm.runInNewContext(shell.worker, {
    URL, AbortController, Uint8Array, crypto: webcrypto, caches, setTimeout, clearTimeout,
    self: {
      registration: { scope: base },
      addEventListener: (type, listener) => listeners.set(type, listener),
      skipWaiting: async () => state.skipped++,
      clients: { claim: async () => state.claimed++ }
    },
    fetch: async (request, options = {}) => {
      const url = typeof request === "string" ? request : request.url;
      state.calls.push({ url, options });
      if (state.offline) throw new TypeError("Failed to fetch");
      if (typeof request === "object" && request.mode === "navigate") return new Response("online entry", { status: state.navigationStatus });
      const file = files.get(url);
      return file ? new Response(file.body, { headers: { "Content-Type": file.type } }) : new Response("missing", { status: 404 });
    }
  });
  return {
    state, caches,
    async lifecycle(type) {
      let promise;
      listeners.get(type)({ waitUntil: (value) => { promise = value; } });
      await promise;
    },
    request(path, options = {}) {
      let result;
      listeners.get("fetch")({
        request: { url: new URL(path, base).href, method: "GET", mode: "cors", ...options },
        respondWith: (value) => { result = value; }
      });
      return result;
    }
  };
}

test("a complete offline shell reloads any room URL without caching identities, APIs or artwork", async (t) => {
  const directory = await fixture(t);
  const shell = await buildClientShell(directory);
  const files = await networkFor(directory, shell);
  const client = worker(shell, files);
  await client.lifecycle("install");
  await client.lifecycle("activate");
  assert.equal(client.state.claimed, 1);
  assert.equal(client.state.skipped, 1);
  assert.ok(client.state.calls.every(({ options }) => options.credentials === "omit" && options.cache === "reload"));
  client.state.offline = true;
  for (const path of ["?room=ABC&host=private-host-key", "index.html?room=DEF&seat=private-seat-key", "index?preview=1"]) {
    const response = await client.request(path, { mode: "navigate" });
    assert.equal(await response.text(), shell.html);
  }
  for (const path of ["api/rooms/ABC/events?session=secret", "api/rooms/ABC/assets/card/private?token=secret", "images/secret.png", "./", "app.js?room=ABC&v=1234567890123456", "https://other.example/table/"]) {
    assert.equal(client.request(path), undefined, `must leave ${path} outside the cache`);
  }
  assert.equal(client.request("api/rooms/ABC/command", { method: "POST" }), undefined);
  const [stored] = client.caches.stores.values();
  assert.deepEqual([...stored.keys()].sort(), [...files.keys()].sort());
  assert.ok([...stored.keys()].every((url) => !/host=|room=|seat=|session=|token=/.test(url)));
  for (const url of files.keys()) if (url !== base) assert.equal((await client.request(url)).status, 200);
});

test("navigation reads the live entry first and uses the shell for connection errors and server outages", async (t) => {
  const directory = await fixture(t);
  const shell = await buildClientShell(directory);
  const client = worker(shell, await networkFor(directory, shell));
  await client.lifecycle("install");
  assert.equal(await (await client.request("?room=ABC", { mode: "navigate" })).text(), "online entry");
  assert.equal(client.state.calls.at(-1).options.cache, "no-cache");
  client.state.navigationStatus = 503;
  assert.equal(await (await client.request("?room=ABC", { mode: "navigate" })).text(), shell.html);
  client.state.navigationStatus = 403;
  assert.equal((await client.request("?room=ABC", { mode: "navigate" })).status, 403, "do not replace an access rejection with an offline page");
});

test("a partial deployment or exhausted storage leaves the previous complete shell usable", async (t) => {
  const directory = await fixture(t);
  const first = await buildClientShell(directory);
  const caches = new CacheStorage();
  const previous = worker(first, await networkFor(directory, first), caches);
  await previous.lifecycle("install");
  const before = await caches.keys();
  await writeFile(join(directory, "app.js"), "const version = 2;");
  const next = await buildClientShell(directory);
  const files = await networkFor(directory, next);
  const appUrl = [...files.keys()].find((url) => url.includes("/app.js?"));
  const correctApp = files.get(appUrl);
  files.set(appUrl, { body: "const version = 1;", type: "text/javascript" });
  const incomplete = worker(next, files, caches);
  await assert.rejects(incomplete.lifecycle("install"), /changed during update/);
  assert.deepEqual(await caches.keys(), before);
  files.set(appUrl, correctApp);
  caches.failWrites = true;
  await assert.rejects(incomplete.lifecycle("install"), /QuotaExceededError/);
  assert.deepEqual(await caches.keys(), before);
  caches.failWrites = false;
  previous.state.offline = true;
  assert.equal(await (await previous.request("?room=ABC", { mode: "navigate" })).text(), first.html);
  assert.equal(incomplete.state.skipped, 0, "an incomplete update cannot replace the working worker");
});

test("a complete update keeps matching assets for old tabs and only prunes its own oldest shell", async (t) => {
  const directory = await fixture(t);
  const first = await buildClientShell(directory);
  const firstFiles = await networkFor(directory, first);
  const caches = new CacheStorage();
  await caches.open("another-app-cache");
  const old = worker(first, firstFiles, caches);
  await old.lifecycle("install");
  await old.lifecycle("activate");
  const oldestName = (await caches.keys()).find((key) => key !== "another-app-cache");
  await writeFile(join(directory, "app.js"), "const version = 2;");
  const second = await buildClientShell(directory);
  const updated = worker(second, await networkFor(directory, second), caches);
  await updated.lifecycle("install");
  await updated.lifecycle("activate");
  updated.state.offline = true;
  assert.equal(await (await updated.request("?room=ABC", { mode: "navigate" })).text(), second.html);
  const oldAppUrl = [...firstFiles.keys()].find((url) => url.includes("/app.js?"));
  assert.equal(await (await updated.request(oldAppUrl)).text(), "const version = 1;");
  await writeFile(join(directory, "index.html"), `${await readFile(join(directory, "index.html"), "utf8")}<p>New page</p>`);
  const third = await buildClientShell(directory);
  const newest = worker(third, await networkFor(directory, third), caches);
  await newest.lifecycle("install");
  await newest.lifecycle("activate");
  assert.equal(caches.stores.has(oldestName), false);
  assert.equal(caches.stores.has("another-app-cache"), true);
  assert.equal(caches.stores.size, 3, "retain only this scope's current and previous shell");
});

test("shell content versions cover HTML, assets and worker behavior while identical builds stay stable", async (t) => {
  const directory = await fixture(t);
  const first = await buildClientShell(directory);
  assert.deepEqual(await buildClientShell(directory), first);
  await writeFile(join(directory, "service-worker.js"), `${workerTemplate}\n// Updated worker behavior\n`);
  const updatedWorker = await buildClientShell(directory);
  assert.notEqual(updatedWorker.worker, first.worker);
  assert.equal(updatedWorker.html, first.html);
});

test("offline registration is limited to secure HTTP contexts and bypasses stale worker HTTP caches", async () => {
  for (const setup of [
    { protocol: "file:", secure: true, supported: true },
    { protocol: "http:", secure: false, supported: true },
    { protocol: "https:", secure: true, supported: false },
    { protocol: "https:", secure: true, supported: true }
  ]) {
    const calls = [];
    let onLoad;
    vm.runInNewContext(registrationScript, {
      URL, console,
      location: { protocol: setup.protocol },
      document: { currentScript: { src: `${base}offline-client.js?v=1234567890123456` } },
      window: { isSecureContext: setup.secure, addEventListener: (type, fn) => { assert.equal(type, "load"); onLoad = fn; } },
      navigator: setup.supported ? { serviceWorker: { register: async (url, options) => { calls.push({ url: url.href, ...options }); } } } : {}
    });
    onLoad?.();
    if (setup.protocol === "https:" && setup.secure && setup.supported) {
      assert.equal(calls[0].url, `${base}service-worker.js`);
      assert.equal(calls[0].updateViaCache, "none");
      assert.equal(calls[0].scope, "./");
    } else assert.equal(calls.length, 0);
  }
});
