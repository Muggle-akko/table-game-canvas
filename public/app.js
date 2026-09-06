const $ = (selector) => document.querySelector(selector);

const elements = {
  welcome: $("#welcome-screen"),
  startDemo: $("#start-demo"),
  demoPack: $("#demo-pack"),
  boot: $("#boot-screen"),
  offline: $("#offline-screen"),
  offlineMessage: $("#offline-message"),
  retryRoom: $("#retry-room"),
  join: $("#join-screen"),
  joinForm: $("#join-form"),
  joinRoomName: $("#join-room-name"),
  joinRoomMeta: $("#join-room-meta"),
  displayName: $("#display-name"),
  joinError: $("#join-error"),
  room: $("#room-screen"),
  roomTitle: $("#room-title"),
  connectionDot: $("#connection-dot"),
  identityChip: $("#identity-chip"),
  previewRole: $("#preview-role"),
  toggleFocus: $("#toggle-focus"),
  openHelp: $("#open-help"),
  openTools: $("#open-tools"),
  openLibrary: $("#open-library"),
  openHistory: $("#open-history"),
  quickUndo: $("#quick-undo"),
  copyLink: $("#copy-link"),
  copyLinkLabel: $("#copy-link-label"),
  playerCount: $("#player-count"),
  playerList: $("#player-list"),
  viewport: $("#viewport"),
  world: $("#world"),
  publicZone: $("#public-zone"),
  handZones: $("#hand-zones"),
  deckRoot: $("#deck-root"),
  tokenRoot: $("#token-root"),
  objectsRoot: $("#objects-root"),
  cardsRoot: $("#cards-root"),
  handCards: $("#hand-cards"),
  handDrawer: $("#hand-drawer"),
  openHand: $("#open-hand"),
  remoteDragRoot: $("#remote-drag-root"),
  cursorRoot: $("#cursor-root"),
  localCursorRoot: $("#local-cursor-root"),
  pingRoot: $("#ping-root"),
  dragRoot: $("#drag-root"),
  turnBanner: $("#turn-banner"),
  turnBannerName: $("#turn-banner-name"),
  mobilePlayerStrip: $("#mobile-player-strip"),
  pingLocation: $("#ping-location"),
  zoomOut: $("#zoom-out"),
  zoomIn: $("#zoom-in"),
  resetCamera: $("#reset-camera"),
  reconnectBanner: $("#reconnect-banner"),
  reconnectLabel: $("#reconnect-label"),
  selectionDock: $("#selection-dock"),
  selectionClose: $("#selection-close"),
  selectionMeta: $("#selection-meta"),
  selectionTitle: $("#selection-title"),
  selectionActions: $("#selection-actions"),
  selectionTransfer: $("#selection-transfer"),
  selectionPlayer: $("#selection-player"),
  selectionSend: $("#selection-send"),
  dieFace: $("#die-face"),
  dieLabel: $("#die-label"),
  rollDie: $("#roll-die"),
  counterLabel: $("#counter-label"),
  counterValue: $("#counter-value"),
  decrementCounter: $("#decrement-counter"),
  incrementCounter: $("#increment-counter"),
  turnAvatar: $("#turn-avatar"),
  turnPlayerName: $("#turn-player-name"),
  turnPlayerSelect: $("#turn-player-select"),
  randomTurn: $("#random-turn"),
  nextTurn: $("#next-turn"),
  undoTable: $("#undo-table"),
  drawCard: $("#draw-card"),
  dealCount: $("#deal-count"),
  dealCards: $("#deal-cards"),
  shuffleDeck: $("#shuffle-deck"),
  tidyPublic: $("#tidy-public"),
  collectPublic: $("#collect-public"),
  resetTable: $("#reset-table"),
  activityList: $("#activity-list"),
  offlineSeatCount: $("#offline-seat-count"),
  leaveSeat: $("#leave-seat"),
  cleanupOffline: $("#cleanup-offline"),
  openGuestTest: $("#open-guest-test"),
  toolsPanel: $("#tools-panel"),
  toolsBackdrop: $("#tools-backdrop"),
  closeTools: $("#close-tools"),
  libraryPanel: $("#library-panel"),
  closeLibrary: $("#close-library"),
  packLibrary: $("#pack-library"),
  historyPanel: $("#history-panel"),
  closeHistory: $("#close-history"),
  helpPanel: $("#help-panel"),
  helpBackdrop: $("#help-backdrop"),
  closeHelp: $("#close-help"),
  startPlaying: $("#start-playing"),
  toastRegion: $("#toast-region")
};

const query = new URLSearchParams(window.location.search);
const roomCode = String(query.get("room") || "").trim().toUpperCase();
const hostSecret = query.get("host") || "";
const previewMode = query.get("preview") === "1";
let freshSession = query.get("fresh") === "1";
let autoJoinName = Array.from(String(query.get("autojoin") || "")).slice(0, 20).join("");

let endpoint;
try {
  endpoint = new URL(query.get("endpoint") || (window.location.protocol === "file:" ? "http://preview.invalid" : window.location.origin));
  if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("unsupported protocol");
  endpoint.hash = "";
  endpoint.search = "";
} catch {
  endpoint = null;
}

const app = {
  summary: null,
  sessionToken: null,
  player: null,
  state: null,
  eventSource: null,
  connectionOpen: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
  closingStream: false,
  terminalOffline: false,
  cameraInitialized: false,
  cameraTouched: false,
  camera: { x: 0, y: 0, scale: 0.68 },
  pan: null,
  drag: null,
  tableTouches: new Map(),
  touchNavigation: null,
  handTouch: null,
  ignoreTableClickUntil: 0,
  handLayouts: new Map(),
  cardPositions: new Map(),
  cardFaceStates: new Map(),
  pendingFlips: new Set(),
  localCursor: null,
  lastTablePoint: null,
  remoteCursors: new Map(),
  remoteDrags: new Map(),
  lastCursorSentAt: Number.NEGATIVE_INFINITY,
  queuedCursorMessage: null,
  cursorSendTimer: null,
  cursorSendInFlight: false,
  cursorRequestController: null,
  lastPingSentAt: Number.NEGATIVE_INFINITY,
  lastDieRollId: 0,
  lastTurnPlayerId: null,
  turnInitialized: false,
  pendingCommands: new Set(),
  helpReturnFocus: null,
  focusMode: false,
  selection: null,
  selectionIntent: 0,
  selectionTransferOpen: false,
  previewModel: null
};

let workspace;
let stackState = null;
let stackIndex = new Map();

const CURSOR_SEND_INTERVAL = 80;
const CURSOR_REQUEST_TIMEOUT = 1800;

function phIcon(name, className = "") {
  if (!window.ParlorIcons) throw new Error("Phosphor Icons 没有加载成功。");
  return window.ParlorIcons.create(name, className);
}

function replaceButtonIcon(button, name) {
  const current = button.querySelector(".ph-icon");
  const icon = phIcon(name);
  if (current) current.replaceWith(icon);
  else button.prepend(icon);
}

function apiUrl(pathname) {
  return new URL(pathname, endpoint).toString();
}

function roomAssetUrl(kind, resourceId = "") {
  if (!endpoint || previewMode) return "";
  const url = new URL("/api/asset", endpoint);
  url.searchParams.set("room", roomCode);
  url.searchParams.set("kind", kind);
  if (resourceId) url.searchParams.set("id", resourceId);
  if (kind === "back") {
    const deck = app.state?.decks?.find((item) => item.id === (resourceId || "main"));
    if (deck) url.searchParams.set("pack", deck.packId);
  }
  if (kind === "card") {
    if (!app.sessionToken) return "";
    url.searchParams.set("session", app.sessionToken);
  }
  return url.toString();
}

function storageKey() {
  return `parlor-session:${endpoint?.origin || "invalid"}:${roomCode}`;
}

function readStoredSession() {
  try {
    return window.sessionStorage.getItem(storageKey());
  } catch {
    return null;
  }
}

function storeSession(token) {
  try {
    window.sessionStorage.setItem(storageKey(), token);
  } catch {
    // Private browsing implementations may deny storage; this session still works until refresh.
  }
}

function clearStoredSession() {
  try {
    window.sessionStorage.removeItem(storageKey());
  } catch {
    // Nothing else to clear.
  }
}

function showHelp() {
  app.selectionIntent++;
  const activeElement = document.activeElement;
  let returnTarget = activeElement;
  if (activeElement instanceof HTMLElement && elements.toolsPanel.contains(activeElement)) returnTarget = elements.openTools;
  if (activeElement instanceof HTMLElement && elements.libraryPanel.contains(activeElement)) returnTarget = elements.openLibrary;
  if (activeElement instanceof HTMLElement && elements.historyPanel.contains(activeElement)) returnTarget = elements.openHistory;
  if (activeElement instanceof HTMLElement && activeElement.closest(".aux-panel")) returnTarget = document.querySelector(`[aria-controls="${activeElement.closest(".aux-panel").id}"]`) || elements.openHelp;
  hideSidePanels({ returnFocus: false });
  app.helpReturnFocus = returnTarget instanceof HTMLElement && returnTarget !== document.body
    ? returnTarget
    : null;
  elements.helpPanel.classList.remove("is-hidden");
  elements.openHelp.setAttribute("aria-expanded", "true");
  document.body.classList.add("has-help-open");
  window.setTimeout(() => elements.closeHelp.focus(), 40);
}

function hideHelp({ returnFocus = true } = {}) {
  const wasOpen = !elements.helpPanel.classList.contains("is-hidden");
  elements.helpPanel.classList.add("is-hidden");
  elements.openHelp.setAttribute("aria-expanded", "false");
  document.body.classList.remove("has-help-open");
  if (returnFocus && wasOpen && app.helpReturnFocus?.isConnected) app.helpReturnFocus.focus();
  app.helpReturnFocus = null;
}

function showTools() {
  app.selectionIntent++;
  workspace?.closePanel({ returnFocus: false });
  hideLibrary({ returnFocus: false });
  hideHistory({ returnFocus: false });
  elements.toolsPanel.classList.add("is-open");
  elements.toolsPanel.setAttribute("aria-hidden", "false");
  elements.toolsPanel.setAttribute("role", "dialog");
  elements.toolsPanel.setAttribute("aria-modal", "true");
  elements.toolsBackdrop.classList.remove("is-hidden");
  elements.openTools.setAttribute("aria-expanded", "true");
  window.setTimeout(() => elements.closeTools.focus(), 40);
}

function hideTools({ returnFocus = true } = {}) {
  const wasOpen = elements.toolsPanel.classList.contains("is-open");
  elements.toolsPanel.classList.remove("is-open");
  if (!elements.libraryPanel.classList.contains("is-open")) elements.toolsBackdrop.classList.add("is-hidden");
  elements.openTools.setAttribute("aria-expanded", "false");
  elements.toolsPanel.setAttribute("aria-hidden", "true");
  if (returnFocus && wasOpen) elements.openTools.focus();
}

function showLibrary() {
  app.selectionIntent++;
  workspace?.closePanel({ returnFocus: false });
  hideTools({ returnFocus: false });
  hideHistory({ returnFocus: false });
  renderPackLibrary();
  elements.libraryPanel.classList.add("is-open");
  elements.libraryPanel.setAttribute("aria-hidden", "false");
  elements.libraryPanel.setAttribute("role", "dialog");
  elements.libraryPanel.setAttribute("aria-modal", String(window.innerWidth < 760));
  elements.toolsBackdrop.classList.toggle("is-hidden", window.innerWidth >= 760);
  elements.room.classList.add("has-library");
  elements.openLibrary.setAttribute("aria-expanded", "true");
  window.setTimeout(() => elements.closeLibrary.focus(), 40);
}

function hideLibrary({ returnFocus = true } = {}) {
  workspace?.cancelLibraryDrag();
  const wasOpen = elements.libraryPanel.classList.contains("is-open");
  elements.libraryPanel.classList.remove("is-open");
  elements.room.classList.remove("has-library");
  if (!elements.toolsPanel.classList.contains("is-open")) elements.toolsBackdrop.classList.add("is-hidden");
  elements.libraryPanel.setAttribute("aria-hidden", "true");
  elements.openLibrary.setAttribute("aria-expanded", "false");
  if (returnFocus && wasOpen) elements.openLibrary.focus();
}

function showHistory() {
  app.selectionIntent++;
  workspace?.closePanel({ returnFocus: false });
  hideTools({ returnFocus: false });
  hideLibrary({ returnFocus: false });
  elements.historyPanel.classList.add("is-open");
  elements.historyPanel.setAttribute("aria-hidden", "false");
  elements.openHistory.setAttribute("aria-expanded", "true");
  window.setTimeout(() => elements.closeHistory.focus(), 40);
}

function hideHistory({ returnFocus = true } = {}) {
  const wasOpen = elements.historyPanel.classList.contains("is-open");
  elements.historyPanel.classList.remove("is-open");
  elements.historyPanel.setAttribute("aria-hidden", "true");
  elements.openHistory.setAttribute("aria-expanded", "false");
  if (returnFocus && wasOpen) elements.openTools.focus();
}

function hideSidePanels({ returnFocus = false } = {}) {
  hideTools({ returnFocus });
  hideLibrary({ returnFocus });
  hideHistory({ returnFocus });
  workspace?.closePanel({ returnFocus });
}

function toggleLibrary() {
  if (elements.libraryPanel.classList.contains("is-open")) hideLibrary();
  else showLibrary();
}

function syncToolDrawer() {
  hideSidePanels({ returnFocus: false });
}

function setFocusMode(enabled, { announce = true } = {}) {
  app.focusMode = Boolean(enabled);
  elements.room.classList.toggle("is-focus-mode", app.focusMode);
  elements.toggleFocus.setAttribute("aria-pressed", String(app.focusMode));
  elements.toggleFocus.classList.toggle("is-active", app.focusMode);
  elements.toggleFocus.querySelector("b").textContent = app.focusMode ? "退出沉浸" : "沉浸";
  replaceButtonIcon(elements.toggleFocus, app.focusMode ? "corners-in" : "corners-out");
  syncToolDrawer();
  window.requestAnimationFrame(applyCamera);
  if (announce) toast(app.focusMode ? "已进入沉浸桌面，按 H 可退出。" : "已退出沉浸桌面。");
}

function showOnly(screen) {
  for (const candidate of [elements.welcome, elements.boot, elements.offline, elements.join, elements.room]) {
    candidate.classList.toggle("is-hidden", candidate !== screen);
  }
}

function showWelcome() {
  app.terminalOffline = false;
  showOnly(elements.welcome);
  window.setTimeout(() => elements.startDemo.focus(), 80);
}

function showOffline(message) {
  app.terminalOffline = true;
  clearTimeout(app.reconnectTimer);
  clearCursorQueue();
  hideSidePanels({ returnFocus: false });
  hideHelp({ returnFocus: false });
  elements.offlineMessage.textContent = message || "没能联系到房主。请确认开房命令仍在运行，或向房主索取新链接。";
  showOnly(elements.offline);
}

function showJoin() {
  app.terminalOffline = false;
  elements.joinError.textContent = "";
  showOnly(elements.join);
  window.setTimeout(() => elements.displayName.focus(), 80);
}

function showRoom() {
  app.terminalOffline = false;
  showOnly(elements.room);
}

function createPreviewModel() {
  const previewUrl = new URL(window.location.href);
  previewUrl.searchParams.set("preview", "1");
  previewUrl.searchParams.delete("as");
  if (!window.ParlorPreview) throw new Error("离线试玩核心没有加载成功，请刷新页面。");
  const model = window.ParlorPreview.createModel({
    shareUrl: previewUrl.toString(),
    packId: query.get("pack") || "standard-54"
  });
  for (const [resourceId, x, y] of [["die-d6", 1080, 590], ["note", 1170, 360]]) {
    window.ParlorPreview.applyCommand(model, "player_a", { type: "spawn-resource", resourceId, x, y });
  }
  const note = [...model.engineRoom.objects.values()].find((item) => item.kind === "note");
  note.label = "便签";
  note.text = "";
  model.engineRoom.undoStack = []; model.engineRoom.history = [];
  return model;
}

function projectPreviewModel(viewerId) {
  return window.ParlorPreview.project(app.previewModel, viewerId);
}

function seedPreviewCursor() {
  app.remoteCursors.clear();
  const other = app.state.players.find((player) => player.id !== app.state.you.id);
  if (!other) return;
  app.remoteCursors.set(other.id, {
    playerId: other.id,
    name: other.name,
    color: other.color,
    x: other.role === "host" ? 720 : 1130,
    y: other.role === "host" ? 440 : 470,
    seenAt: Date.now()
  });
}

function updatePreviewRoleControl() {
  if (!previewMode) return;
  const nextIsGuest = app.state.you.role === "host";
  elements.previewRole.classList.remove("is-hidden");
  elements.previewRole.querySelector("b").textContent = nextIsGuest ? "切到客人视角" : "切到房主视角";
  elements.previewRole.setAttribute("aria-label", nextIsGuest ? "切换到客人B视角" : "切换到房主A视角");
}

function syncPreviewState(viewerId = app.state?.you?.id || "player_a") {
  app.state = projectPreviewModel(viewerId);
  app.player = app.state.you;
  updatePreviewRoleControl();
  renderRoom();
}

function switchPreviewRole() {
  if (!previewMode || !app.state) return;
  const nextViewerId = app.state.you.id === "player_a" ? "player_b" : "player_a";
  app.selection = null;
  app.selectionTransferOpen = false;
  app.turnInitialized = false;
  syncPreviewState(nextViewerId);
  seedPreviewCursor();
  renderCursors();
  toast(`已切换到 ${app.state.you.name} 视角；私有牌面已重新过滤。`);
}

function startPreview() {
  app.previewModel = createPreviewModel();
  const viewerId = query.get("as") === "guest" ? "player_b" : "player_a";
  app.state = projectPreviewModel(viewerId);
  app.player = app.state.you;
  app.sessionToken = "preview-session";
  app.connectionOpen = true;
  app.summary = {
    roomAvailable: true,
    roomCode: app.state.room.code,
    shareUrl: app.state.room.shareUrl
  };
  const localFilePreview = window.location.protocol === "file:";
  elements.copyLink.disabled = localFilePreview;
  elements.copyLinkLabel.textContent = localFilePreview ? "离线试玩" : "复制试玩链接";
  elements.copyLink.title = localFilePreview
    ? "本机离线试玩不能分享；真实开房后会生成 HTTPS 邀请链接。"
    : "复制当前离线试玩页面";
  showRoom();
  setConnectionState("demo");
  updatePreviewRoleControl();
  renderRoom();
  seedPreviewCursor();
  renderCursors();
  toast("桌面准备好了。打开资源库，拿点东西上桌吧。");
}

function toast(message, type = "info") {
  const node = document.createElement("div");
  node.className = `toast${type === "error" ? " is-error" : type === "turn" ? " is-turn" : ""}`;
  node.textContent = message;
  elements.toastRegion.append(node);
  window.setTimeout(() => node.classList.add("is-leaving"), 2600);
  window.setTimeout(() => node.remove(), 2900);
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    try {
      input.select();
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      input.remove();
    }
  }
}

async function fetchJson(url, options = {}, timeout = 6500) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, mode: "cors" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || `请求失败（${response.status}）`);
      error.code = payload.code;
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    window.clearTimeout(timer);
  }
}

async function probeRoom() {
  if (!endpoint || !/^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(roomCode)) {
    throw new Error("邀请链接缺少有效的房间码。请让房主重新复制链接。 ");
  }
  app.summary = await fetchJson(`${apiUrl("/api/room")}?room=${encodeURIComponent(roomCode)}`);
  elements.joinRoomName.textContent = `加入${app.summary.roomTitle || "朋友牌室"}`;
  elements.joinRoomMeta.textContent = `${app.summary.packName || "自定义游戏包"} · ${app.summary.playerCount}/${app.summary.maxPlayers} 人已在桌边`;
  elements.displayName.placeholder = `不填则使用「${app.summary.defaultGuestName || "玩家"}」`;
  return app.summary;
}

async function joinRoom({ displayName = "", resumeToken = "", secret = "" } = {}) {
  const payload = await fetchJson(apiUrl("/api/join"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      roomCode,
      displayName,
      resumeToken,
      hostSecret: secret
    })
  });

  app.sessionToken = payload.sessionToken;
  app.player = payload.player;
  storeSession(payload.sessionToken);

  if (secret || freshSession || autoJoinName) {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("host");
    cleanUrl.searchParams.delete("fresh");
    cleanUrl.searchParams.delete("autojoin");
    window.history.replaceState({}, "", cleanUrl);
    freshSession = false;
    autoJoinName = "";
  }

  showRoom();
  updateIdentity(payload.player);
  connectEvents();
}

async function initialize() {
  app.terminalOffline = false;
  showOnly(elements.boot);
  if (previewMode) {
    startPreview();
    return;
  }
  if (!roomCode) {
    showWelcome();
    return;
  }
  try {
    await probeRoom();

    if (hostSecret) {
      await joinRoom({ secret: hostSecret });
      return;
    }

    if (freshSession) clearStoredSession();
    if (autoJoinName) {
      try {
        await joinRoom({ displayName: autoJoinName });
      } catch (error) {
        showJoin();
        elements.displayName.value = autoJoinName;
        elements.joinError.textContent = error.message;
      }
      return;
    }

    const stored = readStoredSession();
    if (stored) {
      try {
        await joinRoom({ resumeToken: stored });
        return;
      } catch (error) {
        if ([401, 403, 404].includes(error.status)) clearStoredSession();
        else throw error;
      }
    }

    showJoin();
  } catch (error) {
    showOffline(error.name === "AbortError"
      ? "联系房主超时。请确认房主的 Node 和公网隧道仍在运行。"
      : error.message);
  }
}

function eventUrl() {
  const url = new URL("/api/events", endpoint);
  url.searchParams.set("room", roomCode);
  url.searchParams.set("session", app.sessionToken);
  return url.toString();
}

function setConnectionState(status) {
  elements.connectionDot.classList.remove("is-online", "is-reconnecting", "is-offline");
  elements.reconnectBanner.classList.remove("is-offline");
  let label = "正在连接";
  if (status === "online" || status === "demo") {
    elements.connectionDot.classList.add("is-online");
    label = status === "demo" ? "离线试玩" : "房主在线";
    elements.reconnectBanner.classList.add("is-hidden");
  } else if (status === "reconnecting") {
    elements.connectionDot.classList.add("is-reconnecting");
    label = "网络有波动，正在恢复同步";
    elements.reconnectLabel.textContent = "网络有波动，正在恢复同步…";
    elements.reconnectBanner.classList.remove("is-hidden");
  } else if (status === "offline") {
    elements.connectionDot.classList.add("is-offline");
    elements.reconnectBanner.classList.add("is-offline");
    elements.reconnectLabel.textContent = "暂时没有连上房间，仍在尝试恢复…";
    label = "暂时没有连上房间";
    elements.reconnectBanner.classList.remove("is-hidden");
  }
  elements.connectionDot.setAttribute("aria-label", label);
  elements.connectionDot.title = label;
}

function connectEvents() {
  clearTimeout(app.reconnectTimer);
  app.closingStream = false;
  app.eventSource?.close();
  setConnectionState("connecting");

  const source = new EventSource(eventUrl());
  app.eventSource = source;

  source.addEventListener("open", () => {
    if (app.eventSource !== source) return;
    app.connectionOpen = true;
    app.reconnectAttempts = 0;
    setConnectionState("online");
    renderTools();
  });

  source.addEventListener("message", (event) => {
    if (app.eventSource !== source) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === "room-state") {
      if (!app.state || message.revision > app.state.revision) {
        app.state = message;
        app.player = message.you;
        showRoom();
        renderRoom();
      }
      return;
    }

    if (message.type === "cursor") {
      app.remoteCursors.set(message.playerId, { ...message, seenAt: Date.now() });
      if (message.drag) {
        app.remoteDrags.set(message.playerId, {
          ...message.drag,
          playerId: message.playerId,
          name: message.name,
          color: message.color,
          seenAt: Date.now()
        });
      } else {
        app.remoteDrags.delete(message.playerId);
      }
      renderCursors();
      renderRemoteDrags();
      return;
    }

    if (message.type === "cursor-leave") {
      app.remoteCursors.delete(message.playerId);
      app.remoteDrags.delete(message.playerId);
      renderCursors();
      renderRemoteDrags();
      return;
    }

    if (message.type === "drag-end") {
      app.remoteDrags.delete(message.playerId);
      renderRemoteDrags();
      return;
    }

    if (message.type === "ping") {
      showPing(message);
      return;
    }

    if (message.type === "command-error") toast(message.message || "操作没有成功。", "error");
  });

  source.addEventListener("error", () => {
    if (app.eventSource !== source || app.closingStream) return;
    // Quick Tunnel and EventSource may briefly reconnect while the room API remains healthy.
    // Keep table actions available until repeated health checks prove the room is gone.
    if (!app.state) app.connectionOpen = false;
    setConnectionState(app.state ? "reconnecting" : "connecting");
    renderTools();
    scheduleReconnect(source);
  });
}

function scheduleReconnect(source) {
  if (app.terminalOffline || !app.sessionToken) return;
  app.reconnectAttempts += 1;
  const delay = Math.min(4200, 500 * 2 ** Math.min(app.reconnectAttempts, 3));
  clearTimeout(app.reconnectTimer);
  app.reconnectTimer = window.setTimeout(async () => {
    try {
      await probeRoom();
      if (app.eventSource !== source) return;
      if (source.readyState === EventSource.OPEN) {
        app.connectionOpen = true;
        app.reconnectAttempts = 0;
        setConnectionState("online");
        renderTools();
      } else if (app.reconnectAttempts >= 2) {
        source.close();
        connectEvents();
      } else {
        scheduleReconnect(source);
      }
    } catch {
      if (app.reconnectAttempts >= 4) {
        source.close();
        app.connectionOpen = false;
        setConnectionState("offline");
        showOffline("暂时没有连上房间。可能是网络或公网隧道波动；请先重试，若持续失败再确认房主终端仍在运行。");
      } else {
        scheduleReconnect(source);
      }
    }
  }, delay);
}

function updateIdentity(player) {
  if (!player) return;
  const dot = elements.identityChip.querySelector("i");
  const label = elements.identityChip.querySelector("span");
  dot.style.background = player.color;
  label.textContent = `${player.name}${player.role === "host" ? " · 房主" : ""}`;
}

function calculateHandLayouts(players) {
  const sorted = [...players].sort((left, right) => left.seatIndex - right.seatIndex);
  const layouts = new Map();
  const startX = 205;
  const totalWidth = 1390;
  const gap = 18;

  const placeRow = (rowPlayers, y, height) => {
    if (rowPlayers.length === 0) return;
    const width = (totalWidth - gap * (rowPlayers.length - 1)) / rowPlayers.length;
    rowPlayers.forEach((player, index) => {
      layouts.set(player.id, {
        x: startX + index * (width + gap),
        y,
        width,
        height
      });
    });
  };

  if (sorted.length <= 4) {
    placeRow(sorted, 825, 225);
  } else {
    placeRow(sorted.slice(0, 4), 825, 225);
    placeRow(sorted.slice(4), 25, 155);
  }
  return layouts;
}

function makePlayerRow(player, you) {
  const isActive = app.state.turn?.activePlayerId === player.id;
  const row = document.createElement("button");
  row.type = "button";
  row.className = `player-row${player.id === you.id ? " is-you" : ""}${isActive ? " is-turn" : ""}`;
  row.dataset.playerId = player.id;
  row.style.setProperty("--player-color", player.color);
  row.setAttribute("aria-label", `定位到${player.name}的桌面区域${isActive ? "，当前行动玩家" : ""}`);

  const avatar = document.createElement("span");
  avatar.className = "player-avatar";
  avatar.style.background = player.color;
  avatar.textContent = Array.from(player.name)[0] || "玩";

  const meta = document.createElement("span");
  meta.className = "player-meta";
  const name = document.createElement("strong");
  name.textContent = player.id === you.id ? `${player.name}（你）` : player.name;
  const role = document.createElement("small");
  role.textContent = `${player.role === "host" ? "房主 · " : ""}${player.status || "在桌边"}`;
  meta.append(name, role);

  const status = document.createElement("span");
  status.className = "player-row__status";
  const online = document.createElement("i");
  online.className = `online-state${player.online ? " is-online" : ""}`;
  online.title = player.online ? "在线" : "暂时离线";
  const locate = document.createElement("small");
  locate.textContent = isActive ? "行动中" : "定位";
  status.append(online, locate);

  row.append(avatar, meta, status);
  return row;
}

function renderPlayers() {
  const { players, you, room } = app.state;
  elements.playerCount.textContent = `${players.length}/${room.maxPlayers}`;
  elements.playerList.replaceChildren(...players.map((player) => makePlayerRow(player, you)));
}

function renderMobilePlayers() {
  const label = document.createElement("span");
  label.className = "mobile-player-strip__label";
  label.textContent = `${app.state.players.length} 人`;
  const players = app.state.players.map((player) => {
    const isYou = player.id === app.state.you.id;
    const isActive = player.id === app.state.turn?.activePlayerId;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mobile-player${isYou ? " is-you" : ""}${isActive ? " is-turn" : ""}`;
    button.dataset.playerId = player.id;
    button.style.setProperty("--player-color", player.color);
    button.textContent = Array.from(player.name)[0] || "玩";
    button.title = `${player.name}${isYou ? "（你）" : ""}${isActive ? " · 当前行动" : ""}`;
    button.setAttribute("aria-label", `定位到${player.name}${isActive ? "，当前行动玩家" : ""}`);
    const online = document.createElement("i");
    online.className = player.online ? "is-online" : "";
    button.append(online);
    return button;
  });
  elements.mobilePlayerStrip.replaceChildren(label, ...players);
}

function visibleStackForCard(cardId) {
  if (!app.state) return [];
  if (stackState !== app.state) {
    stackState = app.state;
    stackIndex = new Map();
    const cards = app.state.cards.filter((card) => card.zone === "public");
    const { cardWidth, cardHeight } = app.state.room.geometry;
    const stepX = cardWidth / 2, stepY = cardHeight / 2;
    const parent = cards.map((_, index) => index), buckets = new Map();
    const find = (index) => {
      while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
      return index;
    };
    cards.forEach((card, index) => {
      const bx = Math.floor(card.x / stepX), by = Math.floor(card.y / stepY);
      for (let x = bx - 1; x <= bx + 1; x++) for (let y = by - 1; y <= by + 1; y++) {
        for (const neighbor of buckets.get(`${x}:${y}`) || []) {
          if (Math.abs(cards[neighbor].x - card.x) <= stepX && Math.abs(cards[neighbor].y - card.y) <= stepY) parent[find(index)] = find(neighbor);
        }
      }
      const key = `${bx}:${by}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(index);
    });
    const groups = new Map();
    cards.forEach((card, index) => {
      const group = find(index);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(card);
    });
    for (const group of groups.values()) {
      group.sort((left, right) => left.z - right.z);
      for (const card of group) stackIndex.set(card.id, group);
    }
  }
  return stackIndex.get(cardId) || [];
}

function activeDeck() {
  const selectedId = app.selection?.type === "deck" ? app.selection.id : null;
  return app.state?.decks?.find((deck) => deck.id === selectedId)
    || app.state?.decks?.find((deck) => deck.id === "main") || app.state?.deck;
}

function selectedResource() {
  if (!app.selection || !app.state) return null;
  if (app.selection.type === "deck") {
    const value = app.state.decks?.find((deck) => deck.id === (app.selection.id || "main"));
    return value ? { type: "deck", value } : null;
  }
  if (app.selection.type === "card") {
    const value = app.state.cards.find((card) => card.id === app.selection.id);
    return value ? { type: "card", value } : null;
  }
  if (app.selection.type === "token") {
    const value = (app.state.tokens || []).find((token) => token.id === app.selection.id);
    return value ? { type: "token", value } : null;
  }
  if (app.selection.type === "object") {
    const value = (app.state.objects || []).find((object) => object.id === app.selection.id);
    return value ? { type: "object", value } : null;
  }
  return null;
}

function syncSelectionClasses() {
  for (const root of [elements.cardsRoot, elements.handCards, elements.tokenRoot, elements.deckRoot, elements.objectsRoot]) {
    root.querySelectorAll(".is-selected").forEach((node) => node.classList.remove("is-selected"));
  }
  if (!app.selection) return;
  const attribute = `${app.selection.type}Id`;
  for (const root of [elements.cardsRoot, elements.handCards, elements.tokenRoot, elements.deckRoot, elements.objectsRoot]) {
    for (const node of root.children) if (node.dataset[attribute] === app.selection.id) node.classList.add("is-selected");
  }
}

function clearSelection({ preserveIntent = false } = {}) {
  if (!preserveIntent) app.selectionIntent++;
  app.selection = null;
  app.selectionTransferOpen = false;
  delete elements.selectionDock.dataset.resourceKey;
  elements.selectionActions.querySelector(".selection-more")?.removeAttribute("open");
  elements.selectionDock.classList.add("is-hidden");
  elements.selectionTransfer.classList.add("is-hidden");
  syncSelectionClasses();
  if (app.state) { renderDealOptions(); renderTools(); }
}

function selectResource(type, id = "", { preserveIntent = false } = {}) {
  if (!preserveIntent) app.selectionIntent++;
  workspace?.hideMinimap();
  app.selection = { type, id: type === "deck" ? id || "main" : id };
  app.selectionTransferOpen = false;
  if (app.state) { renderDealOptions(); renderTools(); }
  syncSelectionClasses();
}

function makeSelectionAction(action, iconName, label, { accent = false, disabled = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.selectionAction = action;
  button.className = accent ? "is-accent" : "";
  button.disabled = disabled;
  button.title = label;
  const icon = phIcon(iconName);
  const text = document.createElement("b");
  text.textContent = label;
  button.append(icon, text);
  return button;
}

function nextOpenPublicCardPoint() {
  const geometry = app.state.room.geometry;
  const zone = geometry.publicZone;
  const { cardWidth, cardHeight } = geometry;
  const rect = elements.viewport.getBoundingClientRect();
  const selectedDeck = app.selection?.type === "deck" ? activeDeck() : null;
  const center = selectedDeck ? { x: selectedDeck.x + cardWidth + 40, y: selectedDeck.y }
    : screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  const occupied = app.state.cards.filter((card) => card.zone === "public");
  const clampPoint = (point) => ({
    x: Math.max(zone.x, Math.min(zone.x + zone.width - cardWidth, point.x)),
    y: Math.max(zone.y, Math.min(zone.y + zone.height - cardHeight, point.y))
  });
  for (let radius = 0; radius < 6; radius++) {
    for (let index = 0; index < Math.max(1, radius * 8); index++) {
      const angle = index / Math.max(1, radius * 8) * Math.PI * 2;
      const point = clampPoint({ x: center.x + Math.cos(angle) * radius * (cardWidth + 24), y: center.y + Math.sin(angle) * radius * (cardHeight + 24) });
      if ([...app.handLayouts.values()].some((layout) => pointInside(point, layout))) continue;
      if ([...occupied, ...(app.state.decks || [])].every((card) => Math.abs(card.x - point.x) > cardWidth || Math.abs(card.y - point.y) > cardHeight)) return point;
    }
  }
  return clampPoint(center);
}

function canSendSelectedCard(card) {
  return card.canControl && (
    app.state.you.role === "host"
    || card.zone === "public"
    || !card.ownerId
    || card.ownerId === app.state.you.id
  );
}

function renderSelectionTransfer(resource, preserveRecipient = false) {
  const recipient = preserveRecipient ? elements.selectionPlayer.value : "";
  const currentOwnerId = resource.type === "card" ? resource.value.ownerId : null;
  const players = app.state.players.filter((player) => resource.type === "deck" || player.id !== currentOwnerId);
  const options = players.map((player) => {
    const option = document.createElement("option");
    option.value = player.id;
    option.textContent = player.id === app.state.you.id ? `${player.name}（我）` : player.name;
    return option;
  });
  elements.selectionPlayer.replaceChildren(...options);
  elements.selectionPlayer.value = options.find((option) => option.value === recipient)?.value || options[0]?.value || "";
  elements.selectionTransfer.classList.toggle("is-hidden", !app.selectionTransferOpen || options.length === 0);
  elements.selectionSend.disabled = !app.connectionOpen || options.length === 0;
}

function renderSelectionDock() {
  if (!app.state || !app.selection) {
    elements.selectionDock.classList.add("is-hidden");
    return;
  }
  const resource = selectedResource();
  if (!resource) {
    clearSelection({ preserveIntent: true });
    return;
  }

  const resourceKey = `${resource.type}:${resource.value.id}`;
  const sameSelection = elements.selectionDock.dataset.resourceKey === resourceKey;
  const wasOpen = sameSelection && elements.selectionActions.querySelector(".selection-more")?.hasAttribute("open");
  const focused = sameSelection && elements.selectionActions.contains(document.activeElement) ? document.activeElement : null;
  const focusedAction = focused?.dataset.selectionAction;
  const connected = app.connectionOpen;
  const actions = [], secondaryActions = [];
  let allowTransfer = false;
  elements.selectionDock.classList.remove("is-hidden");

  if (resource.type === "deck") {
    elements.selectionMeta.textContent = `${resource.value.count} 张`;
    elements.selectionTitle.textContent = resource.value.label;
    actions.push(makeSelectionAction("draw", "cards-three", "抽一张", { accent: true, disabled: !connected || !resource.value.canDraw }));
    actions.push(makeSelectionAction("draw-public", "arrow-line-down", "盖放", { disabled: !connected || !resource.value.canDraw }));
    actions.push(makeSelectionAction("shuffle-deck", "shuffle", "洗牌", { disabled: !connected || resource.value.count < 2 }));
    secondaryActions.push(makeSelectionAction("collect-deck", "stack", "收回散牌", { disabled: !connected || !resource.value.publicCount }));
    allowTransfer = app.state.players.length > 1 && resource.value.canDraw;
  } else if (resource.type === "token") {
    elements.selectionMeta.textContent = resource.value.locked ? "已锁定" : "";
    elements.selectionTitle.textContent = resource.value.label;
    actions.push(makeSelectionAction("resource-duplicate", "plus", "再拿一个", { accent: true, disabled: !connected || resource.value.locked }));
    secondaryActions.push(makeSelectionAction("token-front", "arrow-up", "提到上层", { disabled: !connected || resource.value.locked }));
  } else if (resource.type === "object") {
    const object = resource.value;
    elements.selectionMeta.textContent = object.locked ? "已锁定" : object.kind === "bag" ? `${object.count} 件` : "";
    elements.selectionTitle.textContent = object.label;
    if (object.kind === "die") actions.push(makeSelectionAction("roll-object", "dice-six", "掷一次", { accent: true, disabled: !connected }));
    if (object.kind === "counter") {
      actions.push(makeSelectionAction("counter-minus", "minus", "减一", { disabled: !connected }));
      actions.push(makeSelectionAction("counter-plus", "plus", "加一", { accent: true, disabled: !connected }));
    }
    if (object.kind === "bag") actions.push(makeSelectionAction("bag-draw", "hand-grabbing", "摸一个", { accent: true, disabled: !connected || !object.count }));
    if (["note", "counter", "bag", "mat"].includes(object.kind)) actions.push(makeSelectionAction("edit-object", "sliders-horizontal", "编辑", { disabled: !connected }));
  } else {
    const card = resource.value;
    const canEdit = connected && card.canControl && !card.locked;
    const stack = card.zone === "public" ? visibleStackForCard(card.id) : [];
    const stackLocked = stack.some((item) => item.locked);
    if (stack.length >= 2) {
      elements.selectionMeta.textContent = `${stack.length} 张`;
      elements.selectionTitle.textContent = card.face?.label || "背面牌堆";
      actions.push(makeSelectionAction("draw-stack", "cards-three", "抽一张", { accent: true, disabled: !canEdit || stackLocked }));
      actions.push(makeSelectionAction("shuffle-stack", "shuffle", "洗牌", { disabled: !canEdit || stackLocked }));
      actions.push(makeSelectionAction("spread-stack", "arrows-out-line-horizontal", "展开", { disabled: !canEdit || stackLocked }));
    } else if (card.zone === "hand") {
      elements.selectionMeta.textContent = card.ownerId === app.state.you.id ? "手牌" : "私有";
      elements.selectionTitle.textContent = card.face?.label || "背面朝上的牌";
      actions.push(makeSelectionAction("reveal-card", "eye", "正面公开", { accent: true, disabled: !canEdit }));
      actions.push(makeSelectionAction("cover-card", "eye-slash", "背面盖放", { disabled: !canEdit }));
      allowTransfer = canEdit && canSendSelectedCard(card) && app.state.players.length > 1;
    } else {
      elements.selectionMeta.textContent = card.locked ? "已锁定" : card.faceUp === false ? "背面" : "";
      elements.selectionTitle.textContent = card.face?.label || "背面朝上的牌";
      actions.push(makeSelectionAction("flip-card", "arrows-counter-clockwise", card.faceUp === false ? "翻到正面" : "翻到背面", { accent: true, disabled: !connected || !card.canControl }));
      secondaryActions.push(makeSelectionAction("rotate-left", "arrow-counter-clockwise", "左转", { disabled: !canEdit }));
      secondaryActions.push(makeSelectionAction("rotate-right", "arrow-clockwise", "右转", { disabled: !canEdit }));
      if (canSendSelectedCard(card)) {
        actions.push(makeSelectionAction("return-card", "arrow-line-down", "收进手牌", { disabled: !canEdit }));
        allowTransfer = canEdit && app.state.players.length > 1;
      }
    }
  }

  if (allowTransfer) {
    secondaryActions.push(makeSelectionAction("toggle-transfer", "arrow-right", "转交", { disabled: !connected }));
  } else {
    app.selectionTransferOpen = false;
  }
  const more = workspace.extraActions(resource, secondaryActions);
  if (wasOpen) more.setAttribute("open", "");
  actions.push(more);
  elements.selectionActions.replaceChildren(...actions);
  elements.selectionDock.dataset.resourceKey = resourceKey;
  renderSelectionTransfer(resource, sameSelection);
  if (focusedAction) {
    const next = elements.selectionActions.querySelector(`[data-selection-action="${focusedAction}"]`);
    (next && !next.disabled ? next : more.querySelector("summary"))?.focus({ preventScroll: true });
  } else if (focused?.tagName === "SUMMARY") more.querySelector("summary")?.focus({ preventScroll: true });
  syncSelectionClasses();
}

function runSelectionAction(action) {
  const resource = selectedResource();
  if (!resource || !app.state) return;
  elements.selectionActions.querySelector(".selection-more")?.removeAttribute("open");
  if (workspace.handleAction(action, resource)) return;
  if (action === "toggle-transfer") {
    app.selectionTransferOpen = !app.selectionTransferOpen;
    renderSelectionDock();
    return;
  }
  if (resource.type === "deck") {
    const deckId = resource.value.id;
    if (action === "draw") sendCommand({ type: "draw", deckId });
    else if (action === "draw-public") {
      const point = nextOpenPublicCardPoint();
      sendCommand({ type: "draw-public", deckId, ...point, rotation: 0 });
    } else if (action === "shuffle-deck") sendCommand({ type: "shuffle", deckId });
    return;
  }
  if (resource.type === "token") {
    const geometry = app.state.room.geometry;
    if (action === "token-center") {
      sendCommand({
        type: "move-token",
        tokenId: resource.value.id,
        x: geometry.homeZone.x + geometry.homeZone.width / 2 - geometry.tokenSize / 2,
        y: geometry.homeZone.y + geometry.homeZone.height / 2 - geometry.tokenSize / 2
      });
    } else if (action === "token-front") {
      sendCommand({ type: "move-token", tokenId: resource.value.id, x: resource.value.x, y: resource.value.y });
    }
    return;
  }
  if (resource.type !== "card" || !resource.value.canControl || (resource.value.locked && action !== "flip-card")) return;

  const card = resource.value;
  if (action === "flip-card") void requestCardFlip(card.id);
  else if (["rotate-left", "rotate-right"].includes(action)) {
    const delta = action === "rotate-left" ? -15 : 15;
    sendCommand({
      type: "move-card",
      cardId: card.id,
      target: "public",
      x: card.x,
      y: card.y,
      rotation: Math.max(-180, Math.min(180, (Number(card.rotation) || 0) + delta)),
      faceUp: card.faceUp !== false
    });
  } else if (["reveal-card", "cover-card"].includes(action)) {
    sendCommand({
      type: "move-card",
      cardId: card.id,
      target: "public",
      ...nextOpenPublicCardPoint(),
      rotation: 0,
      faceUp: action === "reveal-card"
    });
  } else if (action === "return-card") {
    sendCommand({ type: "move-card", cardId: card.id, target: "hand", ownerId: app.state.you.id });
  } else if (["shuffle-stack", "draw-stack", "spread-stack"].includes(action)) {
    sendCommand({ type: action, cardId: card.id });
  }
}

function renderHandZones() {
  const { players, you, cards } = app.state;
  app.handLayouts = calculateHandLayouts(players);
  const counts = new Map();
  for (const card of cards) {
    if (card.zone === "hand") counts.set(card.ownerId, (counts.get(card.ownerId) || 0) + 1);
  }

  const nodes = players.map((player) => {
    const layout = app.handLayouts.get(player.id);
    const zone = document.createElement("section");
    const isActive = app.state.turn?.activePlayerId === player.id;
    zone.className = `hand-zone${player.id === you.id ? " is-you" : ""}${isActive ? " is-turn" : ""}`;
    zone.dataset.playerId = player.id;
    zone.style.left = `${layout.x}px`;
    zone.style.top = `${layout.y}px`;
    zone.style.width = `${layout.width}px`;
    zone.style.height = `${layout.height}px`;
    zone.style.setProperty("--player-color", player.color);

    const label = document.createElement("div");
    label.className = "hand-zone__label";
    const marker = document.createElement("i");
    const name = document.createElement("b");
    name.textContent = player.id === you.id ? "我的手牌" : player.name;
    label.append(marker, name);
    if (isActive) {
      const turn = document.createElement("em");
      turn.className = "hand-zone__turn";
      turn.textContent = "行动";
      label.append(turn);
    }

    const count = document.createElement("span");
    count.className = "hand-zone__count";
    count.textContent = String(counts.get(player.id) || 0);
    zone.append(label, count);
    return zone;
  });

  elements.handZones.replaceChildren(...nodes);
}

function cardBackVisual(source = app.state?.room?.pack?.cardBack || {}) {
  const color = /^#[0-9a-f]{6}$/i.test(source.color || "") ? source.color : "#c94d3d";
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  const luminance = (red * 0.299 + green * 0.587 + blue * 0.114) / 255;
  return {
    label: source.label || "PARLOR",
    theme: source.theme || "default",
    color,
    contrast: luminance > 0.66 ? "#17211d" : "#f6e7d1",
    hasImage: source.hasImage === true
  };
}

function applyCardBackVisual(node, visual = cardBackVisual()) {
  node.style.setProperty("--card-back-color", visual.color);
  node.style.setProperty("--card-back-contrast", visual.contrast);
  node.dataset.cardBackTheme = visual.theme;
  return visual;
}

function appendRoomAssetImage(container, source, className) {
  if (!source) return null;
  const image = document.createElement("img");
  image.className = className;
  image.alt = "";
  image.decoding = "async";
  image.draggable = false;
  image.referrerPolicy = "no-referrer";
  image.setAttribute("aria-hidden", "true");
  image.addEventListener("load", () => {
    container.classList.add("has-asset-image");
    image.classList.add("is-ready");
  }, { once: true });
  image.addEventListener("error", () => {
    container.classList.remove("has-asset-image");
    image.remove();
  }, { once: true });
  image.src = source;
  container.append(image);
  return image;
}

function appendCardBack(container, source, deckId = "main") {
  const visual = applyCardBackVisual(container, cardBackVisual(source));
  const back = document.createElement("div");
  back.className = "card-back";
  back.dataset.cardBackTheme = visual.theme;
  if (visual.hasImage) appendRoomAssetImage(back, roomAssetUrl("back", deckId), "card-back__image");
  const monogram = document.createElement("span");
  monogram.className = "card-back__monogram";
  monogram.textContent = Array.from(visual.label)[0] || "P";
  const label = document.createElement("small");
  label.className = "card-back__label";
  label.textContent = visual.label;
  back.append(monogram, label);
  container.append(back);
}

function appendCardFace(container, face, cardId) {
  const front = document.createElement("div");
  front.className = `card-face${face.tone === "red" ? " is-red" : ""}`;
  if (/^#[0-9a-f]{6}$/i.test(face.color || "")) {
    front.classList.add("has-custom-color");
    front.style.setProperty("--card-face-color", face.color);
    front.style.setProperty("--card-face-ink", /^#[0-9a-f]{6}$/i.test(face.textColor || "") ? face.textColor : "#ffffff");
  }
  if (face.hasImage) appendRoomAssetImage(front, roomAssetUrl("card", cardId), "card-face__image");

  const makeCorner = (bottom = false) => {
    const corner = document.createElement("span");
    corner.className = `card-corner${bottom ? " card-corner--bottom" : ""}`;
    const rank = document.createElement("b");
    rank.textContent = face.rank;
    const suit = document.createElement("small");
    suit.textContent = face.symbol;
    corner.append(rank, suit);
    return corner;
  };

  const symbol = document.createElement("span");
  symbol.className = "card-symbol";
  symbol.textContent = face.symbol;
  const caption = document.createElement("span");
  caption.className = "card-caption";
  caption.textContent = face.label;
  front.append(makeCorner(), symbol, caption, makeCorner(true));
  container.append(front);
}

function makeCardNode(card, position, { ghost = false } = {}) {
  const node = document.createElement("div");
  node.className = `playing-card${card.canControl ? " can-control" : ""}${card.locked ? " is-locked" : ""}${ghost ? " drag-card" : ""}`;
  node.dataset.cardId = card.id || "";
  node.style.left = `${position.x}px`;
  node.style.top = `${position.y}px`;
  node.style.zIndex = String(20 + (position.z || 0));
  node.style.transform = `rotate(${position.rotation || 0}deg)`;
  if (!ghost && card.id) node.tabIndex = 0;
  node.setAttribute("role", !ghost && card.zone === "public" && card.canControl ? "group" : "img");
  node.setAttribute(
    "aria-label",
    card.face ? card.face.label : card.zone === "public" ? "背面朝上的公共牌" : "背面朝上的私有牌"
  );
  const interactionHint = card.canControl
    ? card.zone === "public" ? " · 拖动位置，双击翻面" : " · 拖动改变区域"
    : "";
  node.title = card.face
    ? `${card.face.label}${interactionHint}`
    : `${cardBackVisual(card.back).label} 牌背${interactionHint}`;
  if (card.face) appendCardFace(node, card.face, card.id);
  else appendCardBack(node, card.back, card.deckId);
  if (!ghost && card.zone === "public" && card.canControl) {
    const flip = document.createElement("button");
    flip.className = "card-flip-button";
    flip.type = "button";
    flip.dataset.cardAction = "flip";
    flip.setAttribute("aria-label", card.faceUp === false ? "翻到正面" : "翻到背面");
    flip.title = card.faceUp === false ? "翻到正面" : "翻到背面";
    flip.append(phIcon("arrows-counter-clockwise"));
    node.append(flip);
  }
  return node;
}

function appendStackCount(node, count) {
  const badge = document.createElement("span");
  badge.className = "card-stack-count";
  badge.textContent = String(count);
  badge.title = `${count} 张牌堆 · 拖动整组，轻点操作`;
  node.append(badge);
}

function makeStackDragNode(cards, anchor) {
  const ghost = document.createElement("div");
  ghost.className = "drag-stack";
  cards.forEach((card, index) => {
    const node = makeCardNode(
      { ...card, canControl: false },
      { x: card.x - anchor.x, y: card.y - anchor.y, rotation: card.rotation, z: index },
      { ghost: true }
    );
    node.style.setProperty("--stack-order", String(index + 1));
    if (index === cards.length - 1) appendStackCount(node, cards.length);
    ghost.append(node);
  });
  return ghost;
}

function makeTokenNode(token, { ghost = false } = {}) {
  const node = document.createElement("div");
  node.className = `table-token${token.canControl ? " can-control" : ""}${token.locked ? " is-locked" : ""}${ghost ? " drag-token" : ""}`;
  node.dataset.tokenId = token.id || "";
  node.style.left = `${token.x}px`;
  node.style.top = `${token.y}px`;
  node.style.zIndex = String(35 + (token.z || 0));
  node.style.setProperty("--token-color", token.color || "#e9b94d");
  node.setAttribute("role", token.canControl ? "button" : "img");
  node.setAttribute("aria-label", `${token.label}，公共标记`);
  node.tabIndex = ghost ? -1 : 0;

  const face = document.createElement("span");
  face.className = "table-token__face";
  if (token.hasImage) appendRoomAssetImage(face, roomAssetUrl("token", token.id), "table-token__image");
  const symbol = document.createElement("span");
  symbol.className = "table-token__symbol";
  symbol.textContent = token.symbol ?? "•";
  face.append(symbol);
  const label = document.createElement("small");
  label.className = "table-token__label";
  label.textContent = token.label;
  node.append(face, label);
  return node;
}

function handCardPosition(ownerId, index, total) {
  const zone = app.handLayouts.get(ownerId);
  if (!zone) return { x: 0, y: 0, rotation: 0, z: index };
  const cardWidth = app.state.room.geometry.cardWidth;
  const available = Math.max(0, zone.width - cardWidth - 36);
  const spacing = total <= 1 ? 0 : Math.min(52, available / (total - 1));
  const occupied = cardWidth + spacing * Math.max(0, total - 1);
  const start = zone.x + (zone.width - occupied) / 2;
  return {
    x: start + index * spacing,
    y: zone.y + (zone.y < 200 ? 34 : 53),
    rotation: (index - (total - 1) / 2) * 2.4,
    z: index + 20
  };
}

function renderDeck() {
  const existing = new Map([...elements.deckRoot.children].map((node) => [node.dataset.deckId, node]));
  const ids = new Set();
  for (const deck of app.state.decks || []) {
  ids.add(deck.id);
  const old = existing.get(deck.id), signature = JSON.stringify([deck.back, deck.label, deck.count, deck.locked]);
  if (old?.dataset.signature === signature) {
    old.style.left = `${deck.x}px`; old.style.top = `${deck.y}px`; old.style.zIndex = String(20 + deck.z);
    continue;
  }
  const stack = document.createElement("div");
  stack.className = `deck-stack${deck.count === 0 ? " is-empty" : ""}${deck.locked ? " is-locked" : ""}`;
  stack.dataset.source = "deck";
  stack.dataset.deckId = deck.id;
  stack.dataset.signature = signature;
  stack.setAttribute("role", "button");
  stack.setAttribute("aria-label", `${deck.label}，剩余 ${deck.count} 张，双击抽牌，拖动整个牌盒`);
  stack.tabIndex = 0;
  applyCardBackVisual(stack, cardBackVisual(deck.back));
  stack.style.left = `${deck.x}px`;
  stack.style.top = `${deck.y}px`;
  stack.style.zIndex = String(20 + deck.z);
  stack.title = `${deck.label} · 点选操作，双击抽牌，拖动整个牌盒`;

  const card = document.createElement("div");
  card.className = "playing-card";
  appendCardBack(card, deck.back, deck.id);
  const count = document.createElement("span");
  count.className = "deck-stack__count";
  count.textContent = deck.count > 0 ? String(deck.count) : "0";
  const menu = document.createElement("button");
  menu.type = "button";
  menu.className = "deck-stack__menu";
  menu.dataset.deckAction = "menu";
  menu.setAttribute("aria-label", `打开${deck.label}操作`);
  menu.title = "牌堆操作";
  menu.append(phIcon("sliders-horizontal"));
  const label = document.createElement("small"); label.className = "deck-stack__label"; label.textContent = deck.label;
  stack.append(card, count, menu, label);
  if (old) {
    const focused = old.contains(document.activeElement); old.replaceWith(stack);
    if (focused) stack.focus({ preventScroll: true });
  } else elements.deckRoot.append(stack);
  }
  for (const [id, node] of existing) if (!ids.has(id)) node.remove();
}

function renderCards() {
  const groups = new Map();
  for (const card of app.state.cards) {
    if (card.zone !== "hand") continue;
    if (!groups.has(card.ownerId)) groups.set(card.ownerId, []);
    groups.get(card.ownerId).push(card);
  }

  app.cardPositions.clear();
  const nextFaceStates = new Map();
  const existing = new Map([...elements.cardsRoot.children].map((node) => [node.dataset.cardId, node]));
  const currentIds = new Set();
  for (const card of app.state.cards) {
    currentIds.add(card.id);
    let position;
    if (card.zone === "public") {
      position = { x: card.x, y: card.y, rotation: card.rotation, z: card.z };
    } else {
      const group = groups.get(card.ownerId) || [];
      const index = group.findIndex((candidate) => candidate.id === card.id);
      position = handCardPosition(card.ownerId, index, group.length);
    }
    app.cardPositions.set(card.id, position);
    const signature = JSON.stringify([card.face, card.back, card.deckId, card.canControl, card.locked, card.zone]);
    const old = existing.get(card.id);
    const node = old?.dataset.signature === signature ? old : makeCardNode(card, position);
    node.dataset.signature = signature;
    node.style.left = `${position.x}px`; node.style.top = `${position.y}px`;
    node.style.transform = `rotate(${position.rotation || 0}deg)`; node.style.zIndex = String(20 + (position.z || 0));
    node.classList.remove("is-stack-top");
    node.querySelector(".card-stack-count")?.remove();
    node.setAttribute("aria-label", card.face?.label || "背面朝上的牌");
    if (card.zone === "public") {
      const stack = visibleStackForCard(card.id);
      if (stack.length >= 2) node.title = `${stack.length} 张牌堆 · 拖动整组，轻点操作`;
      if (stack.length >= 2 && stack.at(-1)?.id === card.id) {
        node.classList.add("is-stack-top");
        node.setAttribute("aria-label", `公共牌堆，${stack.length} 张`);
        appendStackCount(node, stack.length);
      }
    }
    const visibleSide = card.face ? "front" : "back";
    const previousSide = app.cardFaceStates.get(card.id);
    if (previousSide && previousSide !== visibleSide) node.classList.add("is-flipping");
    nextFaceStates.set(card.id, visibleSide);
    if (node !== old) {
      if (old) { const focused = old.contains(document.activeElement); old.replaceWith(node); if (focused) node.focus({ preventScroll: true }); }
      else elements.cardsRoot.append(node);
    }
  }
  app.cardFaceStates = nextFaceStates;
  for (const [id, node] of existing) if (!currentIds.has(id)) node.remove();
}

function renderTokens() {
  const existing = new Map([...elements.tokenRoot.children].map((node) => [node.dataset.tokenId, node]));
  const ids = new Set();
  for (const token of app.state.tokens || []) {
    ids.add(token.id);
    const signature = JSON.stringify(token), old = existing.get(token.id);
    if (old?.dataset.signature === signature) continue;
    const node = makeTokenNode(token); node.dataset.signature = signature;
    if (old) { const focused = old.contains(document.activeElement); old.replaceWith(node); if (focused) node.focus({ preventScroll: true }); }
    else elements.tokenRoot.append(node);
  }
  for (const [id, node] of existing) if (!ids.has(id)) node.remove();
}

function renderDie() {
  const die = app.state.die || { label: "公共 D6", sides: 6, value: null, rollId: 0 };
  const value = die.value ?? "?";
  elements.dieLabel.textContent = die.label || `公共 D${die.sides || 6}`;
  elements.dieFace.querySelector("span").textContent = String(value);
  elements.dieFace.dataset.value = String(value);
  elements.dieFace.dataset.sides = `D${die.sides || 6}`;

  if (die.rollId && die.rollId !== app.lastDieRollId) {
    app.lastDieRollId = die.rollId;
    elements.dieFace.classList.remove("is-rolling");
    void elements.dieFace.offsetWidth;
    elements.dieFace.classList.add("is-rolling");
    window.setTimeout(() => elements.dieFace.classList.remove("is-rolling"), 620);
  }

  const roller = app.state.players.find((player) => player.id === die.lastRolledBy);
  elements.dieFace.title = roller ? `${roller.name} 最近掷出了 ${value}` : "还没有人掷骰子";
}

function renderCounter() {
  const counter = app.state.counter || { label: "回合", value: 1, min: 1, max: 99 };
  elements.counterLabel.textContent = counter.label;
  elements.counterValue.textContent = String(counter.value);
  elements.counterValue.setAttribute("aria-label", `${counter.label} ${counter.value}`);
  elements.decrementCounter.setAttribute("aria-label", `${counter.label}减一`);
  elements.incrementCounter.setAttribute("aria-label", `${counter.label}加一`);
}

function renderTurn() {
  const activePlayerId = app.state.turn?.activePlayerId || "";
  const activePlayer = app.state.players.find((player) => player.id === activePlayerId) || null;
  const optionSignature = app.state.players
    .map((player) => `${player.id}:${player.name}:${player.online ? 1 : 0}`)
    .join("|");

  if (elements.turnPlayerSelect.dataset.signature !== optionSignature) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "选择一位玩家";
    placeholder.disabled = true;
    const options = app.state.players.map((player) => {
      const option = document.createElement("option");
      option.value = player.id;
      option.textContent = `${player.name}${player.online ? "" : "（离线）"}`;
      return option;
    });
    elements.turnPlayerSelect.replaceChildren(placeholder, ...options);
    elements.turnPlayerSelect.dataset.signature = optionSignature;
  }
  elements.turnPlayerSelect.value = activePlayer?.id || "";

  const color = activePlayer?.color || "#e9b94d";
  elements.turnAvatar.style.setProperty("--turn-color", color);
  elements.turnAvatar.textContent = activePlayer ? (Array.from(activePlayer.name)[0] || "玩") : "?";
  elements.turnPlayerName.textContent = activePlayer ? activePlayer.name : "尚未指定行动玩家";
  elements.turnBanner.style.setProperty("--turn-color", color);
  elements.turnBanner.classList.toggle("is-hidden", !activePlayer);
  elements.turnBanner.disabled = !activePlayer;
  elements.turnBanner.dataset.playerId = activePlayer?.id || "";
  elements.turnBannerName.textContent = activePlayer ? activePlayer.name : "等待房主指定";

  if (
    app.turnInitialized
    && activePlayer
    && activePlayer.id !== app.lastTurnPlayerId
    && activePlayer.id === app.state.you.id
  ) {
    toast("轮到你了。", "turn");
  }
  app.turnInitialized = true;
  app.lastTurnPlayerId = activePlayer?.id || null;
}

function renderDealOptions() {
  const playerCount = Math.max(1, app.state.players.length);
  const maximum = Math.min(10, Math.floor(activeDeck().count / playerCount));
  if (Number(elements.dealCount.dataset.maximum) !== maximum) {
    const current = Math.max(1, Number(elements.dealCount.value) || 1);
    if (maximum === 0) {
      const option = document.createElement("option");
      option.value = "0";
      option.textContent = "牌不够";
      elements.dealCount.replaceChildren(option);
    } else {
      const options = Array.from({ length: maximum }, (_, index) => {
        const count = index + 1;
        const option = document.createElement("option");
        option.value = String(count);
        option.textContent = `${count} 张`;
        return option;
      });
      elements.dealCount.replaceChildren(...options);
      elements.dealCount.value = String(Math.min(current, maximum));
    }
    elements.dealCount.dataset.maximum = String(maximum);
  }
  const selected = Number(elements.dealCount.value) || 0;
  elements.dealCards.textContent = selected > 0 ? `发 ${selected} 张/人` : "无法发牌";
}

function playerColor(playerId) {
  return app.state.players.find((player) => player.id === playerId)?.color || "#e9b94d";
}

function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 15) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  return `${Math.floor(seconds / 60)} 分钟前`;
}

function renderActivity() {
  if (app.state.history.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-activity";
    empty.textContent = "牌桌刚刚铺好。";
    elements.activityList.replaceChildren(empty);
    return;
  }

  const items = [...app.state.history].reverse().map((entry) => {
    const item = document.createElement("article");
    item.className = "activity-item";
    item.style.setProperty("--activity-color", playerColor(entry.actorId));
    const text = document.createElement("p");
    const actor = document.createElement("strong");
    actor.textContent = entry.actorName;
    text.append(actor, document.createTextNode(` ${entry.label}`));
    const time = document.createElement("time");
    time.dateTime = new Date(entry.at).toISOString();
    time.textContent = relativeTime(entry.at);
    item.append(text, time);
    return item;
  });
  elements.activityList.replaceChildren(...items);
}

function renderPackLibrary() {
  workspace?.renderLibrary();
}

function renderTools() {
  if (!app.state) return;
  const connected = app.connectionOpen;
  const isHost = app.state.you.role === "host";
  const counter = app.state.counter || { value: 1, min: 1, max: 99 };
  const offlineGuests = app.state.players.filter((player) => player.role === "guest" && !player.online);
  const pending = (type) => app.pendingCommands.has(type);
  const deck = activeDeck();
  const maximumDeal = Number(elements.dealCount.dataset.maximum) || 0;
  elements.rollDie.disabled = !connected || pending("roll-die");
  elements.decrementCounter.disabled = !connected || pending("adjust-counter") || counter.value <= counter.min;
  elements.incrementCounter.disabled = !connected || pending("adjust-counter") || counter.value >= counter.max;
  elements.turnPlayerSelect.disabled = !connected || !isHost || pending("set-turn");
  elements.randomTurn.disabled = !connected || !isHost || pending("random-turn");
  elements.nextTurn.disabled = !connected || !isHost || pending("advance-turn");
  elements.undoTable.disabled = !connected || !isHost || !app.state.canUndo || pending("undo");
  elements.drawCard.disabled = !connected || !deck.canDraw || pending("draw");
  elements.dealCount.disabled = !connected || !isHost || maximumDeal < 1 || pending("deal-each");
  elements.dealCards.disabled = !connected || !isHost || maximumDeal < 1 || pending("deal-each");
  elements.shuffleDeck.disabled = !connected || deck.count < 2 || pending("shuffle");
  elements.quickUndo.disabled = !connected || !isHost || !app.state.canUndo || pending("undo");
  elements.quickUndo.title = isHost ? "撤销上一步 · U" : "由房主撤销操作";
  elements.shuffleDeck.querySelector("strong").textContent = "洗选中牌盒";
  elements.drawCard.title = `从「${deck.label || "起始牌盒"}」抽牌`;
  const publicCardCount = app.state.cards.filter((card) => card.zone === "public").length;
  elements.tidyPublic.disabled = !connected || !isHost || publicCardCount < 1 || pending("tidy-public");
  elements.collectPublic.disabled = !connected || !isHost || publicCardCount < 1 || pending("collect-public");
  elements.resetTable.disabled = !connected || !isHost || pending("reset");
  elements.pingLocation.disabled = !connected;
  elements.offlineSeatCount.textContent = `${offlineGuests.length} 离线`;
  elements.offlineSeatCount.classList.toggle("is-complete", offlineGuests.length === 0);
  elements.leaveSeat.classList.toggle("is-hidden", isHost);
  elements.cleanupOffline.classList.toggle("is-hidden", !isHost);
  elements.openGuestTest.classList.toggle("is-hidden", !isHost || previewMode);
  elements.leaveSeat.disabled = !connected || pending("leave-seat");
  elements.cleanupOffline.disabled = !connected || offlineGuests.length === 0 || pending("cleanup-offline");
  elements.openGuestTest.disabled = !connected;
  for (const control of elements.toolsPanel.querySelectorAll(".host-tool")) {
    control.classList.toggle("is-hidden", !isHost);
  }
  elements.cleanupOffline.textContent = offlineGuests.length > 0
    ? `清理 ${offlineGuests.length} 个离线席位`
    : "没有离线席位";
  elements.leaveSeat.title = "离开席位，手牌归回牌盒";
  elements.cleanupOffline.title = "清理离线席位，手牌归回牌盒";
  renderPackLibrary();
  renderSelectionDock();
}

function renderRoom() {
  if (!app.state) return;
  elements.roomTitle.textContent = app.state.room.title;
  updateIdentity(app.state.you);
  renderPlayers();
  renderMobilePlayers();
  renderHandZones();
  renderDeck();
  renderTokens();
  renderCards();
  workspace?.render();
  if (app.drag?.activated) setDragSourceClasses(app.drag, true);
  renderDie();
  renderCounter();
  renderTurn();
  renderDealOptions();
  renderActivity();
  renderTools();
  renderCursors();
  renderRemoteDrags();
  if (!app.cameraInitialized) fitCamera();
}

function applyCamera() {
  const { x, y, scale } = app.camera;
  elements.world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  elements.viewport.style.setProperty("--grid-size", `${48 * scale}px`);
  elements.viewport.style.setProperty("--grid-x", `${x}px`);
  elements.viewport.style.setProperty("--grid-y", `${y}px`);
  workspace?.drawMap();
  if (app.localCursor?.visible) renderCursors();
}

function cameraLeftInset(rect) {
  if (elements.libraryPanel.classList.contains("is-open") && rect.width >= 760) {
    return Math.max(72, Math.min(rect.width - 160, elements.libraryPanel.getBoundingClientRect().right - rect.left + 20));
  }
  return rect.width < 760 ? 56 : 72;
}

function fitCamera() {
  const rect = elements.viewport.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const geometry = app.state?.room.geometry || { width: 1800, height: 1100 };
  const left = cameraLeftInset(rect);
  const scale = Math.max(rect.width < 600 ? 0.42 : 0.25, Math.min(0.84, (rect.width - left - 56) / geometry.width, (rect.height - 100) / geometry.height));
  app.camera = {
    scale,
    x: left / 2 + (rect.width - geometry.width * scale) / 2,
    y: (rect.height - geometry.height * scale) / 2 - 25
  };
  app.cameraInitialized = true;
  app.cameraTouched = false;
  applyCamera();
}

function fitAll() {
  if (!app.state) return;
  const items = [
    ...(app.state.decks || []).map((item) => ({ ...item, width: 94, height: 168 })),
    ...app.state.cards.filter((item) => item.zone === "public").map((item) => ({ ...item, width: 94, height: 138 })),
    ...(app.state.tokens || []).map((item) => ({ ...item, width: 62, height: 62 })),
    ...(app.state.objects || []), ...app.handLayouts.values()
  ];
  const minX = Math.min(205, ...items.map((item) => item.x)) - 80;
  const minY = Math.min(205, ...items.map((item) => item.y)) - 80;
  const maxX = Math.max(1595, ...items.map((item) => item.x + item.width)) + 80;
  const maxY = Math.max(1050, ...items.map((item) => item.y + item.height)) + 80;
  const rect = elements.viewport.getBoundingClientRect();
  const left = cameraLeftInset(rect);
  const width = rect.width - left - 36, height = rect.height - 100;
  const scale = Math.max(0.015, Math.min(0.9, width / (maxX - minX), height / (maxY - minY)));
  app.camera = { scale, x: left + width / 2 - (minX + maxX) / 2 * scale, y: 20 + height / 2 - (minY + maxY) / 2 * scale };
  app.cameraTouched = true; app.cameraInitialized = true; applyCamera();
}

function viewportPoint(clientX, clientY) {
  const rect = elements.viewport.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function screenToWorld(clientX, clientY) {
  const point = viewportPoint(clientX, clientY);
  return {
    x: (point.x - app.camera.x) / app.camera.scale,
    y: (point.y - app.camera.y) / app.camera.scale
  };
}

function focusWorldPoint(point, { minimumScale = 0.58 } = {}) {
  const rect = elements.viewport.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const scale = Math.max(minimumScale, app.camera.scale);
  app.camera = {
    scale,
    x: rect.width / 2 - point.x * scale,
    y: rect.height / 2 - point.y * scale
  };
  app.cameraTouched = true;
  applyCamera();
}

function focusPlayer(playerId) {
  const player = app.state?.players.find((candidate) => candidate.id === playerId);
  if (!player) return;
  const remoteCursor = app.remoteCursors.get(playerId);
  const freshCursor = remoteCursor && Date.now() - remoteCursor.seenAt < 5000 ? remoteCursor : null;
  const ownCursor = playerId === app.state.you.id && app.localCursor?.visible ? app.localCursor : null;
  const layout = app.handLayouts.get(playerId);
  const point = freshCursor || ownCursor || (layout
    ? { x: layout.x + layout.width / 2, y: layout.y + layout.height / 2 }
    : null);
  if (!point) {
    toast(`暂时找不到 ${player.name} 的桌面位置。`, "error");
    return;
  }
  focusWorldPoint(point);
  toast(freshCursor || ownCursor ? `已定位到 ${player.name} 的光标。` : `已定位到 ${player.name} 的手牌区。`);
}

function showPing(ping) {
  if (!Number.isFinite(Number(ping.x)) || !Number.isFinite(Number(ping.y))) return;
  const node = document.createElement("div");
  node.className = "table-ping";
  node.style.left = `${Number(ping.x)}px`;
  node.style.top = `${Number(ping.y)}px`;
  node.style.setProperty("--ping-color", ping.color || "#e9b94d");
  node.setAttribute("aria-label", `${ping.name || "玩家"} 标记了这里`);
  const rings = document.createElement("span");
  rings.className = "table-ping__rings";
  const label = document.createElement("strong");
  label.textContent = `${ping.name || "玩家"} · 看这里`;
  node.append(rings, label);
  while (elements.pingRoot.children.length >= 8) elements.pingRoot.firstElementChild?.remove();
  elements.pingRoot.append(node);
  window.setTimeout(() => node.remove(), 1900);
}

async function pingAt(point) {
  if (!app.state) {
    toast("牌桌还在载入，稍后再标记这里。");
    return;
  }
  const now = performance.now();
  if (now - app.lastPingSentAt < 500) return;
  app.lastPingSentAt = now;
  if (previewMode) {
    showPing({
      id: `preview-${Date.now()}`,
      playerId: app.state.you.id,
      name: app.state.you.name,
      color: app.state.you.color,
      x: point.x,
      y: point.y
    });
    return;
  }
  try {
    await postRealtimeMessage({ type: "ping", x: point.x, y: point.y });
    if (app.eventSource?.readyState !== EventSource.OPEN) {
      toast("位置已发出，画面同步正在恢复。");
    }
  } catch (error) {
    const networkMessage = error.name === "AbortError" || error instanceof TypeError
      ? "网络有波动，这次标记没有发出，请稍后再试。"
      : error.message || "这次标记没有发出去，请稍后再试。";
    toast(networkMessage, "error");
  }
}

function pingCurrentLocation() {
  if (app.lastTablePoint) {
    void pingAt(app.lastTablePoint);
    return;
  }
  const rect = elements.viewport.getBoundingClientRect();
  void pingAt(screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2));
}

function setZoom(nextScale, anchorX, anchorY) {
  const rect = elements.viewport.getBoundingClientRect();
  const screenX = anchorX ?? rect.width / 2;
  const screenY = anchorY ?? rect.height / 2;
  const worldX = (screenX - app.camera.x) / app.camera.scale;
  const worldY = (screenY - app.camera.y) / app.camera.scale;
  const scale = Math.max(0.015, Math.min(1.8, nextScale));
  app.camera.x = screenX - worldX * scale;
  app.camera.y = screenY - worldY * scale;
  app.camera.scale = scale;
  app.cameraTouched = true;
  applyCamera();
}

function cancelPan({ releaseCapture = true } = {}) {
  const pan = app.pan;
  app.pan = null;
  elements.viewport.classList.remove("is-panning");
  if (pan && releaseCapture) {
    try { elements.viewport.releasePointerCapture?.(pan.pointerId); } catch { /* Pointer already released. */ }
  }
}

function rebaseTouchNavigation() {
  const entries = [...app.tableTouches].slice(0, 2);
  if (!entries.length) {
    app.touchNavigation = null;
    app.ignoreTableClickUntil = Date.now() + 400;
    return;
  }
  const first = entries[0][1], second = entries[1]?.[1] || first;
  const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  app.touchNavigation = {
    ids: entries.map(([id]) => id),
    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
    scale: app.camera.scale,
    anchor: screenToWorld(center.x, center.y)
  };
}

function beginTouchNavigation() {
  cancelDrag({ releaseCapture: false });
  cancelPan({ releaseCapture: false });
  app.handTouch = null;
  clearSelection();
  rebaseTouchNavigation();
  app.cameraTouched = true;
  for (const pointerId of app.tableTouches.keys()) elements.viewport.setPointerCapture?.(pointerId);
  clearCursorQueue();
  if (app.localCursor) { app.localCursor.visible = false; renderCursors(); }
}

function moveTouchNavigation() {
  const gesture = app.touchNavigation;
  if (!gesture) return;
  const first = app.tableTouches.get(gesture.ids[0]);
  const second = app.tableTouches.get(gesture.ids[1]) || first;
  if (!first) return;
  const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
  const scale = Math.max(0.015, Math.min(1.8, gesture.scale * distance / gesture.distance));
  const center = viewportPoint((first.x + second.x) / 2, (first.y + second.y) / 2);
  app.camera = { scale, x: center.x - gesture.anchor.x * scale, y: center.y - gesture.anchor.y * scale };
  applyCamera();
}

function endTableTouch(pointerId) {
  const navigating = Boolean(app.touchNavigation);
  if (!app.tableTouches.delete(pointerId)) return false;
  if (navigating) rebaseTouchNavigation();
  return navigating;
}

function cancelTableTouches() {
  const pointerIds = [...app.tableTouches.keys()];
  app.tableTouches.clear();
  app.touchNavigation = null;
  if (pointerIds.length) app.ignoreTableClickUntil = Date.now() + 400;
  for (const pointerId of pointerIds) {
    try { elements.viewport.releasePointerCapture?.(pointerId); } catch { /* Pointer already released. */ }
  }
  return pointerIds.length > 0;
}

function ignoreTableActivation(event) {
  return event.detail !== 0 && Boolean(app.touchNavigation || Date.now() < app.ignoreTableClickUntil);
}

function cancelHandInteraction() {
  const active = Boolean(app.handTouch || app.drag?.fromPocket);
  app.handTouch = null;
  if (app.drag?.fromPocket) cancelDrag();
  if (active) app.ignoreTableClickUntil = Date.now() + 400;
  return active;
}

function moveHandTouch(event) {
  const touch = app.handTouch;
  if (!touch || touch.pointerId !== event.pointerId) return false;
  const dx = event.clientX - touch.clientX, dy = event.clientY - touch.clientY;
  if (touch.scrolling || Math.hypot(dx, dy) < 10) return true;
  if (Math.abs(dx) >= Math.abs(dy)) { touch.scrolling = true; return true; }
  app.handTouch = null;
  const card = app.state?.cards.find((item) => item.id === touch.cardId && item.zone === "hand" && item.ownerId === app.state.you.id);
  const node = elements.handCards.querySelector(`[data-card-id="${touch.cardId}"]`);
  if (card && node && !elements.handDrawer.classList.contains("is-hidden")) {
    startDrag({ pointerId: event.pointerId, pointerType: "touch", target: node, clientX: touch.clientX, clientY: touch.clientY, preventDefault: () => event.preventDefault() }, "card", card);
  }
  return !app.drag;
}

function endHandTouch(event) {
  const touch = app.handTouch;
  if (!touch || touch.pointerId !== event.pointerId) return false;
  app.handTouch = null;
  if (!touch.scrolling && Math.hypot(event.clientX - touch.clientX, event.clientY - touch.clientY) < 10) selectResource("card", touch.cardId);
  return true;
}

function makeCursorNode(cursor, isLocal) {
  const node = document.createElement("div");
  node.className = `table-cursor${isLocal ? " is-local" : ""}`;
  node.dataset.playerId = cursor.playerId;
  const arrow = document.createElement("span");
  arrow.className = "table-cursor__arrow";
  const name = document.createElement("span");
  name.className = "table-cursor__name";
  node.append(arrow, name);
  updateCursorNode(node, cursor);
  return node;
}

function updateCursorNode(node, cursor) {
  node.style.setProperty("--cursor-color", cursor.color);
  node.style.transform = `translate(${cursor.x}px, ${cursor.y}px)`;
  const name = node.querySelector(".table-cursor__name");
  if (name && name.textContent !== cursor.name) name.textContent = cursor.name;
}

function worldToViewport(point) {
  return {
    x: app.camera.x + point.x * app.camera.scale,
    y: app.camera.y + point.y * app.camera.scale
  };
}

function renderCursors() {
  if (!app.state) return;
  const visibleRemoteIds = new Set();
  for (const cursor of app.remoteCursors.values()) {
    if (cursor.playerId === app.state.you.id) continue;
    visibleRemoteIds.add(cursor.playerId);
    let node = [...elements.cursorRoot.children]
      .find((candidate) => candidate.dataset.playerId === cursor.playerId);
    if (!node) {
      node = makeCursorNode(cursor, false);
      elements.cursorRoot.append(node);
    } else {
      updateCursorNode(node, cursor);
    }
  }
  for (const node of [...elements.cursorRoot.children]) {
    if (!visibleRemoteIds.has(node.dataset.playerId)) node.remove();
  }

  if (app.localCursor?.visible) {
    const screenPoint = worldToViewport(app.localCursor);
    const cursor = { ...app.localCursor, ...screenPoint };
    let node = elements.localCursorRoot.firstElementChild;
    if (!node) {
      node = makeCursorNode(cursor, true);
      elements.localCursorRoot.append(node);
    } else {
      updateCursorNode(node, cursor);
    }
  } else {
    elements.localCursorRoot.replaceChildren();
  }
}

function makeRemoteDragNode(preview) {
  const wrapper = document.createElement("div");
  wrapper.className = "remote-drag";
  wrapper.dataset.sourceType = preview.sourceType;
  wrapper.style.left = `${preview.x}px`;
  wrapper.style.top = `${preview.y}px`;
  wrapper.style.setProperty("--drag-player-color", preview.color || "#e9b94d");

  let resource = null;
  if (preview.sourceType === "stack") {
    const cards = (preview.cardIds || [])
      .map((id) => app.state.cards.find((card) => card.id === id && card.zone === "public"));
    const anchor = cards.find((card) => card?.id === preview.resourceId);
    if (!anchor || cards.length < 2 || cards.some((card) => !card)) return null;
    resource = makeStackDragNode(cards, anchor);
  } else if (preview.sourceType === "card") {
    const card = app.state.cards.find((candidate) => candidate.id === preview.resourceId);
    if (!card) return null;
    resource = makeCardNode(
      { ...card, canControl: false },
      { x: 0, y: 0, rotation: preview.rotation || 0, z: 0 },
      { ghost: true }
    );
  } else if (preview.sourceType === "token") {
    const token = (app.state.tokens || []).find((candidate) => candidate.id === preview.resourceId);
    if (!token) return null;
    resource = makeTokenNode({ ...token, x: 0, y: 0, canControl: false }, { ghost: true });
  } else if (preview.sourceType === "deck") {
    const deck = app.state.decks?.find((item) => item.id === (preview.resourceId || "main"));
    if (!deck) return null;
    resource = makeCardNode(
      { id: "remote-deck", deckId: deck.id, back: deck.back, zone: "deck", face: null, canControl: false },
      { x: 0, y: 0, rotation: preview.rotation || 0, z: 0 },
      { ghost: true }
    );
  } else if (preview.sourceType === "object") {
    const object = app.state.objects?.find((item) => item.id === preview.resourceId);
    if (!object) return null;
    resource = workspace.makeObjectNode({ ...object, x: 0, y: 0 }, { ghost: true });
  }
  if (!resource) return null;
  resource.classList.add("remote-drag__resource");
  if (preview.placeFaceDown) resource.dataset.placement = "face-down";

  const label = document.createElement("span");
  label.className = "remote-drag__label";
  label.textContent = `${preview.name || "玩家"} 正在移动${preview.sourceType === "stack" ? ` ${preview.cardIds.length} 张牌` : ""}`;
  wrapper.append(resource, label);
  return wrapper;
}

function renderRemoteDrags() {
  if (!app.state) return;
  for (const node of elements.world.querySelectorAll(".is-remote-source")) {
    node.classList.remove("is-remote-source");
  }
  const nodes = [];
  for (const preview of app.remoteDrags.values()) {
    if (preview.playerId === app.state.you.id) continue;
    const node = makeRemoteDragNode(preview);
    if (!node) continue;
    nodes.push(node);
    const resourceIds = preview.sourceType === "stack" ? preview.cardIds : [preview.resourceId];
    for (const id of resourceIds) {
      sourceNodeFor(preview.sourceType, id)?.classList.add("is-remote-source");
    }
  }
  elements.remoteDragRoot.replaceChildren(...nodes);
}

function scheduleCursorFlush() {
  if (!app.queuedCursorMessage || app.cursorSendInFlight || app.cursorSendTimer || previewMode) return;
  const elapsed = performance.now() - app.lastCursorSentAt;
  const delay = Math.max(0, CURSOR_SEND_INTERVAL - elapsed);
  app.cursorSendTimer = window.setTimeout(flushCursorMessage, delay);
}

async function flushCursorMessage() {
  app.cursorSendTimer = null;
  if (!app.queuedCursorMessage || app.cursorSendInFlight || !app.sessionToken || !endpoint || previewMode) return;

  const message = app.queuedCursorMessage;
  app.queuedCursorMessage = null;
  app.cursorSendInFlight = true;
  app.lastCursorSentAt = performance.now();
  const controller = new AbortController();
  app.cursorRequestController = controller;
  const timeout = window.setTimeout(() => controller.abort(), CURSOR_REQUEST_TIMEOUT);
  const body = JSON.stringify({ roomCode, sessionToken: app.sessionToken, message });

  try {
    await fetch(apiUrl("/api/message"), {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body,
      signal: controller.signal
    });
  } catch {
    // Cursor movement is ephemeral. The next queued position supersedes a missed update.
  } finally {
    window.clearTimeout(timeout);
    if (app.cursorRequestController === controller) app.cursorRequestController = null;
    app.cursorSendInFlight = false;
    scheduleCursorFlush();
  }
}

function clearCursorQueue() {
  app.queuedCursorMessage = null;
  window.clearTimeout(app.cursorSendTimer);
  app.cursorSendTimer = null;
  app.cursorRequestController?.abort();
  app.cursorRequestController = null;
}

function sendCursor(worldPoint) {
  if (!app.state || !app.connectionOpen || previewMode) return;
  const drag = app.drag?.activated
    ? {
        sourceType: app.drag.sourceType,
        resourceId: app.drag.resource?.id || null,
        x: app.drag.x,
        y: app.drag.y,
        rotation: app.drag.rotation || 0,
        placeFaceDown: app.drag.placeFaceDown === true
      }
    : null;
  app.queuedCursorMessage = { type: "cursor", x: worldPoint.x, y: worldPoint.y, drag };
  scheduleCursorFlush();
}

function endRemoteDragPreview() {
  if (app.connectionOpen && !previewMode) postRealtimeMessage({ type: "drag-end" }, true);
}

function pointInside(point, rectangle) {
  return point.x >= rectangle.x
    && point.x <= rectangle.x + rectangle.width
    && point.y >= rectangle.y
    && point.y <= rectangle.y + rectangle.height;
}

function clearDropTargets() {
  elements.publicZone.classList.remove("is-drop-target", "is-face-down-target");
  for (const zone of elements.handZones.querySelectorAll(".hand-zone")) zone.classList.remove("is-drop-target");
  for (const node of elements.objectsRoot.querySelectorAll(".is-drop-target")) node.classList.remove("is-drop-target");
  elements.handDrawer.classList.remove("is-drop-target");
  elements.openHand.classList.remove("is-drop-target");
}

function handZoneElement(playerId) {
  return [...elements.handZones.querySelectorAll(".hand-zone")]
    .find((zone) => zone.dataset.playerId === playerId) || null;
}

function handTargetAt(point) {
  if (!["card", "stack", "deck"].includes(app.drag?.sourceType)) return null;
  const screen = worldToViewport(point), viewport = elements.viewport.getBoundingClientRect();
  const screenPoint = { x: viewport.left + screen.x, y: viewport.top + screen.y };
  for (const node of [elements.openHand, elements.handDrawer]) {
    if (node.classList.contains("is-hidden")) continue;
    const rect = node.getBoundingClientRect();
    if (pointInside(screenPoint, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })) return app.state.you.id;
  }
  for (const [playerId, layout] of app.handLayouts) {
    if (!pointInside(point, layout)) continue;
    return playerId;
  }
  return null;
}

function bagTargetAt(point) {
  if (!app.drag || app.drag.sourceType === "deck" || ["bag", "mat"].includes(app.drag.resource?.kind)) return null;
  return (app.state.objects || []).filter((object) => object.kind === "bag" && object.id !== app.drag.resource?.id && pointInside(point, object)).sort((a, b) => b.z - a.z)[0] || null;
}

function updateDropTargets(point) {
  clearDropTargets();
  if (!app.drag || !app.state) return;
  const bag = bagTargetAt(point);
  if (bag) { sourceNodeFor("object", bag.id)?.classList.add("is-drop-target"); return; }
  const handTargetId = handTargetAt(point);
  if (["deck", "card", "stack"].includes(app.drag.sourceType) && handTargetId) {
    handZoneElement(handTargetId)?.classList.add("is-drop-target");
    if (handTargetId === app.state.you.id) {
      elements.handDrawer.classList.add("is-drop-target");
      elements.openHand.classList.add("is-drop-target");
    }
    return;
  }
  if (pointInside(point, app.state.room.geometry.publicZone)) {
    elements.publicZone.classList.add("is-drop-target");
    elements.publicZone.classList.toggle("is-face-down-target", Boolean(app.drag.placeFaceDown));
  }
}

function sourceNodeFor(sourceType, resourceId) {
  if (["card", "stack"].includes(sourceType)) {
    return elements.cardsRoot.querySelector(`[data-card-id="${resourceId}"]`);
  }
  if (sourceType === "token") return elements.tokenRoot.querySelector(`[data-token-id="${resourceId}"]`);
  if (sourceType === "object") return elements.objectsRoot.querySelector(`[data-object-id="${resourceId}"]`);
  return elements.deckRoot.querySelector(`[data-deck-id="${resourceId || "main"}"]`);
}

function setDragSourceClasses(drag, active) {
  const ids = drag.sourceType === "stack" ? drag.stackCards.map((card) => card.id) : [drag.resource?.id];
  for (const id of ids) {
    sourceNodeFor(drag.sourceType, id)?.classList.toggle("is-source", active);
    if (["card", "stack"].includes(drag.sourceType)) elements.handCards.querySelector(`[data-card-id="${id}"]`)?.classList.toggle("is-source", active);
  }
}

function startDrag(event, sourceType, resource = null) {
  if (!app.state || !resource) return;
  if (app.drag || app.pan || app.touchNavigation || (event.pointerType === "touch" && (event.isPrimary === false || app.tableTouches.size))) return;
  if (!app.connectionOpen || resource.locked || (["card", "token"].includes(sourceType) && !resource.canControl)) {
    selectResource(sourceType, resource.id);
    return;
  }

  const stackCards = sourceType === "card" ? visibleStackForCard(resource.id) : [];
  if (stackCards.some((card) => card.locked)) { selectResource("card", resource.id); toast("牌堆里有锁定的牌，先解锁再移动。"); return; }
  if (stackCards.length >= 2) sourceType = "stack";
  const point = screenToWorld(event.clientX, event.clientY);
  let sourcePosition = ["deck", "token", "object"].includes(sourceType)
      ? { x: resource.x, y: resource.y, z: resource.z }
      : app.cardPositions.get(resource.id);
  if (!sourcePosition) return;
  const pocketNode = event.target.closest("#hand-cards .playing-card");
  if (pocketNode) {
    const rect = pocketNode.getBoundingClientRect();
    sourcePosition = { x: point.x - (event.clientX - rect.left) / rect.width * 94, y: point.y - (event.clientY - rect.top) / rect.height * 138, z: 0, rotation: 0 };
  }

  const ghost = sourceType === "stack"
    ? makeStackDragNode(stackCards, resource)
    : sourceType === "token"
      ? makeTokenNode({ ...resource, canControl: false }, { ghost: true })
      : sourceType === "object"
        ? workspace.makeObjectNode(resource, { ghost: true })
      : makeCardNode(
          sourceType === "deck"
            ? { id: "deck-ghost", deckId: resource.id, back: resource.back, face: null, canControl: false }
            : { ...resource, canControl: false },
          sourcePosition,
          { ghost: true }
        );
  const initialRotation = sourceType === "card" ? Number(sourcePosition.rotation) || 0 : 0;
  if (sourceType === "card") {
    ghost.dataset.rotation = String(Math.round(initialRotation));
    ghost.style.setProperty("--drag-counter-rotation", `${-initialRotation}deg`);
    ghost.style.transform = `rotate(${initialRotation}deg) scale(1.05)`;
    const hint = document.createElement("span");
    hint.className = "drag-rotate-hint";
    hint.textContent = "Q / E  ·  ⌥ 左右移动";
    ghost.append(hint);
  }
  ghost.style.zIndex = "190";
  ghost.style.left = `${sourcePosition.x}px`;
  ghost.style.top = `${sourcePosition.y}px`;

  const sourceNode = pocketNode || sourceNodeFor(sourceType, resource?.id);
  app.drag = {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    fromPocket: Boolean(pocketNode),
    sourceType,
    resource,
    stackCards,
    ghost,
    sourceNode,
    offsetX: point.x - sourcePosition.x,
    offsetY: point.y - sourcePosition.y,
    x: sourcePosition.x,
    y: sourcePosition.y,
    rotation: initialRotation,
    startClientX: event.clientX,
    startClientY: event.clientY,
    rotateGesture: null,
    wheelRotation: 0,
    activated: false
  };
  app.drag.sourceNode?.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function setDraggedCardRotation(rotation) {
  if (app.drag?.sourceType !== "card" || !app.drag.activated) return false;
  app.drag.rotation = Math.max(-180, Math.min(180, rotation));
  app.drag.ghost.dataset.rotation = String(Math.round(app.drag.rotation));
  app.drag.ghost.style.setProperty("--drag-counter-rotation", `${-app.drag.rotation}deg`);
  app.drag.ghost.style.transform = `rotate(${app.drag.rotation}deg) scale(1.05)`;
  return true;
}

function rotateDraggedCard(delta) {
  return setDraggedCardRotation((app.drag?.rotation || 0) + delta);
}

function moveDrag(event) {
  if (!app.drag || event.pointerId !== app.drag.pointerId) return;
  if (!app.drag.activated) {
    const distance = Math.hypot(event.clientX - app.drag.startClientX, event.clientY - app.drag.startClientY);
    if (distance < 5) return;
    app.drag.activated = true;
    elements.dragRoot.replaceChildren(app.drag.ghost);
    setDragSourceClasses(app.drag, true);
  }
  const point = screenToWorld(event.clientX, event.clientY);
  app.drag.x = point.x - app.drag.offsetX;
  app.drag.y = point.y - app.drag.offsetY;
  if (app.drag.sourceType === "card" && event.altKey) {
    if (!app.drag.rotateGesture) {
      app.drag.rotateGesture = { clientX: event.clientX, rotation: app.drag.rotation };
    }
    const nextRotation = app.drag.rotateGesture.rotation + (event.clientX - app.drag.rotateGesture.clientX) * 0.8;
    setDraggedCardRotation(Math.round(nextRotation / 5) * 5);
  } else if (app.drag.rotateGesture) {
    app.drag.rotateGesture = null;
  }
  const overPublic = pointInside(point, app.state.room.geometry.publicZone);
  app.drag.placeFaceDown = overPublic && (
    app.drag.sourceType === "deck"
      || (app.drag.sourceType === "card" && (
        app.drag.resource.zone === "public" ? app.drag.resource.faceUp === false : event.shiftKey
      ))
  );
  if (app.drag.placeFaceDown) app.drag.ghost.dataset.placement = "face-down";
  else delete app.drag.ghost.dataset.placement;
  app.drag.ghost.style.left = `${app.drag.x}px`;
  app.drag.ghost.style.top = `${app.drag.y}px`;
  updateDropTargets(point);
}

function cancelDrag({ releaseCapture = true } = {}) {
  const drag = app.drag;
  if (!drag) return;
  app.drag = null;
  if (drag.activated) endRemoteDragPreview();
  setDragSourceClasses(drag, false);
  if (releaseCapture) {
    try { drag.sourceNode?.releasePointerCapture?.(drag.pointerId); } catch { /* Pointer already released. */ }
  }
  elements.dragRoot.replaceChildren();
  clearDropTargets();
}

function finishDrag(event) {
  if (!app.drag || event.pointerId !== app.drag.pointerId) return;
  const drag = app.drag;
  const type = drag.sourceType === "stack" ? "card" : drag.sourceType;
  if (!drag.activated) {
    cancelDrag();
    selectResource(type, drag.resource.id);
    return;
  }
  const point = screenToWorld(event.clientX, event.clientY);
  const handTargetId = handTargetAt(point);
  const bag = bagTargetAt(point);
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  const overlay = hit?.closest(".topbar, .side-panel, .library-panel, .aux-panel, .history-panel, .selection-dock, .table-rail, .zoom-controls, .world-overview");
  const rect = elements.viewport.getBoundingClientRect();
  const inside = pointInside({ x: event.clientX, y: event.clientY }, { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  let command = null;
  if (!overlay && (inside || handTargetId)) {
    if (bag) command = { type: "bag-put", bagId: bag.id, resourceType: drag.sourceType, resourceId: drag.resource.id };
    else if (["deck", "card", "stack"].includes(drag.sourceType) && handTargetId) {
      command = drag.sourceType === "deck" ? { type: "draw", deckId: drag.resource.id, ownerId: handTargetId }
        : { type: drag.sourceType === "stack" ? "move-stack" : "move-card", cardId: drag.resource.id, target: "hand", ownerId: handTargetId };
    } else if (pointInside(point, app.state.room.geometry.publicZone)) {
      if (["token", "object", "deck"].includes(drag.sourceType)) command = {
        type: "move-resource", resourceType: drag.sourceType, resourceId: drag.resource.id, x: drag.x, y: drag.y
      };
      else command = {
        type: drag.sourceType === "stack" ? "move-stack" : "move-card", cardId: drag.resource.id,
        target: "public", x: drag.x, y: drag.y, rotation: drag.rotation,
        faceUp: drag.resource.zone === "public" ? drag.resource.faceUp !== false : !(event.shiftKey || drag.placeFaceDown)
      };
    }
  }
  cancelDrag();
  selectResource(type, drag.resource.id);
  if (command) void sendCommand(command);
}

async function applyPreviewCommand(command) {
  if (!window.ParlorPreview) throw new Error("离线试玩核心没有加载成功，请刷新页面。");
  const viewerId = app.state.you.id;
  const receipt = await window.ParlorPreview.applyCommand(app.previewModel, viewerId, command, { withReceipt: true });
  if (app.state.you.id === viewerId) syncPreviewState(viewerId);
  return receipt;
}
async function postRealtimeMessage(message, quiet = false) {
  if (previewMode) return { ok: true };
  if (!app.sessionToken || !endpoint) return null;
  const body = JSON.stringify({ roomCode, sessionToken: app.sessionToken, message });
  if (quiet) {
    void fetch(apiUrl("/api/message"), {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body
    }).catch(() => {});
    return null;
  }
  return fetchJson(apiUrl("/api/message"), {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body
  });
}

async function sendCommand(command, { withReceipt = false } = {}) {
  if (!app.connectionOpen) {
    toast("正在连接牌桌，请稍后再试。");
    return false;
  }
  if (app.pendingCommands.has(command.type)) return false;
  app.pendingCommands.add(command.type);
  if (app.state) renderTools();
  try {
    const viewerId = app.state?.you.id;
    const result = previewMode ? await applyPreviewCommand(command) : await postRealtimeMessage({ type: "command", command });
    if (!result?.ok) throw new Error("未能确认操作结果，请检查桌面后再试。");
    if (!previewMode && result.state?.you.id === viewerId && app.state?.you.id === viewerId && result.state.revision > app.state.revision) {
      app.state = result.state; app.player = result.state.you; renderRoom();
    }
    if (command.type === "undo") toast("已恢复到上一步牌桌状态。 ");
    else if (command.type === "shuffle") toast("这副牌已经洗好。");
    else if (command.type === "shuffle-stack") toast("这个牌堆已经洗好。");
    else if (command.type === "spread-stack") toast("牌堆已展开。 ");
    else if (command.type === "replace-pack") toast("新牌盒已经铺上桌。 ");
    else if (command.type === "tidy-public") toast("公共散牌已经整理。 ");
    else if (command.type === "collect-public") toast("公共牌已回到各自的牌盒。");
    else if (command.type === "deal-each") toast(`已给每位玩家发了 ${command.count} 张牌。`);
    else if (command.type === "cleanup-offline") toast("离线席位已经释放。 ");
    return withReceipt ? result : true;
  } catch (error) {
    toast(error.message || "操作没有成功。", "error");
    if (command.type === "set-turn" && app.state) renderTurn();
    return false;
  } finally {
    app.pendingCommands.delete(command.type);
    if (app.state) renderTools();
  }
}

async function leaveCurrentSeat() {
  if (!app.state || app.state.you.role === "host") return;
  if (previewMode) {
    toast("预览模式不会真的占用席位。 ");
    return;
  }
  const confirmed = window.confirm(
    "确定离开此席位？你的私有手牌会洗回牌叠，已公开的牌会留在桌上；为避免恢复到不存在的席位，房主的撤销链会清空。"
  );
  if (!confirmed || app.pendingCommands.has("leave-seat")) return;

  app.pendingCommands.add("leave-seat");
  renderTools();
  try {
    await postRealtimeMessage({ type: "command", command: { type: "leave-seat" } });
  } catch (error) {
    toast(error.message || "暂时没能离开席位。", "error");
    app.pendingCommands.delete("leave-seat");
    if (app.state) renderTools();
    return;
  }

  app.closingStream = true;
  clearTimeout(app.reconnectTimer);
  app.eventSource?.close();
  app.eventSource = null;
  app.connectionOpen = false;
  clearCursorQueue();
  clearStoredSession();
  app.sessionToken = null;
  app.player = null;
  app.state = null;
  app.localCursor = null;
  app.lastTablePoint = null;
  app.remoteCursors.clear();
  app.remoteDrags.clear();
  app.cardFaceStates.clear();
  app.turnInitialized = false;
  app.lastTurnPlayerId = null;
  app.selection = null;
  app.selectionTransferOpen = false;
  app.pendingCommands.delete("leave-seat");
  elements.displayName.value = "";

  try {
    await probeRoom();
    showJoin();
    toast("已经离开席位，这个名额现在可以给其他朋友。 ");
  } catch (error) {
    showOffline(error.message);
  }
}

async function requestCardFlip(cardId) {
  if (app.pendingFlips.has(cardId)) return;
  app.pendingFlips.add(cardId);
  try {
    await sendCommand({ type: "flip-card", cardId });
  } finally {
    app.pendingFlips.delete(cardId);
  }
}

elements.joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = elements.joinForm.querySelector("button[type='submit']");
  submit.disabled = true;
  elements.joinError.textContent = "";
  try {
    await joinRoom({ displayName: elements.displayName.value });
  } catch (error) {
    elements.joinError.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

elements.startDemo.addEventListener("click", () => {
  const demoUrl = new URL(window.location.href);
  demoUrl.search = "";
  demoUrl.hash = "";
  demoUrl.searchParams.set("preview", "1");
  demoUrl.searchParams.set("pack", elements.demoPack.value || "standard-54");
  window.location.assign(demoUrl.toString());
});
elements.retryRoom.addEventListener("click", () => void initialize());
elements.previewRole.addEventListener("click", switchPreviewRole);
elements.toggleFocus.addEventListener("click", () => setFocusMode(!app.focusMode));
elements.openHelp.addEventListener("click", showHelp);
elements.openTools.addEventListener("click", showTools);
elements.openLibrary.addEventListener("click", toggleLibrary);
elements.openHistory.addEventListener("click", () => {
  if (elements.historyPanel.classList.contains("is-open")) hideHistory();
  else showHistory();
});
elements.quickUndo.addEventListener("click", () => sendCommand({ type: "undo" }));
elements.closeTools.addEventListener("click", () => hideTools());
elements.closeLibrary.addEventListener("click", () => hideLibrary());
elements.closeHistory.addEventListener("click", () => hideHistory());
elements.toolsBackdrop.addEventListener("click", () => hideSidePanels());
elements.helpBackdrop.addEventListener("click", () => hideHelp());
elements.closeHelp.addEventListener("click", () => hideHelp());
elements.startPlaying.addEventListener("click", () => hideHelp());

elements.copyLink.addEventListener("click", async () => {
  const link = app.state?.room.shareUrl || app.summary?.shareUrl;
  if (!link) {
    toast("房主还没有生成邀请链接。", "error");
    return;
  }
  const copied = await copyText(link);
  toast(copied ? previewMode ? "试玩链接已复制；联机请按开房说明操作。" : "邀请链接已复制，可以发给朋友。" : "复制失败，请手动复制浏览器地址。", copied ? "info" : "error");
});

elements.rollDie.addEventListener("click", () => sendCommand({ type: "roll-die" }));
elements.decrementCounter.addEventListener("click", () => sendCommand({ type: "adjust-counter", delta: -1 }));
elements.incrementCounter.addEventListener("click", () => sendCommand({ type: "adjust-counter", delta: 1 }));
elements.turnPlayerSelect.addEventListener("change", () => {
  if (elements.turnPlayerSelect.value) {
    sendCommand({ type: "set-turn", playerId: elements.turnPlayerSelect.value });
  }
});
elements.randomTurn.addEventListener("click", () => sendCommand({ type: "random-turn" }));
elements.nextTurn.addEventListener("click", () => sendCommand({ type: "advance-turn" }));
elements.undoTable.addEventListener("click", () => sendCommand({ type: "undo" }));
elements.drawCard.addEventListener("click", () => sendCommand({ type: "draw", deckId: activeDeck()?.id }));
elements.dealCount.addEventListener("change", renderDealOptions);
elements.dealCards.addEventListener("click", () => {
  const count = Number(elements.dealCount.value);
  if (Number.isInteger(count) && count > 0) sendCommand({ type: "deal-each", count, deckId: activeDeck()?.id });
});
elements.shuffleDeck.addEventListener("click", () => sendCommand({ type: "shuffle", deckId: activeDeck()?.id }));
elements.tidyPublic.addEventListener("click", () => sendCommand({ type: "tidy-public" }));
elements.collectPublic.addEventListener("click", () => {
  const count = app.state?.cards.filter((card) => card.zone === "public").length || 0;
  if (count > 0 && window.confirm(`把桌面的 ${count} 张散牌洗回各自的牌盒？手牌会留在原处。`)) {
    sendCommand({ type: "collect-public" });
  }
});
elements.resetTable.addEventListener("click", () => {
  if (window.confirm("收回所有卡牌并复位计数？每张牌会回到原来的牌盒。房主可以撤销。")) sendCommand({ type: "reset" });
});

elements.leaveSeat.addEventListener("click", () => void leaveCurrentSeat());
elements.cleanupOffline.addEventListener("click", () => {
  const count = app.state?.players.filter((player) => player.role === "guest" && !player.online).length || 0;
  if (count > 0 && window.confirm(`释放 ${count} 个离线席位？这些玩家的私有手牌会洗回牌叠，房主撤销链会清空。`)) {
    sendCommand({ type: "cleanup-offline" });
  }
});

elements.openGuestTest.addEventListener("click", () => {
  const shareUrl = app.state?.room.shareUrl;
  if (!shareUrl) {
    toast("房主还没有生成可用的访客链接。", "error");
    return;
  }
  const guestUrl = new URL(shareUrl);
  guestUrl.searchParams.delete("host");
  guestUrl.searchParams.set("fresh", "1");
  guestUrl.searchParams.set("autojoin", "客人B");
  const link = document.createElement("a");
  link.href = guestUrl.toString();
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.click();
  toast("已打开独立客人测试页；不会覆盖当前房主身份。");
});

elements.turnBanner.addEventListener("click", () => {
  if (elements.turnBanner.dataset.playerId) focusPlayer(elements.turnBanner.dataset.playerId);
});

elements.playerList.addEventListener("click", (event) => {
  const row = event.target.closest(".player-row[data-player-id]");
  if (row) focusPlayer(row.dataset.playerId);
});

elements.mobilePlayerStrip.addEventListener("click", (event) => {
  const player = event.target.closest(".mobile-player[data-player-id]");
  if (player) focusPlayer(player.dataset.playerId);
});

elements.pingLocation.addEventListener("click", pingCurrentLocation);
elements.selectionClose.addEventListener("click", clearSelection);
elements.selectionActions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-selection-action]");
  if (button && !button.disabled) runSelectionAction(button.dataset.selectionAction);
});
elements.selectionSend.addEventListener("click", () => {
  const resource = selectedResource();
  const ownerId = elements.selectionPlayer.value;
  if (!resource || !ownerId) return;
  app.selectionTransferOpen = false;
  if (resource.type === "deck") sendCommand({ type: "draw", deckId: resource.value.id, ownerId });
  else if (resource.type === "card") {
    sendCommand({ type: "move-card", cardId: resource.value.id, target: "hand", ownerId });
  }
});

function bindCardSurface(surface) {
  surface.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("[data-card-action]")) return;
    const node = event.target.closest(".playing-card[data-card-id]");
    const card = app.state?.cards.find((item) => item.id === node?.dataset.cardId);
    if (card && surface === elements.handCards && event.pointerType === "touch") {
      if (event.isPrimary === false || app.handTouch || app.drag || app.touchNavigation || app.tableTouches.size) { cancelHandInteraction(); return; }
      app.handTouch = { pointerId: event.pointerId, cardId: card.id, clientX: event.clientX, clientY: event.clientY, scrolling: false };
      return;
    }
    if (card) startDrag(event, "card", card);
  });
  surface.addEventListener("click", (event) => {
    if (ignoreTableActivation(event)) return;
    const button = event.target.closest("[data-card-action='flip']");
    if (!button) return;
    const card = app.state?.cards.find((item) => item.id === button.closest("[data-card-id]")?.dataset.cardId);
    if (card?.canControl && card.zone === "public") void requestCardFlip(card.id);
  });
  surface.addEventListener("dblclick", (event) => {
    if (ignoreTableActivation(event)) return;
    if (event.target.closest("[data-card-action]")) return;
    const node = event.target.closest(".playing-card[data-card-id]");
    const card = app.state?.cards.find((item) => item.id === node?.dataset.cardId);
    if (!card) return;
    if (card.zone === "public" && card.canControl && visibleStackForCard(card.id).length < 2) void requestCardFlip(card.id);
    else { selectResource("card", card.id); workspace.handleAction("inspect", selectedResource()); }
  });
}
bindCardSurface(elements.cardsRoot);
bindCardSurface(elements.handCards);

elements.tokenRoot.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const node = event.target.closest(".table-token[data-token-id]");
  const token = app.state?.tokens?.find((item) => item.id === node?.dataset.tokenId);
  if (token) startDrag(event, "token", token);
});

elements.objectsRoot.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest("button")) return;
  const node = event.target.closest(".world-object[data-object-id]");
  const object = app.state?.objects?.find((item) => item.id === node?.dataset.objectId);
  if (object) startDrag(event, "object", object);
});
elements.objectsRoot.addEventListener("click", (event) => {
  if (ignoreTableActivation(event)) return;
  const button = event.target.closest("[data-object-action]");
  const node = button?.closest("[data-object-id]");
  if (!node) return;
  void sendCommand({ type: "adjust-resource", resourceType: "object", resourceId: node.dataset.objectId, delta: button.dataset.objectAction === "minus" ? -1 : 1 });
});
elements.objectsRoot.addEventListener("dblclick", (event) => {
  if (ignoreTableActivation(event)) return;
  if (event.target.closest("button")) return;
  const node = event.target.closest(".world-object[data-object-id]");
  const object = app.state?.objects?.find((item) => item.id === node?.dataset.objectId);
  if (!object) return;
  selectResource("object", object.id);
  workspace.handleAction(object.kind === "die" ? "roll-object" : object.kind === "bag" ? "bag-draw" : "edit-object", selectedResource());
});

elements.deckRoot.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest("[data-deck-action]")) return;
  const node = event.target.closest(".deck-stack");
  const deck = app.state?.decks?.find((item) => item.id === node?.dataset.deckId);
  if (deck) startDrag(event, "deck", deck);
});
elements.deckRoot.addEventListener("click", (event) => {
  if (ignoreTableActivation(event)) return;
  const node = event.target.closest("[data-deck-id]");
  if (node && event.target.closest("[data-deck-action]")) selectResource("deck", node.dataset.deckId);
});
elements.deckRoot.addEventListener("dblclick", (event) => {
  if (ignoreTableActivation(event)) return;
  if (event.target.closest("[data-deck-action]")) return;
  const node = event.target.closest(".deck-stack");
  if (node) void sendCommand({ type: "draw", deckId: node.dataset.deckId });
});

for (const surface of [elements.cardsRoot, elements.handCards, elements.tokenRoot, elements.deckRoot, elements.objectsRoot]) {
  const selectFromTarget = (target) => {
    const node = target.closest("[data-card-id], [data-deck-id], [data-token-id], [data-object-id]");
    if (!node) return false;
    for (const type of ["card", "deck", "token", "object"]) {
      if (node.dataset[`${type}Id`]) { selectResource(type, node.dataset[`${type}Id`]); return true; }
    }
    return false;
  };
  surface.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.target.closest("button")) return;
    if (selectFromTarget(event.target)) { event.preventDefault(); event.stopPropagation(); }
  });
  surface.addEventListener("contextmenu", (event) => {
    if (ignoreTableActivation(event)) { event.preventDefault(); return; }
    if (selectFromTarget(event.target)) event.preventDefault();
  });
}

elements.viewport.addEventListener("dblclick", (event) => {
  if (ignoreTableActivation(event)) return;
  if (app.drag || app.pan || event.target.closest(".playing-card, .deck-stack, .table-token, .world-object")) return;
  event.preventDefault();
  void pingAt(screenToWorld(event.clientX, event.clientY));
});

elements.viewport.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !app.state) return;
  if (event.pointerType === "touch") {
    app.tableTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (app.tableTouches.size > 1 || app.touchNavigation) {
      event.preventDefault();
      beginTouchNavigation();
      return;
    }
  }
  if (app.drag || app.pan || event.target.closest(".playing-card, .deck-stack, .table-token, .world-object")) return;
  clearSelection();
  app.pan = {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    cameraX: app.camera.x,
    cameraY: app.camera.y
  };
  app.cameraTouched = true;
  elements.viewport.classList.add("is-panning");
  elements.viewport.setPointerCapture?.(event.pointerId);
});

window.addEventListener("pointermove", (event) => {
  if (app.tableTouches.has(event.pointerId)) app.tableTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (app.touchNavigation) { event.preventDefault(); moveTouchNavigation(); return; }
  if (moveHandTouch(event)) return;
  if (app.drag) moveDrag(event);
  if (app.pan && event.pointerId === app.pan.pointerId) {
    app.camera.x = app.pan.cameraX + event.clientX - app.pan.clientX;
    app.camera.y = app.pan.cameraY + event.clientY - app.pan.clientY;
    applyCamera();
  }

  const viewportRect = elements.viewport.getBoundingClientRect();
  const inside = event.clientX >= viewportRect.left
    && event.clientX <= viewportRect.right
    && event.clientY >= viewportRect.top
    && event.clientY <= viewportRect.bottom;
  const overStageControl = event.target.closest?.(".zoom-controls, .turn-banner, .reconnect-banner, .selection-dock");
  if (inside && !overStageControl && app.state) {
    const point = screenToWorld(event.clientX, event.clientY);
    app.lastTablePoint = point;
    app.localCursor = {
      playerId: app.state.you.id,
      name: app.state.you.name,
      color: app.state.you.color,
      x: point.x,
      y: point.y,
      visible: true
    };
    renderCursors();
    sendCursor(point);
  } else if (overStageControl && app.localCursor?.visible && !app.drag && !app.pan) {
    app.localCursor.visible = false;
    renderCursors();
  }
});

window.addEventListener("pointerup", (event) => {
  if (endTableTouch(event.pointerId) || endHandTouch(event)) return;
  if (app.drag) finishDrag(event);
  if (app.pan && event.pointerId === app.pan.pointerId) {
    cancelPan();
  }
});

window.addEventListener("pointercancel", (event) => {
  if (endTableTouch(event.pointerId)) return;
  if (app.handTouch?.pointerId === event.pointerId) app.handTouch = null;
  if (app.drag && event.pointerId === app.drag.pointerId) {
    cancelDrag();
  }
  if (app.pan && event.pointerId === app.pan.pointerId) {
    cancelPan();
  }
});

window.addEventListener("lostpointercapture", (event) => {
  if (event.target === elements.viewport && app.tableTouches.has(event.pointerId)) {
    cancelTableTouches();
    cancelPan();
  }
  if (app.drag?.pointerId === event.pointerId && event.target === app.drag.sourceNode) {
    app.tableTouches.delete(event.pointerId);
    cancelDrag();
  }
  if (app.pan?.pointerId === event.pointerId) cancelPan();
});

elements.viewport.addEventListener("pointerleave", () => {
  if (!app.drag && !app.pan && app.localCursor) {
    app.localCursor.visible = false;
    renderCursors();
    clearCursorQueue();
    if (app.connectionOpen) postRealtimeMessage({ type: "cursor-leave" }, true);
  }
});

elements.viewport.addEventListener("wheel", (event) => {
  event.preventDefault();
  if (app.drag) {
    if (app.drag.sourceType === "card") {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      app.drag.wheelRotation += delta;
      if (Math.abs(app.drag.wheelRotation) >= 12) {
        rotateDraggedCard(app.drag.wheelRotation > 0 ? 15 : -15);
        app.drag.wheelRotation = 0;
      }
    }
    return;
  }
  const point = viewportPoint(event.clientX, event.clientY);
  const multiplier = Math.exp(-event.deltaY * 0.0011);
  setZoom(app.camera.scale * multiplier, point.x, point.y);
}, { passive: false });

elements.zoomIn.addEventListener("click", () => setZoom(app.camera.scale * 1.16));
elements.zoomOut.addEventListener("click", () => setZoom(app.camera.scale / 1.16));
elements.resetCamera.addEventListener("click", fitAll);

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".selection-more")) elements.selectionActions.querySelector(".selection-more")?.removeAttribute("open");
  if (!event.target.closest(".world-overview, #toggle-minimap")) workspace?.hideMinimap();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    const libraryCancelled = workspace?.cancelLibraryDrag();
    const handCancelled = cancelHandInteraction();
    const touchCancelled = cancelTableTouches();
    if (app.drag || app.pan || libraryCancelled || handCancelled || touchCancelled) { event.preventDefault(); cancelDrag(); cancelPan(); return; }
  }
  if (document.querySelector("dialog[open]")) return;
  const openMenu = elements.selectionActions.querySelector("details[open]");
  if (event.key === "Escape" && openMenu) {
    event.preventDefault(); openMenu.removeAttribute("open"); openMenu.querySelector("summary")?.focus(); return;
  }
  if (app.state && elements.helpPanel.classList.contains("is-hidden") && !elements.room.classList.contains("is-hidden") && workspace?.keydown(event)) return;
  const helpOpen = !elements.helpPanel.classList.contains("is-hidden");
  if (event.key === "Escape" && helpOpen) {
    hideHelp();
    return;
  }
  const toolsOpen = elements.toolsPanel.classList.contains("is-open");
  if (event.key === "Escape" && toolsOpen) {
    hideTools();
    return;
  }
  const libraryOpen = elements.libraryPanel.classList.contains("is-open");
  if (event.key === "Escape" && libraryOpen) {
    hideLibrary();
    return;
  }
  const historyOpen = elements.historyPanel.classList.contains("is-open");
  if (event.key === "Escape" && historyOpen) {
    hideHistory();
    return;
  }
  if (event.key === "Escape" && app.selection) {
    clearSelection();
    return;
  }

  if (event.key === "Tab" && (helpOpen || toolsOpen || (libraryOpen && window.innerWidth < 760))) {
    const container = helpOpen
      ? elements.helpPanel.querySelector(".help-sheet__panel")
      : toolsOpen
        ? elements.toolsPanel
        : elements.libraryPanel;
    const focusable = [...container.querySelectorAll(
      "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex='-1'])"
    )].filter((node) => node.getClientRects().length > 0);
    if (focusable.length > 0) {
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable) return;
  if (event.key === "?") {
    if (helpOpen) hideHelp();
    else showHelp();
    return;
  }
  if (helpOpen) return;
  if (!app.state || elements.room.classList.contains("is-hidden")) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  const key = event.key.toLowerCase();
  if (event.repeat && ["d", "h", "p", "r", "u"].includes(key)) return;
  if (app.drag?.sourceType === "card" && (key === "q" || key === "e")) {
    event.preventDefault();
    rotateDraggedCard(key === "q" ? -15 : 15);
  } else if ((key === "q" || key === "e") && selectedResource()?.type === "card") {
    const card = selectedResource().value;
    if (card.zone === "public" && visibleStackForCard(card.id).length < 2) {
      event.preventDefault();
      runSelectionAction(key === "q" ? "rotate-left" : "rotate-right");
    }
  } else if (key === "f") {
    event.preventDefault();
    fitAll();
  } else if (key === "h") {
    event.preventDefault();
    setFocusMode(!app.focusMode);
  } else if (key === "r" && !elements.rollDie.disabled) {
    event.preventDefault();
    sendCommand({ type: "roll-die" });
  } else if (key === "d" && !elements.drawCard.disabled) {
    event.preventDefault();
    sendCommand({ type: "draw", deckId: activeDeck()?.id });
  } else if (key === "p" && !elements.pingLocation.disabled) {
    event.preventDefault();
    pingCurrentLocation();
  } else if (key === "u" && !elements.undoTable.disabled) {
    event.preventDefault();
    sendCommand({ type: "undo" });
  }
});

window.addEventListener("resize", () => {
  if (!app.cameraTouched) fitCamera();
  else workspace?.drawMap();
  const libraryOpen = elements.libraryPanel.classList.contains("is-open");
  elements.libraryPanel.setAttribute("aria-modal", String(window.innerWidth < 760));
  elements.toolsBackdrop.classList.toggle("is-hidden", !elements.toolsPanel.classList.contains("is-open") && !(libraryOpen && window.innerWidth < 760));
});

window.addEventListener("beforeunload", () => {
  app.closingStream = true;
  clearCursorQueue();
  app.eventSource?.close();
});

window.addEventListener("blur", () => {
  cancelHandInteraction();
  cancelTableTouches();
  cancelDrag();
  cancelPan();
  if (app.localCursor) { app.localCursor.visible = false; renderCursors(); }
});

window.setInterval(() => {
  const now = Date.now();
  const cursorCutoff = now - 5000;
  const dragCutoff = now - 1800;
  let cursorsChanged = false;
  let dragsChanged = false;
  for (const [playerId, cursor] of app.remoteCursors) {
    if (cursor.seenAt < cursorCutoff) {
      app.remoteCursors.delete(playerId);
      cursorsChanged = true;
    }
  }
  for (const [playerId, drag] of app.remoteDrags) {
    if (drag.seenAt < dragCutoff) {
      app.remoteDrags.delete(playerId);
      dragsChanged = true;
    }
  }
  if (cursorsChanged) renderCursors();
  if (dragsChanged) renderRemoteDrags();
}, 1000);

for (const control of document.querySelectorAll("[data-tooltip]")) {
  if (!control.title) control.title = control.dataset.tooltip;
}
workspace = window.ParlorWorkspace.create({
  app, elements, previewMode, toast, sendCommand, screenToWorld,
  fitCamera, fitAll, focusWorldPoint, applyCamera, makeCardNode,
  makeSelectionAction, selectedResource, selectResource, clearSelection,
  showLibrary, toggleLibrary, hideSidePanels, cancelHandInteraction,
  fetchScene: async (name) => {
    const url = new URL(apiUrl("/api/save"));
    url.searchParams.set("room", roomCode); url.searchParams.set("session", app.sessionToken); url.searchParams.set("name", name);
    return fetchJson(url.toString());
  }
});
syncToolDrawer();
void initialize();
