(function attachDealing(root) {
  "use strict";
  const node = (tag, className, text) => {
    const item = document.createElement(tag); item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  };

  function create(ui) {
    const $ = (id) => document.getElementById(id);
    const dialog = $("deal-dialog"), form = $("deal-form"), recipientList = $("deal-recipients");
    const amount = $("deal-count"), random = $("deal-random"), remainder = $("deal-remainder");
    let draft = null;
    const contextKey = () => `${ui.app.state?.room.gameId}:${ui.app.state?.room.epoch}:${ui.app.state?.you.id}`;
    const rows = new Map();
    const source = () => {
      if (!draft) return null;
      let references = draft.references;
      if (draft.stackId) {
        if (!ui.tableResource({ type: "card", id: draft.stackId })) return null;
        references = ui.stack(draft.stackId).map((card) => ({ type: "card", id: card.id }));
      }
      const resources = references.map(ui.tableResource);
      if (!resources.length || resources.some((resource) => !resource || !["card", "deck"].includes(resource.type))) return null;
      return {
        resources,
        count: resources.reduce((total, { type, value }) => total + (type === "deck" ? value.count : 1), 0),
        label: resources.length === 1 && resources[0].type === "deck" ? resources[0].value.label
          : resources.every(({ type }) => type === "card") ? "公共牌堆" : "所选的公共牌与牌堆",
        locked: resources.some(({ type, value }) => type === "card" && value.locked),
        pending: resources.some(({ type, value }) => ui.resourceDropPending(type, value.id))
      };
    };
    const planFor = (value) => root.ParlorEngine.cardDealPlan(value.count, draft.playerIds.size, {
      mode: draft.mode, count: Number(draft.count), remainder: draft.remainder ? "distribute" : "keep"
    });
    function close({ focus = true } = {}) {
      const previous = draft; draft = null;
      if (dialog.hasAttribute("open")) dialog.close();
      if (!focus || !previous) return;
      const visible = (target) => target?.isConnected && !target.disabled && !target.closest('.is-hidden, [aria-hidden="true"], details:not([open])');
      const target = [previous.returnFocus, document.querySelector('[data-selection-action="deal-cards"]:not(:disabled)'), $("open-tools")].find(visible);
      if (target && !target.disabled) target.focus({ preventScroll: true });
    }
    function render() {
      if (!draft) return;
      if (draft.context !== contextKey()) { close({ focus: false }); return; }
      const value = source(), state = ui.app.state, busy = draft.busy || ui.app.pendingCommands.has("deal-resources");
      const players = state.players, activeIds = new Set(players.map((player) => player.id));
      const handCounts = new Map();
      for (const card of state.cards) if (card.zone === "hand") handCounts.set(card.ownerId, (handCounts.get(card.ownerId) || 0) + 1);
      let removed = false;
      for (const id of draft.playerIds) if (!activeIds.has(id)) { draft.playerIds.delete(id); removed = true; }
      if (removed) draft.notice = "离席玩家已移出收牌人，请核对后再发。";
      if (value && !busy && draft.available !== value.count) {
        draft.available = value.count;
        draft.notice = `${removed ? draft.notice : ""}牌堆数量已更新为 ${value.count} 张。`;
      }
      let plan, error = "";
      if (!value) error = "这叠牌已被移动或收起，请关闭后重新选择。";
      else if (value.locked) error = "所选公共牌含锁定的牌，请先解锁。";
      else {
        try { plan = planFor(value); } catch (problem) { error = problem.message; }
      }
      if (!ui.app.connectionOpen && !busy) error = "连接恢复后就可以发牌。";
      else if (value?.pending && !busy) error = "这叠牌的上一项操作还在确认，请稍候。";
      if (busy && draft.submittedPlan) plan = draft.submittedPlan;
      $("deal-source").textContent = `${value?.label || draft.label} · 剩 ${busy ? draft.available : value?.count ?? 0} 张`;
      $("deal-recipient-count").textContent = `已选 ${draft.playerIds.size} / ${players.length} 人`;
      for (const [id, row] of rows) if (!activeIds.has(id)) { row.remove(); rows.delete(id); }
      for (const player of players) {
        let row = rows.get(player.id);
        if (!row) {
          row = node("label", "deal-recipient");
          const input = node("input", ""); input.type = "checkbox"; input.dataset.dealPlayer = player.id;
          const avatar = node("span", "deal-avatar"); avatar.setAttribute("aria-hidden", "true");
          const copy = node("span", "deal-recipient-copy"); copy.append(node("strong", ""), node("small", ""));
          const share = node("span", "deal-recipient-share"); share.setAttribute("aria-hidden", "true");
          row.append(input, avatar, copy, share); rows.set(player.id, row); recipientList.append(row);
        }
        const checked = draft.playerIds.has(player.id), input = row.querySelector("input");
        input.checked = checked; input.disabled = busy; input.setAttribute("aria-label", `给${player.name}发牌`);
        row.classList.toggle("is-selected", checked); row.style.setProperty("--player-color", player.color);
        row.querySelector(".deal-avatar").textContent = Array.from(player.name)[0];
        row.querySelector("strong").textContent = `${player.name}${player.id === state.you.id ? "（我）" : ""}`;
        row.querySelector("strong").title = player.name;
        row.querySelector("small").textContent = `${player.online ? "在线" : "离线"} · 手牌 ${handCounts.get(player.id) || 0} 张`;
        row.querySelector(".deal-recipient-share").textContent = checked && plan ? `+${plan.each}${plan.extra ? `–${plan.maximum}` : ""}` : "—";
      }
      for (const control of form.querySelectorAll("[data-deal-select], [data-deal-mode], [data-deal-count]")) control.disabled = busy;
      for (const button of form.querySelectorAll("[data-deal-mode]")) button.setAttribute("aria-pressed", String(button.dataset.dealMode === draft.mode));
      for (const button of form.querySelectorAll("[data-deal-count]")) button.setAttribute("aria-pressed", String(button.dataset.dealCount === draft.count));
      const fixed = draft.mode === "count";
      $("deal-quantity").classList.toggle("is-hidden", !fixed);
      $("deal-remainder-row").classList.toggle("is-hidden", fixed);
      amount.disabled = busy || !fixed; random.disabled = busy; remainder.disabled = busy || fixed;
      amount.max = String(Math.floor((value?.count || 0) / Math.max(1, draft.playerIds.size)));
      for (const button of form.querySelectorAll("[data-deal-step]")) button.disabled = busy || !fixed
        || (Number(button.dataset.dealStep) < 0 ? Number(draft.count) <= 1 : Number(draft.count) >= Number(amount.max));
      $("deal-each").textContent = plan ? `${plan.each}${plan.extra ? `–${plan.maximum}` : ""} 张` : "—";
      $("deal-total").textContent = plan ? `${plan.total} 张` : "—";
      $("deal-remaining").textContent = `${plan ? plan.remaining : value?.count || 0} 张`;
      const status = $("deal-status");
      status.textContent = busy ? ui.app.connectionOpen ? "正在确认这次发牌…" : "等待连接，正在核对这次发牌…"
        : error || draft.error || draft.notice || (plan?.extra ? `随机 ${plan.extra} 人多拿 1 张，发完后牌堆为空。` : draft.mode === "equal" && plan?.remaining ? `余下 ${plan.remaining} 张留在牌堆。` : "");
      status.classList.toggle("is-error", !busy && Boolean(error || draft.error));
      $("deal-submit").disabled = busy || Boolean(error) || !plan;
      $("deal-submit").textContent = busy ? "正在发牌…" : plan ? `发出 ${plan.total} 张` : "发牌";
      $("deal-cancel").textContent = busy ? "收起" : "取消";
    }
    function open(references, { stackId = null } = {}) {
      if (!ui.app.state || ui.app.pendingCommands.has("deal-resources")) return;
      draft = {
        references: references.map(({ type, id }) => ({ type, id })), stackId,
        playerIds: new Set(ui.app.state.players.filter((player) => player.online || player.id === ui.app.state.you.id).map((player) => player.id)),
        mode: "count", count: "1", random: true, remainder: false, busy: false,
        context: contextKey(), intent: ui.app.selectionIntent, selectionType: ui.app.selection?.type,
        returnFocus: document.activeElement, error: "", notice: ""
      };
      const value = source();
      if (!value) { draft = null; ui.toast("先选择公共牌或牌堆。", "error"); return; }
      draft.label = value.label; draft.available = value.count;
      amount.value = draft.count; random.checked = true; remainder.checked = false;
      recipientList.replaceChildren(); rows.clear();
      ui.onOpen(); render(); dialog.showModal();
      recipientList.querySelector("input")?.focus({ preventScroll: true });
    }
    function edited() { if (draft) { draft.error = ""; draft.notice = ""; render(); } }
    form.addEventListener("click", (event) => {
      if (!draft) return;
      if (event.target.closest("[data-deal-close]")) { close(); return; }
      if (draft.busy || ui.app.pendingCommands.has("deal-resources")) return;
      const selection = event.target.closest("[data-deal-select]");
      const mode = event.target.closest("[data-deal-mode]");
      const preset = event.target.closest("[data-deal-count]");
      const step = event.target.closest("[data-deal-step]");
      if (selection) {
        const kind = selection.dataset.dealSelect;
        draft.playerIds = new Set(ui.app.state.players.filter((player) => kind === "all" || kind === "online" && player.online).map((player) => player.id));
      } else if (mode) draft.mode = mode.dataset.dealMode;
      else if (preset || step) {
        draft.count = String(preset ? Number(preset.dataset.dealCount) : Math.max(1, (Number(draft.count) || 0) + Number(step.dataset.dealStep)));
        amount.value = draft.count;
      } else return;
      edited();
    });
    recipientList.addEventListener("change", (event) => {
      if (!draft || draft.busy || !event.target.dataset.dealPlayer) return;
      draft.playerIds[event.target.checked ? "add" : "delete"](event.target.dataset.dealPlayer); edited();
    });
    amount.addEventListener("input", () => { if (draft && !draft.busy) { draft.count = amount.value; edited(); } });
    random.addEventListener("change", () => { if (draft && !draft.busy) { draft.random = random.checked; edited(); } });
    remainder.addEventListener("change", () => { if (draft && !draft.busy) { draft.remainder = remainder.checked; edited(); } });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!draft || draft.busy) return;
      render();
      if (!draft || $("deal-submit").disabled) return;
      const current = draft, value = source();
      const command = {
        type: "deal-resources", playerIds: [...current.playerIds], expectedCount: value.count,
        mode: current.mode, count: Number(current.count), remainder: current.remainder ? "distribute" : "keep", order: current.random ? "random" : "top",
        resources: value.resources.map(({ type, value }) => ({ type, id: value.id, x: value.x, y: value.y,
          ...(type === "deck" ? { count: value.count, topId: value.top?.id || null } : {}) }))
      };
      current.submittedPlan = planFor(value); current.busy = true; current.error = ""; render();
      try {
        const receipt = await ui.sendCommand(command, { withReceipt: true, onError: (error) => { current.error = error.message; } });
        if (receipt) {
          const focus = draft === current && dialog.hasAttribute("open");
          if (draft === current) close({ focus: false });
          ui.onDealt(receipt, current, { focus });
        } else if (draft === current) current.error ||= "发牌未完成，请核对后重试。";
      } finally {
        current.busy = false;
        if (draft === current) render();
      }
    });
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    dialog.addEventListener("close", () => { if (!dialog.hasAttribute("open")) draft = null; });
    return { open, render, close };
  }
  root.ParlorDeal = Object.freeze({ create });
})(globalThis);
