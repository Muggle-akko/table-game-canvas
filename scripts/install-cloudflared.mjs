import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toolsDirectory = resolve(root, ".tools");
const binaryPath = resolve(toolsDirectory, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");

const targets = {
  "darwin-arm64": { asset: "cloudflared-darwin-arm64.tgz", archive: true },
  "darwin-x64": { asset: "cloudflared-darwin-amd64.tgz", archive: true },
  "linux-arm64": { asset: "cloudflared-linux-arm64", archive: false },
  "linux-x64": { asset: "cloudflared-linux-amd64", archive: false }
};

const target = targets[`${process.platform}-${process.arch}`];

if (!target) {
  console.error(`暂不支持自动安装：${process.platform}/${process.arch}`);
  console.error("请从 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 安装 cloudflared。");
  process.exit(1);
}

await mkdir(toolsDirectory, { recursive: true });

const downloadUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/${target.asset}`;
console.log(`正在从 Cloudflare 官方发布页下载 ${target.asset} ...`);

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 90_000);
let response;
try {
  response = await fetch(downloadUrl, { redirect: "follow", signal: controller.signal });
} catch (error) {
  if (error.name === "AbortError") throw new Error("下载 cloudflared 超时，请检查网络后重试。");
  throw error;
} finally {
  clearTimeout(timeout);
}
if (!response.ok) {
  throw new Error(`下载失败：HTTP ${response.status}`);
}

const bytes = Buffer.from(await response.arrayBuffer());
const stagingDirectory = await mkdtemp(resolve(toolsDirectory, "cloudflared-install-"));
const stagedBinaryPath = resolve(stagingDirectory, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");

try {
  if (target.archive) {
    const archivePath = resolve(stagingDirectory, target.asset);
    await writeFile(archivePath, bytes);
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn("tar", ["-xzf", archivePath, "-C", stagingDirectory], { stdio: "inherit" });
      child.once("exit", (code) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`解压 cloudflared 失败，退出码 ${code}`));
      });
      child.once("error", rejectPromise);
    });
  } else {
    await writeFile(stagedBinaryPath, bytes);
  }

  await chmod(stagedBinaryPath, 0o755);
  await rename(stagedBinaryPath, binaryPath);
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
}

console.log(`cloudflared 已安装到 ${binaryPath}`);
console.log("现在可以运行：npm run room -- --name \"玩家1\"");
