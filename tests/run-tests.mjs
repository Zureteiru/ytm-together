// Run with: node tests/run-tests.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const SC = require("../extension/sync-core.js");

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log("✓", name);
};

// ---- sync math ---------------------------------------------------------------

await test("expected position advances only while playing", () => {
  const st = { pos: 10, playing: true, at: 1000 };
  assert.equal(SC.expectedPosition(st, 3000), 12);
  assert.equal(SC.expectedPosition({ ...st, playing: false }, 3000), 10);
  assert.equal(SC.expectedPosition(st, 500), 10); // scheduled start in the future
});

await test("small drift is ignored, medium nudges speed, large seeks", () => {
  assert.equal(SC.decide(10.04, 10, false).action, "none");
  const ahead = SC.decide(10.2, 10, false);
  assert.equal(ahead.action, "rate");
  assert.ok(ahead.rate < 1 && ahead.rate >= 0.97, "ahead → slow down a little");
  const behind = SC.decide(9.8, 10, false);
  assert.ok(behind.rate > 1 && behind.rate <= 1.03, "behind → speed up a little");
  const far = SC.decide(12, 10, false);
  assert.equal(far.action, "seek");
  assert.ok(Math.abs(far.seekTo - 10.03) < 1e-9);
});

await test("hysteresis: keeps correcting until drift is really small", () => {
  assert.equal(SC.decide(10.03, 10, true).action, "rate");
  assert.equal(SC.decide(10.01, 10, true).action, "none");
});

await test("clock offset picks the lowest-latency sample", () => {
  // Server clock is 5000 ms ahead. Second sample had a slow return trip.
  const a = SC.sample(1000, 6020, 1040); // rtt 40, symmetric
  const b = SC.sample(2000, 7010, 2300); // rtt 300, asymmetric
  assert.equal(a.off, 5000);
  assert.equal(SC.bestOffset([b, a]), 5000);
});

await test("autoplay detection", () => {
  assert.equal(SC.looksLikeAutoplay(198, 200), true);
  assert.equal(SC.looksLikeAutoplay(60, 200), false);
  assert.equal(SC.looksLikeAutoplay(5, 0), false);
});

await test("room codes are 6 unambiguous characters", () => {
  for (let i = 0; i < 200; i++) assert.match(SC.randomRoomCode(), /^[A-HJ-NP-Z2-9]{6}$/);
});

// ---- drift simulation ----------------------------------------------------------
// Guest starts 400 ms behind, its clock estimate is off by 15 ms, and its audio
// runs 0.05% fast (several times worse than real sound cards). The controller
// should pull it in without a jump and keep it within ~50 ms.

await test("simulated guest converges and stays in sync", () => {
  const dt = 0.25;
  let hostPos = 30;
  let guestPos = 29.6;
  let rate = 1;
  let correcting = false;
  let seeks = 0;
  const clockError = 0.015;
  const guestClockSkew = 1.0005;
  let worstAfter = 0;

  for (let t = 0; t < 120; t += dt) {
    hostPos += dt;
    guestPos += dt * rate * guestClockSkew;
    const d = SC.decide(guestPos, hostPos + clockError, correcting);
    correcting = d.correcting;
    if (d.action === "seek") {
      guestPos = d.seekTo;
      seeks++;
      rate = 1;
    } else rate = d.rate;
    if (t > 30) worstAfter = Math.max(worstAfter, Math.abs(guestPos - hostPos - clockError));
  }
  assert.equal(seeks, 0, "a 400 ms gap should be closed by speed nudges, not a jump");
  assert.ok(worstAfter < 0.055, `worst drift after 30 s was ${(worstAfter * 1000).toFixed(1)} ms`);
  console.log(`    worst drift after settling: ${(worstAfter * 1000).toFixed(1)} ms`);
});

// ---- relay -------------------------------------------------------------------------
// Minimal stand-ins for the Workers runtime, enough to exercise the Room logic.

class FakeSocket {
  constructor() {
    this.sent = [];
    this.att = null;
  }
  send(m) {
    this.sent.push(JSON.parse(m));
  }
  close() {}
  serializeAttachment(a) {
    this.att = structuredClone(a);
  }
  deserializeAttachment() {
    return structuredClone(this.att);
  }
  last(t) {
    return [...this.sent].reverse().find((m) => m.t === t);
  }
}

globalThis.WebSocketPair = class {
  constructor() {
    const s = new FakeSocket();
    globalThis.__lastServer = s;
    return { 0: new FakeSocket(), 1: s };
  }
};
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse {
  constructor(body, init = {}) {
    super(body, init.status === 101 ? { status: 200 } : init);
    this.fakeStatus = init.status;
  }
};

const { Room, default: worker } = await import("../relay/src/index.js");

function makeRoom() {
  const sockets = [];
  const ctx = {
    acceptWebSocket: (ws) => sockets.push(ws),
    getWebSockets: () => sockets.slice(),
  };
  const room = new Room(ctx, {});
  const join = async (name) => {
    await room.fetch(new Request("https://x/room/ABC"));
    const ws = globalThis.__lastServer;
    await room.webSocketMessage(ws, JSON.stringify({ t: "hello", name }));
    return ws;
  };
  return { room, join };
}

await test("relay: first person is host, state only flows from host", async () => {
  const { room, join } = makeRoom();
  const a = await join("Me");
  const b = await join("Her");
  const peers = b.last("peers");
  assert.equal(peers.peers.length, 2);
  assert.equal(peers.host, a.last("welcome").you);

  await room.webSocketMessage(a, JSON.stringify({ t: "state", videoId: "abc123def45", pos: 1 }));
  assert.equal(b.last("state").videoId, "abc123def45");
  assert.equal(b.last("state").from, a.last("welcome").you);

  const before = a.sent.length;
  await room.webSocketMessage(b, JSON.stringify({ t: "state", videoId: "zzz" }));
  assert.equal(a.sent.length, before, "a guest can't broadcast state");

  await room.webSocketMessage(b, JSON.stringify({ t: "cmd", action: "pause" }));
  assert.equal(a.last("cmd").action, "pause", "guest commands reach the host");
});

await test("relay: pong carries server time; host handover works", async () => {
  const { room, join } = makeRoom();
  const a = await join("Me");
  const b = await join("Her");
  await room.webSocketMessage(b, JSON.stringify({ t: "ping", c: 123 }));
  const pong = b.last("pong");
  assert.equal(pong.c, 123);
  assert.ok(Math.abs(pong.s - Date.now()) < 1000);

  await room.webSocketMessage(b, JSON.stringify({ t: "claimHost" }));
  assert.equal(a.last("peers").host, b.last("welcome").you);

  await room.webSocketClose(b);
  const p = a.last("peers");
  assert.equal(p.peers.length, 1);
  assert.equal(p.host, a.last("welcome").you, "remaining person becomes host");
});

await test("relay: access key and room code validation", async () => {
  const env = { ROOM_KEY: "secret", ROOMS: null };
  let r = await worker.fetch(new Request("https://x/room/ABC"), env);
  assert.equal(r.status, 403);
  r = await worker.fetch(new Request("https://x/room/A"), env);
  assert.equal(r.status, 404);
  r = await worker.fetch(new Request("https://x/health"), env);
  assert.equal(r.status, 200);
});

console.log(`\n${passed} tests passed`);
