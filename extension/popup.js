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
const findMoviesBtn = $('#findMoviesBtn');
const movieModal = $('#movieModal');
const movieSearch = $('#movieSearch');
const movieResults = $('#movieResults');
const modalClose = $('#modalClose');
const siteLabel = $('#siteLabel');

let isConnected = false;
let currentTabUrl = '';

// --- Auto-detect server + room from active tab ---
async function autoDetect() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    currentTabUrl = tab.url;
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
    autoHint.style.display = 'none';
    // Update site label
    getCurrentTab().then(tab => {
      if (tab?.url) {
        try {
          const host = new URL(tab.url).hostname.replace('www.', '');
          siteLabel.textContent = `Search on ${host}`;
        } catch {
          siteLabel.textContent = 'Search on this site';
        }
      }
    });
  } else {
    statusDot.className = 'status-dot';
    statusText.textContent = 'Not connected';
    formSection.style.display = '';
    connectedSection.style.display = 'none';
    howSection.style.display = '';
  }
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

// ============================
// Find movies — crawl current page for all movie links
// ============================
let allMovies = []; // scraped from current page

findMoviesBtn.onclick = async () => {
  movieModal.classList.add('open');
  movieSearch.value = '';
  movieSearch.focus();
  movieResults.innerHTML = '<div class="modal-loading">Scanning page for movies...</div>';

  // Ask content script to scrape the current page
  const tab = await getCurrentTab();
  if (!tab?.id) {
    movieResults.innerHTML = '<div class="modal-empty">Open a streaming site first</div>';
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'scrape-movies' });
    allMovies = response?.movies || [];
    if (allMovies.length === 0) {
      movieResults.innerHTML = '<div class="modal-empty">No movies found on this page</div>';
    } else {
      renderResults(allMovies);
    }
  } catch {
    movieResults.innerHTML = '<div class="modal-empty">Could not scan this page — try refreshing</div>';
  }
};

modalClose.onclick = () => movieModal.classList.remove('open');

// Filter as user types
movieSearch.addEventListener('input', () => {
  const q = movieSearch.value.trim().toLowerCase();
  if (!q) {
    renderResults(allMovies);
    return;
  }
  const filtered = allMovies.filter(m => m.title.toLowerCase().includes(q));
  renderResults(filtered);
});

movieSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') movieModal.classList.remove('open');
});

function renderResults(results) {
  if (results.length === 0) {
    movieResults.innerHTML = '<div class="modal-empty">No matches</div>';
    return;
  }
  movieResults.innerHTML = '';
  results.forEach(movie => {
    const item = document.createElement('div');
    item.className = 'movie-item';
    item.innerHTML = `
      ${movie.poster ? `<img class="movie-poster" src="${escHtml(movie.poster)}" alt="" onerror="this.style.display='none'">` : '<div class="movie-poster" style="background:#1a1a1a"></div>'}
      <div class="movie-info">
        <div class="movie-title">${escHtml(movie.title)}</div>
        ${movie.meta ? `<div class="movie-year">${escHtml(movie.meta)}</div>` : ''}
      </div>
      <button class="movie-send">Watch</button>
    `;
    const go = () => {
      chrome.tabs.update({ url: movie.url });
      movieModal.classList.remove('open');
      window.close();
    };
    item.querySelector('.movie-send').onclick = (e) => { e.stopPropagation(); go(); };
    item.onclick = go;
    movieResults.appendChild(item);
  });
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

refresh();
