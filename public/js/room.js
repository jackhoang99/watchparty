const $ = (s) => document.querySelector(s);
const roomId = decodeURIComponent(location.pathname.split('/').pop());
$('#roomId').textContent = roomId;
document.title = `room ${roomId} · watchparty`;

const name = localStorage.getItem('wp.name') || 'guest';
const myNameInput = $('#myName');
myNameInput.value = name;

// Stable user ID — survives refresh, ensures server can deduplicate
let uid = localStorage.getItem('wp.uid');
if (!uid) { uid = crypto.randomUUID(); localStorage.setItem('wp.uid', uid); }

const socket = io();
socket.emit('room:join', { roomId, name, uid });

// Editable name — save on button click or Enter
function commitNameChange() {
  const newName = myNameInput.value.trim().slice(0, 24) || 'guest';
  myNameInput.value = newName;
  localStorage.setItem('wp.name', newName);
  socket.emit('room:rename', { name: newName });
  // Brief visual feedback
  const btn = $('#saveName');
  btn.style.color = '#4ade80';
  setTimeout(() => { btn.style.color = ''; }, 800);
}
$('#saveName').onclick = commitNameChange;
myNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commitNameChange(); myNameInput.blur(); }
});

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
  emptyEl.style.display = mode ? 'none' : 'flex';
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

  // Hard-reset the player so any prior end-screen overlay / state is cleared.
  // Without this, cueing a new video while the previous one is in ENDED state
  // leaves the recommendations overlay stuck on top of the new video.
  suppress = true;
  try { ytPlayer.stopVideo(); } catch {}

  if (playback && playback.playing) {
    // Late joiner catching up to a playing room — load + autoplay at the right offset
    const drift = (Date.now() - playback.updatedAt) / 1000;
    const startSec = Math.max(0, (playback.currentTime || 0) + drift);
    ytPlayer.loadVideoById({ videoId: id, startSeconds: startSec });
  } else if (playback && !playback.playing) {
    // Room is paused at a known time — cue at that offset, don't autoplay
    ytPlayer.cueVideoById({ videoId: id, startSeconds: Math.max(0, playback.currentTime || 0) });
  } else {
    // Fresh load by the user who picked the source
    ytPlayer.cueVideoById(id);
  }
  setTimeout(() => { suppress = false; }, 1500);
}

function loadUrl(url) {
  if (hls) { try { hls.destroy(); } catch {} hls = null; }
  hideVideoError();
  if (/\.m3u8(\?|$)/i.test(url) && window.Hls && Hls.isSupported()) {
    hls = new Hls();
    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) showVideoError(url);
    });
    hls.loadSource(url);
    hls.attachMedia(nativeEl);
  } else {
    nativeEl.src = url;
  }
}

// Error overlay for restricted video URLs
nativeEl.addEventListener('error', () => {
  if (activeMode === 'url' && nativeEl.src) showVideoError(nativeEl.src);
});

function showVideoError(url) {
  let overlay = document.getElementById('video-error');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'video-error';
    overlay.style.cssText = 'position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.9);';
    document.querySelector('.player-area').appendChild(overlay);
  }
  overlay.innerHTML = `
    <div style="text-align:center;max-width:440px;padding:32px;">
      <div style="font-size:36px;margin-bottom:16px;">&#128274;</div>
      <h3 style="color:#fff;font-size:18px;font-weight:700;margin:0 0 10px;">This site blocks external playback</h3>
      <p style="color:#aaa;font-size:13px;line-height:1.6;margin:0 0 20px;">
        The video can't be loaded here because the streaming site restricts playback to their own domain.
        Use <strong style="color:#fff;">Sync Mode</strong> instead — everyone watches on the original site while the extension keeps you all at the same timestamp.
      </p>

      <div style="background:#141414;border:1px solid #333;border-radius:12px;padding:20px;text-align:left;margin-bottom:16px;">
        <div style="font-size:11px;color:#e50914;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">How Sync Mode works</div>
        <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;">
          <span style="background:#1a1a1a;border:1px solid #333;color:#e50914;font-size:10px;font-weight:700;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;">1</span>
          <span style="font-size:12px;color:#ccc;line-height:1.4;">Everyone installs the <strong style="color:#fff;">watchparty extension</strong> and connects to this room</span>
        </div>
        <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;">
          <span style="background:#1a1a1a;border:1px solid #333;color:#e50914;font-size:10px;font-weight:700;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;">2</span>
          <span style="font-size:12px;color:#ccc;line-height:1.4;">Everyone opens the <strong style="color:#fff;">same movie page</strong> on the streaming site in their own browser</span>
        </div>
        <div style="display:flex;align-items:flex-start;gap:10px;">
          <span style="background:#1a1a1a;border:1px solid #333;color:#e50914;font-size:10px;font-weight:700;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;">3</span>
          <span style="font-size:12px;color:#ccc;line-height:1.4;">Play, pause, or seek — the extension <strong style="color:#fff;">syncs everyone automatically</strong> in real time</span>
        </div>
      </div>

      <p style="color:#666;font-size:10px;margin:0;">Keep this room open for chat and video calls while watching</p>
    </div>
  `;
  overlay.style.display = 'flex';
}

function hideVideoError() {
  const overlay = document.getElementById('video-error');
  if (overlay) overlay.style.display = 'none';
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
let latestPlayback = null; // most recent known room playback state, for tab-switch resync
function broadcastPlayback(state) {
  const now = Date.now();
  if (now - lastBroadcast < 150) return;
  lastBroadcast = now;
  socket.emit('playback:update', state);
  latestPlayback = { ...state, updatedAt: now };
}

// ---------- apply remote playback ----------
function applyPlayback(p) {
  if (!activeMode || activeMode === 'extension') return;
  latestPlayback = p;
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
const cardVideo = document.getElementById('card-video');
const cardExtension = document.getElementById('card-extension');

function updateEmptyCards() {
  const type = $('#sourceType').value;
  if (cardVideo) cardVideo.style.display = type === 'extension' ? 'none' : '';
  if (cardExtension) cardExtension.style.display = type === 'extension' ? '' : 'none';
  // When switching to extension mode, show the empty state and hide any errors/players
  if (type === 'extension' && !activeMode) {
    hideVideoError();
    emptyEl.style.display = 'flex';
    ytWrap.style.display = 'none';
    nativeEl.style.display = 'none';
  }
}
$('#sourceType').addEventListener('change', () => {
  updateEmptyCards();
  // Broadcast the source type change to everyone in the room
  socket.emit('sourceType:change', { type: $('#sourceType').value });
});

socket.on('sourceType:change', ({ type }) => {
  if ($('#sourceType').value !== type) {
    $('#sourceType').value = type;
    updateEmptyCards();
  }
});

updateEmptyCards(); // set initial state

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
  if (joined) {
    memberCache.push(joined);
    // If I'm in a call, initiate a connection to the new member so they can see my webcam
    if (inCall && joined.id !== socket.id && !peers.has(joined.id)) {
      createPeer(joined.id, true);
    }
  }
  if (left) memberCache = memberCache.filter(m => m.id !== left.id);
  renderMembers(memberCache);
});

// Full member list refresh (e.g. after a rename)
socket.on('room:members', (members) => {
  memberCache = members;
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

    const isMe = m.id === socket.id;

    if (isMe) {
      // Editable name: show text + pencil icon, click to edit inline
      const nameSpan = document.createElement('span');
      nameSpan.textContent = m.name;
      nameSpan.className = 'member-name';

      const editBtn = document.createElement('button');
      editBtn.className = 'edit-name-btn';
      editBtn.title = 'Edit name';
      editBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';

      const nameInput = document.createElement('input');
      nameInput.className = 'edit-name-input';
      nameInput.value = m.name;
      nameInput.maxLength = 24;
      nameInput.style.display = 'none';

      editBtn.onclick = () => {
        nameSpan.style.display = 'none';
        editBtn.style.display = 'none';
        nameInput.style.display = '';
        nameInput.focus();
        nameInput.select();
      };

      const commitEdit = () => {
        const newName = nameInput.value.trim().slice(0, 24) || 'guest';
        nameInput.style.display = 'none';
        nameSpan.textContent = newName;
        nameSpan.style.display = '';
        editBtn.style.display = '';
        localStorage.setItem('wp.name', newName);
        myNameInput.value = newName;
        socket.emit('room:rename', { name: newName });
      };

      nameInput.addEventListener('blur', commitEdit);
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
        if (e.key === 'Escape') { nameInput.value = m.name; nameInput.blur(); }
      });

      li.append(dot, nameSpan, editBtn, nameInput);
      li.classList.add('me');
    } else {
      li.append(dot, document.createTextNode(m.name));
    }

    ul.appendChild(li);
  });
}

socket.on('source:change', (source) => applySource(source, null));
function applySource(source, playback) {
  hideVideoError();
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
// ICE servers — fetched from server (includes TURN if configured)
let ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
fetch('/api/turn').then(r => r.json()).then(servers => {
  if (Array.isArray(servers) && servers.length) ICE_SERVERS = servers;
}).catch(() => {});

let localStream = null;
let rawStream = null;
let inCall = false;
const peers = new Map();

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

// Canvas pipeline for beauty filters
function setupProcessedStream(source) {
  const videoTrack = source.getVideoTracks()[0];
  if (!videoTrack) return source;

  processCanvas = document.createElement('canvas');
  processCtx = processCanvas.getContext('2d');
  const settings = videoTrack.getSettings();
  processCanvas.width = settings.width || 320;
  processCanvas.height = settings.height || 240;

  processVideo = document.createElement('video');
  processVideo.srcObject = new MediaStream([videoTrack]);
  processVideo.muted = true;
  processVideo.playsInline = true;

  const syncCanvasSize = () => {
    if (!processVideo) return;
    const vw = processVideo.videoWidth;
    const vh = processVideo.videoHeight;
    if (vw && vh && (processCanvas.width !== vw || processCanvas.height !== vh)) {
      processCanvas.width = vw;
      processCanvas.height = vh;
    }
  };
  processVideo.addEventListener('loadedmetadata', syncCanvasSize);
  processVideo.addEventListener('resize', syncCanvasSize);
  processVideo.play().catch(() => {});

  const draw = () => {
    if (processVideo && processVideo.readyState >= 2) {
      if (processCanvas.width !== processVideo.videoWidth ||
          processCanvas.height !== processVideo.videoHeight) {
        syncCanvasSize();
      }
      processCtx.filter = FILTERS[filterIdx].css;
      processCtx.drawImage(processVideo, 0, 0, processCanvas.width, processCanvas.height);
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
  const label = $('#filterBtn .filter-label');
  if (label) label.textContent = f.name;
  $('#filterBtn').classList.toggle('on', filterIdx !== 0);
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
  createPeer(id, true);
});

socket.on('call:roster', ({ members }) => {
  if (!inCall) return;
  for (const id of members) {
    if (id === socket.id || peers.has(id)) continue;
    setTimeout(() => {
      if (!peers.has(id) && inCall) createPeer(id, true);
    }, 2000);
  }
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
  $('#micBtn').classList.toggle('off', !enabled);
  document.getElementById('tile-local')?.classList.toggle('muted', !enabled);
}

function toggleCam() {
  if (!rawStream) return;
  const tracks = rawStream.getVideoTracks();
  if (!tracks.length) return;
  const enabled = !tracks[0].enabled;
  tracks.forEach(t => t.enabled = enabled);
  $('#camBtn').classList.toggle('off', !enabled);
}

function updateCallUI() {
  const joinBtn = $('#joinCallBtn');
  joinBtn.disabled = false;
  joinBtn.style.display = inCall ? 'none' : 'block';
  joinBtn.textContent = 'Turn on mic + camera';
  $('#callControls').classList.toggle('active', inCall);
  $('#micBtn').classList.remove('off');
  $('#camBtn').classList.remove('off');
  const fl = $('#filterBtn .filter-label');
  if (fl) fl.textContent = FILTERS[filterIdx].name === 'Filter' ? 'Filter' : FILTERS[filterIdx].name;
  $('#filterBtn').classList.toggle('on', filterIdx !== 0);
}

$('#joinCallBtn').onclick = joinCall;
$('#leaveCallBtn').onclick = leaveCall;
$('#micBtn').onclick = toggleMic;
$('#camBtn').onclick = toggleCam;
$('#filterBtn').onclick = cycleFilter;

// Clean up on tab close / refresh so peers see us leave instantly
window.addEventListener('beforeunload', () => {
  if (inCall) leaveCall();
  socket.disconnect();
});

// ---------- tab visibility ----------
// When the tab is hidden, the browser may auto-pause our YouTube player. Without
// guarding, that auto-pause would broadcast to everyone in the room and stop
// their video too. So: while hidden, suppress all outgoing playback events; when
// visible again, resync to whatever the room is currently playing.
let visibilitySuppressTimer = null;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    suppress = true;
    if (visibilitySuppressTimer) {
      clearTimeout(visibilitySuppressTimer);
      visibilitySuppressTimer = null;
    }
  } else {
    if (latestPlayback && activeMode && activeMode !== 'extension') {
      applyPlayback(latestPlayback);
    }
    if (visibilitySuppressTimer) clearTimeout(visibilitySuppressTimer);
    visibilitySuppressTimer = setTimeout(() => {
      suppress = false;
      visibilitySuppressTimer = null;
    }, 1200);
  }
});

// ---------- light/dark theme toggle ----------
(function() {
  const toggle = document.getElementById('themeToggle');
  const iconSun = document.getElementById('iconSun');
  const iconMoon = document.getElementById('iconMoon');
  if (!toggle) return;

  function applyTheme(light) {
    document.body.classList.toggle('light', light);
    iconSun.classList.toggle('hidden', !light);
    iconMoon.classList.toggle('hidden', light);
    localStorage.setItem('wp.theme', light ? 'light' : 'dark');
  }

  // Restore saved preference
  applyTheme(localStorage.getItem('wp.theme') === 'light');

  toggle.onclick = () => applyTheme(!document.body.classList.contains('light'));
})();

// ---------- Virtual browser (Hyperbeam) ----------
(function() {
  const vbFrame = document.getElementById('vbrowser-frame');
  const vbBar = document.getElementById('vbrowser-bar');
  const vbStop = document.getElementById('vbrowser-stop');
  const startBtn = document.getElementById('startVbrowserBtn');
  const urlInput = document.getElementById('vbrowserUrlInput');
  if (!startBtn || !vbFrame) return;

  function showVbrowser(embedUrl) {
    vbFrame.src = embedUrl;
    vbFrame.style.display = 'block';
    vbBar.style.display = 'flex';
    emptyEl.style.display = 'none';
    ytWrap.style.display = 'none';
    nativeEl.style.display = 'none';
    hideVideoError();
  }

  function hideVbrowser() {
    vbFrame.src = '';
    vbFrame.style.display = 'none';
    vbBar.style.display = 'none';
    if (!activeMode) emptyEl.style.display = 'flex';
  }

  // Start virtual browser
  startBtn.onclick = () => {
    const url = urlInput.value.trim() || 'https://google.com';
    startBtn.textContent = 'Launching...';
    startBtn.disabled = true;
    socket.emit('vbrowser:start', { url });
  };

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startBtn.click();
  });

  // Stop virtual browser
  vbStop.onclick = () => {
    socket.emit('vbrowser:stop');
  };

  // Server events
  socket.on('vbrowser:started', (data) => {
    showVbrowser(data.embedUrl);
    startBtn.textContent = 'Launch';
    startBtn.disabled = false;
  });

  socket.on('vbrowser:stopped', () => {
    hideVbrowser();
  });

  socket.on('vbrowser:error', ({ message }) => {
    startBtn.textContent = 'Launch';
    startBtn.disabled = false;
    // Show error inline instead of alert
    let errEl = document.getElementById('vbrowser-error');
    if (!errEl) {
      errEl = document.createElement('p');
      errEl.id = 'vbrowser-error';
      errEl.style.cssText = 'font-size:11px;color:#ff6b6b;margin-top:8px;';
      startBtn.parentElement.appendChild(errEl);
    }
    if (message.includes('429')) {
      errEl.textContent = 'Rate limit reached — wait a few minutes and try again, or upgrade your Hyperbeam plan.';
    } else {
      errEl.textContent = message;
    }
  });

  // Late joiner — check if a vbrowser session is already active
  const origRoomState = socket.listeners('room:state');
  socket.on('room:state', (room) => {
    if (room.vbrowser?.embedUrl) {
      showVbrowser(room.vbrowser.embedUrl);
    }
  });
})();

