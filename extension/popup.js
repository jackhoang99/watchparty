const $ = (s) => document.querySelector(s);

const serverInput = $('#server');
const roomInput = $('#room');
const connectBtn = $('#connectBtn');
const disconnectBtn = $('#disconnectBtn');
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const autoHint = $('#autoHint');
const howSection = $('#howSection');
const formSection = $('#formSection');
const connectedSection = $('#connectedSection');
const moviesList = $('#moviesList');
const moviesLabel = $('#moviesLabel');
const moviesCount = $('#moviesCount');

let isConnected = false;

// --- Auto-detect server + room from active tab ---
async function autoDetect() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    const url = new URL(tab.url);
    const roomMatch = url.pathname.match(/^\/r\/([^/]+)$/);
    if (roomMatch) {
      serverInput.value = url.origin;
      roomInput.value = decodeURIComponent(roomMatch[1]);
      autoHint.style.display = 'flex';
    }
  } catch {}
}

async function getCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  } catch { return null; }
}

// --- Update UI ---
function updateUI(connected, roomId) {
  isConnected = connected;
  if (connected) {
    statusDot.className = 'status-dot connected';
    statusText.innerHTML = 'Connected to room ';
    const badge = document.createElement('span');
    badge.className = 'status-room';
    badge.textContent = roomId;
    statusText.appendChild(badge);
    formSection.style.display = 'none';
    connectedSection.style.display = '';
    howSection.style.display = 'none';
    // Auto-crawl current page
    crawlCurrentPage();
  } else {
    statusDot.className = 'status-dot';
    statusText.textContent = 'Not connected';
    formSection.style.display = '';
    connectedSection.style.display = 'none';
    howSection.style.display = '';
  }
}

// --- Auto-crawl current page for movies ---
async function crawlCurrentPage() {
  const tab = await getCurrentTab();
  if (!tab?.id) {
    moviesList.innerHTML = '<div class="movies-empty">Open a streaming site to see movies</div>';
    return;
  }

  // Update label with site name
  try {
    const host = new URL(tab.url).hostname.replace('www.', '');
    moviesLabel.textContent = 'On ' + host;
  } catch {}

  moviesList.innerHTML = '<div class="movies-loading">Scanning page...</div>';

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'scrape-movies' });
    const movies = response?.movies || [];
    moviesCount.textContent = movies.length ? movies.length + ' found' : '';

    if (movies.length === 0) {
      moviesList.innerHTML = '<div class="movies-empty">No movies found on this page</div>';
      return;
    }

    moviesList.innerHTML = '';
    movies.forEach(movie => {
      const item = document.createElement('div');
      item.className = 'movie-item';
      item.innerHTML = `
        ${movie.poster ? `<img class="movie-poster" src="${esc(movie.poster)}" alt="" onerror="this.style.display='none'">` : '<div class="movie-poster"></div>'}
        <div class="movie-info">
          <div class="movie-title">${esc(movie.title)}</div>
          ${movie.meta ? `<div class="movie-meta">${esc(movie.meta)}</div>` : ''}
        </div>
        <button class="movie-go">Watch</button>
      `;
      const go = () => {
        // Set flag so content script auto-sends the video to room once detected
        chrome.storage.local.set({ autoSendToRoom: true });
        chrome.tabs.update(tab.id, { url: movie.url });
        window.close();
      };
      item.querySelector('.movie-go').onclick = (e) => { e.stopPropagation(); go(); };
      item.onclick = go;
      moviesList.appendChild(item);
    });
  } catch {
    moviesList.innerHTML = '<div class="movies-empty">Could not scan — try refreshing the page</div>';
  }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// --- Refresh from background ---
async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'get-status' });
  if (status.connected) {
    serverInput.value = status.serverUrl || '';
    roomInput.value = status.roomId || '';
    updateUI(true, status.roomId);
  } else if (status.roomId && status.serverUrl && status.serverUrl !== 'http://localhost:3000') {
    serverInput.value = status.serverUrl;
    roomInput.value = status.roomId;
    statusDot.className = 'status-dot error';
    statusText.textContent = 'Reconnecting...';
    connectBtn.textContent = 'Retry';
  } else {
    updateUI(false);
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
  let attempts = 0;
  const check = setInterval(async () => {
    attempts++;
    const status = await chrome.runtime.sendMessage({ type: 'get-status' });
    if (status.connected) {
      clearInterval(check);
      updateUI(true, roomId);
      connectBtn.textContent = 'Connect';
      connectBtn.disabled = false;
    } else if (attempts >= 8) {
      clearInterval(check);
      statusDot.className = 'status-dot error';
      statusText.textContent = 'Could not connect';
      connectBtn.textContent = 'Retry';
      connectBtn.disabled = false;
    }
  }, 500);
};

// --- Disconnect ---
disconnectBtn.onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' });
  updateUI(false);
  autoDetect();
};

roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isConnected) connectBtn.click(); });
serverInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isConnected) connectBtn.click(); });

refresh();
