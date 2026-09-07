(() => {
  if (!window.isSecureContext || !/^https?:$/.test(location.protocol) || !("serviceWorker" in navigator)) return;
  const workerUrl = new URL("./service-worker.js", document.currentScript.src);
  // Registration also checks for a new complete shell after each online visit.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(workerUrl, { scope: "./", updateViaCache: "none" }).catch(() => {
      console.warn("离线入口缓存暂不可用；已打开的桌面仍可继续使用。");
    });
  }, { once: true });
})();
