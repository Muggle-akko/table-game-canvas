import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createShareUrl, describeListenError, parseArguments } from "../src/server.mjs";

test("uses the complete 54-card deck when no pack is specified", () => {
  assert.equal(parseArguments([]).packPath, resolve(process.cwd(), "game-packs", "standard-54.json"));
});

test("accepts a replaceable JSON game pack without changing server code", () => {
  const options = parseArguments([
    "--local",
    "--no-open",
    "--name",
    "测试房主",
    "--pack",
    "./game-packs/parlor-eight.json"
  ]);

  assert.equal(options.local, true);
  assert.equal(options.noOpen, true);
  assert.equal(options.hostName, "测试房主");
  assert.equal(options.packPath, resolve(process.cwd(), "game-packs", "parlor-eight.json"));
});

test("rejects incomplete pack and unsafe public frontend arguments early", () => {
  assert.throws(() => parseArguments(["--pack"]), /JSON 游戏包路径/);
  assert.throws(() => parseArguments(["--app-url", "http://table.example"]), /https:\/\//);
  assert.throws(() => parseArguments(["--port", "80"]), /1024/);
});

test("turns common listener failures into actionable room errors", () => {
  assert.match(describeListenError({ code: "EADDRINUSE" }, 4173).message, /端口 4173 已被占用/);
  assert.match(describeListenError({ code: "EACCES" }, 4173).message, /没有权限/);
  const original = new Error("socket failed");
  assert.equal(describeListenError(original, 4173), original);
});

test("builds an HTTPS guest link without leaking the host credential", () => {
  const shareUrl = createShareUrl(
    "https://table.example/play/",
    "INK-204",
    "https://room-name.trycloudflare.com"
  );

  assert.equal(shareUrl.protocol, "https:");
  assert.equal(shareUrl.pathname, "/play/");
  assert.equal(shareUrl.searchParams.get("room"), "INK-204");
  assert.equal(shareUrl.searchParams.get("endpoint"), "https://room-name.trycloudflare.com");
  assert.equal(shareUrl.searchParams.has("host"), false);
  assert.equal(shareUrl.toString().includes("127.0.0.1"), false);
});
