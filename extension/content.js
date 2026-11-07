// Runs inside music.youtube.com. Reads and controls the player, and runs the
// sync logic: the host broadcasts what's playing, guests follow it.
(() => {
  "use strict";

  const SC = globalThis.SyncCore;
  const log = (...a) => console.debug("[YTM Together]", ...a);

  // ---- shared state ----------------------------------------------------------

  let port = null;
  let active = true; // false if another YouTube Music tab took over
  let offset = 0; // serverNow = Date.now() + offset
  let delayMs = 0; // this computer's audio output delay (e.g. Bluetooth)
  let myId = null;
  let hostId = null;
  let peers = [];
  let role = "none"; // host | guest | none

  let video = null;
  let lastTrack = { id: null, pos: 0, dur: 0 };
  let selfUntil = { play: 0, pause: 0, seeked: 0, track: 0 };
  let lastTickAt = 0;
  let warning = "";
  let lastDrift = null;

  // host-only
  let seq = 0;
  let barrier = null; // waiting for guests to load a new track: { videoId, ready:Set, deadline }
  let pendingStart = null; // scheduled synchronized start: { videoId, pos, at }
  let holds = new Map(); // guestId → since (guests that are buffering / showing an ad)
  let holdActive = null; // { since }
  let lastBroadcast = 0;
  let broadcastSoon = null;

  // guest-only
  let roomState = null; // latest state from the host
  let correcting = false;
  let loading = null; // { id, since, attempts }
  let readySentFor = null;
  let graceUntil = 0; // after sending a command, let the host respond before enforcing
  let pendingUserTrack = null; // { id, until } — a song this guest picked
  let autoplayWait = null; // { oldId, until } — our song ended first; wait for the host
  let stalledSince = 0;
  let stallReported = false;
  let stallReportedAt = 0;
  let stallTimes = []; // when this guest asked the host to wait (perf time)
  let lastAdvance = { t: -1, at: 0 }; // last time the playhead actually moved
  let scheduledPlayAt = 0;
  let selfSeekUntil = 0; // a seek we started is still in progress (slow seeks can take seconds)

  const serverNow = () => Date.now() + offset;
  const perfNow = () => performance.now();
  const markSelf = (kind, ms = 800) => (selfUntil[kind] = perfNow() + ms);
  const isSelf = (kind) => perfNow() < selfUntil[kind];

  // ---- player access ---------------------------------------------------------

  function playerEl() {
    return document.getElementById("movie_player");
  }

  /** YouTube's own player API (page object, reached through Firefox's wrappedJSObject). */
  function api() {
    const el = playerEl();
    if (!el) return null;
    const p = el.wrappedJSObject || el;
    return typeof p.getVideoData === "function" ? p : null;
  }

  function getVideo() {
    const v = document.querySelector("#movie_player video") || document.querySelector("video");
    if (v !== video) bindVideo(v);
    return v;
  }

  function getTrackId() {
    const p = api();
    if (p) {
      try {
        const d = p.getVideoData();
        if (d && d.video_id) return String(d.video_id);
      } catch {
        /* fall through */
      }
    }
    try {
      return new URLSearchParams(location.search).get("v");
    } catch {
      return null;
    }
  }

  function getMeta() {
    const bar = document.querySelector("ytmusic-player-bar");
    const title = bar && bar.querySelector(".title");
    const byline = bar && bar.querySelector(".byline");
    return {
      title: title ? title.textContent.trim() : "",
      artist: byline ? byline.textContent.trim().split("•")[0].trim() : "",
    };
  }

  function adShowing() {
    const el = playerEl();
    return !!(el && el.classList.contains("ad-showing"));
  }

  // ---- player control ----------------------------------------------------------

  function doPlay() {
    const v = getVideo();
    if (!v || !v.paused) return;
    markSelf("play");
    const p = api();
    try {
      if (p && typeof p.playVideo === "function") p.playVideo();
      else v.play().catch(() => {});
    } catch {
      v.play().catch(() => {});
    }
  }

  function doPause() {
    const v = getVideo();
    if (!v || v.paused) return;
    markSelf("pause");
    const p = api();
    try {
      if (p && typeof p.pauseVideo === "function") p.pauseVideo();
      else v.pause();
    } catch {
      v.pause();
    }
  }

  // YouTube Music plays songs gaplessly: the next song is appended to the same
  // <video>, so video.currentTime keeps counting from the start of an earlier
  // song. Positions and seeks therefore go through YouTube's player API, which
  // reports and sets the time within the current song.

  /** Position within the current song, in seconds. */
  function songPos() {
    const p = api();
    if (p && typeof p.getCurrentTime === "function") {
      try {
        const t = Number(p.getCurrentTime());
        if (isFinite(t)) return t;
      } catch {
        /* fall through */
      }
    }
    return video ? video.currentTime : 0;
  }

  /** Length of the current song, in seconds (0 if unknown). */
  function songDur() {
    const p = api();
    if (p && typeof p.getDuration === "function") {
      try {
        const d = Number(p.getDuration());
        if (d > 0 && isFinite(d)) return d;
      } catch {
        /* fall through */
      }
    }
    return video && isFinite(video.duration) ? video.duration : 0;
  }

  function doSeek(t) {
    const v = getVideo();
    if (!v) return;
    markSelf("seeked", 1200);
    selfSeekUntil = perfNow() + 10000;
    const p = api();
    try {
      if (!p || typeof p.seekTo !== "function") throw new Error("no player api");
      p.seekTo(Math.max(0, t), true);
    } catch {
      // Raw fallback: convert song time to the video's own timeline.
      v.currentTime = Math.max(0, t) + (v.currentTime - songPos());
    }
  }

  /** Loaded ranges as [[start, end], …], in song time. */
  function bufferedRanges(v) {
    const out = [];
    const shift = v.currentTime - songPos(); // video timeline → song timeline
    try {
      for (let i = 0; i < v.buffered.length; i++) out.push([v.buffered.start(i) - shift, v.buffered.end(i) - shift]);
    } catch {
      /* ignore */
    }
    return out;
  }

  function setRate(r) {
    const v = getVideo();
    if (!v) return;
    if (Math.abs(v.playbackRate - r) > 0.001) v.playbackRate = r;
  }

  /**
   * Play a song through YouTube Music's own navigation, the same path as clicking
   * a song. (The player's loadVideoById swaps only the audio: the player bar,
   * address and queue stay on the old song, and the queue carries on from there.)
   * Returns false if the app isn't ready.
   */
  function playInApp(id) {
    const app = document.querySelector("ytmusic-app");
    if (!app) return false;
    const init = { bubbles: true, composed: true, detail: { endpoint: { watchEndpoint: { videoId: id } } } };
    // In Firefox the page can only read the event's data if it's created in the page's scope.
    const ev =
      typeof cloneInto === "function" && window.wrappedJSObject
        ? new window.wrappedJSObject.CustomEvent("yt-navigate", cloneInto(init, window))
        : new CustomEvent("yt-navigate", init);
    app.dispatchEvent(ev);
    return true;
  }

  /** Switch this tab to a track: in-app navigation first, then a page load. */
  function ensureLoading(id) {
    const now = perfNow();
    const key = "ytmt-load-" + id;

    if (loading && loading.id === id) {
      if (loading.attempts === 1 && now - loading.since > 4000) {
        // In-page switch didn't take — fall back to loading the page.
        if (sessionStorage.getItem(key)) {
          warning = "Couldn't open this song here — it may be unavailable in your region.";
          return;
        }
        sessionStorage.setItem(key, "1");
        loading.attempts = 2;
        markSelf("track", 10000);
        location.assign("https://music.youtube.com/watch?v=" + encodeURIComponent(id));
      }
      return;
    }

    loading = { id, since: now, attempts: 1 };
    markSelf("track", 5000);
    try {
      if (!playInApp(id)) throw new Error("app not ready");
    } catch (e) {
      log("in-app switch failed, loading page", e);
      loading.attempts = 2;
      sessionStorage.setItem(key, "1");
      location.assign("https://music.youtube.com/watch?v=" + encodeURIComponent(id));
    }
  }

  // ---- video events --------------------------------------------------------------

  function bindVideo(v) {
    if (video) {
      for (const [ev, fn] of Object.entries(handlers)) video.removeEventListener(ev, fn);
    }
    video = v;
    if (video) {
      for (const [ev, fn] of Object.entries(handlers)) video.addEventListener(ev, fn);
    }
  }

  const handlers = {
    play() {
      if (role === "host") {
        // Host pressed play themselves: stop waiting and go. (YouTube also fires
        // 'play' by itself when a new song loads, so a barrier is left alone.)
        if (!isSelf("play") && !barrier) {
          pendingStart = null;
          holdActive = null;
        }
        queueBroadcast();
      } else if (role === "guest" && !isSelf("play") && !isSelf("track") && guestOwnsTrack()) {
        sendCmd({ action: "play" });
      }
    },
    pause() {
      if (role === "host") {
        if (!isSelf("pause")) {
          pendingStart = null;
          holdActive = null;
        }
        queueBroadcast();
      } else if (role === "guest" && !isSelf("pause") && !isSelf("track") && guestOwnsTrack()) {
        // The video also pauses on its own when a song ends — not a user action.
        const v = video;
        const dur = songDur();
        const ended = v && dur > 0 && dur - songPos() < 0.5;
        if (!ended) sendCmd({ action: "pause" });
      }
    },
    seeked() {
      // Ours if we started a seek that hasn't finished yet, however long it took.
      const mine = isSelf("seeked") || perfNow() < selfSeekUntil;
      selfSeekUntil = 0;
      if (mine) markSelf("seeked", 600); // let it settle before measuring drift
      if (role === "host") queueBroadcast();
      else if (role === "guest" && !mine && !isSelf("track") && guestOwnsTrack()) {
        sendCmd({ action: "seek", pos: songPos() });
      }
    },
  };

  /**
   * True when a play/seek on the guest is plausibly the person's own action:
   * they're on the room's song and not at its very start (YouTube fires
   * play/seek events by itself whenever a song loads).
   */
  function guestOwnsTrack() {
    return !!(roomState && video && getTrackId() === roomState.videoId && songPos() > 1.5);
  }

  // Guest's next / previous buttons control the host's queue instead of their own.
  document.addEventListener(
    "click",
    (e) => {
      if (role !== "guest" || !active) return;
      const btn = e.target.closest && e.target.closest("ytmusic-player-bar .next-button, ytmusic-player-bar .previous-button");
      if (!btn) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      sendCmd({ action: btn.classList.contains("next-button") ? "next" : "prev" });
    },
    true
  );

  // ---- messaging -------------------------------------------------------------------

  function send(msg) {
    if (port && active) port.postMessage({ t: "send", msg });
  }

  function sendCmd(cmd) {
    graceUntil = perfNow() + 1500;
    send({ t: "cmd", ...cmd });
  }

  function guestIds() {
    return peers.map((p) => p.id).filter((id) => id && id !== myId);
  }

  function updateRole() {
    const prev = role;
    role = !myId ? "none" : myId === hostId ? "host" : "guest";
    if (role === prev) return;
    log("role:", prev, "→", role);

    // Reset everything tied to the old role.
    setRate(1);
    correcting = false;
    roomState = null;
    loading = null;
    barrier = null;
    pendingStart = null;
    holds.clear();
    holdActive = null;
    readySentFor = null;
    pendingUserTrack = null;
    autoplayWait = null;
    stallReported = false;
    warning = "";
    lastDrift = null;
    if (role === "host") queueBroadcast(0);
  }

  function connectPort() {
    port = browser.runtime.connect({ name: "ytm-together" });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      // Extension reloaded or background restarted — try again shortly.
      setTimeout(connectPort, 2000);
    });
  }

  function onMessage(msg) {
    switch (msg.t) {
      case "init":
        active = true;
        offset = msg.offset || 0;
        delayMs = msg.delayMs || 0;
        myId = msg.you;
        hostId = msg.host;
        peers = msg.peers || [];
        updateRole();
        break;
      case "inactive":
        active = false;
        role = "none";
        setRate(1);
        break;
      case "offset":
        offset = msg.offset;
        break;
      case "config":
        delayMs = msg.delayMs || 0;
        break;
      case "peers":
        myId = msg.you;
        hostId = msg.host;
        peers = msg.peers || [];
        for (const id of [...holds.keys()]) if (!guestIds().includes(id)) holds.delete(id);
        updateRole();
        if (role === "host") queueBroadcast(0); // tell newcomers what's playing
        break;
      case "state":
        if (role === "guest") {
          if (!roomState || msg.videoId !== roomState.videoId) readySentFor = null;
          roomState = msg;
          if (pendingUserTrack && msg.videoId === pendingUserTrack.id) pendingUserTrack = null;
          tick(true);
        }
        break;
      case "cmd":
        if (role === "host") applyCmd(msg);
        break;
      case "ready":
        if (role === "host" && barrier && msg.videoId === barrier.videoId) {
          barrier.ready.add(msg.from);
          tick(true);
        }
        break;
      case "stall":
        if (role === "host") {
          if (msg.on) holds.set(msg.from, perfNow());
          else holds.delete(msg.from);
          tick(true);
        }
        break;
      case "alarm":
      case "tick":
        tick(msg.t === "alarm");
        break;
    }
  }

  // ---- host --------------------------------------------------------------------------

  function applyCmd(cmd) {
    const p = api();
    log("command from guest:", cmd);
    switch (cmd.action) {
      case "play":
        barrier = null;
        holdActive = null;
        scheduleStart(getVideo() ? songPos() : 0);
        break;
      case "pause":
        pendingStart = null;
        doPause();
        queueBroadcast(0);
        break;
      case "seek":
        if (typeof cmd.pos === "number") {
          doSeek(cmd.pos);
          queueBroadcast(0);
        }
        break;
      case "next":
        if (p) p.nextVideo();
        break;
      case "prev":
        if (p) p.previousVideo();
        break;
      case "load":
        if (typeof cmd.videoId === "string" && /^[\w-]{6,20}$/.test(cmd.videoId)) {
          let ok = false;
          try {
            ok = playInApp(cmd.videoId);
          } catch (e) {
            log("in-app switch failed, loading page", e);
          }
          if (!ok) location.assign("https://music.youtube.com/watch?v=" + encodeURIComponent(cmd.videoId));
        }
        break;
    }
  }

  /** Start playing at `pos` on everyone's device at the same moment, ~0.5 s from now. */
  function scheduleStart(pos) {
    const v = getVideo();
    if (!v) return;
    const at = serverNow() + 500;
    pendingStart = { videoId: getTrackId(), pos, at };
    doPause();
    if (Math.abs(songPos() - pos) > 0.05) doSeek(pos); // skip pointless seeks: they can re-buffer
    port && port.postMessage({ t: "alarm", at: at - offset, tag: "start" });
    queueBroadcast(0);
  }

  function hostState() {
    const v = getVideo();
    const meta = getMeta();
    const base = {
      t: "state",
      seq: ++seq,
      videoId: getTrackId(),
      delay: delayMs,
      dur: v ? songDur() : 0,
      title: meta.title,
      artist: meta.artist,
    };
    if (pendingStart) return { ...base, videoId: pendingStart.videoId, playing: true, pos: pendingStart.pos, at: pendingStart.at };
    if (barrier) return { ...base, videoId: barrier.videoId, playing: false, pos: 0, at: serverNow(), barrier: true };
    return {
      ...base,
      playing: !!(v && !v.paused && !v.ended),
      pos: v ? songPos() : 0,
      at: serverNow(),
      hold: !!holdActive,
    };
  }

  function queueBroadcast(delay = 40) {
    if (role !== "host") return;
    clearTimeout(broadcastSoon);
    broadcastSoon = setTimeout(broadcast, delay);
  }

  function broadcast() {
    if (role !== "host" || !getTrackId()) return;
    lastBroadcast = perfNow();
    send(hostState());
  }

  function hostTick() {
    const v = getVideo();
    if (!v) return;
    setRate(1);
    const now = perfNow();
    const id = getTrackId();

    // New song on the host → wait for guests to load it, then start together.
    if (id && id !== lastTrack.id) {
      if (lastTrack.id && guestIds().length) {
        barrier = { videoId: id, ready: new Set(), deadline: now + 5000 };
        pendingStart = null;
        holdActive = null;
      }
      queueBroadcast(0);
    }

    if (barrier) {
      if (barrier.videoId !== id) barrier = null;
      else {
        if (!v.paused) doPause();
        const everyoneReady = guestIds().every((g) => barrier.ready.has(g));
        if ((v.readyState >= 2 && everyoneReady) || now > barrier.deadline) {
          barrier = null;
          scheduleStart(0);
        }
      }
    }

    if (pendingStart) {
      if (pendingStart.videoId !== id) pendingStart = null;
      else if (serverNow() >= pendingStart.at) {
        const late = (serverNow() - pendingStart.at) / 1000;
        if (late > 0.05) doSeek(pendingStart.pos + late);
        pendingStart = null;
        doPlay();
        queueBroadcast(0);
      } else if (!v.paused) doPause();
    }

    // A guest is buffering or seeing an ad → pause everyone until they catch up.
    for (const [g, since] of holds) if (now - since > 15000) holds.delete(g);
    if (holds.size && !holdActive && !v.paused && !barrier && !pendingStart) {
      holdActive = { since: now };
      doPause();
      queueBroadcast(0);
    } else if (!holds.size && holdActive) {
      holdActive = null;
      scheduleStart(songPos());
    }

    if (now - lastBroadcast > 1000) broadcast();
  }

  // ---- guest -------------------------------------------------------------------------

  function guestTick() {
    const v = getVideo();
    const st = roomState;
    if (!v || !st || !st.videoId) return;
    const now = perfNow();
    const id = getTrackId();

    // Track changed on this side without the host asking for it.
    if (id && id !== lastTrack.id && lastTrack.id && id !== st.videoId && !isSelf("track")) {
      if (SC.looksLikeAutoplay(lastTrack.pos, lastTrack.dur)) {
        // Our song ended a moment before the host's; wait for the host's next song.
        log("autoplay picked another song — waiting for the host's next song");
        autoplayWait = { oldId: lastTrack.id, until: now + 8000 };
      } else {
        log("guest picked a song — asking the host to play it");
        pendingUserTrack = { id, until: now + 5000 };
        sendCmd({ action: "load", videoId: id });
      }
    }

    if (pendingUserTrack) {
      if (now < pendingUserTrack.until && id === pendingUserTrack.id) return;
      pendingUserTrack = null;
    }

    if (autoplayWait) {
      if (st.videoId !== autoplayWait.oldId || now > autoplayWait.until) autoplayWait = null;
      else {
        if (!v.paused) doPause();
        setRate(1);
        return;
      }
    }

    if (id !== st.videoId) {
      setRate(1);
      ensureLoading(st.videoId);
      return;
    }
    if (loading) {
      sessionStorage.removeItem("ytmt-load-" + loading.id);
      loading = null;
      warning = "";
    }

    if (now < graceUntil) return; // waiting for the host to act on our command

    // Buffering or an ad on this side → ask the host to wait, and only let it
    // go on once enough audio is loaded that we won't stall again right away.
    const ad = adShowing();
    const shouldPlay = st.playing && serverNow() >= st.at;
    const pos = songPos();
    if (v.paused || !shouldPlay || Math.abs(pos - lastAdvance.t) > 0.01) {
      lastAdvance = { t: pos, at: now };
    }
    // Frozen = supposed to be playing but the playhead hasn't moved (a more
    // reliable sign than readyState, which dips briefly on every small seek).
    const frozen = shouldPlay && !v.paused && now - lastAdvance.at > SC.STALL_AFTER_MS;

    if (!stallReported) {
      if (ad || frozen) {
        if (!stalledSince) stalledSince = now;
        const allowed = ad || SC.mayHold(stallTimes, now);
        if (allowed && now - stalledSince > (ad ? 700 : 0)) {
          stallReported = true;
          stallReportedAt = now;
          if (!ad) stallTimes = [...stallTimes.slice(-10), now];
          send({ t: "stall", on: true });
          log(ad ? "ad showing — asking the host to wait" : "buffering — asking the host to wait");
        } else if (!allowed) {
          warning = "Slow connection — catching up without pausing the host.";
          // Don't jump ahead into audio that isn't loaded yet; that only starts
          // buffering again. Once playback moves, drift correction catches up.
          setRate(1);
          return;
        }
      } else {
        stalledSince = 0;
      }
      if (ad) return;
    } else {
      const loaded = SC.readyToResume(bufferedRanges(v), pos, songDur());
      if ((!ad && loaded && !frozen) || now - stallReportedAt > 14000) {
        stallReported = false;
        stalledSince = 0;
        lastAdvance = { t: pos, at: now };
        send({ t: "stall", on: false });
        log("caught up — host can continue");
      } else if (ad || (st.playing && !st.hold)) {
        return; // wait for the ad to end / for the host to pause
      }
      // Otherwise the host is holding: fall through so we sit paused at the
      // host's spot while more audio loads.
    }
    if (warning.startsWith("Slow connection") && SC.mayHold(stallTimes, now)) warning = "";

    const adjust = (delayMs - (st.delay || 0)) / 1000;

    if (st.barrier) {
      // Host is waiting for us to load the new song.
      if (!v.paused) doPause();
      setRate(1);
      if (v.readyState >= 2 && readySentFor !== st.videoId) {
        if (pos > 0.3) doSeek(0);
        readySentFor = st.videoId;
        send({ t: "ready", videoId: st.videoId });
      }
      return;
    }

    if (!st.playing) {
      if (!v.paused) doPause();
      setRate(1);
      correcting = false;
      if (Math.abs(pos - st.pos) > 0.3) doSeek(st.pos);
      lastDrift = pos - st.pos;
      return;
    }

    const sNow = serverNow();
    if (sNow < st.at) {
      // Synchronized start coming up: get into position and wait.
      if (!v.paused) doPause();
      setRate(1);
      const startPos = Math.max(0, st.pos + adjust);
      if (Math.abs(pos - startPos) > 0.05) doSeek(startPos);
      if (scheduledPlayAt !== st.at) {
        scheduledPlayAt = st.at;
        port && port.postMessage({ t: "alarm", at: st.at - offset, tag: "start" });
      }
      return;
    }

    const target = SC.expectedPosition(st, sNow) + adjust;

    if (v.paused) {
      // Already about right → just play; the speed nudge closes the rest. Jumping
      // here would throw away loaded audio and can start buffering all over again.
      if (Math.abs(pos - target) > SC.RESUME_SNAP) doSeek(target + 0.05);
      doPlay();
      return;
    }

    if (isSelf("seeked")) return; // let the last seek settle before measuring

    const d = SC.decide(songPos(), target, correcting);
    lastDrift = d.drift;
    correcting = d.correcting;
    if (d.action === "seek") {
      setRate(1);
      doSeek(d.seekTo);
    } else {
      setRate(d.rate);
    }
  }

  // ---- main loop ---------------------------------------------------------------------

  function tick(force) {
    if (!active) return;
    const now = perfNow();
    if (!force && now - lastTickAt < 180) return;
    lastTickAt = now;

    try {
      if (role === "host") hostTick();
      else if (role === "guest") guestTick();
      else setRate(1);
    } catch (e) {
      log("tick error", e);
    }

    // Remember where the current song was, to tell autoplay from user picks.
    const v = getVideo();
    const id = getTrackId();
    if (v && id) {
      if (id === lastTrack.id) {
        lastTrack.pos = songPos();
        lastTrack.dur = songDur();
      } else {
        lastTrack = { id, pos: songPos(), dur: songDur() };
      }
    }

    reportStatus();
  }

  let lastReport = 0;
  function reportStatus() {
    const now = perfNow();
    if (!port || now - lastReport < 500) return;
    lastReport = now;
    const meta = getMeta();
    const v = video;
    port.postMessage({
      t: "status",
      status: {
        role,
        title: meta.title,
        artist: meta.artist,
        playing: !!(v && !v.paused),
        rate: v ? v.playbackRate : 1,
        drift: role === "guest" && lastDrift !== null ? Math.round(lastDrift * 1000) : null,
        waiting: role === "host" ? (barrier ? "loading" : holdActive ? "buffering" : null) : null,
        warning,
      },
    });
  }

  connectPort();
  setInterval(() => tick(false), 250);
})();
