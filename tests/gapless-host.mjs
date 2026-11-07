// Runs the real extension/content.js against a fake YouTube Music player that
// plays songs gaplessly, the way YouTube Music does now: the next song is
// appended to the same <video>, so video.currentTime keeps counting from the
// start of the first song while the player API reports time within the song.
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (f) => fs.readFileSync(root + f, "utf8");

/** Fake page: a gapless player, its <video>, and the extension messaging port. */
export function makePage(songs) {
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  };

  const listeners = {};
  const fire = (ev) => later(() => (listeners[ev] || []).forEach((fn) => fn()), 0);

  const P = {
    idx: 0,
    offset: 0, // where the current song starts on the <video> timeline
    t: 0, // time within the current song
    paused: true,
    rate: 1,
    last: performance.now(),
    replayedEarlierSong: false,
    get cur() {
      return songs[this.idx];
    },
    advance() {
      const now = performance.now();
      if (!this.paused) {
        this.t += ((now - this.last) / 1000) * this.rate;
        if (this.t >= this.cur.dur && this.idx < songs.length - 1) {
          const over = this.t - this.cur.dur;
          this.offset += this.cur.dur;
          this.idx++;
          this.t = over;
        }
      }
      this.last = now;
    },
    // YouTube's player API (all in song time)
    getVideoData() {
      this.advance();
      return { video_id: this.cur.id };
    },
    getCurrentTime() {
      this.advance();
      return this.t;
    },
    getDuration() {
      return this.cur.dur;
    },
    seekTo(s) {
      this.advance();
      this.t = Math.max(0, s);
      fire("seeked");
    },
    playVideo() {
      this.advance();
      if (this.paused) {
        this.paused = false;
        fire("play");
      }
    },
    pauseVideo() {
      this.advance();
      if (!this.paused) {
        this.paused = true;
        fire("pause");
      }
    },
    nextVideo() {},
    previousVideo() {},
  };

  const video = {
    get currentTime() {
      P.advance();
      return P.offset + P.t;
    },
    set currentTime(x) {
      P.advance();
      // Seeking the raw <video> before the current song's start lands in an
      // earlier song's audio while YouTube Music still shows the current one.
      if (x < P.offset - 0.001) P.replayedEarlierSong = true;
      P.t = x - P.offset;
      fire("seeked");
    },
    get duration() {
      return P.offset + P.cur.dur + 30; // the stream is longer than any one song
    },
    get paused() {
      return P.paused;
    },
    ended: false,
    readyState: 4,
    get playbackRate() {
      return P.rate;
    },
    set playbackRate(r) {
      P.advance();
      P.rate = r;
    },
    buffered: { length: 0 },
    play() {
      P.playVideo();
      return Promise.resolve();
    },
    pause() {
      P.pauseVideo();
    },
    addEventListener(ev, fn) {
      (listeners[ev] ||= []).push(fn);
    },
    removeEventListener(ev, fn) {
      listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn);
    },
  };

  const playerEl = { ...P, classList: { contains: () => false } };
  // Keep `this` on P for API calls made through the element.
  for (const k of ["getVideoData", "getCurrentTime", "getDuration", "seekTo", "playVideo", "pauseVideo", "nextVideo", "previousVideo"]) {
    playerEl[k] = P[k].bind(P);
  }

  const sent = [];
  const portListeners = [];
  const port = {
    onMessage: { addListener: (fn) => portListeners.push(fn) },
    onDisconnect: { addListener() {} },
    postMessage(m) {
      if (m.t === "send") sent.push({ ...m.msg, ms: performance.now() });
      if (m.t === "alarm") later(() => portListeners.forEach((f) => f({ t: "alarm" })), Math.max(0, m.at - Date.now()));
    },
  };
  const deliver = (msg) => portListeners.forEach((f) => f(msg));

  const assigned = [];
  const ctx = {
    console: { debug() {}, log: console.log },
    performance,
    Date,
    Math,
    JSON,
    Number,
    String,
    Object,
    Set,
    Map,
    Error,
    URLSearchParams,
    isFinite,
    encodeURIComponent,
    setTimeout: later,
    clearTimeout: (id) => {
      clearTimeout(id);
      timers.delete(id);
    },
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      timers.add({ interval: id });
      return id;
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { search: "", assign: (u) => assigned.push(u) },
    document: {
      getElementById: (id) => (id === "movie_player" ? playerEl : null),
      querySelector: (sel) => (sel.includes("video") ? video : null),
      addEventListener() {},
    },
    browser: { runtime: { connect: () => port } },
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read("extension/sync-core.js"), ctx);
  vm.runInContext(read("extension/content.js"), ctx);

  const stop = () => {
    for (const t of timers) {
      if (t && t.interval) clearInterval(t.interval);
      else clearTimeout(t);
    }
    timers.clear();
  };

  return { P, sent, deliver, assigned, stop };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
