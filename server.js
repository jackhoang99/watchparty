const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { WebSocketServer } = require('ws');
const { nanoid } = require('nanoid');

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
    // Tell every existing call peer that a new peer joined — they will initiate the offer
    socket.to(currentRoomId).emit('call:peer-joined', { id: socket.id });
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
    } else if (msg.type === 'source') {
      room.source = {
        type: 'url',
        value: String(msg.url || ''),
        title: String(msg.title || '')
      };
      room.playback = { playing: false, currentTime: 0, updatedAt: Date.now() };
      io.to(roomId).emit('source:change', room.source);
      io.to(roomId).emit('extension:event', {
        kind: 'status',
        text: 'Watching: ' + (room.source.title || room.source.value)
      });
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
