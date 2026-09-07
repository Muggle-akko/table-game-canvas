import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomInt, randomUUID } from "node:crypto";
import { RoomError, createRoom } from "./room-engine.mjs";
import { loadRoomAsset, validatePackAssets } from "./room-assets.mjs";
import { createRoomTransport } from "./room-transport.mjs";
import { createRoomPersistence, latestRoomPath, readRoomCheckpoint } from "./room-persistence.mjs";
import { findCloudflared, startQuickTunnel } from "./tunnel.mjs";
import { versionClientHtml } from "./client-assets.mjs";

const modulePath = fileURLToPath(import.meta.url);
const root = resolve(dirname(modulePath), "..");
const publicDirectory = resolve(root, "public");
const defaultPackPath = resolve(root, "game-packs", "standard-54.json");
const unoPackPath = resolve(root, "game-packs", "uno.json");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

export function parseArguments(argv) {
  const options = {
    local: false,
    noOpen: false,
    port: Number(process.env.PORT) || 4173,
    hostName: "玩家1",
    appUrl: process.env.PUBLIC_APP_URL || "",
    resumePath: null,
    resumeLatest: false,
    storageDirectory: resolve(root, ".parlor/rooms"),
    packPath: resolve(root, process.env.GAME_PACK || defaultPackPath)
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--local") options.local = true;
    else if (argument === "--no-open") options.noOpen = true;
    else if (argument === "--port") options.port = Number(argv[++index]);
    else if (argument === "--name") options.hostName = argv[++index] || options.hostName;
    else if (argument === "--app-url") options.appUrl = argv[++index] || "";
    else if (argument === "--resume-latest") options.resumeLatest = true;
    else if (argument === "--resume") {
      const path = argv[++index];
      if (!path || path.startsWith("--")) throw new Error("--resume 后需要填写房间续局文件路径。");
      options.resumePath = resolve(root, path);
    }
    else if (argument === "--pack") {
      const requestedPath = argv[++index];
      if (!requestedPath) throw new Error("--pack 后需要填写 JSON 游戏包路径。");
      options.packPath = resolve(root, requestedPath);
    }
    else throw new Error(`未知参数：${argument}`);
  }

  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw new Error("端口必须是 1024–65535 之间的整数。");
  }
  if (options.resumePath && options.resumeLatest) throw new Error("--resume 和 --resume-latest 只能选择一个。");

  if (options.appUrl) {
    const parsed = new URL(options.appUrl);
    if (parsed.protocol !== "https:") throw new Error("公网前端地址必须使用 https://。");
    parsed.hash = "";
    parsed.search = "";
    options.appUrl = parsed.toString();
  }

  return options;
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";
  for (let index = 0; index < 6; index += 1) value += alphabet[randomInt(alphabet.length)];
  return `${value.slice(0, 3)}-${value.slice(3)}`;
}

export function createShareUrl(baseUrl, roomCode, endpoint = null) {
  const url = new URL(baseUrl);
  url.searchParams.set("room", roomCode);
  if (endpoint) url.searchParams.set("endpoint", endpoint);
  return url;
}

async function openBrowser(url) {
  const commands = {
    darwin: ["open", [url]],
    linux: ["xdg-open", [url]],
    win32: ["cmd", ["/c", "start", "", url]]
  };
  const command = commands[process.platform];
  if (!command) return false;

  return new Promise((resolvePromise) => {
    try {
      const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
      child.once("spawn", () => {
        child.unref();
        resolvePromise(true);
      });
      child.once("error", () => resolvePromise(false));
    } catch {
      resolvePromise(false);
    }
  });
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

export async function serveStatic(response, pathname) {
  let relativePath;
  try {
    relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Bad request");
    return;
  }
  const absolutePath = resolve(publicDirectory, relativePath);
  if (!(absolutePath === publicDirectory || absolutePath.startsWith(`${publicDirectory}${sep}`))) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) throw new Error("not a file");
    const extension = extname(absolutePath);
    let bytes = await readFile(absolutePath);
    if (extension === ".html") bytes = Buffer.from(await versionClientHtml(bytes.toString("utf8"), publicDirectory));
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Cache-Control": [".html", ".js", ".css"].includes(extension) ? "no-cache" : "public, max-age=300",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self' http: https:; img-src 'self' data: http: https:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    });
    response.end(bytes);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

export function describeListenError(error, port) {
  if (error?.code === "EADDRINUSE") {
    return new Error(`端口 ${port} 已被占用。请关闭占用该端口的程序，或使用 --port 指定其他端口。`);
  }
  if (error?.code === "EACCES") {
    return new Error(`没有权限监听端口 ${port}，请改用 1024 以上的其他端口。`);
  }
  return error;
}

export async function createRoomServer(room, port, { assetDirectory = null, packLibrary = [], persistence = null } = {}) {
  const packsById = new Map(packLibrary.map((entry) => [entry.pack.id, entry]));
  room.packOptions = packsById.size > 0
    ? [...packsById.values()].map((entry) => ({
        id: entry.pack.id,
        name: entry.pack.name,
        cardCount: entry.pack.cards.length
      }))
    : [{ id: room.pack.id, name: room.pack.name, cardCount: room.cards.size }];
  const transport = createRoomTransport(room, {
    persistence,
    loadAsset: assetDirectory || packsById.size > 0
      ? (reference, packId = room.pack.id) => {
          const entry = packsById.get(packId);
          if (entry) {
            const allowed = [entry.pack.cardBack.image, ...entry.pack.cards.map((card) => card.image), ...(entry.pack.tokens || []).map((token) => token.image)];
            if (!allowed.includes(reference)) throw new RoomError("ASSET_NOT_FOUND", "图片没有在这个牌盒中声明。", 404);
          }
          const sourceDirectory = entry?.assetDirectory || (packId === room.pack.id ? assetDirectory : null);
          if (!sourceDirectory) throw new RoomError("ASSET_NOT_FOUND", "这个牌盒没有图片资源。", 404);
          return loadRoomAsset(sourceDirectory, reference);
        }
      : null,
    loadPack: packsById.size > 0
      ? (packId) => {
          const entry = packsById.get(packId);
          if (!entry) throw new RoomError("PACK_NOT_AVAILABLE", "没有找到这个牌盒。", 404);
          return structuredClone(entry.pack);
        }
      : null
  });
  const httpServer = createServer(async (request, response) => {
    if (await transport.handle(request, response)) return;

    const requestUrl = new URL(request.url || "/", "http://room.local");
    if (request.method === "GET") {
      await serveStatic(response, requestUrl.pathname);
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });

  try {
    await new Promise((resolvePromise, rejectPromise) => {
      httpServer.once("error", rejectPromise);
      httpServer.listen(port, "127.0.0.1", resolvePromise);
    });
  } catch (error) {
    transport.close();
    throw describeListenError(error, port);
  }

  return {
    httpServer,
    transport,
    async close() {
      await transport.flush();
      await persistence?.flush().catch(() => {});
      transport.close();
      httpServer.closeIdleConnections?.();
      await new Promise((resolvePromise) => httpServer.close(resolvePromise));
      await persistence?.close?.();
    }
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const cloudflared = options.local ? null : findCloudflared();
  if (!options.local && !cloudflared) {
    throw new Error("未找到 cloudflared。请先运行 `npm run setup:tunnel`，安装成功后再开房。");
  }

  let pack;
  try {
    pack = JSON.parse(await readFile(options.packPath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取游戏包 ${options.packPath}：${error.message}`);
  }
  const resumePath = options.resumePath || (options.resumeLatest ? await latestRoomPath(options.storageDirectory) : null);
  const room = resumePath ? await readRoomCheckpoint(resumePath) : createRoom({
    code: createRoomCode(),
    hostName: options.hostName,
    hostSecret: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    pack
  });
  const assetDirectory = dirname(options.packPath);
  await validatePackAssets(pack, assetDirectory);
  const packLibrary = [{ pack, assetDirectory }];
  for (const packPath of [defaultPackPath, unoPackPath, resolve(root, "game-packs/moon-outpost.json"), resolve(root, "game-packs/holdem-52.json")]) {
    if (resolve(packPath) === resolve(options.packPath)) continue;
    const builtinPack = JSON.parse(await readFile(packPath, "utf8"));
    const builtinAssetDirectory = dirname(packPath);
    await validatePackAssets(builtinPack, builtinAssetDirectory);
    if (!packLibrary.some((entry) => entry.pack.id === builtinPack.id)) {
      packLibrary.push({ pack: builtinPack, assetDirectory: builtinAssetDirectory });
    }
  }
  const persistence = await createRoomPersistence(room, { directory: options.storageDirectory });

  let server = null;
  let tunnel = null;
  let shuttingDown = false;

  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    tunnel?.stop();
    if (server) await server.close();
    else await persistence.close();
    process.exitCode = exitCode;
  };

  try {
    await persistence.save();
    server = await createRoomServer(room, options.port, { assetDirectory: room.pack.id === pack.id ? assetDirectory : null, packLibrary, persistence });
    console.log(resumePath ? "已恢复上次对局，原席位和手牌已保留。" : "这桌已启用自动存档。");
    console.log(`房主续局文件：${persistence.path}`);
    console.log("下次运行 npm run room -- --resume-latest 可续局；公网地址可能变化，请重新分享链接。\n");
    const localBaseUrl = `http://127.0.0.1:${options.port}/`;

    if (options.local) {
      const shareUrl = createShareUrl(localBaseUrl, room.code);
      const hostUrl = new URL(shareUrl);
      hostUrl.searchParams.set("host", room.hostSecret);
      room.publicEndpoint = localBaseUrl;
      room.shareUrl = shareUrl.toString();
      console.log("本地开发房间已开启：");
      console.log(`房间加入链接（发给朋友）：${shareUrl}`);
      console.log(`房主链接（仅自己使用）：${hostUrl}`);
      console.log("按 Ctrl+C 关闭房间。\n");
    } else {
      console.log("正在建立 HTTPS 公网隧道，链接可用前不会开放房间……");
      tunnel = await startQuickTunnel({ binaryPath: cloudflared, localPort: options.port });
      const appBaseUrl = options.appUrl || `${tunnel.url}/`;
      const shareUrl = createShareUrl(appBaseUrl, room.code, options.appUrl ? tunnel.url : null);
      const hostUrl = new URL(shareUrl);
      hostUrl.searchParams.set("host", room.hostSecret);
      room.publicEndpoint = tunnel.url;
      room.shareUrl = shareUrl.toString();

      if (options.appUrl) {
        let response;
        try {
          response = await fetchWithTimeout(options.appUrl, 8_000);
        } catch (error) {
          if (error.name === "AbortError") throw new Error("公网前端访问超时，请检查地址后重试。");
          throw error;
        }
        if (!response.ok) throw new Error(`公网前端无法访问：HTTP ${response.status}`);
      }

      console.log("\n房间已开启，朋友无需安装或登录：");
      console.log(`房间加入链接（发给朋友）：${shareUrl}`);
      console.log(`房主链接（仅自己使用）：${hostUrl}`);
      console.log("按 Ctrl+C 关闭房间。\n");

      if (!options.noOpen) {
        const opened = await openBrowser(hostUrl.toString());
        if (!opened) {
          console.warn("没有自动打开浏览器，请手动打开上面的房主链接。");
        }
      }

      tunnel.child.once("exit", async (code, signal) => {
        if (shuttingDown) return;
        console.error(`公网隧道已断开（${signal || code || "unknown"}），房间同时关闭。`);
        await shutdown(1);
      });
    }

    process.on("SIGINT", () => {
      console.log("\n正在关闭房间……");
      void shutdown(0);
    });
    process.on("SIGTERM", () => void shutdown(0));
  } catch (error) {
    await shutdown(1);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(modulePath)) {
  main().catch((error) => {
    console.error(`开房失败：${error.message}`);
    process.exitCode = 1;
  });
}
