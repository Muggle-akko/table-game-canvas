(function attachWorkspace(root) {
  "use strict";
  const el = (tag, className = "", text) => {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = (name) => root.ParlorIcons.create(name);
  const button = (label, className = "", iconName) => {
    const node = el("button", className); node.type = "button";
    if (iconName) node.append(icon(iconName));
    node.append(el("span", "", label)); return node;
  };
  const kindNames = { die: "骰子", note: "便签", counter: "计数器", bag: "收纳袋", mat: "桌面区域", token: "标记" };

  function create(ui) {
    const $ = (id) => document.getElementById(id);
    const vault = root.ParlorVault;
    const catalog = root.ParlorEngine.RESOURCE_CATALOG;
    let category = "all", importedPacks = [], scenes = [], previews = [], favorites = vault.favorites();
    let previewListSignature = "";
    let librarySignature = "", locationsSignature = "", handSignature = "", chatSignature = "";
    let initializedRoom = false, openAux = null, returnFocus = null, editorId = null, saving = false;
    let libraryDrag = null, lastDragAt = 0, spawnNumber = 0, spawning = false, seenMessages = new Set();
    const spawnQueue = [], pendingAssets = new Map();
    let mapBounds = { x: -200, y: -200, width: 2200, height: 1500 };
    const panels = { world: $("world-panel"), chat: $("chat-panel"), saves: $("saves-panel") };
    const auxBackdrop = button("", "aux-backdrop is-hidden");
    auxBackdrop.setAttribute("aria-label", "关闭面板"); ui.elements.room.append(auxBackdrop);

    const handleError = (error) => ui.toast(error.message || "没有完成，请再试一次。", "error");
    const guarded = (operation) => Promise.resolve().then(operation).catch(handleError);
    async function refreshVault() {
      const results = await Promise.allSettled([vault.listPacks(), vault.listScenes(), ui.previewMode ? vault.listPreviews() : Promise.resolve([])]);
      if (results[0].status === "fulfilled") importedPacks = results[0].value;
      if (results[1].status === "fulfilled") scenes = results[1].value;
      if (results[2].status === "fulfilled") previews = results[2].value;
      renderLibrary(true); renderSaves();
    }

    function entries() {
      const builtin = (ui.app.state?.room.packOptions || root.ParlorPacks.map((pack) => ({ id: pack.id, name: pack.name, cardCount: pack.cards.length })))
        .map((pack) => ({ key: `pack:${pack.id}`, type: "pack", id: pack.id, label: pack.name, description: `${pack.cardCount} 张牌 · 可反复取用`, category: "packs", count: pack.cardCount }));
      const local = importedPacks.map(({ id, pack }) => ({
        key: `import:${id}`, type: "import", id: pack.id, localId: id, label: pack.name, description: `${pack.cards.length} 张牌 · 我的导入`, category: "packs", count: pack.cards.length, pack
      }));
      const objects = catalog.map((resource) => ({ key: resource.id, type: "object", id: resource.id, label: resource.label, description: resource.description, category: resource.kind === "mat" ? "boards" : "objects", resource }));
      const saved = (ui.app.state?.templates || []).map((template) => ({
        key: template.id, type: "saved", id: template.id, label: template.label, description: `${template.count} ${template.kind === "deck" ? "张" : "件"} · 同桌收藏`, category: "favorites", kind: template.kind, count: template.count, unit: template.kind === "deck" ? "张" : "件", canDelete: template.canDelete
      }));
      return [...builtin, ...local, ...objects, ...saved];
    }

    function makeObjectNode(object, { ghost = false } = {}) {
      const node = el("div", `world-object object-${object.kind}${object.locked ? " is-locked" : ""}${ghost ? " is-ghost" : ""}`);
      node.dataset.objectId = object.id || "";
      node.dataset.kind = object.kind;
      node.dataset.resourceId = object.resourceId || "";
      node.style.left = `${object.x || 0}px`; node.style.top = `${object.y || 0}px`;
      node.style.width = `${object.width}px`; node.style.height = `${object.height}px`;
      node.style.setProperty("--object-color", object.color);
      node.style.transform = `rotate(${object.rotation || 0}deg)`;
      node.style.zIndex = String(object.kind === "mat" ? 1 : 40 + (object.z || 0));
      node.setAttribute("role", "group"); node.tabIndex = ghost ? -1 : 0;
      node.setAttribute("aria-label", `${object.label}${object.locked ? "，已锁定" : ""}${object.kind === "die" ? `，${object.value === null ? "尚未掷骰" : object.value + " 点"}` : ""}`);
      const gesture = { die: "双击掷骰", note: "双击编辑", bag: "双击摸一个", mat: "拖动边框移动" }[object.kind];
      node.title = `${object.label}${gesture ? ` · ${gesture}` : ""}`;
      if (object.kind === "die") {
        const face = el("span", `world-die-face${object.sides === 20 ? " is-d20" : ""}`);
        if (object.sides === 6 && object.value) {
          face.dataset.value = String(object.value);
          for (let index = 0; index < 9; index++) face.append(el("i", `pip pip-${index}`));
        } else face.append(el("b", "", object.value ?? "?"));
        node.append(face, el("small", "object-caption", `D${object.sides}`));
      } else if (object.kind === "counter") {
        node.append(el("strong", "counter-object-label", object.label));
        const row = el("div", "counter-object-row");
        const minus = button("", "", "minus"), plus = button("", "", "plus");
        minus.dataset.objectAction = "minus"; plus.dataset.objectAction = "plus";
        minus.tabIndex = plus.tabIndex = ghost ? -1 : 0;
        minus.disabled = plus.disabled = !ghost && !ui.app.connectionOpen;
        minus.setAttribute("aria-label", `${object.label}减一`); plus.setAttribute("aria-label", `${object.label}加一`);
        row.append(minus, el("output", "", object.value), plus); node.append(row);
      } else if (object.kind === "note") {
        node.append(el("strong", "note-object-label", object.label), el("p", "note-object-text", object.text));
      } else if (object.kind === "bag") {
        const body = el("div", "bag-body"); body.append(icon("package"), el("b", "", object.count ?? object.contents?.length ?? 0));
        node.append(body, el("strong", "bag-label", object.label));
      } else if (object.kind === "mat") {
        node.dataset.pattern = object.pattern;
        const heading = el("div", "mat-heading"); heading.append(el("strong", "", object.label));
        node.append(heading);
        if (object.pattern === "checker") node.append(el("div", "checker-cells"));
        if (object.pattern === "poker") {
          const slots = el("div", "poker-mat-slots");
          for (const label of ["翻", "牌", "", "转", "河"]) slots.append(el("span", "", label));
          node.append(slots, el("div", "poker-mat-pot", "底池"));
        }
      }
      if (!ghost) ui.appendLockIndicator(node, object.locked);
      return node;
    }

    function thumbnail(entry) {
      const visual = el("div", `asset-art asset-art--${entry.type === "pack" || entry.type === "import" ? "pack" : entry.resource?.kind || entry.kind}`);
      if (["pack", "import"].includes(entry.type)) {
        const pack = entry.pack || root.ParlorPacks.find((pack) => pack.id === entry.id);
        const back = pack?.cardBack || { color: "#355b49", label: entry.label };
        const card = el("div", "asset-card-back"); card.style.setProperty("--asset-color", back.color);
        card.append(el("b", "", entry.id === "uno" ? "UNO" : entry.id === "moon-outpost" ? "MOON" : "P"));
        visual.append(card);
        if (pack?.cards[0]) {
          const face = pack.cards.find((card) => card.rank === "A") || pack.cards[0];
          const sample = el("div", "asset-card-front");
          sample.style.setProperty("--sample-color", face.color || "#f6f0e6");
          sample.style.setProperty("--sample-ink", face.textColor || (face.tone === "red" ? "#a74236" : "#223c31"));
          sample.append(el("b", "", face.rank), el("span", "", face.symbol)); visual.append(sample);
        }
      } else if (entry.type === "saved") {
        visual.append(icon(entry.kind === "deck" ? "cards-three" : entry.kind === "die" ? "dice-six" : "package"));
      } else if (entry.resource.kind === "token") {
        const token = el("span", "asset-token", entry.resource.symbol); token.style.setProperty("--token-color", entry.resource.color); visual.append(token);
      } else {
        const sample = makeObjectNode({ ...entry.resource, id: "", x: 0, y: 0, value: entry.resource.kind === "die" ? (entry.resource.sides === 6 ? 5 : 20) : 0, count: 0, text: "" }, { ghost: true });
        sample.removeAttribute("role"); sample.removeAttribute("tabindex"); sample.setAttribute("aria-hidden", "true");
        visual.append(sample);
      }
      return visual;
    }

    function renderLibrary(force = false) {
      if (!ui.app.state) return;
      const term = $("library-search").value.trim().toLowerCase();
      const all = entries();
      const signature = JSON.stringify([category, term, all.map(({ key, label, description }) => [key, label, description]), [...favorites], ui.app.connectionOpen, ui.app.state.you.id, ui.app.state.you.role]);
      if (!force && signature === librarySignature) return;
      librarySignature = signature;
      const filtered = all.filter((entry) => (category === "all" || (category === "favorites" ? favorites.has(entry.key) || entry.type === "saved" : entry.category === category))
        && `${entry.id} ${entry.label} ${entry.description}`.toLowerCase().includes(term));
      const nodes = filtered.map((entry) => {
        const card = el("article", "asset-item"); card.dataset.libraryKey = entry.key;
        const preview = button("", "asset-preview"); preview.setAttribute("aria-label", `添加${entry.label}`); preview.dataset.addAsset = entry.key;
        preview.replaceChildren(thumbnail(entry));
        preview.title = `${entry.label} · ${entry.description}`;
        const copy = el("div", "asset-copy"); copy.append(el("strong", "", entry.label));
        if (entry.count !== undefined) copy.append(el("small", "", `${entry.count} ${entry.unit || "张"}${entry.type === "import" ? " · 导入" : ""}`));
        const add = button("", "asset-add", "plus"); add.dataset.addAsset = entry.key; add.setAttribute("aria-label", `添加${entry.label}`);
        const disabled = !ui.app.connectionOpen || (entry.type === "import" && ui.app.state.you.role !== "host");
        add.disabled = disabled; preview.disabled = disabled;
        const favorite = button(favorites.has(entry.key) ? "★" : "☆", `asset-favorite${favorites.has(entry.key) ? " is-favorite" : ""}`);
        favorite.dataset.favorite = entry.key; favorite.setAttribute("aria-label", `${favorites.has(entry.key) ? "取消收藏" : "收藏"}${entry.label}`);
        favorite.setAttribute("aria-pressed", String(favorites.has(entry.key)));
        if (entry.type === "saved" && entry.canDelete) {
          delete favorite.dataset.favorite; favorite.dataset.removeTemplate = entry.id;
          favorite.replaceChildren(icon("x")); favorite.removeAttribute("aria-pressed");
          favorite.setAttribute("aria-label", `移除本桌收藏${entry.label}`); favorite.disabled = !ui.app.connectionOpen;
        }
        card.append(preview, favorite, copy, add);
        if (entry.type === "import") {
          const remove = button("", "asset-remove", "x"); remove.dataset.removePack = entry.localId;
          remove.setAttribute("aria-label", `从本机资源库移除${entry.label}`); remove.title = "从本机资源库移除";
          card.append(remove);
        }
        return card;
      });
      if (!nodes.length) {
        const empty = el("div", "library-empty"); empty.append(icon("package"), el("strong", "", term ? "没找到这件物品" : "暂无收藏")); nodes.push(empty);
      }
      ui.elements.packLibrary.replaceChildren(...nodes);
      renderPendingAssets();
      $("library-total").textContent = String(all.length);
      $("import-pack").disabled = !ui.app.connectionOpen || ui.app.state.you.role !== "host";
      $("import-pack").title = ui.app.state.you.role === "host" ? "导入 JSON 牌盒" : "由房主导入牌盒";
    }

    function placement(entry) {
      const rect = ui.elements.viewport.getBoundingClientRect();
      const libraryOpen = ui.elements.libraryPanel.classList.contains("is-open") && rect.width >= 760;
      const left = libraryOpen ? Math.max(80, ui.elements.libraryPanel.getBoundingClientRect().right - rect.left + 24) : 80;
      const point = ui.screenToWorld(rect.left + left + (rect.width - left - 150) / 2, rect.top + (rect.height - 60) / 2);
      const size = entry?.resource || { width: 94, height: 138 };
      return { x: point.x - (size.width || 94) / 2 + (spawnNumber % 4) * 32, y: point.y - (size.height || 138) / 2 + (Math.floor(spawnNumber / 4) % 3) * 24 };
    }

    function renderPendingAssets() {
      for (const node of ui.elements.packLibrary.children) {
        const count = pendingAssets.get(node.dataset.libraryKey) || 0;
        const add = node.querySelector(".asset-add");
        if (!add) continue;
        const label = node.querySelector(".asset-copy strong").textContent;
        node.setAttribute("aria-busy", String(count > 0));
        if (count) add.dataset.pendingCount = String(count);
        else delete add.dataset.pendingCount;
        add.title = count ? `${count} 件正在添加，点击继续取用` : `添加${label}`;
        add.setAttribute("aria-label", count ? `继续添加${label}，${count} 件等待完成` : `添加${label}`);
      }
    }

    const sameSpawnContext = (request) => ui.app.state?.you.id === request.playerId && ui.app.state?.room.code === request.roomCode;

    async function drainSpawns() {
      if (spawning) return;
      spawning = true;
      let cancellationNotified = false;
      try {
        while (spawnQueue.length) {
          const request = spawnQueue.shift();
          let completed = false;
          try {
            if (!ui.app.connectionOpen || !sameSpawnContext(request)) {
              if (!cancellationNotified) { ui.toast("未发送的资源取用已取消，请重新取用。"); cancellationNotified = true; }
              continue;
            }
            const receipt = await ui.sendCommand(request.command, { withReceipt: true });
            completed = Boolean(receipt);
            if (receipt && sameSpawnContext(request)) {
              const created = receipt.createdResource;
              const resources = { deck: ui.app.state.decks, object: ui.app.state.objects, token: ui.app.state.tokens }[created?.type];
              const canSelect = request.intent === ui.app.selectionIntent && !ui.app.drag && !ui.app.pan && !ui.app.touchNavigation && !ui.app.handTouch;
              if (canSelect && Array.isArray(resources) && resources.some((item) => item.id === created.id)) {
                ui.selectResource(created.type, created.id, { preserveIntent: true });
                if (innerWidth < 760 && ui.elements.libraryPanel.classList.contains("is-open")) ui.hideSidePanels({ returnFocus: false });
              }
              ui.toast(`「${request.entry.label}」已放上桌`);
            }
          } catch (error) { handleError(error); }
          finally {
            const remaining = (pendingAssets.get(request.entry.key) || 1) - 1;
            if (remaining) pendingAssets.set(request.entry.key, remaining);
            else pendingAssets.delete(request.entry.key);
            renderPendingAssets();
            request.resolve(completed);
          }
        }
      } finally { spawning = false; }
    }

    async function addAsset(entry, point) {
      if (!entry || !ui.app.state) return false;
      if (!ui.app.connectionOpen) { ui.toast("正在连接牌桌，请稍后再取用。"); return false; }
      const command = entry.type === "pack" ? { type: "add-pack", packId: entry.id }
        : entry.type === "import" ? { type: "import-pack", pack: entry.pack }
          : entry.type === "saved" ? { type: "spawn-template", templateId: entry.id } : { type: "spawn-resource", resourceId: entry.id };
      const position = point || placement(entry);
      spawnNumber++;
      const request = { entry, command: { ...command, ...position }, playerId: ui.app.state.you.id, roomCode: ui.app.state.room.code, intent: ++ui.app.selectionIntent };
      pendingAssets.set(entry.key, (pendingAssets.get(entry.key) || 0) + 1);
      renderPendingAssets();
      return new Promise((resolve) => {
        spawnQueue.push({ ...request, resolve });
        void drainSpawns();
      });
    }

    function renderObjects() {
      const root = $("objects-root"), existing = new Map([...root.children].map((node) => [node.dataset.objectId, node]));
      const current = new Set();
      for (const object of ui.app.state.objects || []) {
        current.add(object.id);
        const signature = JSON.stringify([object, ui.app.connectionOpen]), old = existing.get(object.id);
        if (old?.dataset.signature === signature) continue;
        const node = makeObjectNode(object); node.dataset.signature = signature;
        if (old) {
          if (old.dataset.rollId !== String(object.rollId) && object.kind === "die") node.classList.add("just-rolled");
          const focused = old.contains(document.activeElement), action = document.activeElement?.dataset.objectAction;
          old.replaceWith(node);
          if (focused) (action ? node.querySelector(`[data-object-action="${action}"]`) : node)?.focus({ preventScroll: true });
        }
        else root.append(node);
        node.dataset.rollId = String(object.rollId);
      }
      for (const [id, node] of existing) if (!current.has(id)) node.remove();
    }

    function drawMap() {
      const state = ui.app.state; if (!state || $("minimap-panel").classList.contains("is-hidden")) return;
      const canvas = $("minimap"), ctx = canvas.getContext("2d"); if (!ctx) return;
      const items = [
        ...(state.decks || []).map((item) => ({ ...item, width: 94, height: 138, color: item.back.color })),
        ...state.cards.filter((card) => card.zone === "public").map((card) => ({ ...card, width: 94, height: 138, color: "#e9e6d7" })),
        ...(state.tokens || []).map((token) => ({ ...token, width: 62, height: 62 })), ...(state.objects || [])
      ];
      const minX = Math.min(0, ...items.map((item) => item.x)) - 180, minY = Math.min(0, ...items.map((item) => item.y)) - 180;
      const maxX = Math.max(1800, ...items.map((item) => item.x + item.width)) + 180, maxY = Math.max(1100, ...items.map((item) => item.y + item.height)) + 180;
      const scale = Math.min(canvas.width / (maxX - minX), canvas.height / (maxY - minY));
      mapBounds = { x: minX - (canvas.width / scale - (maxX - minX)) / 2, y: minY - (canvas.height / scale - (maxY - minY)) / 2, width: canvas.width / scale, height: canvas.height / scale };
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#365646"; ctx.fillRect((205 - mapBounds.x) * scale, (205 - mapBounds.y) * scale, 1390 * scale, 565 * scale);
      for (const item of items) {
        ctx.fillStyle = item.color || "#a9c3b2";
        ctx.globalAlpha = item.kind === "mat" ? 0.5 : 0.9;
        ctx.fillRect((item.x - mapBounds.x) * scale, (item.y - mapBounds.y) * scale, Math.max(3, item.width * scale), Math.max(3, item.height * scale));
      }
      const rect = ui.elements.viewport.getBoundingClientRect(), camera = ui.app.camera;
      ctx.globalAlpha = 1; ctx.strokeStyle = "#d8dfb8"; ctx.lineWidth = 2;
      ctx.strokeRect((-camera.x / camera.scale - mapBounds.x) * scale, (-camera.y / camera.scale - mapBounds.y) * scale, rect.width / camera.scale * scale, rect.height / camera.scale * scale);
    }

    function renderLocations() {
      const state = ui.app.state;
      const mats = (state.objects || []).filter((object) => object.kind === "mat");
      const signature = JSON.stringify([mats, state.decks]); if (signature === locationsSignature) return; locationsSignature = signature;
      const home = button("主桌", "location-item", "cards-three"); home.addEventListener("click", () => { ui.fitCamera(); if (innerWidth < 760) closePanel(); });
      const nodes = [home, ...mats.map((mat) => {
        const node = button(mat.label, "location-item", "stack");
        node.append(el("small", "", mat.pattern === "checker" ? "方格棋盘" : "自由区域"));
        node.addEventListener("click", () => { ui.focusWorldPoint({ x: mat.x + mat.width / 2, y: mat.y + mat.height / 2 }); if (innerWidth < 760) closePanel(); }); return node;
      })];
      $("world-locations").replaceChildren(...nodes);
    }

    function renderHand() {
      const own = ui.app.state.cards.filter((card) => card.zone === "hand" && card.ownerId === ui.app.state.you.id);
      $("hand-count").textContent = String(own.length);
      const signature = JSON.stringify(own); if (signature === handSignature) return; handSignature = signature;
      const container = $("hand-cards"), scrollLeft = container.scrollLeft;
      const existing = new Map([...container.children].map((node) => [node.dataset.cardId, node]));
      const ids = new Set(own.map((card) => card.id));
      const activeCardId = ui.app.handTouch?.cardId || (ui.app.drag?.fromPocket ? ui.app.drag.resource.id : null);
      if (activeCardId && !ids.has(activeCardId)) ui.cancelHandInteraction();
      for (const [index, card] of own.entries()) {
        const old = existing.get(card.id);
        const cardSignature = JSON.stringify([card.face, card.back, card.deckId, card.canControl, card.locked]);
        const node = old?.dataset.pocketSignature === cardSignature ? old : ui.makeCardNode(card, { x: 0, y: 0, rotation: 0, z: 0 });
        node.dataset.pocketSignature = cardSignature;
        if (old && old !== node) {
          const focused = old.contains(document.activeElement);
          old.replaceWith(node);
          if (focused) node.focus({ preventScroll: true });
        }
        if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null);
      }
      for (const [id, node] of existing) if (!ids.has(id)) node.remove();
      if (!own.length) container.append(el("p", "empty-hand", "暂无手牌"));
      container.scrollLeft = scrollLeft;
    }

    function toggleHand() {
      ui.app.selectionIntent++;
      const open = $("hand-drawer").classList.toggle("is-hidden") === false;
      $("open-hand").setAttribute("aria-expanded", String(open));
      if (open) $("hand-cards").querySelector("[tabindex]")?.focus({ preventScroll: true });
      else { ui.cancelHandInteraction(); $("open-hand").focus({ preventScroll: true }); }
    }

    function renderChat() {
      const messages = ui.app.state.messages || [], signature = JSON.stringify(messages);
      if (signature === chatSignature) return;
      chatSignature = signature;
      const container = $("chat-messages"), atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 70;
      const unread = messages.filter((message) => !seenMessages.has(message.id) && message.playerId !== ui.app.state.you.id).length;
      if (openAux !== "chat" && unread) { $("chat-unread").classList.remove("is-hidden"); $("chat-unread").textContent = String(Math.min(99, Number($("chat-unread").textContent || 0) + unread)); }
      messages.forEach((message) => seenMessages.add(message.id));
      const nodes = messages.map((message) => {
        const row = el("article", `chat-message${message.playerId === ui.app.state.you.id ? " is-mine" : ""}`);
        const heading = el("div", "chat-message-heading");
        const name = el("strong", "", message.name); name.style.setProperty("--player-color", message.color);
        heading.append(name, el("time", "", new Date(message.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })));
        row.append(heading, el("p", "", message.text)); return row;
      });
      if (!nodes.length) nodes.push(el("p", "chat-empty", "暂无消息"));
      container.replaceChildren(...nodes);
      if (atBottom || messages.at(-1)?.playerId === ui.app.state.you.id) container.scrollTop = container.scrollHeight;
    }

    function hideMinimap({ returnFocus: restoreFocus = false } = {}) {
      const wasOpen = !$("minimap-panel").classList.contains("is-hidden");
      $("minimap-panel").classList.add("is-hidden"); $("toggle-minimap").setAttribute("aria-expanded", "false");
      if (wasOpen && restoreFocus) $("toggle-minimap").focus();
      return wasOpen;
    }
    function toggleMinimap() {
      if (hideMinimap({ returnFocus: true })) return;
      ui.hideSidePanels({ returnFocus: false }); ui.clearSelection();
      if (innerWidth < 760 && !$("hand-drawer").classList.contains("is-hidden")) toggleHand();
      $("minimap-panel").classList.remove("is-hidden"); $("toggle-minimap").setAttribute("aria-expanded", "true");
      drawMap(); $("minimap").focus();
    }

    function closePanel({ returnFocus: restoreFocus = true } = {}) {
      hideMinimap();
      Object.values(panels).forEach((panel) => { panel.classList.remove("is-open"); panel.setAttribute("aria-hidden", "true"); });
      for (const id of ["open-world", "open-chat", "open-saves"]) $(id).setAttribute("aria-expanded", "false");
      auxBackdrop.classList.add("is-hidden"); openAux = null;
      if (restoreFocus) returnFocus?.focus({ preventScroll: true }); returnFocus = null;
    }
    function showPanel(name) {
      ui.app.selectionIntent++;
      if (name === openAux) { closePanel(); return; }
      closePanel(); ui.hideSidePanels({ returnFocus: false }); returnFocus = document.activeElement;
      openAux = name; panels[name].classList.add("is-open"); panels[name].setAttribute("aria-hidden", "false");
      panels[name].setAttribute("role", "dialog"); panels[name].setAttribute("aria-modal", String(innerWidth < 760));
      $(name === "saves" ? "open-saves" : `open-${name}`).setAttribute("aria-expanded", "true");
      auxBackdrop.classList.toggle("is-hidden", innerWidth >= 760);
      if (name === "chat") { $("chat-unread").classList.add("is-hidden"); $("chat-unread").textContent = ""; $("chat-input").focus(); $("chat-messages").scrollTop = $("chat-messages").scrollHeight; }
      else if (name === "saves") { if (!$("save-name").value) $("save-name").value = ui.app.state.room.title; guarded(refreshVault); $("save-name").focus(); }
      else panels[name].querySelector("button")?.focus();
    }

    function editObject(object) {
      editorId = object.id; $("resource-label").value = object.label; $("resource-text").value = object.text || "";
      $("resource-text").classList.toggle("is-hidden", object.kind !== "note"); $("resource-text-label").classList.toggle("is-hidden", object.kind !== "note");
      $("resource-editor").showModal();
    }
    function inspectCard(card) {
      $("inspected-card").replaceChildren(ui.makeCardNode({ ...card, canControl: false }, { x: 0, y: 0, z: 0, rotation: 0 })); $("card-inspector").showModal();
    }

    function extraActions(resource, secondaryActions = []) {
      const extra = el("details", "selection-more"), summary = el("summary", "", "更多");
      summary.setAttribute("aria-label", "更多物件操作"); summary.title = "更多操作";
      const menu = el("div", "selection-more-menu");
      if (secondaryActions.length) {
        const divider = el("div", "selection-menu-divider"); divider.setAttribute("role", "separator");
        menu.append(...secondaryActions, divider);
      }
      const canControl = resource.value.canControl !== false;
      const add = (action, label, iconName, disabled = false) => menu.append(ui.makeSelectionAction(action, iconName, label, { disabled: disabled || (action !== "inspect" && (!ui.app.connectionOpen || !canControl)) }));
      if (resource.type === "card") add("inspect", "放大看看", "eye");
      if (resource.type !== "token") add("resource-duplicate", "复制", "plus", resource.value.locked || (resource.value.kind === "bag" && resource.value.count > 0));
      add("resource-lock", resource.value.locked ? "解除锁定" : "锁定位置", "hand-grabbing");
      if (resource.type !== "card") add("resource-save", "存入资源库", "package", resource.value.kind === "bag" && resource.value.count > 0);
      if (!(resource.type === "deck" && resource.value.id === "main")) add("resource-delete", "收起物件", "x", resource.value.locked);
      extra.append(summary, menu); return extra;
    }
    function handleAction(action, resource) {
      const ref = { resourceType: resource.type, resourceId: resource.value.id };
      if (action.startsWith("resource-")) {
        const type = { "resource-duplicate": "duplicate-resource", "resource-lock": "lock-resource", "resource-delete": "delete-resource", "resource-save": "save-template" }[action];
        if (type) void ui.sendCommand({ type, ...ref }); return true;
      }
      if (action === "inspect") { inspectCard(resource.value); return true; }
      if (action === "edit-object") { editObject(resource.value); return true; }
      if (action === "roll-object") { void ui.sendCommand({ type: "roll-resource", ...ref }); return true; }
      if (["counter-minus", "counter-plus"].includes(action)) { void ui.sendCommand({ type: "adjust-resource", ...ref, delta: action === "counter-minus" ? -1 : 1 }); return true; }
      if (action === "bag-draw") { void ui.sendCommand({ type: "bag-draw", bagId: resource.value.id }); return true; }
      if (action === "collect-deck") { void ui.sendCommand({ type: "collect-deck", deckId: resource.value.id }); return true; }
      return false;
    }

    async function currentScene(kind = $("save-kind").value) {
      const name = $("save-name").value.trim() || ui.app.state.room.title;
      if (ui.previewMode) return (kind === "scene" ? root.ParlorEngine.exportRoomScene : root.ParlorEngine.exportRoomGame)(ui.app.previewModel.engineRoom, ui.app.state.you.id, name);
      return ui.fetchScene(name, kind);
    }
    function download(scene) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(scene, null, 2)], { type: "application/json" }));
      const link = el("a"); link.href = url; link.download = `${scene.name || "Parlor"}.parlor.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function renderPreviewList() {
      const others = previews.filter((record) => record.id !== ui.app.previewPersistence?.id);
      $("other-previews").classList.toggle("is-hidden", !ui.previewMode || !others.length);
      const signature = JSON.stringify([others, saving, ui.app.pendingCommands.size > 0]);
      if (signature === previewListSignature) return;
      previewListSignature = signature;
      $("saved-previews").replaceChildren(...others.map((record) => {
        const row = el("article", "saved-scene"), load = button(record.name || "试玩桌面", "saved-scene-load", "stack");
        load.dataset.previewId = record.id;
        load.append(el("small", "", `${record.playerCount} 人 · ${new Date(record.updatedAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`));
        load.disabled = saving || ui.app.pendingCommands.size > 0;
        load.addEventListener("click", () => guarded(() => ui.openSavedPreview(record)));
        row.append(load); return row;
      }));
    }
    function renderSaveStatus() {
      if (!ui.app.state) return;
      const host = ui.app.state.you.role === "host";
      const persistence = ui.previewMode ? ui.app.previewPersistence : ui.app.state.persistence;
      $("autosave-status").textContent = ui.app.previewTransition ? "正在保留当前桌面，完成后继续…" : persistence?.error || (ui.previewMode
        ? persistence?.pending ? "正在保存试玩…" : persistence?.savedAt ? `试玩已自动保存到本机 · ${new Date(persistence.savedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "本机试玩，可保存或导出完整对局。"
        : persistence?.enabled && persistence.savedAt ? `房主电脑已自动存档 · ${new Date(persistence.savedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "自动存档尚未确认，请先导出文件保留对局。");
      $("autosave-status").classList.toggle("has-error", Boolean(persistence?.error));
      $("preview-save-actions").classList.toggle("is-hidden", !ui.previewMode);
      $("new-preview").disabled = !host || saving || ui.app.pendingCommands.size > 0;
      $("retry-preview-save").classList.toggle("is-hidden", !persistence?.error);
      $("retry-preview-save").disabled = saving;
      $("seat-recovery").classList.toggle("is-hidden", ui.previewMode);
      renderPreviewList();
    }
    function renderSaves() {
      if (!ui.app.state) return;
      const host = ui.app.state.you.role === "host";
      for (const id of ["save-scene", "save-name", "save-kind", "export-scene", "import-scene"]) $(id).disabled = !host || !ui.app.connectionOpen || saving;
      $("save-privacy").textContent = $("save-kind").value === "scene" ? "模板用于重新开局：手牌收回，牌堆重新洗牌。" : "完整对局包含所有私有牌面和续局口令，仅供房主保管。";
      renderSaveStatus();
      $("copy-my-seat").disabled = ui.previewMode || !ui.app.state.you.recoveryKey;
      $("host-seat-links").classList.toggle("is-hidden", !host || ui.previewMode);
      const playerSelect = $("recovery-player"), previousPlayer = playerSelect.value;
      playerSelect.replaceChildren(...ui.app.state.players.filter((player) => player.id !== ui.app.state.you.id).map((player) => {
        const option = el("option", "", player.name); option.value = player.id; return option;
      }));
      if (ui.app.state.players.some((player) => player.id === previousPlayer)) playerSelect.value = previousPlayer;
      $("copy-player-seat").disabled = !host || !ui.app.connectionOpen || !playerSelect.children.length;
      const nodes = scenes.map((item) => {
        const node = el("article", "saved-scene"), load = button(item.name, "saved-scene-load", "stack");
        const isGame = item.scene.format === "parlor.game";
        load.append(el("small", "", `${isGame ? "完整对局" : "布置模板"} · ${new Date(item.updatedAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`));
        load.disabled = !host || !ui.app.connectionOpen || saving; load.title = isGame ? "恢复手牌、席位与牌堆顺序" : "恢复桌面布置并重新洗牌";
        load.addEventListener("click", () => guarded(async () => {
          if (saving || !window.confirm(isGame ? `恢复「${item.name}」的对局与席位？恢复前会自动保存当前对局作为备份。旧撤销记录会清空。` : `铺上「${item.name}」？手牌将收回并重新洗牌，房主可以撤销。`)) return;
          saving = true; ui.app.previewTransition = ui.previewMode; renderSaves();
          try {
            if (isGame) {
              const backup = await currentScene("game"); backup.name = `恢复前 · ${backup.name}`.slice(0, 20);
              await vault.saveScene(backup); await refreshVault();
            }
            const command = isGame ? { type: "restore-game", game: item.scene } : { type: "restore-scene", scene: item.scene };
            if (await ui.sendCommand(command)) { closePanel(); ui.clearSelection(); ui.fitAll(); ui.toast(`已恢复「${item.name}」`); }
          } finally { saving = false; ui.app.previewTransition = false; renderSaves(); }
        }));
        const remove = button("", "saved-scene-remove", "x"); remove.setAttribute("aria-label", `删除存档${item.name}`);
        remove.addEventListener("click", () => guarded(async () => { if (window.confirm(`删除本机存档「${item.name}」？当前桌面不会改变。`)) { await vault.deleteScene(item.id); await refreshVault(); } }));
        node.append(load, remove); return node;
      });
      if (!nodes.length) nodes.push(el("p", "saved-empty", "暂无存档"));
      $("saved-scenes").replaceChildren(...nodes);
      if (!host) $("save-status").textContent = "整个桌面由房主保存和恢复。";
      else if ($("save-status").textContent === "整个桌面由房主保存和恢复。") $("save-status").textContent = "";
    }

    function render() {
      const state = ui.app.state; if (!state) return;
      renderObjects(); renderLibrary(); renderLocations(); renderHand(); renderChat(); drawMap();
      $("chat-input").disabled = !ui.app.connectionOpen;
      $("nickname-save").disabled = !ui.app.connectionOpen;
      if (!initializedRoom) {
        initializedRoom = true;
        guarded(refreshVault);
      }
      if (openAux === "saves") renderSaves();
    }

    function renderWelcome() {
      const surface = $("welcome-resources");
      const faces = root.ParlorPacks[0].cards;
      for (const [index, face] of [faces[0], faces.find((card) => card.key === "spades-k"), faces.find((card) => card.key === "diamonds-q")].entries()) {
        const card = ui.makeCardNode({ id: "", face, canControl: false, zone: "public" }, { x: 70 + index * 96, y: 120 + index * 18, rotation: -16 + index * 14, z: index });
        card.removeAttribute("data-card-id"); surface.append(card);
      }
      const die = makeObjectNode({ ...catalog[0], x: 350, y: 280, value: 5, id: "welcome-die" }, { ghost: true });
      const note = makeObjectNode({ ...catalog.find((entry) => entry.kind === "note"), id: "welcome-note", x: 95, y: 350, rotation: -6, text: "" }, { ghost: true });
      surface.append(die, note);
    }

    $("library-search").addEventListener("input", () => { ui.app.selectionIntent++; renderLibrary(); });
    $("library-tabs").addEventListener("click", (event) => {
      const selected = event.target.closest("[data-category]"); if (!selected) return; category = selected.dataset.category;
      ui.app.selectionIntent++;
      for (const item of $("library-tabs").children) { item.classList.toggle("is-active", item === selected); item.setAttribute("aria-pressed", String(item === selected)); }
      renderLibrary();
    });
    ui.elements.packLibrary.addEventListener("click", (event) => {
      if (Date.now() - lastDragAt < 250) return;
      const remove = event.target.closest("[data-remove-template]");
      if (remove && !remove.disabled) { void ui.sendCommand({ type: "delete-template", templateId: remove.dataset.removeTemplate }); return; }
      const removePack = event.target.closest("[data-remove-pack]");
      if (removePack && !removePack.disabled) {
        const entry = entries().find((item) => item.localId === removePack.dataset.removePack);
        if (entry && window.confirm(`从本机资源库移除「${entry.label}」？桌上已取出的物件仍会保留。`)) guarded(async () => {
          removePack.disabled = true;
          try {
            await vault.deletePack(entry.localId);
            importedPacks = importedPacks.filter((item) => item.id !== entry.localId);
            renderLibrary(true); ui.toast(`已从本机资源库移除「${entry.label}」`);
          } finally { removePack.disabled = false; }
        });
        return;
      }
      const favorite = event.target.closest("[data-favorite]");
      if (favorite) { try { favorites = vault.toggleFavorite(favorite.dataset.favorite); renderLibrary(); } catch (error) { handleError(error); } return; }
      const add = event.target.closest("[data-add-asset]"); if (add && !add.disabled) guarded(() => addAsset(entries().find((entry) => entry.key === add.dataset.addAsset)));
    });
    function releaseLibraryDrag() {
      const drag = libraryDrag; if (!drag) return null;
      libraryDrag = null; drag.ghost?.remove();
      try { drag.source.releasePointerCapture(drag.pointerId); } catch { /* Already released. */ }
      return drag;
    }
    function cancelLibraryDrag() {
      if (!releaseLibraryDrag()) return false;
      lastDragAt = Date.now(); return true;
    }
    ui.elements.packLibrary.addEventListener("pointerdown", (event) => {
      const target = event.target.closest(".asset-preview");
      if (!target || target.disabled || event.button !== 0 || event.pointerType === "touch") return;
      cancelLibraryDrag();
      libraryDrag = { pointerId: event.pointerId, key: target.dataset.addAsset, startX: event.clientX, startY: event.clientY, active: false, source: target };
      target.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    window.addEventListener("pointermove", (event) => {
      if (!libraryDrag || event.pointerId !== libraryDrag.pointerId) return;
      if (!libraryDrag.active && Math.hypot(event.clientX - libraryDrag.startX, event.clientY - libraryDrag.startY) > 6) {
        const entry = entries().find((entry) => entry.key === libraryDrag.key);
        if (!entry) { cancelLibraryDrag(); return; }
        libraryDrag.active = true;
        libraryDrag.ghost = el("div", "library-drag-ghost"); libraryDrag.ghost.append(thumbnail(entry), el("strong", "", entry.label)); document.body.append(libraryDrag.ghost);
      }
      if (libraryDrag.ghost) { libraryDrag.ghost.style.left = `${event.clientX + 12}px`; libraryDrag.ghost.style.top = `${event.clientY + 12}px`; }
    });
    const endLibraryDrag = (event) => {
      if (!libraryDrag || event.pointerId !== libraryDrag.pointerId) return;
      const drag = releaseLibraryDrag();
      if (!drag.active) return;
      lastDragAt = Date.now();
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      if (hit?.closest(".topbar, .side-panel, .library-panel, .aux-panel, .history-panel, .selection-dock, .table-rail, .zoom-controls, .world-overview, .tools-backdrop, .aux-backdrop, .help-sheet, .hand-drawer, #open-hand, dialog")) return;
      const rect = ui.elements.viewport.getBoundingClientRect(), libraryRect = ui.elements.libraryPanel.getBoundingClientRect();
      const onLibrary = event.clientX >= libraryRect.left && event.clientX <= libraryRect.right && event.clientY >= libraryRect.top && event.clientY <= libraryRect.bottom;
      if (!onLibrary && event.clientX > rect.left && event.clientX < rect.right && event.clientY > rect.top && event.clientY < rect.bottom) guarded(() => addAsset(entries().find((entry) => entry.key === drag.key), ui.screenToWorld(event.clientX, event.clientY)));
    };
    window.addEventListener("pointerup", endLibraryDrag);
    for (const type of ["pointercancel", "lostpointercapture"]) window.addEventListener(type, (event) => { if (libraryDrag?.pointerId === event.pointerId) cancelLibraryDrag(); });
    window.addEventListener("blur", cancelLibraryDrag);
    for (const [name, panel] of Object.entries(panels)) {
      $(name === "saves" ? "open-saves" : `open-${name}`).addEventListener("click", () => showPanel(name));
      panel.querySelector("[data-close-aux]").addEventListener("click", closePanel);
    }
    auxBackdrop.addEventListener("click", closePanel);
    window.addEventListener("resize", () => {
      if (!openAux) return;
      auxBackdrop.classList.toggle("is-hidden", innerWidth >= 760);
      panels[openAux].setAttribute("aria-modal", String(innerWidth < 760));
    });
    $("add-playmat").addEventListener("click", () => guarded(async () => { const entry = entries().find((item) => item.id === "playmat"); closePanel(); await addAsset(entry); }));
    $("open-hand").addEventListener("click", toggleHand); $("close-hand").addEventListener("click", toggleHand);
    $("focus-private-zone").addEventListener("click", () => {
      const zone = ui.app.handLayouts.get(ui.app.state.you.id); if (!zone) return;
      if (!$("hand-drawer").classList.contains("is-hidden")) toggleHand();
      ui.focusWorldPoint({ x: zone.x + zone.width / 2, y: zone.y + zone.height / 2 }, { minimumScale: .85 });
    });
    $("arrange-private-cards").addEventListener("click", () => void ui.sendCommand({ type: "arrange-hand" }));
    $("toggle-minimap").addEventListener("click", toggleMinimap);
    $("go-home").addEventListener("click", () => { ui.fitCamera(); hideMinimap({ returnFocus: true }); });
    $("minimap").addEventListener("click", (event) => { const rect = event.currentTarget.getBoundingClientRect(); ui.focusWorldPoint({ x: mapBounds.x + (event.clientX - rect.left) / rect.width * mapBounds.width, y: mapBounds.y + (event.clientY - rect.top) / rect.height * mapBounds.height }); if (innerWidth < 760) hideMinimap({ returnFocus: true }); });
    $("minimap").addEventListener("keydown", (event) => {
      const offsets = { ArrowLeft: [180, 0], ArrowRight: [-180, 0], ArrowUp: [0, 180], ArrowDown: [0, -180] };
      if (offsets[event.key]) { event.preventDefault(); event.stopPropagation(); ui.app.camera.x += offsets[event.key][0]; ui.app.camera.y += offsets[event.key][1]; ui.applyCamera(); }
    });
    $("chat-form").addEventListener("submit", (event) => { event.preventDefault(); guarded(async () => { const text = $("chat-input").value.trim(); if (text && await ui.sendCommand({ type: "chat", text })) $("chat-input").value = ""; }); });
    $("resource-edit-form").addEventListener("submit", (event) => { event.preventDefault(); guarded(async () => { if (await ui.sendCommand({ type: "edit-resource", resourceType: "object", resourceId: editorId, label: $("resource-label").value, text: $("resource-text").value })) $("resource-editor").close(); }); });
    for (const node of document.querySelectorAll("[data-close-dialog]")) node.addEventListener("click", () => node.closest("dialog").close());
    $("welcome-host-help").addEventListener("click", () => $("host-guide").showModal());
    $("save-form").addEventListener("submit", (event) => { event.preventDefault(); guarded(async () => {
      if (saving || !ui.app.connectionOpen || ui.app.state.you.role !== "host") return;
      saving = true;
      $("save-scene").disabled = true; $("save-status").textContent = "正在保存…";
      try { const scene = await currentScene(); await vault.saveScene(scene); await refreshVault(); $("save-status").textContent = `「${scene.name}」已保存在这个浏览器。`; }
      catch (error) { $("save-status").textContent = error.message; throw error; }
      finally { saving = false; renderSaves(); }
    }); });
    $("export-scene").addEventListener("click", () => guarded(async () => download(await currentScene())));
    $("new-preview").addEventListener("click", () => guarded(async () => {
      if (!ui.previewMode || saving || ui.app.pendingCommands.size || ui.app.state.you.role !== "host"
        || !window.confirm("新开一张试玩桌面？当前完整对局会先保存为「新开前」备份。")) return;
      saving = true; ui.app.previewTransition = true; renderSaves();
      try {
        const backup = await currentScene("game"); backup.name = `新开前 · ${backup.name}`.slice(0, 20);
        await vault.saveScene(backup);
        await ui.restartPreview(); await refreshVault();
        ui.toast("已新开试玩，上一张桌面保存在「新开前」存档。");
      } finally { saving = false; ui.app.previewTransition = false; renderSaves(); }
    }));
    $("retry-preview-save").addEventListener("click", () => guarded(async () => {
      if (await ui.retryPreviewSave()) ui.toast("试玩已自动保存到本机。");
    }));
    $("save-kind").addEventListener("change", renderSaves);
    $("copy-my-seat").addEventListener("click", () => guarded(async () => {
      if (!await ui.copyText(ui.personalLink())) throw new Error("未能复制，请检查剪贴板权限。");
      ui.toast("个人续局链接已复制，请自己保管。");
    }));
    $("copy-player-seat").addEventListener("click", () => guarded(async () => {
      const seat = await ui.fetchSeat($("recovery-player").value);
      if (!await ui.copyText(seat.recoveryKey)) throw new Error("未能复制，请检查剪贴板权限。");
      ui.toast(`已复制 ${seat.name} 的续局口令，请只交给本人。`);
    }));
    $("import-scene").addEventListener("click", () => $("scene-file").click());
    $("import-pack").addEventListener("click", () => $("pack-file").click());
    $("scene-file").addEventListener("change", (event) => guarded(async () => {
      const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
      if (file.size > 12 * 1_048_576) throw new Error("存档不能超过 12 MB。");
      const scene = JSON.parse(await file.text());
      if (scene.format === "parlor.game") root.ParlorEngine.validateRoomGame(scene);
      else { if (file.size > 1_048_576) throw new Error("布置模板不能超过 1 MB。"); root.ParlorEngine.validateRoomScene(scene); }
      await vault.saveScene(scene); await refreshVault(); $("save-status").textContent = "存档已导入，点击它可以恢复桌面。";
    }));
    $("pack-file").addEventListener("change", (event) => guarded(async () => {
      const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
      if (file.size > 512_000) throw new Error("牌盒 JSON 不能超过 500 KB。");
      const pack = JSON.parse(await file.text()); root.ParlorEngine.validatePortablePack(pack); await vault.savePack(pack); await refreshVault();
      await addAsset({ type: "import", id: pack.id, label: pack.name, pack });
    }));

    function keydown(event) {
      if (document.querySelector("dialog[open]")) return false;
      if (event.key === "Escape") {
        if (hideMinimap({ returnFocus: true })) return true;
        if (openAux) { closePanel(); return true; }
        if (!$("hand-drawer").classList.contains("is-hidden")) { toggleHand(); return true; }
      }
      if (event.key === "Tab" && openAux && innerWidth < 760) {
        const focusable = [...panels[openAux].querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled)")].filter((node) => node.getClientRects().length);
        if (focusable.length && event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus(); return true; }
        if (focusable.length && !event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus(); return true; }
      }
      if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable) return false;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); showPanel("saves"); return true; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") { event.preventDefault(); const resource = ui.selectedResource(); if (resource) handleAction("resource-duplicate", resource); return true; }
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return false;
      if (event.key.toLowerCase() === "b") { ui.toggleLibrary(); return true; }
      if (event.key.toLowerCase() === "c") { showPanel("chat"); return true; }
      if (event.key.toLowerCase() === "i") { toggleHand(); return true; }
      if (event.key === " " && !event.target.closest("button, summary, a") && ui.selectedResource()?.type === "card") { event.preventDefault(); inspectCard(ui.selectedResource().value); return true; }
      return false;
    }
    renderWelcome();
    return { render, renderLibrary, renderObjects, renderSaveStatus, drawMap, makeObjectNode, extraActions, handleAction, editObject, keydown, closePanel, showPanel, hideMinimap, cancelLibraryDrag, kindNames };
  }
  root.ParlorWorkspace = Object.freeze({ create });
})(globalThis);
