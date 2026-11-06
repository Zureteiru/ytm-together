// Background page: owns the connection to the relay, keeps the clock in sync,
// and passes messages between the relay, the YouTube Music tab and the popup.
// It runs persistently and isn't throttled like a background tab.
"use strict";

const SC = globalThis.SyncCore;
const DEFAULTS = { relayUrl: "", key: "", name: "", delayMs: 0 };

let cfg = { ...DEFAULTS };
let room = null; // room code we want to be in
let ws = null;
let wsState = "idle"; // idle | connecting | connected | reconnecting | error
let lastError = "";
let myId = null;
let hostId = null;
let peers = [];
let offset = 0; // serverTime ≈ Date.now() + offset
let samples = [];
let pingTimer = null;
let reconnectTimer = null;
let backoff = 1000;

let contentPort = null; // the active YouTube Music tab
let contentStatus = {};
let tickTimer = null;

// ---- startup ---------------------------------------------------------------

browser.storage.local.get(["cfg", "room"]).then((s) => {
  cfg = { ...DEFAULTS, ...(s.cfg || {}) };
  room = s.room || null;
  if (room) connect();
});

// ---- relay connection --------------------------------------------------------

function relayUrl() {
  let base = (cfg.relayUrl || "").trim().replace(/\/+$/, "");
  if (!base) return null;
  if (!/^[a-z]+:\/\//i.test(base)) base = "https://" + base;
  base = base.replace(/^http(s?):/i, "ws$1:");
  const q = cfg.key ? `?key=${encodeURIComponent(cfg.key)}` : "";
  return `${base}/room/${encodeURIComponent(room)}${q}`;
}

function connect() {
  clearTimeout(reconnectTimer);
  closeSocket();
  const url = relayUrl();
  if (!room) return;
  if (!url) {
    wsState = "error";
    lastError = "Set your relay URL in Settings first.";
    return;
  }

  wsState = wsState === "connected" || wsState === "reconnecting" ? "reconnecting" : "connecting";
  lastError = "";
  let opened = false;

  try {
    ws = new WebSocket(url);
  } catch (e) {
    wsState = "error";
    lastError = "Invalid relay URL.";
    return;
  }

  const sock = ws;
  sock.onopen = () => {
    if (sock !== ws) return;
    opened = true;
    wsState = "connected";
    backoff = 1000;
    sendRelay({ t: "hello", name: cfg.name || "Someone", ver: 1 });
    startClockSync();
  };

  sock.onmessage = (ev) => {
    if (sock !== ws) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleRelay(msg);
  };

  sock.onclose = (ev) => {
    if (sock !== ws) return;
    ws = null;
    stopClockSync();
    myId = null;
    hostId = null;
    peers = [];
    toContent({ t: "peers", you: null, host: null, peers: [] });
    if (!room) {
      wsState = "idle";
      return;
    }
    if (!opened && (ev.code === 1006 || ev.code === 1002)) {
      lastError = "Couldn't reach the relay (check the URL and access key).";
    }
    wsState = "reconnecting";
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  };

  sock.onerror = () => {
    /* onclose follows and handles reconnecting */
  };
}

function closeSocket() {
  if (ws) {
    const s = ws;
    ws = null;
    try {
      s.close(1000, "leaving");
    } catch {
      /* ignore */
    }
  }
  stopClockSync();
}

function sendRelay(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function handleRelay(msg) {
  switch (msg.t) {
    case "pong": {
      samples.push(SC.sample(msg.c, msg.s, Date.now()));
      if (samples.length > 12) samples.shift();
      const next = SC.bestOffset(samples);
      if (Math.abs(next - offset) > 1 || samples.length <= 1) {
        offset = next;
        toContent({ t: "offset", offset });
      }
      return;
    }
    case "welcome":
      myId = msg.you;
      return;
    case "peers":
      hostId = msg.host;
      peers = msg.peers || [];
      toContent({ t: "peers", you: myId, host: hostId, peers });
      return;
    default:
      // state / cmd / ready / stall → the YouTube Music tab
      toContent(msg);
  }
}

function startClockSync() {
  stopClockSync();
  samples = [];
  let burst = 0;
  const ping = () => sendRelay({ t: "ping", c: Date.now() });
  // A quick burst for a good first estimate, then a steady trickle.
  pingTimer = setInterval(() => {
    ping();
    if (++burst === 8) {
      clearInterval(pingTimer);
      pingTimer = setInterval(ping, 5000);
    }
  }, 150);
}

function stopClockSync() {
  clearInterval(pingTimer);
  pingTimer = null;
}

// ---- room actions --------------------------------------------------------------

async function joinRoom(code) {
  room = String(code || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(room)) {
    room = null;
    return { ok: false, error: "Room codes are 3–32 letters or numbers." };
  }
  await browser.storage.local.set({ room });
  wsState = "connecting";
  backoff = 1000;
  connect();
  return { ok: true, room };
}

async function leaveRoom() {
  room = null;
  await browser.storage.local.remove("room");
  clearTimeout(reconnectTimer);
  closeSocket();
  wsState = "idle";
  myId = null;
  hostId = null;
  peers = [];
  toContent({ t: "peers", you: null, host: null, peers: [] });
  return { ok: true };
}

// ---- YouTube Music tab -----------------------------------------------------------

function toContent(msg) {
  if (contentPort) {
    try {
      contentPort.postMessage(msg);
    } catch {
      /* tab went away */
    }
  }
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "ytm-together") return;

  // The most recently opened YouTube Music tab becomes the active one.
  if (contentPort) {
    try {
      contentPort.postMessage({ t: "inactive" });
    } catch {
      /* ignore */
    }
  }
  contentPort = port;
  contentStatus = {};

  port.postMessage({
    t: "init",
    offset,
    delayMs: Number(cfg.delayMs) || 0,
    you: myId,
    host: hostId,
    peers,
  });

  port.onMessage.addListener((msg) => {
    if (port !== contentPort) return;
    switch (msg.t) {
      case "send":
        sendRelay(msg.msg);
        break;
      case "status":
        contentStatus = msg.status || {};
        break;
      case "alarm": {
        // Timers here aren't throttled, unlike a silent background tab.
        const wait = Math.max(0, msg.at - Date.now());
        setTimeout(() => toContent({ t: "alarm", tag: msg.tag }), wait);
        break;
      }
    }
  });

  port.onDisconnect.addListener(() => {
    if (port === contentPort) {
      contentPort = null;
      contentStatus = {};
    }
  });

  // Steady heartbeat so the tab keeps syncing even when Firefox throttles it.
  if (!tickTimer) tickTimer = setInterval(() => toContent({ t: "tick" }), 250);
});

// ---- popup ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener((msg) => {
  switch (msg && msg.type) {
    case "getStatus":
      return Promise.resolve({
        cfg,
        room,
        wsState,
        lastError,
        myId,
        hostId,
        peers,
        offset,
        clockSamples: samples.length,
        tabConnected: !!contentPort,
        content: contentStatus,
      });

    case "saveConfig":
      cfg = { ...DEFAULTS, ...cfg, ...msg.cfg };
      cfg.delayMs = Number(cfg.delayMs) || 0;
      return browser.storage.local.set({ cfg }).then(() => {
        toContent({ t: "config", delayMs: cfg.delayMs });
        if (room) connect();
        return { ok: true };
      });

    case "create":
      return joinRoom(SC.randomRoomCode());

    case "join":
      return joinRoom(msg.room);

    case "leave":
      return leaveRoom();

    case "claimHost":
      return Promise.resolve({ ok: sendRelay({ t: "claimHost" }) });
  }
  return undefined;
});
