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

// --- Enter to connect ---
roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isConnected) connectBtn.click(); });
serverInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isConnected) connectBtn.click(); });

// ============================
// Movie search modal
// ============================
findMoviesBtn.onclick = () => {
  movieModal.classList.add('open');
  movieSearch.value = '';
  movieSearch.focus();
  movieResults.innerHTML = '<div class="modal-empty">Search for a movie to watch together</div>';
};

modalClose.onclick = () => movieModal.classList.remove('open');

let searchTimeout = null;
movieSearch.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  const q = movieSearch.value.trim();
  if (!q) {
    movieResults.innerHTML = '<div class="modal-empty">Search for a movie to watch together</div>';
    return;
  }
  movieResults.innerHTML = '<div class="modal-loading">Searching...</div>';
  searchTimeout = setTimeout(() => searchMovies(q), 400);
});

movieSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') movieModal.classList.remove('open');
});

async function searchMovies(query) {
  try {
    // Use OMDB API (free tier: 1000 req/day)
    const res = await fetch(`https://www.omdbapi.com/?apikey=b2e31e43&s=${encodeURIComponent(query)}&type=movie`);
    const data = await res.json();

    if (data.Response === 'False' || !data.Search) {
      movieResults.innerHTML = '<div class="modal-empty">No movies found</div>';
      return;
    }

    movieResults.innerHTML = '';
    data.Search.forEach(movie => {
      const item = document.createElement('div');
      item.className = 'movie-item';
      item.innerHTML = `
        <img class="movie-poster" src="${movie.Poster !== 'N/A' ? movie.Poster : ''}" alt="" onerror="this.style.background='#222'">
        <div class="movie-info">
          <div class="movie-title">${escHtml(movie.Title)}</div>
          <div class="movie-year">${movie.Year}</div>
        </div>
        <button class="movie-send">Watch</button>
      `;
      item.querySelector('.movie-send').onclick = (e) => {
        e.stopPropagation();
        openOnFshare(movie.Title, movie.Year);
      };
      item.onclick = () => openOnFshare(movie.Title, movie.Year);
      movieResults.appendChild(item);
    });
  } catch (err) {
    movieResults.innerHTML = '<div class="modal-empty">Search failed — try again</div>';
  }
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// Open the movie on fshare in a new tab so the user can start it
// The content script will detect the video and show "Watch in party"
function openOnFshare(title, year) {
  const query = `${title} ${year}`.trim();
  const url = `https://fsharetv.com/search?q=${encodeURIComponent(query)}`;
  chrome.tabs.create({ url });
  movieModal.classList.remove('open');
  window.close();
}

refresh();
