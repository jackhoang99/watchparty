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
let pendingYoutube = null; // { value, playback } queued until YT API is ready
let pendingPlayback = null; // playback to re-apply once YT player can accept it
let lastLoadedYTId = null;
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
          const p = pendingYoutube;
          pendingYoutube = null;
          loadYoutube(p.value, p.playback);
        }
      },
      onStateChange: (e) => {
        // Once the video is actually cued/playing, drain any pending playback sync
        if ((e.data === YT.PlayerState.CUED || e.data === YT.PlayerState.PLAYING) && pendingPlayback) {
          const p = pendingPlayback;
          pendingPlayback = null;
          setTimeout(() => applyPlayback(p), 100);
        }
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

function loadYoutube(value, playback) {
  const id = extractYoutubeId(value);
  if (!id) return;
  if (!ytReady) {
    pendingYoutube = { value, playback: playback || null };
    return;
  }
  // If we're already on this video and just need a sync, reuse the player
  if (id === lastLoadedYTId) {
    if (playback) applyPlayback(playback);
    return;
  }
  lastLoadedYTId = id;

  if (playback && playback.playing) {
    // Late joiner catching up to a playing room — load + autoplay at the right offset
    const drift = (Date.now() - playback.updatedAt) / 1000;
    const startSec = Math.max(0, (playback.currentTime || 0) + drift);
    suppress = true;
    ytPlayer.loadVideoById({ videoId: id, startSeconds: startSec });
    setTimeout(() => { suppress = false; }, 1500);
  } else if (playback && !playback.playing) {
    // Room is paused at a known time — cue at that offset, don't autoplay
    suppress = true;
    ytPlayer.cueVideoById({ videoId: id, startSeconds: Math.max(0, playback.currentTime || 0) });
    setTimeout(() => { suppress = false; }, 1500);
  } else {
    // Fresh load by the user who picked the source
    ytPlayer.cueVideoById(id);
  }
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
  // YT not ready yet — stash and re-apply once it is (drained from onStateChange)
  if (activeMode === 'youtube' && (!ytReady || !ytPlayer)) {
    pendingPlayback = p;
    return;
  }
  const drift = (Date.now() - p.updatedAt) / 1000;
  const target = p.playing ? p.currentTime + drift : p.currentTime;
  suppress = true;
  try {
    if (activeMode === 'youtube') {
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
  if (room.source) applySource(room.source, room.playback || null);
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

socket.on('source:change', (source) => applySource(source, null));
function applySource(source, playback) {
  setMode(source.type);
  if (source.type === 'youtube') loadYoutube(source.value, playback);
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

let localStream = null;       // what we send to peers (canvas-processed when video is on)
let rawStream = null;         // what getUserMedia gave us (real camera + mic)
let inCall = false;
const peers = new Map();      // remoteSocketId -> RTCPeerConnection

// Beauty filter pipeline (canvas-based, applies to outgoing video)
const FILTERS = [
  { name: 'Filter', css: 'none' },
  { name: 'Soft',   css: 'blur(0.6px) brightness(1.06) contrast(0.96) saturate(1.08)' },
  { name: 'Glow',   css: 'blur(0.4px) brightness(1.15) saturate(1.22) contrast(1.02)' },
  { name: 'Dreamy', css: 'blur(1.4px) brightness(1.12) saturate(1.18) hue-rotate(-6deg)' }
];
let filterIdx = 0;
let processCanvas = null;
let processCtx = null;
let processVideo = null;
let processRAF = null;

function nameForId(id) {
  const m = memberCache.find(x => x.id === id);
  return m ? m.name : 'guest';
}

async function joinCall() {
  if (inCall) return;
  $('#joinCallBtn').disabled = true;
  try {
    rawStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 320 }, height: { ideal: 240 } }
    });
  } catch (err) {
    // Camera blocked or absent — fall back to audio-only
    try {
      rawStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      $('#joinCallBtn').disabled = false;
      alert('Could not access mic or camera: ' + (e?.message || e));
      return;
    }
  }
  localStream = setupProcessedStream(rawStream);
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
  teardownProcessedStream();
  if (rawStream) {
    rawStream.getTracks().forEach(t => t.stop());
    rawStream = null;
  }
  localStream = null;
  inCall = false;
  filterIdx = 0;
  updateCallUI();
}

// Pipe the camera through a hidden canvas so we can apply CSS filters to the
// outgoing video track. Audio passes straight through. If there's no video,
// we just hand back the raw stream.
function setupProcessedStream(source) {
  const videoTrack = source.getVideoTracks()[0];
  if (!videoTrack) return source; // audio-only mode

  const settings = videoTrack.getSettings();
  const w = settings.width || 320;
  const h = settings.height || 240;

  processCanvas = document.createElement('canvas');
  processCanvas.width = w;
  processCanvas.height = h;
  processCtx = processCanvas.getContext('2d');

  processVideo = document.createElement('video');
  processVideo.srcObject = new MediaStream([videoTrack]);
  processVideo.muted = true;
  processVideo.playsInline = true;
  processVideo.play().catch(() => {});

  const draw = () => {
    if (processVideo && processVideo.readyState >= 2) {
      processCtx.filter = FILTERS[filterIdx].css;
      processCtx.drawImage(processVideo, 0, 0, w, h);
    }
    processRAF = requestAnimationFrame(draw);
  };
  draw();

  const canvasStream = processCanvas.captureStream(30);
  const out = new MediaStream();
  canvasStream.getVideoTracks().forEach(t => out.addTrack(t));
  source.getAudioTracks().forEach(t => out.addTrack(t));
  return out;
}

function teardownProcessedStream() {
  if (processRAF) cancelAnimationFrame(processRAF);
  processRAF = null;
  if (processVideo) {
    try { processVideo.pause(); } catch {}
    processVideo.srcObject = null;
    processVideo = null;
  }
  processCanvas = null;
  processCtx = null;
}

function cycleFilter() {
  if (!inCall) return;
  filterIdx = (filterIdx + 1) % FILTERS.length;
  const f = FILTERS[filterIdx];
  const btn = $('#filterBtn');
  btn.textContent = f.name;
  btn.classList.toggle('on', filterIdx !== 0);
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
  if (!rawStream) return;
  const tracks = rawStream.getAudioTracks();
  if (!tracks.length) return;
  const enabled = !tracks[0].enabled;
  tracks.forEach(t => t.enabled = enabled);
  const btn = $('#micBtn');
  btn.classList.toggle('off', !enabled);
  btn.textContent = enabled ? 'Mic' : 'Mic off';
  document.getElementById('tile-local')?.classList.toggle('muted', !enabled);
}

function toggleCam() {
  if (!rawStream) return;
  const tracks = rawStream.getVideoTracks();
  if (!tracks.length) return;
  const enabled = !tracks[0].enabled;
  tracks.forEach(t => t.enabled = enabled);
  const btn = $('#camBtn');
  btn.classList.toggle('off', !enabled);
  btn.textContent = enabled ? 'Cam' : 'Cam off';
}

function updateCallUI() {
  const joinBtn = $('#joinCallBtn');
  joinBtn.disabled = false;
  joinBtn.style.display = inCall ? 'none' : 'block';
  $('#callControls').classList.toggle('active', inCall);
  // reset button labels each time
  $('#micBtn').textContent = 'Mic';
  $('#micBtn').classList.remove('off');
  $('#camBtn').textContent = 'Cam';
  $('#camBtn').classList.remove('off');
  $('#filterBtn').textContent = FILTERS[filterIdx].name;
  $('#filterBtn').classList.toggle('on', filterIdx !== 0);
}

$('#joinCallBtn').onclick = joinCall;
$('#leaveCallBtn').onclick = leaveCall;
$('#micBtn').onclick = toggleMic;
$('#camBtn').onclick = toggleCam;
$('#filterBtn').onclick = cycleFilter;

// Clean up on tab close so peers see us leave promptly
window.addEventListener('beforeunload', () => {
  if (inCall) leaveCall();
});
