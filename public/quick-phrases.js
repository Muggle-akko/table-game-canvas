(function (root) {
  "use strict";

  const { QUICK_PHRASES, QUICK_PHRASE_LIFETIME, QUICK_PHRASE_COOLDOWN } = root.ParlorEngine;
  const clamp = (value, min, max) => Math.max(min, Math.min(Math.max(min, max), value));
  const isTyping = (target) => /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName) || target?.isContentEditable;

  function create({ app, toast, postRealtimeMessage, screenToWorld, worldToViewport }) {
    const $ = (id) => document.getElementById(id);
    const panel = $("quick-phrases"), trigger = $("open-phrases"), options = $("phrase-options");
    const layer = $("cursor-phrase-root"), viewport = $("viewport"), announcement = $("phrase-announcement");
    const bubbles = new Map(), latest = new Map();
    let context = null, lastState = null, clock = null, frame = null;
    let pending = null, cooling = false, cooldownTimer = null;
    const isOpen = () => !panel.classList.contains("is-hidden");
    const busyGesture = () => app.drag || app.pan || app.marquee || app.touchNavigation;
    const currentCursor = (playerId) => playerId === app.state?.you.id
      ? (app.localCursor?.visible ? app.localCursor : null) : app.remoteCursors.get(playerId);
    const serverNow = () => clock ? clock.server + performance.now() - clock.local : Date.now();

    function close({ restoreFocus = false } = {}) {
      if (!isOpen()) return false;
      const ownedFocus = panel.contains(document.activeElement);
      panel.classList.add("is-hidden"); trigger.setAttribute("aria-expanded", "false");
      if (restoreFocus && ownedFocus) trigger.focus({ preventScroll: true });
      return true;
    }

    function removeBubble(playerId) {
      const bubble = bubbles.get(playerId);
      if (!bubble) return;
      clearTimeout(bubble.timer); bubble.node.remove(); bubbles.delete(playerId);
      if (announcement.dataset.signalId === bubble.id) announcement.textContent = "";
    }

    function reset() {
      close();
      for (const id of bubbles.keys()) removeBubble(id);
      latest.clear(); lastState = null; clock = null; frame = null;
      pending = null; cooling = false; clearTimeout(cooldownTimer);
      announcement.textContent = "";
    }

    function updateControls() {
      trigger.disabled = !app.state || !app.connectionOpen;
      trigger.setAttribute("aria-busy", String(Boolean(pending)));
      for (const button of options.children) button.disabled = trigger.disabled || Boolean(pending) || cooling;
      $("phrase-status").textContent = !app.connectionOpen ? "正在连接牌桌…"
        : pending ? "正在发送…" : cooling ? "稍等片刻就能再发" : "点选或按数字发送 · Esc 收起";
    }

    function sync() {
      const next = app.state ? `${app.state.room.epoch}:${app.state.you.id}` : null;
      if (next !== context) { reset(); context = next; }
      if (app.state && lastState !== app.state) {
        lastState = app.state;
        if (Number.isFinite(app.state.serverTime)) clock = { server: app.state.serverTime, local: performance.now() };
        const players = new Set(app.state.players.map((player) => player.id));
        for (const id of bubbles.keys()) if (!players.has(id)) removeBubble(id);
        for (const id of latest.keys()) if (!players.has(id)) latest.delete(id);
      }
      updateControls();
    }

    function positionPanel() {
      if (!isOpen()) return;
      const bounds = viewport.getBoundingClientRect(), anchor = trigger.getBoundingClientRect();
      const size = panel.getBoundingClientRect();
      panel.style.left = `${clamp(anchor.right - bounds.left + 10, 8, bounds.width - size.width - 8)}px`;
      panel.style.top = `${clamp(anchor.top - bounds.top - 8, 8, bounds.height - size.height - 8)}px`;
    }

    function open() {
      sync();
      if (trigger.disabled || busyGesture() || document.querySelector("dialog[open]") || !$("help-panel").classList.contains("is-hidden")) return;
      app.selectionIntent++;
      panel.classList.remove("is-hidden"); trigger.setAttribute("aria-expanded", "true");
      positionPanel();
      (options.querySelector("button:not(:disabled)") || $("close-phrases")).focus({ preventScroll: true });
    }

    function measure() {
      frame = viewport.getBoundingClientRect();
      for (const bubble of bubbles.values()) {
        bubble.node.style.maxWidth = `${Math.max(40, Math.min(240, frame.width - 16))}px`;
        // Read dimensions only on creation/resize, never on each pointer event.
        const hidden = bubble.node.classList.contains("is-hidden");
        bubble.node.classList.remove("is-hidden");
        bubble.size = bubble.node.getBoundingClientRect();
        bubble.node.classList.toggle("is-hidden", hidden);
      }
    }

    function render() {
      if (!bubbles.size || !app.state) return;
      if (!frame || (app.cameraViewport && (frame.width !== app.cameraViewport.width || frame.height !== app.cameraViewport.height))) measure();
      for (const [playerId, bubble] of bubbles) {
        const cursor = currentCursor(playerId);
        if (cursor && cursor !== bubble.cursorAtReceipt) bubble.point = cursor;
        const point = worldToViewport(bubble.point), { width, height } = bubble.size;
        const hidden = point.x < 0 || point.x > frame.width || point.y < 0 || point.y > frame.height;
        bubble.node.classList.toggle("is-hidden", hidden);
        if (hidden) continue;
        const leftSide = point.x + 18 + width > frame.width - 8;
        const below = point.y - height - 14 < 8;
        const x = clamp(leftSide ? point.x - width - 16 : point.x + 18, 8, frame.width - width - 8);
        const y = clamp(below ? point.y + 38 : point.y - height - 14, 8, frame.height - height - 8);
        bubble.node.dataset.side = leftSide ? "left" : "right";
        bubble.node.dataset.placement = below ? "below" : "above";
        bubble.node.style.transform = `translate(${x}px, ${y}px)`;
      }
    }

    function receive(signal) {
      sync();
      if (!app.state || signal?.type !== "quick-phrase" || signal.epoch !== app.state.room.epoch) return;
      const phrase = QUICK_PHRASES.find((item) => item.id === signal.phraseId);
      if (!phrase || !app.state.players.some((player) => player.id === signal.playerId)
          || typeof signal.id !== "string" || ![signal.x, signal.y, signal.at, signal.expiresAt].every(Number.isFinite)) return;
      // The room's echo is also confirmation when the HTTP receipt is lost.
      if (signal.playerId === app.state.you.id && pending?.id === signal.requestId) { pending = null; updateControls(); }
      const remaining = Math.min(QUICK_PHRASE_LIFETIME, signal.expiresAt - serverNow());
      const previous = latest.get(signal.playerId);
      if (remaining <= 0 || (previous && (signal.id === previous.id || signal.at <= previous.at))) return;
      latest.set(signal.playerId, { id: signal.id, at: signal.at });
      removeBubble(signal.playerId);
      const node = document.createElement("div"), body = document.createElement("div");
      node.className = `cursor-phrase${signal.playerId === app.state.you.id ? " is-local" : ""}`;
      node.dataset.playerId = signal.playerId;
      node.style.setProperty("--player-color", signal.color);
      node.style.setProperty("--phrase-exit-delay", `${Math.max(0, remaining - 180)}ms`);
      body.className = "cursor-phrase__body";
      const name = document.createElement("div"), text = document.createElement("div");
      name.className = "cursor-phrase__name"; name.textContent = signal.playerId === app.state.you.id ? "你" : signal.name;
      text.className = "cursor-phrase__text"; text.textContent = phrase.text;
      body.append(name, text); node.append(body); layer.append(node);
      const bubble = { id: signal.id, node, point: { x: signal.x, y: signal.y }, cursorAtReceipt: currentCursor(signal.playerId) };
      bubbles.set(signal.playerId, bubble);
      bubble.timer = window.setTimeout(() => { if (bubbles.get(signal.playerId) === bubble) removeBubble(signal.playerId); }, remaining);
      measure(); render();
      announcement.dataset.signalId = signal.id;
      announcement.textContent = `${signal.name}：${phrase.text}`;
    }

    async function send(phraseId, event) {
      sync();
      if (!app.state || !app.connectionOpen || pending || cooling || busyGesture()) return;
      const bounds = viewport.getBoundingClientRect();
      const point = event?.detail > 0 && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
        ? screenToWorld(event.clientX, event.clientY)
        : app.lastTablePoint || screenToWorld(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      const request = { context, id: root.crypto.randomUUID() }; pending = request; cooling = true;
      cooldownTimer = window.setTimeout(() => { cooling = false; updateControls(); }, QUICK_PHRASE_COOLDOWN);
      close({ restoreFocus: true }); updateControls();
      try {
        const result = await postRealtimeMessage({ type: "quick-phrase", requestId: request.id, phraseId, x: point.x, y: point.y });
        if (pending === request && context === request.context) {
          if (!result?.signal) throw new Error("短语没能送达，请稍后重试。");
          receive(result.signal);
        }
      } catch (error) {
        if (pending === request && context === request.context) toast(error.message || "短语没能送达，请稍后重试。", "error");
      } finally {
        if (pending === request) { pending = null; updateControls(); }
      }
    }

    function keydown(event) {
      if (isTyping(event.target)) return false;
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return isOpen();
      if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        if (!event.repeat) { if (!close({ restoreFocus: true })) open(); }
        return true;
      }
      if (!isOpen()) return false;
      if (event.key === "Escape") { event.preventDefault(); close({ restoreFocus: true }); return true; }
      if (event.key === "Tab") return true;
      if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        if (!event.repeat) void send(QUICK_PHRASES[Number(event.key) - 1].id);
        return true;
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = [...options.children].filter((button) => !button.disabled);
        const current = buttons.indexOf(document.activeElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus({ preventScroll: true });
      }
      // Leave Enter/Space to native buttons; other table shortcuts wait until closed.
      return true;
    }

    QUICK_PHRASES.forEach((phrase, index) => {
      const button = document.createElement("button"), key = document.createElement("kbd"), label = document.createElement("span");
      button.type = "button"; button.dataset.phraseId = phrase.id; button.setAttribute("aria-label", phrase.text);
      button.setAttribute("aria-keyshortcuts", String(index + 1));
      key.textContent = String(index + 1); key.setAttribute("aria-hidden", "true"); label.textContent = phrase.text;
      button.append(key, label); button.addEventListener("click", (event) => { void send(phrase.id, event); }); options.append(button);
    });
    trigger.addEventListener("click", () => { if (!close({ restoreFocus: true })) open(); });
    $("close-phrases").addEventListener("click", () => close({ restoreFocus: true }));
    document.addEventListener("pointerdown", (event) => { if (!event.target.closest("#quick-phrases, #open-phrases")) close(); });
    document.addEventListener("focusin", (event) => { if (!event.target.closest("#quick-phrases, #open-phrases")) close(); });
    window.addEventListener("resize", () => { positionPanel(); measure(); render(); });
    window.addEventListener("blur", () => close());
    return { sync, reset, render, receive, keydown };
  }
  root.ParlorPhrases = Object.freeze({ create });
})(window);
