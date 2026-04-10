// Detects video URLs on any page and shows a "Watch in party" button.
// When clicked, sends the video URL to the watchparty room so everyone can watch.

(function () {
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
    if (button) return;
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
    const url = currentVideo ? getVideoUrl(currentVideo) : null;
    if (!url) {
      showFeedback('No playable URL found', false);
      return;
    }

    try {
      await chrome.runtime.sendMessage({
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

  // --- Scan for videos and show button when appropriate ---
  function tryShowButton() {
    const video = document.querySelector('video');
    if (!video) { removeButton(); return; }
    currentVideo = video;

    // Check if we're connected to a room
    chrome.runtime.sendMessage({ type: 'get-status' }).then(status => {
      if (status?.connected) {
        const url = getVideoUrl(video);
        if (url || capturedUrls.size > 0) {
          createButton();
        }
      } else {
        removeButton();
      }
    }).catch(() => {});
  }

  // Scan on load and watch for DOM changes
  tryShowButton();
  const obs = new MutationObserver(tryShowButton);
  obs.observe(document.documentElement, { childList: true, subtree: true });

  // Re-check periodically (some players load video src lazily)
  setInterval(tryShowButton, 3000);

  // --- Still handle remote playback sync (for extension-to-extension mode) ---
  let suppress = false;
  function sendPlayback(playing) {
    if (!currentVideo || suppress) return;
    chrome.runtime.sendMessage({
      type: 'video-event',
      playing,
      currentTime: currentVideo.currentTime
    }).catch(() => {});
  }

  // Watch for video events
  const attachedVideos = new WeakSet();
  function attachEvents(v) {
    if (attachedVideos.has(v)) return;
    attachedVideos.add(v);
    v.addEventListener('play', () => sendPlayback(true));
    v.addEventListener('pause', () => sendPlayback(false));
    v.addEventListener('seeked', () => sendPlayback(!v.paused));
  }

  new MutationObserver(() => {
    const v = document.querySelector('video');
    if (v) attachEvents(v);
  }).observe(document.documentElement, { childList: true, subtree: true });
  const v = document.querySelector('video');
  if (v) attachEvents(v);

  chrome.runtime.onMessage.addListener((msg) => {
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
})();
