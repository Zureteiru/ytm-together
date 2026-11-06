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
