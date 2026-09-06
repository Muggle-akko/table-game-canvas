import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RoomAssetError,
  collectPackAssetReferences,
  loadRoomAsset,
  validatePackAssets
} from "../src/room-assets.mjs";

test("loads declared local artwork and deduplicates repeated references", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "parlor-assets-"));
  const packDirectory = join(temporaryRoot, "pack");
  try {
    await mkdir(join(packDirectory, "art"), { recursive: true });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(join(packDirectory, "art", "shared.png"), bytes);
    const pack = {
      cardBack: { image: "art/shared.png" },
      cards: [{ image: "art/shared.png" }],
      tokens: [{ image: "art/shared.png" }]
    };

    assert.deepEqual(collectPackAssetReferences(pack), ["art/shared.png"]);
    const asset = await loadRoomAsset(packDirectory, "art/shared.png");
    assert.equal(asset.contentType, "image/png");
    assert.equal(asset.size, bytes.length);
    assert.deepEqual(asset.bytes, bytes);
    await validatePackAssets(pack, packDirectory);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects missing, unsupported, oversized, and symlink-escaping artwork", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "parlor-assets-"));
  const packDirectory = join(temporaryRoot, "pack");
  try {
    await mkdir(packDirectory, { recursive: true });
    await writeFile(join(packDirectory, "notes.svg"), "<svg></svg>");
    await writeFile(join(packDirectory, "huge.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
    await writeFile(join(temporaryRoot, "outside.png"), "outside");
    await symlink("../outside.png", join(packDirectory, "linked.png"));

    await assert.rejects(
      loadRoomAsset(packDirectory, "missing.png"),
      (error) => error instanceof RoomAssetError && error.code === "ASSET_NOT_FOUND" && error.status === 404
    );
    await assert.rejects(
      loadRoomAsset(packDirectory, "notes.svg"),
      (error) => error instanceof RoomAssetError && error.code === "ASSET_TYPE_UNSUPPORTED" && error.status === 415
    );
    await assert.rejects(
      loadRoomAsset(packDirectory, "huge.png"),
      (error) => error instanceof RoomAssetError && error.code === "ASSET_TOO_LARGE" && error.status === 413
    );
    await assert.rejects(
      loadRoomAsset(packDirectory, "linked.png"),
      (error) => error instanceof RoomAssetError && error.code === "ASSET_FORBIDDEN" && error.status === 403
    );
    await assert.rejects(
      validatePackAssets({ cardBack: { image: "missing.png" }, cards: [], tokens: [] }, packDirectory),
      /missing\.png.*不存在/
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
