import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { versionClientHtml } from "../src/client-assets.mjs";

test("client asset URLs change with content and remain stable for unchanged resources", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "parlor-client-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const html = '<link rel="stylesheet" href="./styles.css"><script defer src="./app.js"></script><img src="./card.png">';
  await writeFile(join(directory, "styles.css"), ".viewport { cursor: grab; }");
  await writeFile(join(directory, "app.js"), "const version = 1;");
  const first = await versionClientHtml(html, directory);
  const asset = (value, name) => value.match(new RegExp(`\\./${name}\\?v=[a-f0-9]{16}`))?.[0];
  assert.ok(asset(first, "app.js")); assert.ok(asset(first, "styles.css"));
  assert.ok(first.includes('<img src="./card.png">'));
  assert.equal(await versionClientHtml(first, directory), first, "rebuilding identical resources should not invalidate caches");
  await writeFile(join(directory, "app.js"), "const version = 2;");
  const updated = await versionClientHtml(html, directory);
  assert.notEqual(asset(updated, "app.js"), asset(first, "app.js"), "a cached old client must have a different URL after deployment");
  assert.equal(asset(updated, "styles.css"), asset(first, "styles.css"));
});
