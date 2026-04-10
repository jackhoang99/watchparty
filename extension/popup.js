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
// Find movies — search on the current site
// ============================
findMoviesBtn.onclick = () => {
  movieModal.classList.add('open');
  movieSearch.value = '';
  movieSearch.focus();
  movieResults.innerHTML = '<div class="modal-empty">Type a movie name to search on this site</div>';
};

modalClose.onclick = () => movieModal.classList.remove('open');

let searchTimeout = null;
movieSearch.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  const q = movieSearch.value.trim();
  if (!q) {
    movieResults.innerHTML = '<div class="modal-empty">Type a movie name to search on this site</div>';
    return;
  }
  movieResults.innerHTML = '<div class="modal-loading">Searching...</div>';
  searchTimeout = setTimeout(() => searchOnSite(q), 500);
});

movieSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') movieModal.classList.remove('open');
});

async function searchOnSite(query) {
  const tab = await getCurrentTab();
  if (!tab?.url) {
    movieResults.innerHTML = '<div class="modal-empty">Open a streaming site first</div>';
    return;
  }

  let hostname;
  try { hostname = new URL(tab.url).hostname; } catch { return; }

  // Build search URL based on the site
  let searchUrl;
  if (hostname.includes('fsharetv') || hostname.includes('fshare.tv')) {
    searchUrl = `https://${hostname}/search?q=${encodeURIComponent(query)}`;
  } else if (hostname.includes('phimmoichill') || hostname.includes('phimmoi')) {
    searchUrl = `https://${hostname}/tim-kiem/${encodeURIComponent(query)}`;
  } else {
    // Generic: try /search?q= (works on many sites)
    searchUrl = `https://${hostname}/search?q=${encodeURIComponent(query)}`;
  }

  try {
    // Fetch the search page and scrape results
    const res = await fetch(searchUrl);
    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Try to find movie links — look for common patterns
    const results = [];

    // Pattern 1: links with images (most movie sites)
    const links = doc.querySelectorAll('a[href]');
    const seen = new Set();

    for (const a of links) {
      const href = a.getAttribute('href');
      if (!href || href === '#' || href === '/') continue;

      // Skip non-movie links
      if (/\/(search|login|register|tag|category|page|user|api)\b/i.test(href)) continue;

      // Look for links that contain an image (movie poster)
      const img = a.querySelector('img');
      const title = (a.getAttribute('title') || a.textContent || '').trim();
      if (!title || title.length < 2 || title.length > 120) continue;

      // Deduplicate
      const key = title.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);

      let fullHref = href;
      if (href.startsWith('/')) fullHref = `https://${hostname}${href}`;

      // Must look like a movie/show page
      if (/\/(w|watch|phim|film|movie|video|episode|play|v)\//i.test(fullHref) || /-(id|episode)/i.test(fullHref)) {
        results.push({
          title: title.slice(0, 80),
          url: fullHref,
          poster: img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : ''
        });
      }

      if (results.length >= 12) break;
    }

    if (results.length === 0) {
      // Fallback: just show all links that look movie-ish
      for (const a of links) {
        const href = a.getAttribute('href');
        const title = (a.getAttribute('title') || a.textContent || '').trim();
        if (!href || !title || title.length < 3 || title.length > 100) continue;
        if (/\.(css|js|png|jpg|svg)/i.test(href)) continue;
        const key = title.toLowerCase().replace(/\s+/g, ' ');
        if (seen.has(key)) continue;
        seen.add(key);
        let fullHref = href.startsWith('/') ? `https://${hostname}${href}` : href;
        if (fullHref.startsWith('http')) {
          const img = a.querySelector('img');
          results.push({
            title: title.slice(0, 80),
            url: fullHref,
            poster: img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : ''
          });
        }
        if (results.length >= 10) break;
      }
    }

    renderResults(results);
  } catch (err) {
    movieResults.innerHTML = `<div class="modal-empty">Could not search on this site</div>`;
  }
}

function renderResults(results) {
  if (results.length === 0) {
    movieResults.innerHTML = '<div class="modal-empty">No results found</div>';
    return;
  }
  movieResults.innerHTML = '';
  results.forEach(movie => {
    const item = document.createElement('div');
    item.className = 'movie-item';
    item.innerHTML = `
      ${movie.poster ? `<img class="movie-poster" src="${escHtml(movie.poster)}" alt="" onerror="this.style.display='none'">` : ''}
      <div class="movie-info">
        <div class="movie-title">${escHtml(movie.title)}</div>
        <div class="movie-year" style="color:#666;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px">${escHtml(new URL(movie.url).pathname)}</div>
      </div>
      <button class="movie-send">Go</button>
    `;
    const goBtn = item.querySelector('.movie-send');
    const go = () => {
      chrome.tabs.create({ url: movie.url });
      movieModal.classList.remove('open');
      window.close();
    };
    goBtn.onclick = (e) => { e.stopPropagation(); go(); };
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
