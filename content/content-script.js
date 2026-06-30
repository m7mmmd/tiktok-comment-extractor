// content-script.js — runs in the ISOLATED world.
//
// Responsibilities:
//   1. Ask background to inject injected.js into the MAIN world.
//   2. Bridge MAIN-world postMessage payloads to the background worker.
//   3. Track the current video ID across TikTok's SPA navigation.
//   4. Drive randomized auto-scroll + "view replies" expansion when capturing.
//
// It performs ZERO data parsing — the DOM is only touched to scroll and to find
// the comment panel / reply buttons. All schema work happens in background.js.

const SOURCE = "tte-injected";
const VIDEO_RE = /\/@[^/]+\/video\/(\d+)/;

let currentVideoId = null;
let capturing = false;
let scrollTimer = null;
let lastPayloadAt = 0;

// ---------------------------------------------------------------------------
// 1. Request MAIN-world injection (content scripts cannot call chrome.scripting).
// ---------------------------------------------------------------------------
chrome.runtime.sendMessage({ type: "INJECT_MAIN_WORLD" }).catch(() => {});

// ---------------------------------------------------------------------------
// 2. Bridge MAIN-world messages → background.
// ---------------------------------------------------------------------------
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== SOURCE) return;
  if (data.type !== "RAW_COMMENT_PAYLOAD") return;

  lastPayloadAt = Date.now();
  chrome.runtime
    .sendMessage({
      type: "RAW_COMMENT_PAYLOAD",
      kind: data.kind,
      url: data.url,
      payload: data.payload,
      videoId: currentVideoId,
    })
    .catch(() => {});
});

// ---------------------------------------------------------------------------
// 3. Video-ID tracking across SPA navigation (polling — simple and adequate).
// ---------------------------------------------------------------------------
function readVideoId() {
  const m = location.pathname.match(VIDEO_RE);
  return m ? m[1] : null;
}

function reportVideoId() {
  const id = readVideoId();
  if (id !== currentVideoId) {
    currentVideoId = id;
    // SPA navigation to a new video: abort any running capture loop.
    stopAutoScroll();
    chrome.runtime
      .sendMessage({ type: "VIDEO_CONTEXT", videoId: currentVideoId })
      .catch(() => {});
  }
}

reportVideoId();
setInterval(reportVideoId, 500);

// ---------------------------------------------------------------------------
// 4. Capture controls from popup.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "START_CAPTURE") {
    startAutoScroll();
    sendResponse({ ok: true, capturing: true });
  } else if (msg.type === "STOP_CAPTURE") {
    stopAutoScroll();
    sendResponse({ ok: true, capturing: false });
  } else if (msg.type === "PING_CONTENT") {
    sendResponse({ ok: true, videoId: currentVideoId, capturing });
  }
  return true;
});

// --- helpers ---------------------------------------------------------------

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// NOTE: these selectors are the single DOM dependency of the extension and may
// need maintenance if TikTok restructures its markup. We try several strategies.
function findCommentPanel() {
  const candidates = [
    '[class*="CommentListContainer"]',
    '[class*="DivCommentListContainer"]',
    '[data-e2e="comment-list"]',
    '[class*="comment-list"]',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

// Return the nearest scrollable ancestor of an element (or the panel itself).
function findScrollable(el) {
  let node = el;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    const oy = style.overflowY;
    if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function getScrollTarget() {
  const panel = findCommentPanel();
  if (panel) {
    const scrollable = findScrollable(panel) || findScrollable(panel.parentElement);
    if (scrollable) return scrollable;
  }
  // Fallback: whole document.
  return document.scrollingElement || document.documentElement;
}

function tryOpenCommentPanel() {
  if (findCommentPanel()) return;
  const openers = [
    '[data-e2e="comment-icon"]',
    '[data-e2e="browse-comment"]',
    'button[aria-label*="omment" i]',
    'span[data-e2e="comment-icon"]',
  ];
  for (const sel of openers) {
    const el = document.querySelector(sel);
    if (el) {
      el.click();
      return;
    }
  }
}

// Click any not-yet-expanded "view replies" toggles within view so the
// reply-list API fires. Selectors may need maintenance.
function expandSomeReplies() {
  const replySelectors = [
    '[data-e2e="comment-reply-show"]',
    'p[class*="ReplyAction"]',
    'span[class*="ReplyAction"]',
    'div[class*="ViewRepliesContainer"] span',
  ];
  for (const sel of replySelectors) {
    const nodes = document.querySelectorAll(sel);
    for (const node of nodes) {
      if (node.dataset.tteClicked) continue;
      const text = (node.textContent || "").toLowerCase();
      // Only click "view"/"show" affordances, not "hide".
      if (text.includes("hide")) continue;
      node.dataset.tteClicked = "1";
      try {
        node.click();
      } catch {}
      return; // one click per tick to stay human-paced
    }
  }
}

function startAutoScroll() {
  if (capturing) return;
  capturing = true;
  lastPayloadAt = Date.now();
  tryOpenCommentPanel();
  chrome.runtime
    .sendMessage({ type: "CAPTURE_STATE", capturing: true, videoId: currentVideoId })
    .catch(() => {});

  const tick = () => {
    if (!capturing) return;

    // End-of-list detection: no new payloads within a 6s window.
    if (Date.now() - lastPayloadAt > 6000) {
      stopAutoScroll();
      chrome.runtime
        .sendMessage({ type: "CAPTURE_COMPLETE", videoId: currentVideoId })
        .catch(() => {});
      return;
    }

    const target = getScrollTarget();
    if (target) {
      const distance = rand(400, 900);
      if (typeof target.scrollBy === "function") {
        target.scrollBy({ top: distance, behavior: "smooth" });
      } else {
        target.scrollTop += distance;
      }
    }

    // Interleave reply expansion roughly every other tick.
    if (Math.random() < 0.5) expandSomeReplies();

    // Anti-detection: randomized cadence, with a 1-in-8 longer "reading" pause.
    const interval = Math.random() < 0.125 ? rand(2000, 4000) : rand(700, 1400);
    scrollTimer = setTimeout(tick, interval);
  };

  scrollTimer = setTimeout(tick, rand(700, 1400));
}

function stopAutoScroll() {
  capturing = false;
  if (scrollTimer) {
    clearTimeout(scrollTimer);
    scrollTimer = null;
  }
  chrome.runtime
    .sendMessage({ type: "CAPTURE_STATE", capturing: false, videoId: currentVideoId })
    .catch(() => {});
}
