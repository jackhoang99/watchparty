// Watches the page (and child frames) for <video> elements and bridges
// play / pause / seek events back to the watchparty service worker.

(function () {
  let video = null;
  let lastSent = 0;
  let suppress = false;

  function send(playing) {
    if (!video || suppress) return;
    const now = Date.now();
    if (now - lastSent < 150) return;
    lastSent = now;
    chrome.runtime.sendMessage({
      type: 'video-event',
      playing,
      currentTime: video.currentTime
    }).catch(() => {});
  }

  function attach(v) {
    if (video === v) return;
    video = v;
    v.addEventListener('play',   () => send(true));
    v.addEventListener('pause',  () => send(false));
    v.addEventListener('seeked', () => send(!v.paused));
    chrome.runtime.sendMessage({
      type: 'video-detected',
      url: location.href,
      title: document.title
    }).catch(() => {});
  }

  function scan() {
    const v = document.querySelector('video');
    if (v && v !== video) attach(v);
  }

  scan();
  const obs = new MutationObserver(scan);
  obs.observe(document.documentElement, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'apply-playback' || !video) return;
    const p = msg.playback;
    const drift = (Date.now() - p.updatedAt) / 1000;
    const target = p.playing ? p.currentTime + drift : p.currentTime;
    suppress = true;
    try {
      if (Math.abs(video.currentTime - target) > 1) video.currentTime = target;
      if (p.playing) video.play().catch(() => {});
      else video.pause();
    } finally {
      setTimeout(() => { suppress = false; }, 300);
    }
  });
})();
