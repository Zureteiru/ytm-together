<div align="center">

<img src="extension/icon.svg" alt="YTM Together logo" width="120" height="120">

# YTM Together

**Listen to YouTube Music together in Firefox, in tight sync.**

[![Latest release](https://img.shields.io/github/v/release/Zureteiru/ytm-together?style=flat-square&color=e5484d&label=release)](https://github.com/Zureteiru/ytm-together/releases/latest)
[![Firefox](https://img.shields.io/badge/Firefox-115%2B-FF7139?style=flat-square&logo=firefoxbrowser&logoColor=white)](https://github.com/Zureteiru/ytm-together/releases/latest)
[![Cloudflare Workers](https://img.shields.io/badge/relay-Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](#1-deploy-the-relay-once-about-5-minutes)
[![License: MIT](https://img.shields.io/github/license/Zureteiru/ytm-together?style=flat-square&color=blue)](LICENSE)

[**⬇ Download the extension**](https://github.com/Zureteiru/ytm-together/releases/latest) · [Set up a relay](#1-deploy-the-relay-once-about-5-minutes) · [How it works](#how-it-works)

</div>

---

One of you is the host; the other follows the host's player within a few tens
of milliseconds. Either of you can play, pause, seek, skip or pick a song.

- 🎧 **Tight sync:** usually within 50 ms, with gentle speed correction instead of jumps
- 🔁 **Shared control:** play, pause, seek, skip and pick songs from either side
- 🔒 **Private:** your own relay, an optional access key, and no audio ever leaves your computer
- 💸 **Free:** runs on Cloudflare's free plan

Each of you plays YouTube Music on your own account. The extension only sends
small messages ("song X, 83.2 s, playing, at time T") through a tiny relay you
run on Cloudflare's free plan. No audio is ever sent anywhere.

```
relay/       Cloudflare Worker that passes messages between the two of you
extension/   The Firefox extension (both of you install this)
tests/       Tests for the sync math and the relay (node tests/run-tests.mjs)
```

---

## 1. Deploy the relay (once, about 5 minutes)

You need [Node.js](https://nodejs.org) (the LTS version) and a free Cloudflare account.

```bash
cd relay
npm install
npx wrangler login          # opens the browser to sign in to Cloudflare
npx wrangler deploy
```

The last command prints your relay's address, something like
`https://ytm-together-relay.<your-name>.workers.dev`. Open it in a browser; you
should see "YTM Together relay is running."

**Optional but recommended: an access key**, so only the two of you can use your
relay:

```bash
npx wrangler secret put ROOM_KEY      # type any password, e.g. a long random word
```

If npm says some packages have install scripts "not yet covered by allowScripts"
(npm 11 and newer), allow the two that wrangler needs and run deploy again:

```bash
npm install-scripts approve esbuild workerd
npm rebuild esbuild workerd
```

## 2. Install the extension (both of you)

### Easiest: the signed release

1. Download the `.xpi` file from the
   [latest release](https://github.com/Zureteiru/ytm-together/releases/latest).
2. Drag it into a Firefox window and click **Add**.

It's signed by Mozilla, so it stays installed after restarts. The extension
doesn't contain anyone's relay: each pair of listeners uses their own relay from step 1.

### Quick test from source (disappears when Firefox restarts)

1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and choose `extension/manifest.json`

### Sign your own copy (if you change the code, ~10 minutes)

Regular Firefox only keeps signed extensions. Signing it "unlisted" means Mozilla
signs it but it doesn't appear in the add-ons store.

1. Change the `id` in `extension/manifest.json` to something unique to you
   (any `name@something` works); the ID of the release above is already taken.
2. Zip the **contents** of the `extension/` folder, so `manifest.json` is at the
   top level of the zip (not inside an `extension/` folder).
3. Go to <https://addons.mozilla.org/developers/>, sign in, and choose
   **Submit a New Add-on → On your own**.
4. Upload the zip. Automated review usually finishes in a few minutes.
5. Download the signed `.xpi` and install it on both computers by dragging it
   into Firefox.

When you change the code later, bump `version` in `manifest.json` and upload the
new zip as a new version of the same add-on.

## 3. Use it

1. Click the extension icon → **Settings**: enter your name, the relay URL and the
   access key (if you set one) → **Save**. Both of you do this once.
2. One of you clicks **Create a room** and sends the 6-letter code to the other,
   who types it and clicks **Join**.
3. Both open <https://music.youtube.com>. The first person in the room is the host.
4. The host plays music as usual. The guest's player follows automatically.

What each of you can do:

| Action on… | Host | Guest |
|---|---|---|
| Play / pause / seek | Works normally, guest follows | Sent to the host, both follow |
| Next / previous button | Host's queue | Moves the **host's** queue |
| Click a different song | Plays for both | Plays for both (it doesn't get added to the host's queue) |
| "Make me host" | — | Swaps roles; the new host's queue is used from then on |

The popup shows how far apart you are. Under 80 ms is shown green; that's
already tighter than you can notice.

**Bluetooth headphones:** they add roughly 150–250 ms of delay. If one of you uses
them, put that number in **Audio delay** in that person's Settings so you hear
the same moment.

---

## How it works

- **Clock sync:** when you connect, the extension pings the relay a few times and
  works out the difference between your computer's clock and the relay's, using
  the fastest round trip. Both of you are measured against the same clock.
- **Host is the source of truth:** the host sends what's playing every second and
  right away on any change.
- **Starting songs together:** when the song changes, the host waits (up to 5 s)
  for the guest to load it, then both start at the same planned moment about
  half a second later.
- **Drift correction:** under 50 ms, nothing happens. Between 50 ms and 0.8 s,
  the guest speeds up or slows down by at most 3% until it's within 15 ms
  (Firefox keeps the pitch the same, so you won't hear it). Over 0.8 s, it jumps
  to the right spot.
- **Autoplay guard:** if YouTube Music's autoplay starts a different song on the
  guest, the extension switches back to the host's song.
- **Buffering / ad hold:** if the guest is buffering or gets an ad for more than
  0.7 s, the host pauses and both resume together (gives up waiting after 15 s).

## Troubleshooting

- **The popup says "Reconnecting…"** — check the relay URL (it should start with
  `https://` and have no `/room/...` part) and that the access key matches the
  one you set with `wrangler secret put`.
- **Guest's song switches with a full page reload** — that's the fallback when
  YouTube Music's in-page player doesn't take the switch. It still works, just
  takes a second or two longer. If it happens every time, [open an issue](https://github.com/Zureteiru/ytm-together/issues).
- **Nothing plays on the guest** — Firefox may be blocking autoplay. Click the
  icon left of the address bar on music.youtube.com → **Autoplay → Allow Audio
  and Video**.
- **"Couldn't open this song here"** — the song isn't available in the guest's
  region. Pick another version of it.
- **Two YouTube Music tabs open** — only the most recently opened one syncs.
- **Logs:** press F12 on music.youtube.com, open **Console**, enable the
  **Debug** level, and look for lines starting with `[YTM Together]`.

## Limits

- Desktop Firefox only. The YouTube Music phone app can't be controlled from outside.
- Both of you should have YouTube Music Premium. It works without it, but every ad
  pauses both of you.
- Cloudflare's free plan easily covers two people listening every day.

## License

[MIT](LICENSE)
