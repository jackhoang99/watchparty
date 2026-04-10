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

// ---------- WebRTC voice + video call ----------
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

let localStream = null;
let inCall = false;
const peers = new Map(); // remoteSocketId -> RTCPeerConnection

function nameForId(id) {
  const m = memberCache.find(x => x.id === id);
  return m ? m.name : 'guest';
}

async function joinCall() {
  if (inCall) return;
  $('#joinCallBtn').disabled = true;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 320 }, height: { ideal: 240 } }
    });
  } catch (err) {
    // Camera blocked or absent — fall back to audio-only
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      $('#joinCallBtn').disabled = false;
      alert('Could not access mic or camera: ' + (e?.message || e));
      return;
    }
  }
  inCall = true;
  addLocalTile();
  socket.emit('call:join');
  updateCallUI();
}

function leaveCall() {
  if (!inCall) return;
  socket.emit('call:leave');
  for (const [, pc] of peers) {
    try { pc.close(); } catch {}
  }
  peers.clear();
  document.querySelectorAll('#video-grid .video-tile').forEach(el => el.remove());
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  inCall = false;
  updateCallUI();
}

function createPeer(remoteId, isInitiator) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peers.set(remoteId, pc);

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('webrtc:signal', {
        to: remoteId,
        signal: { type: 'ice', candidate: e.candidate }
      });
    }
  };

  pc.ontrack = (e) => {
    addRemoteTile(remoteId, e.streams[0]);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      removeRemoteTile(remoteId);
      peers.delete(remoteId);
    }
  };

  if (isInitiator) {
    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc:signal', {
          to: remoteId,
          signal: { type: 'offer', sdp: pc.localDescription }
        });
      } catch (err) {
        console.warn('createOffer failed', err);
      }
    })();
  }

  return pc;
}

socket.on('call:peer-joined', ({ id }) => {
  if (!inCall || id === socket.id) return;
  // I'm an existing call member; the new joiner needs an offer from me
  createPeer(id, true);
});

socket.on('call:peer-left', ({ id }) => {
  const pc = peers.get(id);
  if (pc) { try { pc.close(); } catch {} }
  peers.delete(id);
  removeRemoteTile(id);
});

socket.on('webrtc:signal', async ({ from, signal }) => {
  if (!inCall) return;
  let pc = peers.get(from);
  if (!pc) {
    // Receiving an offer from a peer we don't yet know about — answer side
    pc = createPeer(from, false);
  }
  try {
    if (signal.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('webrtc:signal', {
        to: from,
        signal: { type: 'answer', sdp: pc.localDescription }
      });
    } else if (signal.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    } else if (signal.type === 'ice') {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  } catch (err) {
    console.warn('signal handling failed', err);
  }
});

// ---------- video tiles ----------
function addLocalTile() {
  const existing = document.getElementById('tile-local');
  if (existing) existing.remove();
  const tile = document.createElement('div');
  tile.className = 'video-tile local';
  tile.id = 'tile-local';
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true; // never play your own audio back to yourself
  video.playsInline = true;
  video.srcObject = localStream;
  const label = document.createElement('div');
  label.className = 'tile-label';
  label.textContent = 'You';
  const mutedTag = document.createElement('div');
  mutedTag.className = 'tile-muted';
  mutedTag.textContent = 'muted';
  tile.append(video, label, mutedTag);
  $('#video-grid').appendChild(tile);
}

function addRemoteTile(peerId, stream) {
  let tile = document.getElementById('tile-' + peerId);
  if (tile) {
    const video = tile.querySelector('video');
    if (video.srcObject !== stream) video.srcObject = stream;
    return;
  }
  tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = 'tile-' + peerId;
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;
  const label = document.createElement('div');
  label.className = 'tile-label';
  label.textContent = nameForId(peerId);
  tile.append(video, label);
  $('#video-grid').appendChild(tile);
}

function removeRemoteTile(peerId) {
  const t = document.getElementById('tile-' + peerId);
  if (t) t.remove();
}

// ---------- mic / cam toggles ----------
function toggleMic() {
  if (!localStream) return;
  const tracks = localStream.getAudioTracks();
  if (!tracks.length) return;
  const enabled = !tracks[0].enabled;
  tracks.forEach(t => t.enabled = enabled);
  const btn = $('#micBtn');
  btn.classList.toggle('off', !enabled);
  btn.textContent = enabled ? 'Mic on' : 'Mic off';
  document.getElementById('tile-local')?.classList.toggle('muted', !enabled);
}

function toggleCam() {
  if (!localStream) return;
  const tracks = localStream.getVideoTracks();
  if (!tracks.length) return;
  const enabled = !tracks[0].enabled;
  tracks.forEach(t => t.enabled = enabled);
  const btn = $('#camBtn');
  btn.classList.toggle('off', !enabled);
  btn.textContent = enabled ? 'Cam on' : 'Cam off';
}

function updateCallUI() {
  const joinBtn = $('#joinCallBtn');
  joinBtn.disabled = false;
  joinBtn.style.display = inCall ? 'none' : 'block';
  $('#callControls').classList.toggle('active', inCall);
}

$('#joinCallBtn').onclick = joinCall;
$('#leaveCallBtn').onclick = leaveCall;
$('#micBtn').onclick = toggleMic;
$('#camBtn').onclick = toggleCam;

// Clean up on tab close so peers see us leave promptly
window.addEventListener('beforeunload', () => {
  if (inCall) leaveCall();
});
