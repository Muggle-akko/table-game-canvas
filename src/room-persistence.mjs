import { mkdir, open, readFile, rename, chmod, unlink, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomError, exportRoomCheckpoint, roomFromCheckpoint } from "./room-engine.mjs";

const MAX_BYTES = 12 * 1024 * 1024;

async function atomicWrite(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, path);
    // Persist the directory entry as well as the file contents on POSIX systems.
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function acquireWriter(path) {
  const token = randomUUID(), lock = `${path}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lock, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); }
      finally { await handle.close(); }
      return async () => {
        const current = JSON.parse(await readFile(lock, "utf8").catch(() => "{}"));
        if (current.token === token) await unlink(lock);
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let holder;
      try { holder = JSON.parse(await readFile(lock, "utf8")); } catch { /* an incomplete lock is treated as occupied */ }
      if (Number.isInteger(holder?.pid) && holder.pid > 0) {
        try { process.kill(holder.pid, 0); }
        catch (error) {
          if (error.code === "ESRCH" && attempt === 0) { await unlink(lock); continue; }
        }
      }
      throw new RoomError("ROOM_IN_USE", "这桌的续局文件正由另一房主进程使用，请先关闭原开房窗口。", 409);
    }
  }
}

export async function readRoomCheckpoint(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_BYTES) throw new RoomError("INVALID_CHECKPOINT", "续局文件不能超过 12 MB。");
  let checkpoint;
  try { checkpoint = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new RoomError("INVALID_CHECKPOINT", "续局文件不是完整的 JSON，请尝试同目录的 .bak 备份。"); }
  return roomFromCheckpoint(checkpoint);
}

export async function latestRoomPath(directory) {
  let value;
  try { value = JSON.parse(await readFile(resolve(directory, "latest.json"), "utf8")); }
  catch { throw new RoomError("NO_SAVED_ROOM", "还没有自动续局文件，请先新开一桌。"); }
  if (typeof value?.file !== "string" || !/^[A-Z0-9-]{3,24}\.room\.json$/.test(value.file)) throw new RoomError("INVALID_CHECKPOINT", "最近一桌的续局索引无效，请使用 --resume 指定文件。");
  return resolve(directory, value.file);
}

export async function createRoomPersistence(room, { directory } = {}) {
  if (!directory || !/^[A-Z0-9-]{3,24}$/.test(room.code)) throw new Error("A private room storage directory and a valid room code are required.");
  directory = resolve(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = resolve(directory, `${room.code}.room.json`);
  const release = await acquireWriter(path);
  room.persistence = { enabled: true, savedAt: null, savedRevision: null, error: null };
  let queue = Promise.resolve();
  const enqueue = (operation) => {
    const result = queue.catch(() => {}).then(operation);
    queue = result;
    return result;
  };
  const encode = () => {
    const checkpoint = exportRoomCheckpoint(room), text = JSON.stringify(checkpoint);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new RoomError("SAVE_FAILED", "对局超过自动存档容量，请导出并精简本桌资源库。", 503);
    return { checkpoint, text };
  };
  return {
    path,
    save() {
      return enqueue(async () => {
        try {
          const { checkpoint, text } = encode();
          // Keep the previous committed checkpoint until the next one is durable.
          try {
            const previous = await readFile(path, "utf8");
            roomFromCheckpoint(JSON.parse(previous));
            await atomicWrite(`${path}.bak`, previous);
          } catch (error) {
            if (error.code !== "ENOENT" && !(error instanceof RoomError) && !(error instanceof SyntaxError)) throw error;
          }
          await atomicWrite(path, text);
          await atomicWrite(resolve(directory, "latest.json"), JSON.stringify({ file: basename(path), savedAt: checkpoint.savedAt }));
          room.persistence = { enabled: true, savedAt: checkpoint.savedAt, savedRevision: checkpoint.revision, error: null };
          return { ...room.persistence };
        } catch (error) {
          room.persistence.error = "自动存档未完成，请检查房主电脑的磁盘空间或导出对局。";
          throw new RoomError("SAVE_FAILED", room.persistence.error, 503);
        }
      });
    },
    backup() {
      return enqueue(async () => {
        const { text } = encode();
        const backup = resolve(directory, `${room.code}-before-${Date.now()}-${randomUUID().slice(0, 8)}.room.json`);
        await atomicWrite(backup, text);
        return backup;
      });
    },
    flush: () => queue,
    async close() { await queue.catch(() => {}); await release(); }
  };
}
