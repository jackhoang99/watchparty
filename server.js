const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const { Server } = require('socket.io');
const { WebSocketServer } = require('ws');
const { nanoid } = require('nanoid');

// Helper: fetch with fallback for older Node versions
function apiFetch(url, options = {}) {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch(url, options);
  }
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyData = options.body || null;
    const headers = { ...(options.headers || {}) };
    if (bodyData) headers['Content-Length'] = Buffer.byteLength(bodyData);
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers
    };
    const req = https.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: () => { try { return Promise.resolve(JSON.parse(body)); } catch { return Promise.resolve({ error: body }); } }
        });
      });
    });
    req.on('error', reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 5000,
  pingTimeout: 10000
});
const wss = new WebSocketServer({ noServer: true });

// Manually route WebSocket upgrades so Socket.IO and ws don't conflict
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/bridge') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    // Let Socket.IO handle all other upgrades (it listens on /socket.io/)
  }
});

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- room state ----------
const rooms = new Map();              // roomId -> Room
const wsRoomMembers = new Map();      // roomId -> Set<ws>
const reapTimers = new Map();         // roomId -> Timeout

const COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#6366f1','#a855f7','#ec4899'];
let colorIdx = 0;

function createRoom(id) {
  return {
    id,
    members: new Map(),                                       // socketId -> { id, name, color }
    callMembers: new Set(),                                   // socketIds currently in the voice/video call
    source: null,                                             // { type, value, title }
    playback: { playing: false, currentTime: 0, updatedAt: Date.now() },
    chat: []
  };
}

function getOrCreateRoom(id) {
  if (!rooms.has(id)) rooms.set(id, createRoom(id));
  const t = reapTimers.get(id);
  if (t) { clearTimeout(t); reapTimers.delete(id); }
  return rooms.get(id);
}

function serializeRoom(room) {
  return {
    id: room.id,
    members: Array.from(room.members.values()).map(m => ({ id: m.id, name: m.name, color: m.color })),
    callMembers: Array.from(room.callMembers || []),
    vbrowser: room.vbrowser || null,
    source: room.source,
    playback: room.playback,
    chat: room.chat
  };
}

function broadcastPlayback(roomId, playback, exceptSocketId) {
  const sockets = io.sockets.adapter.rooms.get(roomId);
  if (sockets) {
    for (const sid of sockets) {
      if (sid === exceptSocketId) continue;
      io.to(sid).emit('playback:update', playback);
    }
  }
  const wsSet = wsRoomMembers.get(roomId);
  if (wsSet) {
    const data = JSON.stringify({ type: 'playback', playback });
    for (const ws of wsSet) {
      try { ws.send(data); } catch {}
    }
  }
}

function broadcastSource(roomId, source) {
  io.to(roomId).emit('source:change', source);
  const wsSet = wsRoomMembers.get(roomId);
  if (wsSet) {
    const data = JSON.stringify({ type: 'source', source });
    for (const ws of wsSet) {
      try { ws.send(data); } catch {}
    }
  }
}

function maybeReap(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const wsCount = wsRoomMembers.get(roomId)?.size || 0;
  if (room.members.size === 0 && wsCount === 0) {
    const t = setTimeout(() => {
      const r = rooms.get(roomId);
      if (r && r.members.size === 0 && (wsRoomMembers.get(roomId)?.size || 0) === 0) {
        rooms.delete(roomId);
        reapTimers.delete(roomId);
      }
    }, 60_000);
    reapTimers.set(roomId, t);
  }
}

// ---------- HTTP routes ----------
// TURN credentials endpoint — generates fresh credentials from Cloudflare TURN
app.get('/api/turn', async (req, res) => {
  // Option 1: Metered TURN API (recommended — free 500GB/month)
  const meteredKey = process.env.METERED_API_KEY;
  if (meteredKey) {
    try {
      const appName = process.env.METERED_APP_NAME || 'watchparty';
      const r = await apiFetch(`https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${meteredKey}`, {});
      const creds = await r.json();
      if (Array.isArray(creds) && creds.length) return res.json(creds);
    } catch {}
  }

  // Option 2: Cloudflare TURN
  const cfToken = process.env.CLOUDFLARE_TURN_TOKEN;
  const cfKeyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  if (cfToken && cfKeyId) {
    try {
      const r = await apiFetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + cfKeyId + '/credentials/generate', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 })
      });
      const data = await r.json();
      if (data.iceServers) return res.json(data.iceServers);
    } catch {}
  }

  // Fallback: STUN only (works ~85% of the time, fails cross-country)
  res.json([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]);
});

// Serve extension folder for download
app.use('/extension', express.static(path.join(__dirname, 'extension')));

app.post('/api/rooms', (req, res) => {
  const id = nanoid(8);
  getOrCreateRoom(id);
  res.json({ id });
});

app.get('/r/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// ---------- Socket.IO (web clients) ----------
io.on('connection', (socket) => {
  let currentRoomId = null;

  socket.on('room:join', ({ roomId, name, uid }) => {
    if (!roomId) return;
    const room = getOrCreateRoom(roomId);
    const safeName = (String(name || 'guest')).slice(0, 24) || 'guest';
    const safeUid = uid ? String(uid) : null;

    // If this uid already has a socket in this room, evict the stale one
    if (safeUid) {
      for (const [oldSid, oldMember] of room.members) {
        if (oldMember.uid === safeUid && oldSid !== socket.id) {
          room.members.delete(oldSid);
          if (room.callMembers) room.callMembers.delete(oldSid);
          if (room.screenSharer === oldSid) room.screenSharer = null;
          const oldSocket = io.sockets.sockets.get(oldSid);
          if (oldSocket) { oldSocket.leave(roomId); oldSocket.disconnect(true); }
          break;
        }
      }
    }

    const color = COLORS[colorIdx++ % COLORS.length];
    const member = { id: socket.id, name: safeName, color, uid: safeUid };
    room.members.set(socket.id, member);
    socket.join(roomId);
    currentRoomId = roomId;
    socket.emit('room:state', serializeRoom(room));
    socket.to(roomId).emit('room:member', { joined: member });
  });

  socket.on('source:change', (source) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    if (!source || !source.type) return;
    room.source = {
      type: String(source.type),
      value: String(source.value || ''),
      title: String(source.title || '')
    };
    room.playback = { playing: false, currentTime: 0, updatedAt: Date.now() };
    broadcastSource(currentRoomId, room.source);
    broadcastPlayback(currentRoomId, room.playback);
  });

  socket.on('playback:update', (state) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    room.playback = {
      playing: !!state.playing,
      currentTime: Number(state.currentTime) || 0,
      updatedAt: Date.now()
    };
    broadcastPlayback(currentRoomId, room.playback, socket.id);
  });

  // Virtual browser — create a shared browsing session via Hyperbeam
  let vbrowserCreating = false;
  socket.on('vbrowser:start', async ({ url }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    if (room.vbrowser) {
      // Session already exists — just send it
      socket.emit('vbrowser:started', room.vbrowser);
      return;
    }
    if (vbrowserCreating) return;
    vbrowserCreating = true;
    const apiKey = process.env.HYPERBEAM_API_KEY;
    if (!apiKey) {
      socket.emit('vbrowser:error', { message: 'Virtual browser not configured — set HYPERBEAM_API_KEY' });
      return;
    }
    try {
      const resp = await apiFetch('https://engine.hyperbeam.com/v0/vm', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_url: url || 'https://google.com' })
      });
      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        console.error('Hyperbeam API error:', resp.status, errBody);
        throw new Error('Hyperbeam API error: ' + resp.status + ' ' + (errBody.error || ''));
      }
      const data = await resp.json();
      console.log('Hyperbeam session created:', data.session_id);
      room.vbrowser = { embedUrl: data.embed_url, sessionId: data.session_id, startedBy: socket.id };
      io.to(currentRoomId).emit('vbrowser:started', room.vbrowser);
    } catch (err) {
      console.error('Hyperbeam error:', err);
      socket.emit('vbrowser:error', { message: err.message || 'Failed to create virtual browser' });
    } finally {
      vbrowserCreating = false;
    }
  });

  socket.on('vbrowser:stop', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    room.vbrowser = null;
    io.to(currentRoomId).emit('vbrowser:stopped');
  });

  socket.on('sourceType:change', ({ type }) => {
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('sourceType:change', { type: String(type || 'youtube') });
  });

  socket.on('chat:message', (msg) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const member = room.members.get(socket.id);
    if (!member) return;
    const text = String(msg?.text || '').slice(0, 500).trim();
    if (!text) return;
    const entry = {
      id: nanoid(8),
      name: member.name,
      color: member.color,
      text,
      ts: Date.now()
    };
    room.chat.push(entry);
    if (room.chat.length > 200) room.chat.shift();
    io.to(currentRoomId).emit('chat:message', entry);
  });

  socket.on('room:rename', ({ name: newName }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const member = room.members.get(socket.id);
    if (!member) return;
    member.name = (String(newName || 'guest')).slice(0, 24) || 'guest';
    io.to(currentRoomId).emit('room:members', Array.from(room.members.values()));
  });

  // ---------- WebRTC call signaling ----------
  socket.on('call:join', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    if (!room.callMembers) room.callMembers = new Set();
    if (room.callMembers.has(socket.id)) return;
    room.callMembers.add(socket.id);
    // Tell ALL room members (not just call members) that someone joined the call
    // This lets viewers create receive-only connections
    io.to(currentRoomId).emit('call:peer-joined', { id: socket.id });
    io.to(currentRoomId).emit('call:roster', { members: Array.from(room.callMembers) });
  });

  socket.on('call:leave', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.callMembers) return;
    if (!room.callMembers.delete(socket.id)) return;
    socket.to(currentRoomId).emit('call:peer-left', { id: socket.id });
    io.to(currentRoomId).emit('call:roster', { members: Array.from(room.callMembers) });
  });

  // Generic SDP/ICE relay between two peers in the same room
  socket.on('webrtc:signal', ({ to, signal }) => {
    if (!to || !signal) return;
    io.to(to).emit('webrtc:signal', { from: socket.id, signal });
  });

  socket.on('disconnect', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const left = room.members.get(socket.id);
    room.members.delete(socket.id);
    if (room.callMembers && room.callMembers.delete(socket.id)) {
      socket.to(currentRoomId).emit('call:peer-left', { id: socket.id });
      io.to(currentRoomId).emit('call:roster', { members: Array.from(room.callMembers) });
    }
    if (left) socket.to(currentRoomId).emit('room:member', { left });
    maybeReap(currentRoomId);
  });
});

// ---------- WebSocket bridge (browser extension) ----------
wss.on('connection', (ws) => {
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'join') {
      roomId = String(msg.roomId || '').trim();
      if (!roomId) return;
      getOrCreateRoom(roomId);
      if (!wsRoomMembers.has(roomId)) wsRoomMembers.set(roomId, new Set());
      wsRoomMembers.get(roomId).add(ws);
      ws.send(JSON.stringify({ type: 'joined', roomId }));
      io.to(roomId).emit('extension:event', { kind: 'status', text: 'Browser extension connected' });
      // Send the current playback so the extension can catch up
      const room = rooms.get(roomId);
      if (room) ws.send(JSON.stringify({ type: 'playback', playback: room.playback }));
      return;
    }

    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (msg.type === 'playback') {
      room.playback = {
        playing: !!msg.playing,
        currentTime: Number(msg.currentTime) || 0,
        updatedAt: Date.now()
      };
      // Forward to socket.io clients and other ws clients in the same room
      io.to(roomId).emit('playback:update', room.playback);
      const wsSet = wsRoomMembers.get(roomId);
      if (wsSet) {
        const data = JSON.stringify({ type: 'playback', playback: room.playback });
        for (const peer of wsSet) {
          if (peer !== ws) { try { peer.send(data); } catch {} }
        }
      }
    } else if (msg.type === 'source' || msg.type === 'source-yt') {
      room.source = {
        type: msg.type === 'source-yt' ? 'youtube' : 'url',
        value: String(msg.url || ''),
        title: String(msg.title || '')
      };
      room.playback = { playing: false, currentTime: 0, updatedAt: Date.now() };
      broadcastSource(roomId, room.source);
      broadcastPlayback(roomId, room.playback);
    }
  });

  ws.on('close', () => {
    if (!roomId) return;
    const set = wsRoomMembers.get(roomId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) wsRoomMembers.delete(roomId);
    }
    io.to(roomId).emit('extension:event', { kind: 'status', text: 'Browser extension disconnected' });
    maybeReap(roomId);
  });
});

server.listen(PORT, () => {
  console.log(`watchparty listening on http://localhost:${PORT}`);
});
