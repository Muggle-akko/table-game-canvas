import test from "node:test";
import assert from "node:assert/strict";
import { buildClientShell } from "../src/client-assets.mjs";
import { serveStatic } from "../src/server.mjs";

class MockResponse {
  constructor() {
    this.statusCode = null;
    this.headers = {};
    this.body = Buffer.alloc(0);
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  end(chunk = "") {
    this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    return this;
  }
}

test("serves the client with restrictive headers", async () => {
  const response = new MockResponse();
  await serveStatic(response, "/");

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["Content-Type"], /text\/html/);
  assert.match(response.headers["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.match(response.headers["Content-Security-Policy"], /img-src[^;]*http: https:/);
  assert.match(response.body.toString("utf8"), /Parlor/);
});

test("rejects malformed or escaping static paths without throwing", async () => {
  const malformed = new MockResponse();
  await serveStatic(malformed, "/%E0%A4%A");
  assert.equal(malformed.statusCode, 400);

  const escaping = new MockResponse();
  await serveStatic(escaping, "/../package.json");
  assert.equal(escaping.statusCode, 403);
  assert.equal(escaping.body.toString("utf8"), "Forbidden");
});

test("entry pages reference current client assets and runtime files require cache revalidation", async () => {
  const response = new MockResponse();
  await serveStatic(response, "/");
  const html = response.body.toString("utf8");
  const assets = [...html.matchAll(/(?:src|href)="(\.\/[^\"]+\.(?:js|css)\?v=[a-f0-9]{16})"/g)].map((match) => match[1]);
  assert.equal(assets.length, 12);
  assert.equal(response.headers["Cache-Control"], "no-cache");
  for (const asset of assets) {
    const file = new MockResponse();
    await serveStatic(file, new URL(asset, "https://table.example/").pathname);
    assert.equal(file.statusCode, 200, `${asset} should be served`);
    assert.equal(file.headers["Cache-Control"], "no-cache");
  }
});

test("the room serves the same versioned offline shell as a static deployment", async () => {
  const shell = await buildClientShell(new URL("../public/", import.meta.url).pathname);
  const entry = new MockResponse();
  await serveStatic(entry, "/");
  assert.equal(entry.body.toString("utf8"), shell.html);
  const worker = new MockResponse();
  await serveStatic(worker, "/service-worker.js");
  assert.equal(worker.statusCode, 200);
  assert.equal(worker.headers["Cache-Control"], "no-cache");
  assert.match(worker.headers["Content-Type"], /javascript/);
  assert.equal(worker.body.toString("utf8"), shell.worker);
  assert.doesNotMatch(shell.worker, /PARLOR_SHELL_MANIFEST/);
});
