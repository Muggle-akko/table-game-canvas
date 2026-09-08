import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

// An in-memory DOM double for production event wiring. It has no layout engine,
// networking, or browser process; these tests do not replace visual browser QA.
export async function loadClient({ width = 1440, height = 900, indexedDB, storage = new Map(), url = "https://table.example/?preview=1", fetch: fetchImpl, EventSource, IntersectionObserver } = {}) {
  let document, context;
  const listeners = new Map();
  let timerId = 0, timerClock = 0;
  const timers = new Map();
  const style = () => ({ setProperty(key, value) { this[key] = value; }, removeProperty(key) { delete this[key]; } });
  const toData = (key) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const split = (selector, delimiter) => {
    let bracket = 0, paren = 0, quote = "", value = "";
    const parts = [];
    for (const char of selector) {
      if (quote) { value += char; if (char === quote) quote = ""; continue; }
      if (char === '"' || char === "'") { quote = char; value += char; continue; }
      if (char === "[") bracket++; if (char === "]") bracket--;
      if (char === "(") paren++; if (char === ")") paren--;
      if (char === delimiter && !bracket && !paren) { if (value.trim()) parts.push(value.trim()); value = ""; }
      else value += char;
    }
    if (value.trim()) parts.push(value.trim()); return parts;
  };
  function simple(node, selector) {
    if (!node || node.tagName === "#TEXT") return false;
    const not = [...selector.matchAll(/:not\(([^)]+)\)/g)].map((match) => match[1]);
    if (not.some((part) => simple(node, part))) return false;
    selector = selector.replace(/:not\([^)]+\)/g, "");
    if (selector.includes(":disabled") && !node.disabled) return false;
    selector = selector.replace(/:disabled/g, "");
    for (const match of selector.matchAll(/\[([^\]=]+)(?:=['"]?([^'"\]]*)['"]?)?\]/g)) {
      if (!node.hasAttribute(match[1])) return false;
      if (match[2] !== undefined && node.getAttribute(match[1]) !== match[2]) return false;
    }
    selector = selector.replace(/\[[^\]]+\]/g, "");
    const id = selector.match(/#([\w-]+)/)?.[1]; if (id && node.id !== id) return false;
    for (const match of selector.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(match[1])) return false;
    const tag = selector.match(/^[\w-]+/)?.[0];
    return !tag || node.tagName === tag.toUpperCase();
  }
  function matches(node, selector) {
    return split(selector, ",").some((part) => {
      const chain = split(part, " ");
      if (!simple(node, chain.pop())) return false;
      let parent = node.parentElement;
      while (chain.length) {
        const target = chain.pop();
        while (parent && !simple(parent, target)) parent = parent.parentElement;
        if (!parent) return false;
        parent = parent.parentElement;
      }
      return true;
    });
  }
  class Element {
    constructor(tag = "div") {
      this.tagName = tag.toUpperCase(); this.attributes = new Map(); this.childNodes = []; this.parentElement = null;
      this.style = style(); this.events = new Map(); this.captureEvents = new Map(); this.disabled = false; this._value = undefined; this._text = "";
      this.scrollTop = 0; this.scrollLeft = 0; this.scrollHeight = 200; this.clientHeight = 200; this.files = []; this.rect = null;
      this.dataset = new Proxy({}, {
        get: (_, key) => this.getAttribute(`data-${toData(key)}`) ?? undefined,
        set: (_, key, value) => { this.setAttribute(`data-${toData(key)}`, value); return true; },
        deleteProperty: (_, key) => { this.removeAttribute(`data-${toData(key)}`); return true; }
      });
      this.classList = {
        contains: (name) => this.className.split(/\s+/).includes(name),
        add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
        toggle: (name, force) => { const enabled = force ?? !this.classList.contains(name); this.classList[enabled ? "add" : "remove"](name); return enabled; }
      };
    }
    get id() { return this.getAttribute("id"); }
    get className() { return this.getAttribute("class") || ""; }
    set className(value) { this.setAttribute("class", value); }
    get children() { return this.childNodes.filter((node) => node.tagName !== "#TEXT"); }
    get firstElementChild() { return this.children[0] || null; }
    get isConnected() { return this === document || Boolean(this.parentElement?.isConnected); }
    get textContent() { return this._text + this.childNodes.map((node) => node.textContent).join(""); }
    set textContent(value) { this.replaceChildren(); this._text = String(value ?? ""); }
    get value() { return this._value ?? this.getAttribute("value") ?? (this.tagName === "SELECT" ? this.children[0]?.value || "" : ""); }
    set value(value) { this._value = String(value); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === "disabled") this.disabled = true; }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); if (name === "disabled") this.disabled = false; }
    append(...nodes) {
      for (let node of nodes) {
        if (typeof node !== "object") { const text = new Element("#text"); text._text = String(node); node = text; }
        node.remove(); node.parentElement = this; this.childNodes.push(node);
      }
    }
    prepend(...nodes) { const previous = [...this.childNodes]; this.replaceChildren(...nodes, ...previous); }
    insertBefore(node, before) {
      if (!before) { this.append(node); return node; }
      if (node === before) return node;
      if (before.parentElement !== this) throw new Error("Reference node is not a child");
      node.remove(); node.parentElement = this;
      this.childNodes.splice(this.childNodes.indexOf(before), 0, node);
      return node;
    }
    replaceChildren(...nodes) { for (const child of this.childNodes) child.parentElement = null; this.childNodes = []; this._text = ""; if (this.tagName === "SELECT") this._value = undefined; this.append(...nodes); }
    replaceWith(...nodes) {
      if (!this.parentElement) return;
      const parent = this.parentElement, position = parent.childNodes.indexOf(this);
      for (const node of nodes) { node.remove(); node.parentElement = parent; }
      parent.childNodes.splice(position, 1, ...nodes); this.parentElement = null;
    }
    remove() { if (this.parentElement) this.parentElement.childNodes.splice(this.parentElement.childNodes.indexOf(this), 1); this.parentElement = null; }
    contains(node) { return node === this || this.childNodes.some((child) => child.contains(node)); }
    matches(selector) { return matches(this, selector); }
    closest(selector) { let node = this; while (node) { if (matches(node, selector)) return node; node = node.parentElement; } return null; }
    querySelectorAll(selector) { const found = []; const visit = (node) => { for (const child of node.children) { if (matches(child, selector)) found.push(child); visit(child); } }; visit(this); return found; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, callback, options) {
      const events = options === true || options?.capture ? this.captureEvents : this.events;
      if (!events.has(type)) events.set(type, []); events.get(type).push(callback);
    }
    getBoundingClientRect() {
      const value = this.rect || { left: 0, top: 0, width: Number.parseFloat(this.style.width) || 94, height: Number.parseFloat(this.style.height) || 138 };
      return { ...value, x: value.left, y: value.top, right: value.left + value.width, bottom: value.top + value.height };
    }
    getClientRects() { return this.closest(".is-hidden") ? [] : [this.getBoundingClientRect()]; }
    getContext() { return { clearRect() {}, fillRect(...numbers) { if (!numbers.every(Number.isFinite)) throw new Error("Invalid minimap rectangle"); }, strokeRect(...numbers) { if (!numbers.every(Number.isFinite)) throw new Error("Invalid viewport rectangle"); } }; }
    focus() { document.activeElement = this; }
    setPointerCapture() {} releasePointerCapture() {}
    click() { return dispatch(this, "click"); }
    select() { this.focus(); }
    showModal() { this.setAttribute("open", ""); }
    close() { this.removeAttribute("open"); }
  }
  class Input extends Element {} class Textarea extends Element {} class Select extends Element {}
  const make = (tag) => new (tag === "input" ? Input : tag === "textarea" ? Textarea : tag === "select" ? Select : Element)(tag);
  document = new Element("document");
  document.createElement = make; document.createElementNS = (_, tag) => make(tag);
  document.createTextNode = (text) => { const node = new Element("#text"); node._text = text; return node; };
  document.getElementById = (id) => document.querySelector(`#${id}`);
  document.elementFromPoint = () => document.hitTarget || document.getElementById("viewport");
  const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
  const parents = [document];
  for (const match of html.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?[\w-]+[^>]*>|[^<]+/g)) {
    const token = match[0]; if (token.startsWith("<!")) continue;
    if (token.startsWith("</")) { if (parents.length > 1) parents.pop(); continue; }
    if (!token.startsWith("<")) { parents.at(-1).append(document.createTextNode(token)); continue; }
    const tag = token.match(/^<([\w-]+)/)[1].toLowerCase(), node = make(tag);
    const attributes = token.slice(tag.length + 1, -1);
    for (const attribute of attributes.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) node.setAttribute(attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    if (tag === "canvas") { node.width = Number(node.getAttribute("width")); node.height = Number(node.getAttribute("height")); }
    parents.at(-1).append(node);
    if (!["meta", "link", "input", "br", "img", "hr"].includes(tag) && !token.endsWith("/>")) parents.push(node);
  }
  document.body = document.querySelector("body"); document.activeElement = document.body;
  document.getElementById("viewport").rect = { left: 0, top: 58, width, height: height - 58 };
  document.getElementById("open-hand").rect = { left: width / 2 - 60, top: height - 88, width: 120, height: 40 };
  document.getElementById("hand-drawer").rect = { left: width / 2 - 340, top: height - 300, width: 680, height: 215 };
  const storageApi = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  const location = new URL(url); location.assign = (value) => { location.href = value; };
  const globals = {
    document, URL, URLSearchParams, Blob, AbortController, EventSource, IntersectionObserver, crypto: webcrypto, structuredClone, console, indexedDB,
    HTMLElement: Element, HTMLInputElement: Input, HTMLTextAreaElement: Textarea, HTMLSelectElement: Select,
    innerWidth: width, innerHeight: height, location, localStorage: storageApi, sessionStorage: storageApi,
    performance,
    setTimeout: (callback, delay = 0) => { const id = ++timerId; timers.set(id, { callback, at: timerClock + delay }); return id; },
    clearTimeout: (id) => timers.delete(id), setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: (callback) => { callback(); return 1; },
    addEventListener: (type, callback) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); },
    fetch: fetchImpl || (() => { throw new Error("The offline client must not use the network"); }),
    navigator: { clipboard: { writeText: async () => {} } }, confirm: () => true, history: { replaceState(_state, _title, value) { location.href = String(value); } }
  };
  context = vm.createContext(globals); context.window = context;
  for (const match of html.matchAll(/<script\s+defer\s+src="\.\/([^"]+)"/g)) {
    const file = match[1];
    new vm.Script(await readFile(new URL(`../../public/${file}`, import.meta.url), "utf8"), { filename: file }).runInContext(context);
  }
  vm.runInContext("globalThis.client = { app, elements, workspace, recovery, previewRecovery, syncPreviewState, switchPreviewRole, selectResource, selectedResource, visibleStackForCard, activeDeck, runSelectionAction, sendCommand, fitAll, fitCamera, cancelDrag, nextOpenPublicCardPoint };", context);
  async function settle() { for (let index = 0; index < 40; index++) await Promise.resolve(); }
  async function dispatch(target, type, options = {}) {
    let stopped = false;
    const event = { target, type, button: 0, pointerId: 1, pointerType: "mouse", clientX: 0, clientY: 0, key: "", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { stopped = true; }, ...options };
    const ancestors = []; for (let node = target; node; node = node.parentElement) ancestors.unshift(node);
    for (const node of ancestors) {
      if (stopped) break;
      for (const callback of node.captureEvents.get(type) || []) { event.currentTarget = node; await callback(event); }
    }
    let node = target;
    while (node && !stopped) { for (const callback of node.events.get(type) || []) { event.currentTarget = node; await callback(event); } node = node.parentElement; }
    if (!stopped) for (const callback of listeners.get(type) || []) { event.currentTarget = context; await callback(event); }
    await settle(); return event;
  }
  await settle();
  async function advanceTimers(ms) {
    const until = timerClock + ms;
    for (let count = 0; count < 1000; count++) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; timerClock = timer.at; timers.delete(id); timer.callback(); await settle();
    }
    timerClock = until;
  }
  return { ...context.client, context, document, dispatch, settle, advanceTimers, $: (id) => document.getElementById(id), vm: (source) => vm.runInContext(source, context) };
}
