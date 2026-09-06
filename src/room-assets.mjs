import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".avif", "image/avif"]
]);

export class RoomAssetError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "RoomAssetError";
    this.code = code;
    this.status = status;
  }
}

export function collectPackAssetReferences(pack) {
  const references = [];
  if (pack?.cardBack?.image) references.push(pack.cardBack.image);
  for (const token of pack?.tokens || []) {
    if (token?.image) references.push(token.image);
  }
  for (const card of pack?.cards || []) {
    if (card?.image) references.push(card.image);
  }
  return [...new Set(references)];
}

export async function loadRoomAsset(assetDirectory, reference) {
  if (!assetDirectory || typeof reference !== "string" || reference.length === 0) {
    throw new RoomAssetError("ASSET_NOT_FOUND", "图片资源不存在。", 404);
  }

  let basePath;
  let assetPath;
  try {
    basePath = await realpath(assetDirectory);
    const requestedPath = resolve(basePath, reference);
    if (!(requestedPath === basePath || requestedPath.startsWith(`${basePath}${sep}`))) {
      throw new RoomAssetError("ASSET_FORBIDDEN", "图片路径超出了游戏包目录。", 403);
    }
    assetPath = await realpath(requestedPath);
  } catch (error) {
    if (error instanceof RoomAssetError) throw error;
    throw new RoomAssetError("ASSET_NOT_FOUND", "图片资源不存在。", 404);
  }

  if (!(assetPath === basePath || assetPath.startsWith(`${basePath}${sep}`))) {
    throw new RoomAssetError("ASSET_FORBIDDEN", "图片路径不能通过链接跳出游戏包目录。", 403);
  }
  const contentType = MIME_TYPES.get(extname(assetPath).toLowerCase());
  if (!contentType) {
    throw new RoomAssetError("ASSET_TYPE_UNSUPPORTED", "图片格式不受支持。", 415);
  }

  const fileStat = await stat(assetPath);
  if (!fileStat.isFile()) throw new RoomAssetError("ASSET_NOT_FOUND", "图片资源不存在。", 404);
  if (fileStat.size > MAX_ASSET_BYTES) {
    throw new RoomAssetError("ASSET_TOO_LARGE", "单张图片不能超过 8 MB。", 413);
  }

  return {
    bytes: await readFile(assetPath),
    contentType,
    size: fileStat.size
  };
}

export async function validatePackAssets(pack, assetDirectory) {
  for (const reference of collectPackAssetReferences(pack)) {
    try {
      await loadRoomAsset(assetDirectory, reference);
    } catch (error) {
      throw new Error(`游戏包图片「${reference}」不可用：${error.message}`);
    }
  }
}
