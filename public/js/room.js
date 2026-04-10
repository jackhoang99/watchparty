const $ = (s) => document.querySelector(s);
const roomId = decodeURIComponent(location.pathname.split('/').pop());
$('#roomId').textContent = roomId;
document.title = `room ${roomId} · watchparty`;

const name = localStorage.getItem('wp.name') || 'guest';

const socket = io();
socket.emit('room:join', { roomId, name });

// ---------- DOM refs ----------
const ytWrap = $('#yt-wrap');
const nativeEl = $('#native-player');
const emptyEl = $('#player-empty');
const extInfoEl = $('#ext-info');

// ---------- player state ----------
let activeMode = null;     // 'youtube' | 'url' | 'extension' | null
let suppress = false;      // skip echoing remote-applied events
let ytPlayer = null;
let ytReady = false;
let pendingYoutube = null;
let hls = null;
let memberCache = [];

// ---------- YouTube IFrame API ----------
window.onYouTubeIframeAPIReady = () => {
  ytPlayer = new YT.Player('yt-player', {
    height: '100%', width: '100%',
    playerVars: { autoplay: 0, rel: 0, modestbranding: 1, playsinline: 1 },
    events: {
      onReady: () => {
        ytReady = true;
        if (pendingYoutube) {
          loadYoutube(pendingYoutube);
          pendingYoutube = null;
        }
      },
      onStateChange: (e) => {
        if (suppress || activeMode !== 'youtube') return;
        if (e.data === YT.PlayerState.PLAYING) {
          broadcastPlayback({ playing: true, currentTime: ytPlayer.getCurrentTime() });
        } else if (e.data === YT.PlayerState.PAUSED) {
          broadcastPlayback({ playing: false, currentTime: ytPlayer.getCurrentTime() });
        }
      }
    }
  });
};

// ---------- mode switching ----------
function setMode(mode) {
  activeMode = mode;
  emptyEl.style.display = mode ? 'none' : 'block';
  ytWrap.style.display = mode === 'youtube' ? 'block' : 'none';
  nativeEl.style.display = mode === 'url' ? 'block' : 'none';
  extInfoEl.style.display = mode === 'extension' ? 'block' : 'none';
}

function extractYoutubeId(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const parts = u.pathname.split('/');
    const i = parts.indexOf('embed');
    if (i >= 0 && parts[i + 1]) return parts[i + 1];
    const s = parts.indexOf('shorts');
    if (s >= 0 && parts[s + 1]) return parts[s + 1];
  } catch {}
  return url; // assume already an ID
}

function loadYoutube(value) {
  const id = extractYoutubeId(value);
  if (!id) return;
  if (!ytReady) { pendingYoutube = id; return; }
  ytPlayer.cueVideoById(id);
}

function loadUrl(url) {
  if (hls) { try { hls.destroy(); } catch {} hls = null; }
  if (/\.m3u8(\?|$)/i.test(url) && window.Hls && Hls.isSupported()) {
    hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(nativeEl);
  } else {
    nativeEl.src = url;
  }
}

// ---------- native video event hooks ----------
nativeEl.addEventListener('play', () => {
  if (suppress || activeMode !== 'url') return;
  broadcastPlayback({ playing: true, currentTime: nativeEl.currentTime });
});
nativeEl.addEventListener('pause', () => {
  if (suppress || activeMode !== 'url') return;
  broadcastPlayback({ playing: false, currentTime: nativeEl.currentTime });
});
nativeEl.addEventListener('seeked', () => {
  if (suppress || activeMode !== 'url') return;
  broadcastPlayback({ playing: !nativeEl.paused, currentTime: nativeEl.currentTime });
});

// ---------- broadcast (with debounce) ----------
let lastBroadcast = 0;
function broadcastPlayback(state) {
  const now = Date.now();
  if (now - lastBroadcast < 150) return;
  lastBroadcast = now;
  socket.emit('playback:update', state);
}

// ---------- apply remote playback ----------
function applyPlayback(p) {
  if (!activeMode || activeMode === 'extension') return;
  const drift = (Date.now() - p.updatedAt) / 1000;
  const target = p.playing ? p.currentTime + drift : p.currentTime;
  suppress = true;
  try {
    if (activeMode === 'youtube' && ytReady && ytPlayer) {
      const cur = ytPlayer.getCurrentTime() || 0;
      if (Math.abs(cur - target) > 1.0) ytPlayer.seekTo(target, true);
      if (p.playing) ytPlayer.playVideo();
      else ytPlayer.pauseVideo();
    } else if (activeMode === 'url') {
      if (Math.abs(nativeEl.currentTime - target) > 1.0) nativeEl.currentTime = target;
      if (p.playing) nativeEl.play().catch(() => {});
      else nativeEl.pause();
    }
  } finally {
    setTimeout(() => { suppress = false; }, 300);
  }
}

// ---------- source picker ----------
$('#loadSource').onclick = () => {
  const type = $('#sourceType').value;
  const value = $('#sourceValue').value.trim();
  if (type !== 'extension' && !value) { $('#sourceValue').focus(); return; }
  socket.emit('source:change', { type, value });
};
$('#sourceValue').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#loadSource').click();
});

$('#copyLink').onclick = () => {
  navigator.clipboard.writeText(location.href).catch(() => {});
  const btn = $('#copyLink');
  const orig = btn.textContent;
  btn.textContent = 'copied!';
  setTimeout(() => { btn.textContent = orig; }, 1200);
};

// ---------- socket events ----------
socket.on('room:state', (room) => {
  memberCache = room.members || [];
  renderMembers(memberCache);
  (room.chat || []).forEach(addChatMessage);
  if (room.source) applySource(room.source);
  if (room.playback && room.source) {
    setTimeout(() => applyPlayback(room.playback), 600);
  }
});

socket.on('room:member', ({ joined, left }) => {
  if (joined) memberCache.push(joined);
  if (left) memberCache = memberCache.filter(m => m.id !== left.id);
  renderMembers(memberCache);
});

function renderMembers(members) {
  const ul = $('#members');
  ul.innerHTML = '';
  members.forEach(m => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = m.color;
    li.append(dot, document.createTextNode(m.name));
    ul.appendChild(li);
  });
}

socket.on('source:change', applySource);
function applySource(source) {
  setMode(source.type);
  if (source.type === 'youtube') loadYoutube(source.value);
  else if (source.type === 'url') loadUrl(source.value);
  else if (source.type === 'extension') {
    $('#ext-status').textContent = source.title
      ? 'Watching: ' + source.title
      : (source.value || 'Waiting for the browser extension to connect…');
  }
}

socket.on('playback:update', applyPlayback);

socket.on('extension:event', (evt) => {
  if (evt.kind === 'status' && activeMode === 'extension') {
    $('#ext-status').textContent = evt.text || 'Connected';
  }
});

socket.on('chat:message', addChatMessage);
function addChatMessage(m) {
  const log = $('#chat-log');
  const div = document.createElement('div');
  div.className = 'msg';
  const who = document.createElement('span');
  who.className = 'who';
  who.style.color = m.color;
  who.textContent = m.name;
  div.append(who, document.createTextNode(': ' + m.text));
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat:message', { text });
  input.value = '';
};
