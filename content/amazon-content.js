// amazon-content.js — runs on Amazon product + product-reviews pages.
//
// Unlike TikTok (JSON APIs), Amazon renders reviews as server-side HTML, so
// there is no response body to intercept. This script reads the reviews Amazon
// has ALREADY rendered into the page, normalizes them, and forwards them to the
// background worker. It never calls Amazon's servers itself — auto-pagination
// works by clicking Amazon's own "Next page" link, exactly what a user would do.
//
// The data-hook selectors below are the DOM dependency of this module and may
// need maintenance if Amazon restructures review markup.

const ASIN_RE =
  /\/(?:dp|gp\/product|gp\/aw\/d|product-reviews)\/([A-Z0-9]{10})(?:[/?]|$)/i;

let currentAsin = null;
let running = false;

// ---------------------------------------------------------------------------
// Context detection.
// ---------------------------------------------------------------------------
function readAsin() {
  const m = location.pathname.match(ASIN_RE);
  if (m) return m[1].toUpperCase();
  // Fallback: some pages expose ASIN on a hidden input or data attribute.
  const input = document.querySelector(
    'input#ASIN, input[name="ASIN"], [data-asin][data-asin!=""]'
  );
  const v = input?.value || input?.getAttribute?.("data-asin");
  return v && /^[A-Z0-9]{10}$/i.test(v) ? v.toUpperCase() : null;
}

function isReviewsPage() {
  return /\/product-reviews\//i.test(location.pathname);
}

function reportContext() {
  const asin = readAsin();
  if (asin !== currentAsin) {
    currentAsin = asin;
    chrome.runtime
      .sendMessage({ type: "AMAZON_CONTEXT", asin: currentAsin })
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers — defensive, never throw on a single malformed review.
// ---------------------------------------------------------------------------
const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

function parseRating(node) {
  const el = node.querySelector(
    '[data-hook="review-star-rating"] .a-icon-alt, [data-hook="cmps-review-star-rating"] .a-icon-alt, .a-icon-star .a-icon-alt'
  );
  const s = txt(el);
  const m = s.match(/([\d.,]+)\s*out of/i) || s.match(/^([\d.,]+)/);
  if (!m) return "";
  const num = parseFloat(m[1].replace(",", "."));
  return Number.isFinite(num) ? num : "";
}

function parseTitle(node) {
  const el = node.querySelector('[data-hook="review-title"]');
  if (!el) return "";
  // The title element often embeds the star-rating as a hidden ".a-icon-alt"
  // span; remove those before reading the visible title text.
  const clone = el.cloneNode(true);
  clone.querySelectorAll(".a-icon-alt, .a-letter-space").forEach((n) => n.remove());
  return txt(clone);
}

function parseDateLocation(node) {
  const raw = txt(node.querySelector('[data-hook="review-date"]'));
  let location = "";
  let isoDate = "";
  // Typical: "Reviewed in the United States on March 5, 2023"
  const m = raw.match(/in\s+(.+?)\s+on\s+(.+)$/i);
  if (m) {
    location = m[1].replace(/^the\s+/i, "").trim();
    const parsed = Date.parse(m[2]);
    if (!Number.isNaN(parsed)) isoDate = new Date(parsed).toISOString();
    return { date: isoDate || m[2].trim(), location, raw };
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) isoDate = new Date(parsed).toISOString();
  return { date: isoDate || raw, location, raw };
}

function parseHelpful(node) {
  const s = txt(node.querySelector('[data-hook="helpful-vote-statement"]'));
  if (!s) return 0;
  const m = s.match(/([\d,]+)/);
  if (m) return parseInt(m[1].replace(/,/g, ""), 10) || 0;
  // "One person found this helpful"
  return /one\b/i.test(s) ? 1 : 0;
}

function parseReviews(asin) {
  const nodes = document.querySelectorAll(
    '[data-hook="review"], [data-hook="cmps-review"]'
  );
  const rows = [];
  const capturedAt = new Date().toISOString();
  for (const node of nodes) {
    try {
      const reviewId = node.id || node.getAttribute("id") || "";
      const body = txt(node.querySelector('[data-hook="review-body"]'));
      if (!reviewId && !body) continue;
      const { date, location } = parseDateLocation(node);
      rows.push({
        review_id: reviewId,
        product_asin: asin || "",
        rating: parseRating(node),
        title: parseTitle(node),
        author: txt(node.querySelector(".a-profile-name")),
        review_date: date,
        location,
        verified_purchase: !!node.querySelector('[data-hook="avp-badge"]'),
        helpful_votes: parseHelpful(node),
        variant: txt(node.querySelector('[data-hook="format-strip"]')),
        review_text: body,
        captured_at: capturedAt,
      });
    } catch (err) {
      console.warn("[TTE] amazon review parse skipped:", err);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Capture flag persisted across page navigations (session-scoped).
// ---------------------------------------------------------------------------
const flagKey = (asin) => `azcap:${asin}`;

async function getFlag(asin) {
  try {
    const r = await chrome.storage.session.get(flagKey(asin));
    return r[flagKey(asin)] || null;
  } catch {
    return null;
  }
}
async function setFlag(asin, value) {
  try {
    await chrome.storage.session.set({ [flagKey(asin)]: value });
  } catch {}
}
async function clearFlag(asin) {
  try {
    await chrome.storage.session.remove(flagKey(asin));
  } catch {}
}

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function findNextPageLink() {
  const candidates = [
    "ul.a-pagination li.a-last:not(.a-disabled) a",
    "li.a-last:not(.a-disabled) a",
    'a[data-hook="pagination-bar-next"]',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function findSeeAllReviewsLink() {
  return document.querySelector(
    '[data-hook="see-all-reviews-link-foot"], a[href*="/product-reviews/"]'
  );
}

function reviewsUrl(asin) {
  return `${location.origin}/product-reviews/${asin}/?reviewerType=all_reviews&pageNumber=1`;
}

function notifyState(asin, capturing) {
  chrome.runtime
    .sendMessage({ type: "CAPTURE_STATE", id: asin, capturing })
    .catch(() => {});
}

function notifyComplete(asin) {
  chrome.runtime
    .sendMessage({ type: "CAPTURE_COMPLETE", id: asin })
    .catch(() => {});
}

// Parse the current page, push rows, then advance to the next page (or finish).
async function captureStep() {
  const asin = currentAsin;
  if (!asin) return;
  const flag = await getFlag(asin);
  if (!flag || !flag.capturing) {
    running = false;
    return;
  }

  const rows = parseReviews(asin);
  if (rows.length) {
    chrome.runtime
      .sendMessage({ type: "AMAZON_REVIEWS", asin, rows })
      .catch(() => {});
  }

  const page = (flag.page || 1) + 0;
  const maxPages = flag.maxPages || 0;

  // Stop if a page cap was set and reached.
  if (maxPages > 0 && page >= maxPages) {
    await clearFlag(asin);
    running = false;
    notifyComplete(asin);
    return;
  }

  // On the product page (no review pagination) jump to the full reviews page.
  if (!isReviewsPage()) {
    const link = findSeeAllReviewsLink();
    const target = link?.href || reviewsUrl(asin);
    await setFlag(asin, { capturing: true, page: 1, maxPages });
    setTimeout(() => {
      location.href = target;
    }, rand(800, 1600));
    return;
  }

  const next = findNextPageLink();
  if (!next) {
    // No further pages — done.
    await clearFlag(asin);
    running = false;
    notifyComplete(asin);
    return;
  }

  await setFlag(asin, { capturing: true, page: page + 1, maxPages });
  // Randomized human-like delay before clicking "Next page".
  setTimeout(() => {
    if (next.href) location.href = next.href;
    else next.click();
  }, rand(1500, 3500));
}

async function startCapture(options) {
  const asin = currentAsin || readAsin();
  if (!asin) return;
  currentAsin = asin;
  running = true;
  await setFlag(asin, {
    capturing: true,
    page: 1,
    maxPages: options?.maxPages || 0,
    autoPaginate: options?.autoPaginate !== false,
  });
  notifyState(asin, true);

  // If auto-pagination is disabled, just grab the current page once.
  if (options && options.autoPaginate === false) {
    const rows = parseReviews(asin);
    if (rows.length) {
      chrome.runtime.sendMessage({ type: "AMAZON_REVIEWS", asin, rows }).catch(() => {});
    }
    await clearFlag(asin);
    running = false;
    notifyComplete(asin);
    return;
  }

  captureStep();
}

async function stopCapture() {
  const asin = currentAsin;
  running = false;
  if (asin) {
    await clearFlag(asin);
    notifyState(asin, false);
  }
}

// ---------------------------------------------------------------------------
// Resume capture automatically after an auto-pagination navigation.
// ---------------------------------------------------------------------------
async function maybeResume() {
  const asin = readAsin();
  if (!asin) return;
  currentAsin = asin;
  const flag = await getFlag(asin);
  if (flag && flag.capturing && !running) {
    running = true;
    notifyState(asin, true);
    // Give SSR content a brief moment to settle, then capture this page.
    setTimeout(captureStep, rand(600, 1200));
  }
}

// ---------------------------------------------------------------------------
// Message handling from the popup.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "START_CAPTURE") {
    startCapture(msg.options || {});
    sendResponse({ ok: true, capturing: true });
  } else if (msg.type === "STOP_CAPTURE") {
    stopCapture();
    sendResponse({ ok: true, capturing: false });
  } else if (msg.type === "PING_CONTENT") {
    sendResponse({ ok: true, asin: currentAsin, running });
  }
  return true;
});

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
reportContext();
maybeResume();
// Amazon uses some client-side navigation; re-check context periodically.
setInterval(reportContext, 1000);
