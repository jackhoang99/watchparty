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

// --- Detect if current page is a movie page or a browse page ---
function isMoviePage(url) {
  try {
    const path = new URL(url).pathname;
    // Common movie/watch page patterns
    return /\/(w|watch|play|video|episode|phim|film|movie|v)\//i.test(path) ||
           /-(episode|id|tt)\d/i.test(path);
  } catch { return false; }
}

// --- Auto-crawl or show "send to room" based on page type ---
async function crawlCurrentPage() {
  const tab = await getCurrentTab();
  if (!tab?.id || !tab?.url) {
    moviesList.innerHTML = '<div class="movies-empty">Open a streaming site to see movies</div>';
    return;
  }

  let host;
  try { host = new URL(tab.url).hostname.replace('www.', ''); } catch { return; }

  // If we're on a movie/video page, show all detected video URLs to pick from
  if (isMoviePage(tab.url)) {
    moviesLabel.textContent = tab.title || 'Video page';
    moviesCount.textContent = '';
    moviesList.innerHTML = '<div class="movies-loading">Detecting video sources...</div>';

    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'get-all-video-urls' });
      const urls = resp?.urls || [];

      if (urls.length === 0) {
        moviesList.innerHTML = '<div class="movies-empty">No video URLs detected yet — try playing the video first, then reopen this popup</div>';
        return;
      }

      moviesCount.textContent = urls.length + ' source' + (urls.length > 1 ? 's' : '');
      moviesList.innerHTML = '';

      urls.forEach((entry, i) => {
        const item = document.createElement('div');
        item.className = 'movie-item';

        // Determine type label
        let typeLabel = 'Video';
        let typeColor = '#888';
        if (/\.m3u8/i.test(entry.url)) { typeLabel = 'HLS'; typeColor = '#e50914'; }
        else if (/\.mp4/i.test(entry.url)) { typeLabel = 'MP4'; typeColor = '#22c55e'; }
        else if (/\.webm/i.test(entry.url)) { typeLabel = 'WebM'; typeColor = '#3b82f6'; }

        // Truncate URL for display
        let displayUrl;
        try {
          const u = new URL(entry.url);
          displayUrl = u.pathname.split('/').pop() || u.pathname;
          if (displayUrl.length > 40) displayUrl = displayUrl.slice(0, 37) + '...';
        } catch {
          displayUrl = entry.url.slice(0, 40) + '...';
        }

        item.innerHTML = `
          <div style="
            background: ${typeColor}; color: #fff; font-size: 9px; font-weight: 800;
            padding: 2px 6px; border-radius: 3px; flex-shrink: 0; letter-spacing: 0.5px;
          ">${typeLabel}</div>
          <div class="movie-info">
            <div class="movie-title" style="font-size:11px">${esc(displayUrl)}</div>
            ${entry.source ? `<div class="movie-meta">${esc(entry.source)}</div>` : ''}
          </div>
          <button class="movie-go">Send</button>
        `;

        item.querySelector('.movie-go').onclick = async (e) => {
          e.stopPropagation();
          const btn = e.target;
          btn.textContent = '...';
          try {
            await chrome.runtime.sendMessage({ type: 'send-to-room', url: entry.url, title: tab.title || '' });
            btn.textContent = 'Sent!';
            btn.style.background = '#22c55e';
          } catch {
            btn.textContent = 'Error';
            btn.style.background = '#666';
          }
        };

        moviesList.appendChild(item);
      });
    } catch {
      moviesList.innerHTML = '<div class="movies-empty">Could not reach page — try refreshing</div>';
    }
    return;
  }

  // Otherwise, crawl the page for movie links
  moviesLabel.textContent = 'On ' + host;
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
