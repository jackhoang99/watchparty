const $ = (s) => document.querySelector(s);

const serverInput = $('#server');
const roomInput = $('#room');
const connectBtn = $('#connectBtn');
const disconnectBtn = $('#disconnectBtn');
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const statusBar = $('#statusBar');
const autoHint = $('#autoHint');
const howSection = $('#howSection');

let isConnected = false;

// --- Auto-detect server + room from active tab ---
async function autoDetect() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return false;
    const url = new URL(tab.url);
    const roomMatch = url.pathname.match(/^\/r\/([^/]+)$/);
    if (roomMatch) {
      const origin = url.origin;
      const roomId = decodeURIComponent(roomMatch[1]);
      if (!serverInput.value || serverInput.value === 'http://localhost:3000') {
        serverInput.value = origin;
      }
      if (!roomInput.value) {
        roomInput.value = roomId;
      }
      autoHint.style.display = 'flex';
      return true;
    }
  } catch {}
  return false;
}

// --- Update UI based on connection status ---
function updateUI(connected, roomId) {
  isConnected = connected;

  if (connected) {
    statusDot.className = 'status-dot connected';
    statusText.innerHTML = 'Connected to room ';
    const badge = document.createElement('span');
    badge.className = 'status-room';
    badge.textContent = roomId;
    statusText.appendChild(badge);
    connectBtn.style.display = 'none';
    disconnectBtn.style.display = '';
    serverInput.disabled = true;
    roomInput.disabled = true;
    howSection.style.display = 'none';
  } else {
    statusDot.className = 'status-dot';
    statusText.textContent = 'Not connected';
    connectBtn.style.display = '';
    disconnectBtn.style.display = 'none';
    serverInput.disabled = false;
    roomInput.disabled = false;
    howSection.style.display = '';
  }
}

function showError(msg) {
  statusDot.className = 'status-dot error';
  statusText.textContent = msg;
}

// --- Refresh status from background ---
async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'get-status' });
  serverInput.value = status.serverUrl || '';
  roomInput.value = status.roomId || '';

  if (status.connected) {
    updateUI(true, status.roomId);
  } else {
    updateUI(false);
    if (status.roomId && status.serverUrl) {
      showError('Connection failed — check server URL');
    }
    await autoDetect();
  }
}

// --- Connect ---
connectBtn.onclick = async () => {
  const roomId = roomInput.value.trim();
  const serverUrl = serverInput.value.trim();
  if (!serverUrl) { serverInput.focus(); return; }
  if (!roomId) { roomInput.focus(); return; }

  connectBtn.textContent = 'Connecting...';
  connectBtn.disabled = true;

  await chrome.runtime.sendMessage({ type: 'set-room', roomId, serverUrl });

  // Poll for connection
  let attempts = 0;
  const check = setInterval(async () => {
    attempts++;
    const status = await chrome.runtime.sendMessage({ type: 'get-status' });
    if (status.connected) {
      clearInterval(check);
      updateUI(true, roomId);
      connectBtn.textContent = 'Connect';
      connectBtn.disabled = false;
    } else if (attempts >= 6) {
      clearInterval(check);
      showError('Could not connect — is the server running?');
      connectBtn.textContent = 'Connect';
      connectBtn.disabled = false;
    }
  }, 500);
};

// --- Disconnect ---
disconnectBtn.onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' });
  updateUI(false);
  serverInput.disabled = false;
  roomInput.disabled = false;
};

// --- Enter to connect ---
roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !isConnected) connectBtn.click();
});
serverInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !isConnected) connectBtn.click();
});

refresh();
