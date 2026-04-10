# watchparty

A Twoseven-style sync watch party. Watch YouTube, direct video URLs (mp4 / HLS),
and any other streaming site (via a companion browser extension) together with
chat, in real time.

## Features

- **Rooms with shareable codes** — create a room, share the link, friends join.
- **YouTube sync** — paste any YouTube URL; play / pause / seek stays in sync.
- **Direct video URL sync** — paste an `.mp4` or `.m3u8` (HLS) URL; played in a
  built-in HTML5 video player with hls.js.
- **Any-site sync via browser extension** — install the unpacked extension,
  open a streaming site (e.g. fsharetv.com), and the extension bridges its
  `<video>` element's play / pause / seek events into your room.
- **Live chat** with per-user colors.
- **Member list** showing who's currently watching.

## Run locally

```bash
cd ~/watchparty
npm install
npm start
```

Then open <http://localhost:3000>.

Use `npm run dev` for auto-reload on file changes (requires Node 18+).

## Watching with friends across the internet

`localhost` only works on your machine. For friends to join you need a public
URL. Easiest options:

- [ngrok](https://ngrok.com/): `ngrok http 3000` → use the printed `https://…`
  URL as the shared link.
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):
  `cloudflared tunnel --url http://localhost:3000`
- Deploy it (see below).

## Deploying

The app is a single Node process — works on anything that runs Node:

- **Render / Railway / Fly.io**: point at this repo, set start command `node server.js`.
  A `Procfile` is included for Heroku-style platforms.
- **Port**: respects `PORT` env var.
- **Sticky sessions**: not required for a single instance. If you horizontally
  scale, you'll need a Redis adapter for socket.io and a shared store for room
  state — both out of scope for this MVP.

## Browser extension (for arbitrary streaming sites)

The extension lives in `./extension`. To install it in Chrome / Edge / Brave:

1. Visit `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked** and choose the `~/watchparty/extension` folder
4. Click the extension icon → enter:
   - **Server URL**: e.g. `http://localhost:3000` (or your ngrok / deploy URL)
   - **Room code**: the same code you and your friends are using on the site
5. Click **Connect**

Now open the streaming site (e.g. `https://fsharetv.com/...`) in any tab.
When you press play / pause / seek the video, every other person in the room
gets the same action applied to their copy of the video on their machine.

> **Note:** the extension drives playback by simulating events on the page's
> `<video>` element. Sites that use a non-standard player or block extension
> access may not work. Sites that geo-block content still geo-block — sync
> doesn't bypass that.

### How sync works

- The web app uses **Socket.IO** for room state, chat, and YouTube / direct-URL
  playback events.
- The browser extension uses a plain **WebSocket** at `/bridge` (Manifest V3
  service workers can't easily run the Socket.IO client, so a thin JSON
  protocol is used instead).
- The server keeps room state in memory (rooms are reaped 60s after the last
  member leaves) and forwards `playback:update` events to every member of the
  room — both Socket.IO peers and `/bridge` peers.
- Each playback update carries a server-side `updatedAt` timestamp; clients
  add the elapsed delta to compute the target seek position, so people who
  joined late catch up to the right spot.

## Project layout

```
watchparty/
├── server.js              # Express + Socket.IO + ws bridge
├── package.json
├── Procfile
├── public/
│   ├── index.html         # Landing
│   ├── room.html          # Room view
│   ├── css/style.css
│   └── js/
│       ├── landing.js
│       └── room.js        # Player wrappers + sync logic
└── extension/
    ├── manifest.json      # MV3
    ├── background.js      # WebSocket service worker
    ├── content.js         # Finds <video> elements, bridges events
    ├── popup.html
    └── popup.js
```

## Roadmap ideas

- Persist rooms across restarts (sqlite / redis)
- Skip-ahead voting / "host-only" controls
- Voice chat (WebRTC)
- Subtitle upload (.vtt)
- Mobile-friendly extension alternative (PWA + screen share)
# watchparty
