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
    const u = new URL(url);
    // YouTube watch pages
    if ((u.hostname.includes('youtube.com') && u.searchParams.has('v')) ||
        u.hostname.includes('youtu.be')) return true;
    // Vimeo, Dailymotion
    if (/vimeo\.com\/\d|dailymotion\.com\/video/i.test(url)) return true;
    // Common movie/watch page patterns
    return /\/(w|watch|play|video|episode|phim|film|movie|v)\//i.test(u.pathname) ||
           /-(episode|id|tt)\d/i.test(u.pathname);
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

  // If we're on a video page, show send options
  if (isMoviePage(tab.url)) {
    moviesLabel.textContent = tab.title || 'Video page';
    moviesCount.textContent = '';

    // Collect URLs: start with the page URL itself, then add detected streams
    const allUrls = [];

    // For YouTube/Vimeo — the page URL IS the video
    const isYT = /youtube\.com\/watch|youtu\.be\//i.test(tab.url);
    const isVimeo = /vimeo\.com\/\d/i.test(tab.url);
    if (isYT || isVimeo) {
      allUrls.push({ url: tab.url, source: isYT ? 'YouTube video' : 'Vimeo video', typeLabel: isYT ? 'YT' : 'Video', typeColor: '#e50914' });
    }

    // Also try to get detected stream URLs from content script
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'get-all-video-urls' });
      if (resp?.urls) {
        resp.urls.forEach(entry => {
          if (!allUrls.find(u => u.url === entry.url)) {
            let typeLabel = 'Video', typeColor = '#888';
            if (/\.m3u8/i.test(entry.url)) { typeLabel = 'HLS'; typeColor = '#e50914'; }
            else if (/\.mp4/i.test(entry.url)) { typeLabel = 'MP4'; typeColor = '#22c55e'; }
            else if (/\.webm/i.test(entry.url)) { typeLabel = 'WebM'; typeColor = '#3b82f6'; }
            else if (/youtube|youtu\.be/i.test(entry.url)) { typeLabel = 'YT'; typeColor = '#e50914'; }
            allUrls.push({ ...entry, typeLabel, typeColor });
          }
        });
      }
    } catch {}

    if (allUrls.length === 0) {
      moviesList.innerHTML = '<div class="movies-empty">No video detected — try playing the video first</div>';
      return;
    }

    moviesCount.textContent = allUrls.length + ' source' + (allUrls.length > 1 ? 's' : '');
    moviesList.innerHTML = '';

    allUrls.forEach(entry => {
      const item = document.createElement('div');
      item.className = 'movie-item';

      let displayUrl;
      try {
        const u = new URL(entry.url);
        if (/youtube|youtu\.be/i.test(entry.url)) {
          displayUrl = 'YouTube: ' + (u.searchParams.get('v') || u.pathname);
        } else {
          displayUrl = u.pathname.split('/').pop() || u.pathname;
        }
        if (displayUrl.length > 45) displayUrl = displayUrl.slice(0, 42) + '...';
      } catch { displayUrl = entry.url.slice(0, 42) + '...'; }

      item.innerHTML = `
        <div style="
          background: ${entry.typeColor || '#888'}; color: #fff; font-size: 9px; font-weight: 800;
          padding: 2px 6px; border-radius: 3px; flex-shrink: 0; letter-spacing: 0.5px;
        ">${esc(entry.typeLabel || 'Video')}</div>
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
          const status = await chrome.runtime.sendMessage({ type: 'get-status' });
          await chrome.runtime.sendMessage({ type: 'send-to-room', url: entry.url, title: tab.title || '' });
          // Redirect to the watchparty room
          if (status.serverUrl && status.roomId) {
            const roomUrl = status.serverUrl.replace(/\/$/, '') + '/r/' + encodeURIComponent(status.roomId);
            // Find existing room tab or open new one
            const tabs = await chrome.tabs.query({});
            const roomTab = tabs.find(t => t.url && t.url.includes('/r/' + status.roomId));
            if (roomTab) {
              chrome.tabs.update(roomTab.id, { active: true });
            } else {
              chrome.tabs.create({ url: roomUrl });
            }
          }
          window.close();
        } catch {
          btn.textContent = 'Error';
          btn.style.background = '#666';
        }
      };

      moviesList.appendChild(item);
    });
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
