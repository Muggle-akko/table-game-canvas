import { accessSync, constants } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function canExecute(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findCloudflared() {
  const candidates = [
    process.env.CLOUDFLARED_BIN,
    resolve(root, ".tools", process.platform === "win32" ? "cloudflared.exe" : "cloudflared"),
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared"
  ].filter(Boolean);

  return candidates.find(canExecute) ?? null;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function fetchWithTimeout(url, milliseconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  try {
    return await fetch(url, { signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(tunnelUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(`${tunnelUrl}/api/health`, 4_000);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(700);
  }

  throw new Error(`公网隧道已经分配地址，但健康检查没有通过：${lastError?.message ?? "超时"}`);
}

export async function startQuickTunnel({ binaryPath, localPort }) {
  const child = spawn(
    binaryPath,
    ["tunnel", "--url", `http://127.0.0.1:${localPort}`, "--no-autoupdate", "--loglevel", "info"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const recentLines = [];
  let rollingOutput = "";
  let settled = false;

  const urlPromise = new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectPromise(new Error(`Cloudflare Tunnel 启动超时。\n${recentLines.slice(-8).join("\n")}`));
    }, 40_000);

    const inspect = (chunk) => {
      const text = chunk.toString("utf8");
      rollingOutput = `${rollingOutput}${text}`.slice(-6000);
      recentLines.push(...text.split(/\r?\n/).filter(Boolean));
      if (recentLines.length > 30) recentLines.splice(0, recentLines.length - 30);
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
        ?? rollingOutput.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolvePromise(match[0]);
      }
    };

    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(new Error(`Cloudflare Tunnel 提前退出（${code ?? "signal"}）。\n${recentLines.slice(-8).join("\n")}`));
    });
  });

  try {
    const url = await urlPromise;
    await waitForHealth(url);
    return {
      url,
      child,
      recentLines,
      stop() {
        if (!child.killed) child.kill("SIGTERM");
      }
    };
  } catch (error) {
    if (!child.killed) child.kill("SIGTERM");
    throw error;
  }
}
