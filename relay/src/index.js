// YTM Together relay — a tiny Cloudflare Worker that passes sync messages
// between the people in a room. It never sees or streams any audio.
//
// Each room code maps to one Durable Object. The first person in a room is the
// host; if the host leaves, the longest-connected guest is promoted.

const MAX_PEOPLE = 8;
const MAX_MESSAGE = 8192;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("YTM Together relay is running.", {
        headers: { "content-type": "text/plain" },
      });
    }

    const match = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{3,32})$/);
    if (!match) return new Response("Not found", { status: 404 });

    // Optional shared secret so only people with the key can use your relay.
    if (env.ROOM_KEY && url.searchParams.get("key") !== env.ROOM_KEY) {
      return new Response("Forbidden", { status: 403 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }

    const id = env.ROOMS.idFromName(match[1].toUpperCase());
    return env.ROOMS.get(id).fetch(request);
  },
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  // ---- helpers -------------------------------------------------------------

  info(ws) {
    try {
      return ws.deserializeAttachment() || {};
    } catch {
      return {};
    }
  }

  setInfo(ws, info) {
    ws.serializeAttachment(info);
  }

  /** Sockets of people still in the room (excluding ones that are leaving). */
  live() {
    return this.ctx.getWebSockets().filter((ws) => {
      const i = this.info(ws);
      return i.id && !i.left;
    });
  }

  send(ws, msg) {
    try {
      ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
    } catch {
      /* socket already gone */
    }
  }

  broadcastPeers() {
    const people = this.live().map((ws) => this.info(ws));
    const host = people.find((p) => p.host);
    const msg = JSON.stringify({
      t: "peers",
      host: host ? host.id : null,
      peers: people.map((p) => ({ id: p.id, name: p.name })),
    });
    for (const ws of this.live()) this.send(ws, msg);
  }

  ensureHost() {
    const sockets = this.live();
    if (!sockets.length) return;
    if (sockets.some((ws) => this.info(ws).host)) return;
    sockets.sort((a, b) => this.info(a).joined - this.info(b).joined);
    const first = this.info(sockets[0]);
    first.host = true;
    this.setInfo(sockets[0], first);
  }

  // ---- connection ----------------------------------------------------------

  async fetch(request) {
    if (this.live().length >= MAX_PEOPLE) {
      return new Response("Room is full", { status: 429 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const isHost = !this.live().some((ws) => this.info(ws).host);

    // acceptWebSocket lets the room sleep between messages (cheap on the free plan).
    this.ctx.acceptWebSocket(server);
    this.setInfo(server, { id, name: "Guest", host: isHost, joined: Date.now() });

    this.send(server, { t: "welcome", you: id });
    this.broadcastPeers();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE) return;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    const me = this.info(ws);
    if (!me.id || me.left) return;

    switch (msg.t) {
      case "ping":
        // Clock sync: echo the client's time with ours.
        this.send(ws, { t: "pong", c: msg.c, s: Date.now() });
        return;

      case "hello":
        me.name = String(msg.name || "Guest").slice(0, 32) || "Guest";
        this.setInfo(ws, me);
        this.broadcastPeers();
        return;

      case "claimHost":
        for (const other of this.live()) {
          const i = this.info(other);
          i.host = i.id === me.id;
          this.setInfo(other, i);
        }
        this.broadcastPeers();
        return;

      case "state":
        if (!me.host) return; // only the host decides what's playing
        break;

      case "cmd":
      case "ready":
      case "stall":
        break; // guest → host messages

      default:
        return;
    }

    msg.from = me.id;
    const out = JSON.stringify(msg);
    for (const other of this.live()) {
      if (other === ws) continue;
      // State goes to everyone; guest messages only go to the host.
      if (msg.t === "state" || this.info(other).host) this.send(other, out);
    }
  }

  leave(ws) {
    const me = this.info(ws);
    if (!me.id || me.left) return;
    me.left = true;
    me.host = false;
    this.setInfo(ws, me);
    this.ensureHost();
    this.broadcastPeers();
  }

  async webSocketClose(ws) {
    this.leave(ws);
    try {
      ws.close(1000, "bye");
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws) {
    this.leave(ws);
  }
}
