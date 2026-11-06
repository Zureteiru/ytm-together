"use strict";

const $ = (id) => document.getElementById(id);
const send = (msg) => browser.runtime.sendMessage(msg);
let settingsLoaded = false;

function showError(text) {
  $("error").textContent = text || "";
  $("error").hidden = !text;
}

function render(s) {
  // Fill settings once, so typing isn't overwritten by refreshes.
  if (!settingsLoaded) {
    settingsLoaded = true;
    $("name").value = s.cfg.name || "";
    $("relayUrl").value = s.cfg.relayUrl || "";
    $("key").value = s.cfg.key || "";
    $("delayMs").value = s.cfg.delayMs || 0;
    if (!s.cfg.relayUrl) $("settingsBox").open = true;
  }

  const inRoom = !!s.room;
  $("lobby").hidden = inRoom;
  $("inRoom").hidden = !inRoom;

  const conn = $("conn");
  const states = {
    idle: ["Not in a room", ""],
    connecting: ["Connecting…", "warn"],
    reconnecting: ["Reconnecting…", "warn"],
    connected: ["Connected", "good"],
    error: ["Error", "bad"],
  };
  const [label, cls] = states[s.wsState] || ["…", ""];
  conn.textContent = label;
  conn.className = "pill " + cls;

  showError(s.lastError);
  if (!inRoom) return;

  $("roomCode").textContent = s.room;

  const names = s.peers.map((p) => {
    const tags = [];
    if (p.id === s.myId) tags.push("you");
    if (p.id === s.hostId) tags.push("host");
    return (p.name || "Someone") + (tags.length ? ` (${tags.join(", ")})` : "");
  });
  $("people").textContent = names.length ? names.join(" · ") : "Waiting for the connection…";
  if (names.length === 1) $("people").textContent += " — share the code so she can join";

  const c = s.content || {};
  const track = $("track");
  track.textContent = "";
  if (!s.tabConnected) {
    track.textContent = "Open music.youtube.com in a tab.";
  } else if (c.title) {
    track.append(c.title);
    if (c.artist) {
      const a = document.createElement("span");
      a.className = "artist";
      a.textContent = c.artist;
      track.append(a);
    }
  } else {
    track.textContent = "Nothing playing yet.";
  }

  $("role").textContent = s.myId ? (s.myId === s.hostId ? "Host" : "Guest") : "—";

  const drift = $("drift");
  drift.className = "";
  if (s.myId && s.myId === s.hostId) {
    drift.textContent = c.waiting === "loading" ? "Starting together…" : c.waiting === "buffering" ? "Waiting for guest…" : "Leading";
  } else if (typeof c.drift === "number") {
    const ms = Math.abs(c.drift);
    drift.textContent = `${c.drift > 0 ? "+" : c.drift < 0 ? "−" : ""}${ms} ms`;
    drift.className = ms < 80 ? "good" : ms < 300 ? "warn" : "bad";
  } else {
    drift.textContent = "—";
  }

  $("warning").textContent = c.warning || "";
  $("warning").hidden = !c.warning;
  $("claimHost").disabled = !s.myId || s.myId === s.hostId;
}

async function refresh() {
  try {
    render(await send({ type: "getStatus" }));
  } catch (e) {
    showError(String(e));
  }
}

$("create").addEventListener("click", async () => {
  const r = await send({ type: "create" });
  if (!r.ok) showError(r.error);
  refresh();
});

$("joinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await send({ type: "join", room: $("joinCode").value });
  if (!r.ok) showError(r.error);
  refresh();
});

$("leave").addEventListener("click", async () => {
  await send({ type: "leave" });
  refresh();
});

$("claimHost").addEventListener("click", () => send({ type: "claimHost" }).then(refresh));

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("roomCode").textContent);
  $("copy").textContent = "Copied";
  setTimeout(() => ($("copy").textContent = "Copy"), 1200);
});

$("settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  await send({
    type: "saveConfig",
    cfg: {
      name: $("name").value.trim(),
      relayUrl: $("relayUrl").value.trim(),
      key: $("key").value,
      delayMs: Number($("delayMs").value) || 0,
    },
  });
  $("saved").hidden = false;
  setTimeout(() => ($("saved").hidden = true), 1500);
  refresh();
});

refresh();
setInterval(refresh, 500);
