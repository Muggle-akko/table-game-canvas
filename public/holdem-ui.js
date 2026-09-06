(function attachHoldemUI(root) {
  "use strict";
  const el = (tag, className = "", text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const phaseNames = { waiting: "准备入局", preflop: "翻牌前", flop: "翻牌", turn: "转牌", river: "河牌", complete: "本手结束" };
  const statusNames = { waiting: "等待下一手", active: "", folded: "已弃牌", "all-in": "已全下", out: "筹码用完", "sitting-out": "本手休息" };
  function create(ui) {
    const $ = (id) => document.getElementById(id);
    let busy = false, rosterSignature = "", actionSignature = "", playersSignature = "", boardSignature = "", ownSignature = "";
    const playerName = (id) => ui.app.state?.players.find((player) => player.id === id)?.name || "玩家";
    const current = () => ui.app.state?.holdem;
    const between = () => ["waiting", "complete"].includes(current()?.phase);
    function miniCard(card, label = "") {
      const node = el("div", `poker-card${card?.face ? "" : " is-back"}`);
      node.setAttribute("role", "img"); node.setAttribute("aria-label", card?.face?.label || label || "尚未发出的公共牌");
      if (card?.face) {
        node.classList.toggle("is-red", card.face.tone === "red");
        node.append(el("b", "", card.face.rank), el("span", "", card.face.symbol));
      } else node.append(el("span", "", label || "·"));
      return node;
    }
    function focusTable() {
      const mat = ui.app.state?.objects.find((object) => object.id === current()?.matId); if (!mat) return;
      const bounds = ui.elements.viewport.getBoundingClientRect(), inset = innerWidth >= 760 ? 360 : 0;
      const scale = Math.max(.2, Math.min(.85, (bounds.width - inset - 96) / mat.width, (bounds.height - 150) / mat.height));
      ui.app.camera = { scale, x: (bounds.width - inset) / 2 - (mat.x + mat.width / 2) * scale, y: bounds.height / 2 - (mat.y + mat.height / 2) * scale };
      ui.app.cameraInitialized = true; ui.app.cameraTouched = true; ui.applyCamera();
    }
    async function send(command) {
      if (busy) return false;
      busy = true; render();
      try { return await ui.sendCommand(command.type.startsWith("holdem-") && current() ? { ...command, decision: current().decision } : command); }
      finally { busy = false; render(); }
    }
    function render() {
      const view = ui.app.state; if (!view) return;
      const poker = view.holdem, host = view.you.role === "host", connected = ui.app.connectionOpen;
      $("holdem-setup").classList.toggle("is-hidden", Boolean(poker)); $("holdem-game").classList.toggle("is-hidden", !poker);
      $("open-holdem").classList.toggle("is-your-turn", Boolean(poker?.actorId === view.you.id && connected));
      $("open-holdem").setAttribute("aria-label", poker?.actorId === view.you.id ? "德州助手，轮到你行动" : "德州助手");
      if (!poker) {
        const signature = JSON.stringify(view.players.map((player) => [player.id, player.name]));
        if (signature !== rosterSignature) {
          const checked = new Map([...$("holdem-seat-choices").querySelectorAll("input")].map((input) => [input.value, input.checked]));
          $("holdem-seat-choices").replaceChildren(...view.players.map((player) => {
            const label = el("label"), input = el("input"); input.type = "checkbox"; input.value = player.id; input.checked = checked.get(player.id) ?? true;
            label.append(input, el("span", "", player.name)); return label;
          })); rosterSignature = signature;
        }
        for (const input of $("holdem-setup-form").querySelectorAll("input, button")) input.disabled = busy || !host || !connected;
        $("holdem-setup-status").textContent = host ? "独立牌桌，每位玩家保留自己的底牌。" : "等房主开启德州，你就可以入局。";
        actionSignature = playersSignature = boardSignature = ownSignature = ""; return;
      }
      $("holdem-phase").textContent = phaseNames[poker.phase]; $("holdem-hand-number").textContent = `第 ${poker.handNumber || "—"} 手`;
      $("holdem-pot-label").textContent = poker.phase === "complete" ? "已结算" : "底池";
      $("holdem-pot").textContent = (poker.phase === "complete" ? poker.lastPot : poker.pot).toLocaleString("zh-CN");
      const matPot = document.querySelector(`[data-object-id="${poker.matId}"] .poker-mat-pot`);
      if (matPot) matPot.textContent = `${poker.phase === "complete" ? "已结算" : "底池"} · ${poker.phase === "complete" ? poker.lastPot : poker.pot}`;
      $("holdem-side-pots").textContent = poker.pots.length > 1 ? poker.pots.map((pot, index) => `${index ? `边池 ${index}` : "主池"} · ${pot.amount}`).join("　") : "";
      $("holdem-refunds").textContent = poker.refunds.map((entry) => `退回 ${playerName(entry.playerId)} 未被跟注的 ${entry.amount}`).join("；");
      const cards = new Map(view.cards.map((card) => [card.id, card])), own = poker.players.find((player) => player.playerId === view.you.id);
      const board = poker.board.map((id) => cards.get(id));
      const nextBoard = JSON.stringify(board.map((card) => [card?.id, card?.face]));
      if (nextBoard !== boardSignature) { $("holdem-community").replaceChildren(...Array.from({ length: 5 }, (_, index) => miniCard(board[index], ["翻", "牌", "", "转", "河"][index]))); boardSignature = nextBoard; }
      const ownCards = (own?.holeCards || []).map((id) => cards.get(id));
      const nextOwn = JSON.stringify(ownCards.map((card) => [card?.id, card?.face]));
      if (nextOwn !== ownSignature) { $("holdem-hole-cards").replaceChildren(...ownCards.map((card) => miniCard(card))); ownSignature = nextOwn; }
      $("holdem-own-stack").textContent = own ? `剩余 ${own.stack.toLocaleString("zh-CN")} 筹码` : "尚未入局";
      const legal = poker.legal, enabled = Boolean(legal && connected && !busy);
      $("holdem-status").textContent = !connected ? "连接恢复后继续这一手。" : poker.phase === "complete" ? "筹码已分好，准备下一手。" : poker.phase === "waiting" ? "准备好后由房主发牌。"
        : legal ? legal.canCheck ? "轮到你，可以过牌或下注。" : `轮到你，需跟注 ${legal.callAmount}${legal.callAmount < legal.owed ? "（全下）" : ""}。`
        : poker.actorId ? `等 ${playerName(poker.actorId)} 行动…` : "本轮下注结束，等房主发牌。";
      $("holdem-status").classList.toggle("is-your-turn", Boolean(legal));
      $("holdem-action-form").classList.toggle("is-hidden", !legal);
      $("holdem-fold").disabled = $("holdem-call").disabled = !enabled;
      $("holdem-call").textContent = legal?.canCheck ? "过牌" : `跟注 ${legal?.callAmount || 0}`;
      $("holdem-all-in").disabled = !enabled || !legal.canAllIn;
      const raiseAllowed = enabled && legal.canRaise && legal.maxRaiseTo >= legal.minRaiseTo;
      $("holdem-raise").disabled = $("holdem-raise-to").disabled = !raiseAllowed;
      for (const button of $("holdem-action-form").querySelectorAll("[data-poker-bet]")) button.disabled = !raiseAllowed;
      const nextAction = JSON.stringify([poker.handNumber, poker.phase, poker.actorId, poker.currentBet, view.you.id]);
      if (nextAction !== actionSignature) {
        $("holdem-raise-to").value = legal?.minRaiseTo || poker.bigBlind;
        $("holdem-raise-to").min = legal?.minRaiseTo || poker.bigBlind; $("holdem-raise-to").max = legal?.maxRaiseTo || poker.bigBlind;
        actionSignature = nextAction;
      }
      $("holdem-result").textContent = poker.phase === "complete" ? poker.payouts.map((entry) => `${playerName(entry.playerId)} +${entry.amount}${poker.players.find((player) => player.playerId === entry.playerId)?.rank?.name ? ` · ${poker.players.find((player) => player.playerId === entry.playerId).rank.name}` : ""}`).join("\n") : "";
      $("holdem-result").classList.toggle("is-hidden", poker.phase !== "complete");
      $("holdem-next").textContent = poker.phase === "waiting" ? "发牌开局" : poker.phase === "complete" ? "下一手" : { preflop: "烧牌并发翻牌", flop: "烧牌并发转牌", turn: "烧牌并发河牌", river: "摊牌并分配底池" }[poker.phase];
      $("holdem-next").classList.toggle("is-hidden", !host);
      $("holdem-next").disabled = !connected || busy || (!between() && !poker.readyToAdvance) || (between() && poker.players.filter((player) => player.stack > 0 && !player.sittingOut).length < 2);
      const nextPlayers = JSON.stringify([poker.players, poker.actorId, poker.dealerId, poker.smallBlindId, poker.bigBlindId, view.players]);
      if (nextPlayers !== playersSignature) {
        $("holdem-players").replaceChildren(...poker.players.map((player) => {
          const person = view.players.find((entry) => entry.id === player.playerId), row = el("article", `poker-player${player.playerId === poker.actorId ? " is-acting" : ""}`);
          row.style.setProperty("--player-color", person?.color || "#7b946d");
          const copy = el("div"), name = el("strong", "", playerName(player.playerId));
          const badges = [player.playerId === poker.dealerId ? "庄" : "", player.playerId === poker.smallBlindId ? "小盲" : "", player.playerId === poker.bigBlindId ? "大盲" : ""].filter(Boolean);
          copy.append(name, el("small", "", [badges.join(" / "), statusNames[player.status], player.sittingOut ? "下手休息" : "", person?.online ? "" : "暂离"].filter(Boolean).join(" · ")));
          const amounts = el("div", "poker-player-amounts"); amounts.append(el("b", "", player.stack.toLocaleString("zh-CN")), el("small", "", player.streetBet ? `本轮 ${player.streetBet}` : ""));
          row.append(copy, amounts); return row;
        })); playersSignature = nextPlayers;
      }
      $("holdem-join").classList.toggle("is-hidden", Boolean(own)); $("holdem-join").disabled = !connected || busy;
      for (const id of ["holdem-sitout", "holdem-rebuy", "holdem-reveal"]) $(id).classList.toggle("is-hidden", !own);
      $("holdem-sitout").disabled = !connected || busy; $("holdem-sitout").textContent = own?.sittingOut ? "准备下一手" : "下手休息";
      $("holdem-rebuy").disabled = !connected || busy || !between(); $("holdem-rebuy").textContent = `补充 ${poker.buyIn}`;
      $("holdem-reveal").disabled = !connected || busy || poker.phase !== "complete" || own?.holeCards.length !== 2 || own.revealed;
      $("holdem-undo").disabled = !connected || busy || !view.canUndo; $("holdem-undo").classList.toggle("is-hidden", !host);
      $("holdem-close").disabled = !connected || busy || !between(); $("holdem-close").classList.toggle("is-hidden", !host);
      $("holdem-fold-offline").classList.toggle("is-hidden", !host);
      $("holdem-fold-offline").disabled = !connected || busy || !poker.actorId || view.players.find((player) => player.id === poker.actorId)?.online !== false;
    }
    $("holdem-setup-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const playerIds = [...$("holdem-seat-choices").querySelectorAll("input")].filter((input) => input.checked).map((input) => input.value);
      if (await send({ type: "holdem-setup", buyIn: Number($("holdem-buyin").value), smallBlind: Number($("holdem-small-blind").value), bigBlind: Number($("holdem-big-blind").value), playerIds })) focusTable();
    });
    $("holdem-fold").addEventListener("click", () => void send({ type: "holdem-action", action: "fold" }));
    $("holdem-call").addEventListener("click", () => void send({ type: "holdem-action", action: current()?.legal?.canCheck ? "check" : "call" }));
    $("holdem-all-in").addEventListener("click", () => void send({ type: "holdem-action", action: "all-in" }));
    $("holdem-action-form").addEventListener("submit", (event) => { event.preventDefault(); void send({ type: "holdem-action", action: "raise", to: Number($("holdem-raise-to").value) }); });
    for (const button of $("holdem-action-form").querySelectorAll("[data-poker-bet]")) button.addEventListener("click", () => {
      const poker = current(), legal = poker?.legal; if (!legal) return;
      const proposed = button.dataset.pokerBet === "minimum" ? legal.minRaiseTo : poker.currentBet + Math.floor((poker.pot + legal.callAmount) * (button.dataset.pokerBet === "half" ? .5 : 1));
      $("holdem-raise-to").value = Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, proposed));
    });
    $("holdem-next").addEventListener("click", () => void send({ type: between() ? "holdem-start" : "holdem-advance" }));
    for (const action of ["join", "sitout", "rebuy", "reveal"]) $(`holdem-${action}`).addEventListener("click", () => void send({ type: `holdem-${action}` }));
    $("holdem-undo").addEventListener("click", () => void send({ type: "undo" }));
    $("holdem-focus").addEventListener("click", focusTable);
    $("holdem-fold-offline").addEventListener("click", () => {
      const poker = current();
      if (poker?.actorId && window.confirm(`为暂离的 ${playerName(poker.actorId)} 弃牌？这项房主操作会写入历史。`)) void send({ type: "holdem-fold-offline", playerId: poker.actorId });
    });
    $("holdem-close").addEventListener("click", () => { if (window.confirm("结束德州助手？这场的筹码记录会收起，牌盒与桌垫留在桌上。房主可以撤销。")) void send({ type: "holdem-close" }); });
    return { render, focusTable };
  }
  root.ParlorHoldemUI = Object.freeze({ create });
})(globalThis);
