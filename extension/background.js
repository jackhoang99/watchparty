// MV3 service worker — bridges the active tab's <video> element to a watchparty room.

let ws = null;
let roomId = null;
let serverUrl = 'http://localhost:3000';
let reconnectTimer = null;

function log(...args) { console.log('[watchparty]', ...args); }

async function loadConfig() {
  const stored = await chrome.storage.local.get(['roomId', 'serverUrl']);
  roomId = stored.roomId || null;
  serverUrl = stored.serverUrl || 'http://localhost:3000';
}

async function connect() {
  await loadConfig();
  if (!roomId) { log('no room configured, skipping connect'); return; }

  try { if (ws) ws.close(); } catch {}
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  const wsUrl = serverUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/bridge';
  log('connecting to', wsUrl, 'room', roomId);

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    log('ws construct failed', err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    log('ws open');
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'join', roomId }));
    }
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'playback') {
      // Push to all tabs / frames; the content script ignores tabs without a video.
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(t => {
          chrome.tabs.sendMessage(t.id, { type: 'apply-playback', playback: msg.playback })
            .catch(() => {});
        });
      });
    }
  };

  ws.onclose = () => { log('ws close'); ws = null; scheduleReconnect(); };
  ws.onerror = (err) => { log('ws error', err); };
}

function scheduleReconnect() {
  if (!roomId) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'video-event') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'playback',
        playing: !!msg.playing,
        currentTime: Number(msg.currentTime) || 0
      }));
    }
  } else if (msg.type === 'video-detected') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'source',
        url: msg.url || (sender.url || ''),
        title: msg.title || ''
      }));
    }
  } else if (msg.type === 'set-room') {
    chrome.storage.local.set({
      roomId: msg.roomId,
      serverUrl: msg.serverUrl || 'http://localhost:3000'
    }).then(connect);
  } else if (msg.type === 'disconnect') {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try { if (ws) ws.close(); } catch {}
    ws = null;
    roomId = null;
    serverUrl = '';
    chrome.storage.local.remove(['roomId', 'serverUrl']);
    return Promise.resolve({ ok: true });
  } else if (msg.type === 'get-status') {
    return Promise.resolve({
      connected: !!(ws && ws.readyState === WebSocket.OPEN),
      roomId, serverUrl
    });
  }
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
