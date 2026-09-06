import { EventEmitter } from "node:events";
import { createRoomTransport } from "../../src/room-transport.mjs";

// Runs the production protocol without a TCP listener. Real sockets are covered
// by the separately permissioned test:network suite.
export function createRoomLink(room, options = {}) {
  return createClientLink(createRoomTransport(room, options));
}

function createClientLink(transport) {
  const sources = new Set(), commands = [], events = [], responses = [];
  const link = { online: true, dropNextReceipt: false, commands, events, responses, transport,
    createPeer: () => createClientLink(transport) };
  const request = (url, options = {}) => {
    const parsed = new URL(url), req = new EventEmitter();
    Object.assign(req, { url: `${parsed.pathname}${parsed.search}`, method: options.method || "GET", headers: options.headers || {},
      async *[Symbol.asyncIterator]() { if (options.body) yield Buffer.from(options.body); } });
    return req;
  };
  link.fetch = async (url, options = {}) => {
    if (!link.online) throw new TypeError("Offline");
    const req = request(url, options);
    let body = "", status = 200;
    const res = { writeHead(code) { status = code; }, end(value = "") { body += value; } };
    const message = options.body ? JSON.parse(options.body).message : null;
    if (message?.type === "command") commands.push(structuredClone(message));
    await transport.handle(req, res);
    responses.push({ path: new URL(url).pathname, status, payload: JSON.parse(body) });
    if (message?.type === "command" && link.dropNextReceipt) { link.dropNextReceipt = false; throw new TypeError("Receipt lost"); }
    return { ok: status < 400, status, json: async () => JSON.parse(body) };
  };
  link.EventSource = class EventSource {
    static OPEN = 1;
    constructor(url) {
      this.listeners = new Map(); this.readyState = 0; sources.add(this);
      this.req = request(url);
      this.res = { destroyed: false,
        writeHead: () => { this.readyState = 1; this.emit("open", {}); },
        write: (chunk) => {
          for (const part of chunk.split("\n\n")) if (part.startsWith("data: ")) {
            events.push(JSON.parse(part.slice(6))); this.emit("message", { data: part.slice(6) });
          }
          return true;
        },
        end: () => { this.readyState = 2; }, flushHeaders() {} };
      queueMicrotask(() => {
        if (this.closed) return;
        if (!link.online) this.emit("error", {});
        else void transport.handle(this.req, this.res);
      });
    }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
    emit(type, event) { if (!this.closed) for (const callback of this.listeners.get(type) || []) callback(event); }
    disconnect() { this.res.destroyed = true; this.req.emit("close"); this.readyState = 0; this.emit("error", {}); }
    close() { this.closed = true; this.res.destroyed = true; this.req.emit("close"); this.readyState = 2; sources.delete(this); }
  };
  link.disconnect = () => { link.online = false; for (const source of sources) source.disconnect(); };
  return link;
}
