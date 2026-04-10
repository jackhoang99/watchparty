// Detects video URLs on any page and shows a "Watch in party" button.
// When clicked, sends the video URL to the watchparty room so everyone can watch.

(function () {
  // Guard: if extension was reloaded, old content scripts become zombies.
  // Check once and bail out if the context is dead.
  function isAlive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }
  if (!isAlive()) return;

  // Safe wrapper for chrome.runtime.sendMessage
  function safeSend(msg) {
    if (!isAlive()) return Promise.reject('dead');
    return chrome.runtime.sendMessage(msg);
  }

  let button = null;
  let currentVideo = null;
  const capturedUrls = new Set();

  // --- Capture video URLs from network requests (catches .m3u8, .mp4, etc.) ---
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (/\.(m3u8|mp4|webm|mkv)(\?|$)/i.test(entry.name)) {
          capturedUrls.add(entry.name);
          tryShowButton();
        }
      }
    });
    obs.observe({ type: 'resource', buffered: true });
  } catch {}

  // Page-level interceptor skipped — CSP on many sites blocks inline scripts.
  // We rely on PerformanceObserver + video element scanning instead, which work
  // in the content script's isolated world without CSP issues.

  // --- Find the best playable URL for a video element ---
  function getVideoUrl(video) {
    // 1. Check direct src (skip blob: URLs)
    if (video.currentSrc && !video.currentSrc.startsWith('blob:')) return video.currentSrc;
    if (video.src && !video.src.startsWith('blob:')) return video.src;

    // 2. Check <source> children
    const sources = video.querySelectorAll('source');
    for (const s of sources) {
      if (s.src && !s.src.startsWith('blob:')) return s.src;
    }

    // 3. Check captured network URLs (from PerformanceObserver)
    if (capturedUrls.size > 0) {
      // Prefer .m3u8 (HLS) over .mp4
      for (const url of capturedUrls) {
        if (/\.m3u8/i.test(url)) return url;
      }
      return capturedUrls.values().next().value;
    }

    return null;
  }

  // --- Create the floating button ---
  function createButton() {
    if (button || !isAlive()) return;
    button = document.createElement('div');
    button.innerHTML = `
      <div style="
        position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
        display: flex; align-items: center; gap: 8px;
        background: #e50914; color: white;
        font-family: -apple-system, system-ui, sans-serif;
        font-size: 14px; font-weight: 700;
        padding: 12px 20px; border-radius: 12px;
        cursor: pointer; user-select: none;
        box-shadow: 0 4px 20px rgba(229,9,20,0.4), 0 2px 8px rgba(0,0,0,0.3);
        transition: transform 0.15s, box-shadow 0.15s;
        line-height: 1;
      " id="wp-send-btn">
        <svg width="20" height="20" viewBox="0 0 48 46" style="flex-shrink:0">
          <path d="M13 24 L16 43 L32 43 L35 24 Z" fill="white" opacity="0.9"/>
          <circle cx="19" cy="21" r="4" fill="#e50914"/><circle cx="29" cy="21" r="4" fill="#e50914"/>
          <circle cx="24" cy="20" r="4.5" fill="#e50914"/><circle cx="24" cy="14" r="3" fill="#e50914"/>
        </svg>
        Watch in party
      </div>
    `;
    document.body.appendChild(button);

    const btn = button.querySelector('#wp-send-btn');
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'scale(1.05)';
      btn.style.boxShadow = '0 6px 28px rgba(229,9,20,0.5), 0 4px 12px rgba(0,0,0,0.4)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1)';
      btn.style.boxShadow = '0 4px 20px rgba(229,9,20,0.4), 0 2px 8px rgba(0,0,0,0.3)';
    });
    btn.addEventListener('click', sendToRoom);
  }

  function removeButton() {
    if (button) { button.remove(); button = null; }
  }

  // --- Send video URL to the room ---
  async function sendToRoom() {
    if (!isAlive()) return;
    const url = currentVideo ? getVideoUrl(currentVideo) : null;
    if (!url) {
      showFeedback('No playable URL found', false);
      return;
    }

    try {
      await safeSend({
        type: 'send-to-room',
        url: url,
        title: document.title
      });
      showFeedback('Sent to room!', true);
    } catch (e) {
      showFeedback('Not connected to a room', false);
    }
  }

  function showFeedback(text, success) {
    const btn = button?.querySelector('#wp-send-btn');
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.style.background = success ? '#22c55e' : '#666';
    btn.innerHTML = `<span>${text}</span>`;
    setTimeout(() => {
      btn.style.background = '#e50914';
      btn.innerHTML = orig;
    }, 2000);
  }

  // --- Auto-send: if popup navigated us here, auto-send once video is found ---
  let autoSendDone = false;

  function tryAutoSend() {
    if (autoSendDone || !isAlive()) return;
    const video = document.querySelector('video');
    if (!video) return;
    const url = getVideoUrl(video);
    if (!url) return;

    try {
      chrome.storage.local.get('autoSendToRoom', (data) => {
        if (chrome.runtime.lastError) return;
        if (data.autoSendToRoom && !autoSendDone) {
          autoSendDone = true;
          chrome.storage.local.remove('autoSendToRoom');
          safeSend({
            type: 'send-to-room',
            url: url,
            title: document.title
          }).then(() => {
            showFeedback('Sent to room!', true);
          }).catch(() => {});
        }
      });
    } catch {}
  }

  // --- Scan for videos and show button when appropriate ---
  function tryShowButton() {
    if (!isAlive()) { cleanup(); return; }
    const video = document.querySelector('video');
    if (!video) { removeButton(); return; }
    currentVideo = video;

    // Check if we're connected to a room
    safeSend({ type: 'get-status' }).then(status => {
      if (status?.connected) {
        const url = getVideoUrl(video);
        if (url || capturedUrls.size > 0) {
          createButton();
          tryAutoSend();
        }
      } else {
        removeButton();
      }
    }).catch(() => {});
  }

  // --- Single main loop: scans for videos, shows button, attaches events ---
  let suppress = false;
  const attachedVideos = new WeakSet();

  function sendPlayback(playing) {
    if (!currentVideo || suppress || !isAlive()) return;
    safeSend({ type: 'video-event', playing, currentTime: currentVideo.currentTime }).catch(() => {});
  }

  function mainScan() {
    if (!isAlive()) { cleanup(); return; }
    const v = document.querySelector('video');
    if (v && !attachedVideos.has(v)) {
      attachedVideos.add(v);
      v.addEventListener('play', () => sendPlayback(true));
      v.addEventListener('pause', () => sendPlayback(false));
      v.addEventListener('seeked', () => sendPlayback(!v.paused));
    }
    tryShowButton();
  }

  // One observer, one interval — both cleaned up if context dies
  const mainObs = new MutationObserver(mainScan);
  mainObs.observe(document.documentElement, { childList: true, subtree: true });
  const mainInterval = setInterval(() => {
    if (!isAlive()) { cleanup(); return; }
    mainScan();
  }, 3000);

  function cleanup() {
    mainObs.disconnect();
    clearInterval(mainInterval);
    removeButton();
  }

  mainScan();

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isAlive()) return;
    // --- Return the single best video URL ---
    if (msg.type === 'get-video-url') {
      const video = document.querySelector('video');
      const url = video ? getVideoUrl(video) : null;
      sendResponse({ url: url || null });
      return true;
    }

    // --- Return ALL detected video URLs on this page ---
    if (msg.type === 'get-all-video-urls') {
      const urls = getAllVideoUrls();
      sendResponse({ urls });
      return true;
    }

    // --- Scrape all movie/show links from the current page ---
    if (msg.type === 'scrape-movies') {
      const movies = scrapePageForMovies();
      sendResponse({ movies });
      return true;
    }

    if (msg.type !== 'apply-playback' || !currentVideo) return;
    const p = msg.playback;
    const drift = (Date.now() - p.updatedAt) / 1000;
    const target = p.playing ? p.currentTime + drift : p.currentTime;
    suppress = true;
    try {
      if (Math.abs(currentVideo.currentTime - target) > 1) currentVideo.currentTime = target;
      if (p.playing) currentVideo.play().catch(() => {});
      else currentVideo.pause();
    } finally {
      setTimeout(() => { suppress = false; }, 300);
    }
  });

  // --- Scrape all movie/show links from the current page ---
  function scrapePageForMovies() {
    const results = [];
    const seen = new Set();
    const hostname = location.hostname;

    // Gather all links on the page
    const allLinks = document.querySelectorAll('a[href]');

    for (const a of allLinks) {
      const href = a.getAttribute('href');
      if (!href || href === '#' || href === '/' || href.length < 3) continue;

      // Build full URL
      let fullUrl;
      try {
        fullUrl = new URL(href, location.origin).href;
      } catch { continue; }

      // Skip external links, anchors, static assets, nav links
      try {
        if (new URL(fullUrl).hostname !== hostname) continue;
      } catch { continue; }
      if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff)/i.test(fullUrl)) continue;
      if (/\/(search|login|register|signup|sign-in|auth|tag|category|page|user|api|about|contact|privacy|policy|faq|help|terms)\b/i.test(fullUrl)) continue;

      // Get title from: title attr > img alt > text content
      const img = a.querySelector('img');
      let title = (a.getAttribute('title') || '').trim();
      if (!title && img) title = (img.getAttribute('alt') || '').trim();
      if (!title) {
        // Get text but skip if it's too short or just whitespace
        const text = a.textContent.replace(/\s+/g, ' ').trim();
        if (text.length >= 2 && text.length <= 100) title = text;
      }
      if (!title || title.length < 2) continue;

      // Deduplicate by URL
      if (seen.has(fullUrl)) continue;
      seen.add(fullUrl);

      // Get poster image
      let poster = '';
      if (img) {
        poster = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('src') || '';
        // Make poster absolute
        if (poster && !poster.startsWith('http')) {
          try { poster = new URL(poster, location.origin).href; } catch { poster = ''; }
        }
      }

      // Get any metadata near the link (year, rating, etc.)
      let meta = '';
      const parent = a.closest('[class]') || a.parentElement;
      if (parent) {
        const metaEl = parent.querySelector('.year, .meta, .info, .rating, [class*="year"], [class*="quality"], [class*="rating"], span, small');
        if (metaEl && metaEl.textContent.trim().length < 30) {
          meta = metaEl.textContent.trim();
        }
      }

      results.push({ title: title.slice(0, 100), url: fullUrl, poster, meta });
      if (results.length >= 50) break;
    }

    // Sort: prefer links with posters (they're more likely to be actual movies)
    results.sort((a, b) => (b.poster ? 1 : 0) - (a.poster ? 1 : 0));

    return results;
  }

  // --- Get ALL video URLs found on this page ---
  function getAllVideoUrls() {
    const urls = [];
    const seen = new Set();

    // 0. Always include the page URL if it looks like a video page (YouTube, Vimeo, etc.)
    const pageUrl = location.href;
    const isVideoPage = /youtube\.com\/watch|youtu\.be\/|vimeo\.com\/\d|dailymotion\.com\/video/i.test(pageUrl);
    if (isVideoPage) {
      urls.push({ url: pageUrl, source: 'this page (YouTube/video link)' });
      seen.add(pageUrl);
    }

    // 1. From captured network requests (PerformanceObserver)
    for (const url of capturedUrls) {
      if (!seen.has(url)) {
        seen.add(url);
        urls.push({ url, source: 'network request' });
      }
    }

    // 2. From video elements
    document.querySelectorAll('video').forEach((v, i) => {
      const label = 'video element' + (i > 0 ? ' #' + (i + 1) : '');
      if (v.currentSrc && !v.currentSrc.startsWith('blob:') && !seen.has(v.currentSrc)) {
        seen.add(v.currentSrc);
        urls.push({ url: v.currentSrc, source: label });
      }
      if (v.src && !v.src.startsWith('blob:') && v.src !== v.currentSrc && !seen.has(v.src)) {
        seen.add(v.src);
        urls.push({ url: v.src, source: label + ' (src)' });
      }
      v.querySelectorAll('source').forEach(s => {
        if (s.src && !s.src.startsWith('blob:') && !seen.has(s.src)) {
          seen.add(s.src);
          urls.push({ url: s.src, source: label + ' (source tag)' });
        }
      });
    });

    // 3. Scan page for video URLs in script tags / iframes
    document.querySelectorAll('script').forEach(s => {
      const text = s.textContent || '';
      const matches = text.match(/https?:\/\/[^\s"'<>]+\.(m3u8|mp4|webm)(\?[^\s"'<>]*)*/gi);
      if (matches) {
        matches.forEach(url => {
          if (!seen.has(url)) {
            seen.add(url);
            urls.push({ url, source: 'page script' });
          }
        });
      }
    });

    // Sort: HLS first, then MP4, then others
    urls.sort((a, b) => {
      const scoreA = /\.m3u8/i.test(a.url) ? 2 : /\.mp4/i.test(a.url) ? 1 : 0;
      const scoreB = /\.m3u8/i.test(b.url) ? 2 : /\.mp4/i.test(b.url) ? 1 : 0;
      return scoreB - scoreA;
    });

    return urls;
  }
})();
