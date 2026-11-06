// Pure sync math shared by the background page and the content script.
// No browser APIs in here, so it can be unit-tested with plain Node.
(function (root) {
  "use strict";

  const SyncCore = {
    // Tunables (seconds unless noted)
    HARD_SEEK: 0.8, // drift above this → jump straight to the right spot
    START_CORRECT: 0.05, // drift above this → start nudging the speed
    STOP_CORRECT: 0.015, // while nudging, stop once drift is below this
    GAIN: 0.25, // speed change per second of drift
    MAX_RATE_DELTA: 0.03, // never go beyond ±3% speed (inaudible with pitch preservation)
    SEEK_LEAD: 0.03, // seeking takes a moment; land slightly ahead

    clamp(x, lo, hi) {
      return Math.min(hi, Math.max(lo, x));
    },

    /**
     * Where the host's track should be right now.
     * state: { pos, playing, at } — `at` is the server time (ms) when pos was true.
     */
    expectedPosition(state, serverNowMs) {
      if (!state) return 0;
      if (!state.playing) return state.pos;
      const elapsed = (serverNowMs - state.at) / 1000;
      return state.pos + Math.max(0, elapsed);
    },

    /**
     * Decide how to correct drift.
     * drift > 0 means we're ahead of the host.
     * Returns { action: 'none' | 'rate' | 'seek', rate, seekTo, drift, correcting }.
     */
    decide(localPos, targetPos, correcting) {
      const drift = localPos - targetPos;
      const abs = Math.abs(drift);

      if (abs > this.HARD_SEEK) {
        return {
          action: "seek",
          seekTo: Math.max(0, targetPos + this.SEEK_LEAD),
          rate: 1,
          drift,
          correcting: false,
        };
      }

      if (abs > this.START_CORRECT || (correcting && abs > this.STOP_CORRECT)) {
        const delta = this.clamp(drift * this.GAIN, -this.MAX_RATE_DELTA, this.MAX_RATE_DELTA);
        // Keep at least a 1% nudge so small drifts actually close.
        const minDelta = 0.01 * Math.sign(drift);
        const d = Math.abs(delta) < 0.01 ? minDelta : delta;
        return { action: "rate", rate: 1 - d, drift, correcting: true };
      }

      return { action: "none", rate: 1, drift, correcting: false };
    },

    /**
     * Clock offset from ping samples [{ rtt, off }]. The sample with the
     * smallest round trip is the most trustworthy.
     */
    bestOffset(samples) {
      if (!samples || !samples.length) return 0;
      let best = samples[0];
      for (const s of samples) if (s.rtt < best.rtt) best = s;
      return best.off;
    },

    /** One ping sample from client send time c, server time s, receive time now. */
    sample(c, s, now) {
      const rtt = now - c;
      return { rtt, off: s - (c + rtt / 2) };
    },

    /**
     * Did the track change because the previous song finished (autoplay),
     * rather than because someone picked a different song?
     */
    looksLikeAutoplay(prevPos, prevDuration) {
      if (!(prevDuration > 0)) return false;
      return prevDuration - prevPos < 4;
    },

    // Buffering holds (seconds unless noted)
    STALL_AFTER_MS: 1500, // playback frozen this long → ask the host to wait
    RESUME_BUFFER: 3, // only let the host resume once this much audio is loaded ahead
    STALL_LIMIT: 3, // this many holds in STALL_WINDOW_MS → stop pausing the host for a while
    STALL_WINDOW_MS: 60000,
    STALL_COOLDOWN_MS: 120000,
    RESUME_SNAP: 0.25, // when resuming, closer than this → just play and let the speed nudge fix it

    /** Seconds of audio loaded ahead of `t`, given buffered ranges [[start, end], …]. */
    bufferedAhead(ranges, t) {
      for (const [s, e] of ranges || []) if (t >= s - 0.1 && t < e) return e - Math.max(t, s);
      return 0;
    },

    /** Enough audio loaded to resume without stalling again right away? */
    readyToResume(ranges, t, duration) {
      const left = duration > 0 ? Math.max(0, duration - t - 0.1) : Infinity;
      return this.bufferedAhead(ranges, t) >= Math.min(this.RESUME_BUFFER, left);
    },

    /**
     * Should this guest still pause the host for buffering? Returns false once it
     * has asked too often recently: a slow connection then catches up by jumping
     * ahead instead of pausing both people again and again.
     */
    mayHold(recentStallTimes, nowMs) {
      const recent = recentStallTimes.filter((t) => nowMs - t < this.STALL_WINDOW_MS + this.STALL_COOLDOWN_MS);
      const inWindow = recent.filter((t) => nowMs - t < this.STALL_WINDOW_MS);
      if (inWindow.length >= this.STALL_LIMIT) return false;
      // Still cooling down after hitting the limit earlier?
      for (let i = 0; i + this.STALL_LIMIT - 1 < recent.length; i++) {
        const first = recent[i];
        const last = recent[i + this.STALL_LIMIT - 1];
        if (last - first < this.STALL_WINDOW_MS && nowMs - last < this.STALL_COOLDOWN_MS) return false;
      }
      return true;
    },

    randomRoomCode() {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let code = "";
      for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
      return code;
    },
  };

  if (typeof module !== "undefined" && module.exports) module.exports = SyncCore;
  else root.SyncCore = SyncCore;
})(typeof globalThis !== "undefined" ? globalThis : this);
