(function attachRoomFeedback(root) {
  "use strict";
  const node = (tag, className, text) => {
    const item = document.createElement(tag); item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  };
  const categoryFor = (action = "") => /card|deck|stack|draw|shuffle|deal|collect/.test(action) ? "cards"
    : /resource|template|pack|bag|token/.test(action) ? "objects" : "table";

  function create(ui) {
    const $ = (id) => document.getElementById(id);
    let identity = "", seen = new Set(), historySignature = "", playerSignature = "";
    const timers = new Map();
    const requests = new Map(), requestTimers = new Map();
    let pendingSelection = null, requestIntent = 0, requestChain = Promise.resolve();

    function removeNotice(item) {
      clearTimeout(timers.get(item)); timers.delete(item); item.remove();
    }
    function announce(entry, chat = false) {
      const item = node("button", `room-notice${chat ? " is-chat" : ""}`);
      item.type = "button"; item.dataset.noticeId = entry.id;
      item.style.setProperty("--notice-color", chat ? entry.color : entry.actorColor || "#dce7aa");
      const name = chat ? entry.name : entry.actorName, text = chat ? entry.text : entry.label;
      item.append(node("strong", "room-notice__name", name), node("span", "room-notice__text", text));
      item.title = `${name} ${text} · ${chat ? "打开聊天" : "查看记录"}`;
      item.addEventListener("click", () => { removeNotice(item); chat ? ui.openChat() : ui.openHistory(); });
      const region = $("room-notices"); region.append(item);
      const ordinary = [...region.children].filter((item) => !item.classList.contains("is-card-request"));
      while (ordinary.length > 4) removeNotice(ordinary.shift());
      timers.set(item, setTimeout(() => removeNotice(item), chat ? 7200 : 4200));
    }
    function showEffect(entry) {
      const effect = entry.effect;
      if (effect?.type !== "shuffle" || !Number.isFinite(effect.x) || !Number.isFinite(effect.y)) return;
      const item = node("div", "shuffle-effect");
      item.setAttribute("aria-hidden", "true");
      item.style.left = `${effect.x}px`; item.style.top = `${effect.y}px`;
      item.style.setProperty("--effect-color", entry.actorColor || "#dce7aa");
      for (let index = 0; index < 3; index++) {
        const card = node("i", "shuffle-effect__card"); card.style.setProperty("--shuffle-index", index - 1); item.append(card);
      }
      $("table-effects").append(item);
      setTimeout(() => item.remove(), 850);
    }
    function consume(state) {
      const key = `${state.room.gameId || state.room.code}:${state.you.id}`;
      const entries = [...state.history.map((entry) => ({ entry, chat: false })), ...(state.messages || []).map((entry) => ({ entry, chat: true }))];
      if (identity !== key) {
        identity = key; seen = new Set(entries.map(({ entry }) => entry.id));
        for (const item of [...timers.keys()]) removeNotice(item);
        for (const playerId of [...requests.keys()]) clearRequest(playerId);
        pendingSelection = null; requestIntent++;
        $("table-effects").replaceChildren();
        return;
      }
      for (const { entry, chat } of entries.sort((a, b) => a.entry.at - b.entry.at)) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        // Rejoining a room must not replay a backlog of animations or chat bubbles.
        if (state.serverTime - entry.at > 12000) continue;
        if (!chat || entry.playerId !== state.you.id) announce(entry, chat);
        if (!chat) showEffect(entry);
      }
      if (seen.size > 1000) seen = new Set(entries.map(({ entry }) => entry.id));
      for (const [playerId, request] of requests) {
        if (!request.cardIds.every((id) => state.cards.some((card) => card.id === id && card.zone === "hand" && card.ownerId === request.ownerId))) clearRequest(playerId);
      }
      renderHighlights();
    }

    function renderHighlights() {
      for (const item of document.querySelectorAll(".is-requested-card")) {
        item.classList.remove("is-requested-card"); item.style.removeProperty("--request-color");
      }
      for (const request of requests.values()) for (const cardId of request.cardIds) {
        for (const item of document.querySelectorAll(".playing-card[data-card-id]")) if (item.dataset.cardId === cardId) {
          item.classList.add("is-requested-card"); item.style.setProperty("--request-color", request.color);
        }
      }
    }
    function clearRequest(playerId) {
      const previous = requests.get(playerId);
      clearTimeout(requestTimers.get(playerId)); requestTimers.delete(playerId); requests.delete(playerId);
      for (const item of [...$("room-notices").children]) if (item.dataset.requesterId === playerId) item.remove();
      if (playerId === ui.app.state?.you.id && previous?.cardIds.includes(ui.app.selection?.id)) ui.clearSelection({ preserveIntent: true });
      renderHighlights();
    }
    function receiveRequest(signal) {
      if (signal.type === "card-request-end") { clearRequest(signal.playerId); return; }
      if (requests.get(signal.playerId)?.id === signal.id || !Array.isArray(signal.cardIds)) return;
      clearRequest(signal.playerId);
      const cardIds = signal.cardIds.filter((id) => ui.app.state?.cards.some((card) => card.id === id && card.zone === "hand" && card.ownerId === signal.ownerId));
      if (!cardIds.length) return;
      const duration = Math.min(8000, Math.max(0, signal.expiresAt - signal.at));
      const request = { ...signal, cardIds, localUntil: Date.now() + duration };
      requests.set(signal.playerId, request);
      requestTimers.set(signal.playerId, setTimeout(() => clearRequest(signal.playerId), duration));
      if (signal.ownerId === ui.app.state.you.id) {
        const offer = node("div", "room-notice is-card-request"); offer.dataset.requesterId = signal.playerId;
        offer.style.setProperty("--notice-color", signal.color);
        const text = node("span", "room-notice__text", `${signal.name} 想选 ${cardIds.length} 张牌`);
        const accept = node("button", "card-request-accept", "交给对方"); accept.type = "button";
        accept.dataset.requestId = signal.id; accept.setAttribute("aria-label", `把这 ${cardIds.length} 张牌交给${signal.name}`);
        accept.addEventListener("click", async () => {
          accept.disabled = true;
          if (await ui.sendCommand({ type: "accept-card-request", requestId: signal.id })) clearRequest(signal.playerId);
          else accept.disabled = false;
        });
        const dismiss = node("button", "card-request-dismiss", "×"); dismiss.type = "button";
        dismiss.setAttribute("aria-label", "暂不交牌"); dismiss.addEventListener("click", () => clearRequest(signal.playerId));
        offer.append(text, accept, dismiss); $("room-notices").append(offer);
      }
      renderHighlights();
    }
    function requestCard(card) {
      if (!ui.app.connectionOpen || card.zone !== "hand" || card.ownerId === ui.app.state.you.id) return Promise.resolve();
      const previous = pendingSelection || requests.get(ui.app.state.you.id);
      const current = previous?.ownerId === card.ownerId && previous.localUntil > Date.now() ? previous.cardIds.filter((id) => ui.app.state.cards.some((item) => item.id === id && item.ownerId === card.ownerId)) : [];
      const cardIds = current.includes(card.id) ? current.filter((id) => id !== card.id) : [...current, card.id];
      if (cardIds.length > 12) return Promise.resolve();
      pendingSelection = { ownerId: card.ownerId, cardIds, localUntil: Date.now() + 8000 };
      const intent = ++requestIntent;
      requestChain = requestChain.catch(() => {}).then(async () => {
        if (intent !== requestIntent) return;
        const result = await ui.postRealtimeMessage(cardIds.length ? { type: "card-request", cardIds } : { type: "card-request-end" });
        if (intent !== requestIntent) return;
        pendingSelection = null;
        if (result?.signal) receiveRequest(result.signal);
      }).catch((error) => { pendingSelection = null; ui.toast(error.message || "标记暂时没有送到", "error"); });
      return requestChain;
    }
    function filteredHistory() {
      const player = $("history-player").value, category = $("history-kind").value;
      const query = $("history-search").value.trim().toLocaleLowerCase();
      return (ui.app.state?.history || []).filter((entry) => (!player || entry.actorId === player)
        && (!category || categoryFor(entry.action) === category)
        && (!query || `${entry.actorName} ${entry.label}`.toLocaleLowerCase().includes(query)));
    }
    function renderHistory() {
      const state = ui.app.state; if (!state) return;
      const players = new Map(state.players.map((player) => [player.id, player.name]));
      for (const entry of state.history) if (!players.has(entry.actorId)) players.set(entry.actorId, entry.actorName);
      const nextPlayers = JSON.stringify([...players]);
      if (nextPlayers !== playerSignature) {
        playerSignature = nextPlayers;
        const previous = $("history-player").value;
        const options = [["", "所有玩家"], ...players].map(([value, name]) => {
          const option = node("option", "", name); option.value = value; return option;
        });
        $("history-player").replaceChildren(...options);
        $("history-player").value = players.has(previous) ? previous : "";
      }
      const entries = filteredHistory();
      const signature = JSON.stringify([entries.map((entry) => entry.id), $("history-player").value, $("history-kind").value, $("history-search").value]);
      if (signature === historySignature) return;
      historySignature = signature;
      $("history-count").textContent = `${entries.length} / ${state.history.length} 条`;
      $("export-history").disabled = !entries.length;
      const items = [...entries].reverse().map((entry) => {
        const item = node("article", "activity-item");
        item.dataset.actorId = entry.actorId; item.style.setProperty("--activity-color", entry.actorColor || "#7b946d");
        const text = node("p", ""); text.append(node("strong", "", entry.actorName), document.createTextNode(` ${entry.label}`));
        const time = node("time", "", new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false }));
        time.dateTime = new Date(entry.at).toISOString(); time.title = new Date(entry.at).toLocaleString("zh-CN");
        item.append(text, time); return item;
      });
      if (!items.length) items.push(node("p", "empty-activity", state.history.length ? "没有符合筛选的操作" : "牌桌刚刚铺好"));
      $("activity-list").replaceChildren(...items);
    }
    for (const id of ["history-player", "history-kind"]) $(id).addEventListener("change", renderHistory);
    $("history-search").addEventListener("input", renderHistory);
    $("export-history").addEventListener("click", () => {
      const data = { room: ui.app.state.room.title, exportedAt: new Date().toISOString(), entries: filteredHistory() };
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = node("a", ""); link.href = url; link.download = "Parlor-操作记录.json";
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    $("identity-chip").addEventListener("click", () => {
      if (!ui.app.state) return;
      $("nickname-input").value = ui.app.state.you.name; $("nickname-editor").showModal(); $("nickname-input").select();
    });
    $("nickname-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (await ui.sendCommand({ type: "rename-player", name: $("nickname-input").value })) $("nickname-editor").close();
    });
    return { consume, renderHistory, requestCard, receiveRequest };
  }
  root.ParlorFeedback = Object.freeze({ create });
})(globalThis);
