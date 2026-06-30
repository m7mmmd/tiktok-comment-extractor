// background.js — MV3 service worker.
//
// Central brain for two sources:
//   • TikTok  — receives raw comment API payloads (from the MAIN-world patch via
//               the content script), normalizes + dedups them here.
//   • Amazon  — receives already-normalized review rows (DOM-parsed in the
//               content script, since Amazon renders reviews as HTML).
//
// Datasets are keyed by item id (TikTok videoId or Amazon ASIN — these never
// collide), mirrored into chrome.storage.session in batched writes, surfaced on
// the toolbar badge, and served to the popup for state/rows/exports.

const BADGE_IDLE = "#5A5A5A";
const BADGE_ACTIVE = "#1DB954";

const TT_VIDEO_RE = /\/@[^/]+\/video\/(\d+)/;
const AMZN_ASIN_RE =
  /\/(?:dp|gp\/product|gp\/aw\/d|product-reviews)\/([A-Z0-9]{10})(?:[/?]|$)/i;

// In-memory state (rebuilt from storage.session on worker wake).
const datasets = new Map(); // id -> Map<itemId, row>
const sourceById = new Map(); // id -> "tiktok" | "amazon"
const capturingIds = new Set(); // ids with an active capture session
const commentsDisabled = new Set(); // TikTok ids flagged comments-disabled
const tabContext = new Map(); // tabId -> { source, id }

// ---------------------------------------------------------------------------
// Context detection from a URL.
// ---------------------------------------------------------------------------
function detectContext(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname;
  if (host.endsWith("tiktok.com")) {
    const m = u.pathname.match(TT_VIDEO_RE);
    if (m) return { source: "tiktok", id: m[1] };
  }
  if (/(^|\.)amazon\./.test(host)) {
    const m = u.pathname.match(AMZN_ASIN_RE);
    if (m) return { source: "amazon", id: m[1].toUpperCase() };
  }
  return null;
}

const rowId = (row) => row.comment_id ?? row.review_id ?? null;

// ===========================================================================
// TikTok normalization (STEP 0 RECON HOOK — verify field names in DevTools).
//
//   raw.cid                       -> comment_id
//   raw.text                      -> comment_text  (raw UTF-8, untouched)
//   raw.user.unique_id            -> username (@handle)
//   raw.user.nickname             -> display_name (may be Arabic/non-Latin)
//   raw.digg_count                -> like_count
//   raw.reply_comment_total       -> reply_count
//   raw.create_time (unix secs)   -> created_at (ISO 8601 UTC)
//   raw.aweme_id                  -> video_id
// ===========================================================================
function normalizeTikTok(raw, parentId, videoId) {
  try {
    const commentId = raw?.cid ?? raw?.comment_id ?? raw?.id ?? null;
    if (!commentId) {
      console.warn("[TTE] normalize: missing comment id, skipping", raw);
      return null;
    }
    const user = raw?.user ?? raw?.author ?? {};
    const createSecs = raw?.create_time ?? raw?.created_time ?? null;
    const createdAt =
      typeof createSecs === "number" && createSecs > 0
        ? new Date(createSecs * 1000).toISOString()
        : "";
    return {
      comment_id: String(commentId),
      parent_comment_id: parentId ? String(parentId) : "",
      is_reply: !!parentId,
      username: user?.unique_id ?? user?.uniqueId ?? user?.sec_uid ?? "",
      display_name: user?.nickname ?? user?.nick_name ?? "",
      comment_text: raw?.text ?? raw?.comment_text ?? "",
      like_count: raw?.digg_count ?? raw?.like_count ?? 0,
      reply_count: raw?.reply_comment_total ?? raw?.reply_count ?? 0,
      created_at: createdAt,
      video_id: String(raw?.aweme_id ?? videoId ?? ""),
      captured_at: new Date().toISOString(),
    };
  } catch (err) {
    console.warn("[TTE] normalize threw, skipping row:", err, raw);
    return null;
  }
}

function deriveParentId(url, payload) {
  try {
    const u = new URL(url);
    const fromUrl =
      u.searchParams.get("comment_id") || u.searchParams.get("item_id");
    if (fromUrl) return fromUrl;
  } catch {}
  return payload?.comment_id ?? payload?.reply_id ?? null;
}

// ---------------------------------------------------------------------------
// Dataset helpers.
// ---------------------------------------------------------------------------
function getDataset(id) {
  let map = datasets.get(id);
  if (!map) {
    map = new Map();
    datasets.set(id, map);
  }
  return map;
}

function countsFor(id) {
  const map = datasets.get(id);
  return map ? map.size : 0;
}

// ---------------------------------------------------------------------------
// TikTok payload ingestion.
// ---------------------------------------------------------------------------
function ingestTikTok({ kind, url, payload, videoId }) {
  const vid = String(videoId ?? payload?.comments?.[0]?.aweme_id ?? "");
  if (!vid) return;
  sourceById.set(vid, "tiktok");

  const list = Array.isArray(payload?.comments) ? payload.comments : null;
  if (kind === "list") {
    const disabledFlag =
      payload?.comment_config?.disabled ??
      payload?.comments_disabled ??
      (list === null && (payload?.status_code === 0 || payload?.total === 0));
    if (disabledFlag === true) commentsDisabled.add(vid);
  }

  if (!list || list.length === 0) {
    scheduleSave(vid);
    return;
  }
  commentsDisabled.delete(vid);

  const parentId = kind === "reply" ? deriveParentId(url, payload) : null;
  const map = getDataset(vid);

  for (const raw of list) {
    const row = normalizeTikTok(raw, parentId, vid);
    if (!row) continue;
    map.set(row.comment_id, row);

    const nested = Array.isArray(raw?.reply_comment) ? raw.reply_comment : null;
    if (nested) {
      for (const r2 of nested) {
        const childRow = normalizeTikTok(r2, row.comment_id, vid);
        if (childRow) map.set(childRow.comment_id, childRow);
      }
    }
  }

  scheduleSave(vid);
  updateBadgeForId(vid);
  pushStateUpdate(vid);
}

// ---------------------------------------------------------------------------
// Amazon row ingestion (rows arrive already normalized from the content script).
// ---------------------------------------------------------------------------
function ingestAmazon(asin, rows) {
  if (!asin || !Array.isArray(rows)) return;
  sourceById.set(asin, "amazon");
  const map = getDataset(asin);
  for (const row of rows) {
    if (!row) continue;
    const key =
      row.review_id || `${row.author || ""}|${(row.review_text || "").slice(0, 80)}`;
    if (!key) continue;
    map.set(key, row);
  }
  scheduleSave(asin);
  updateBadgeForId(asin);
  pushStateUpdate(asin);
}

// ---------------------------------------------------------------------------
// Batched persistence to chrome.storage.session (debounced ~500ms per id).
// ---------------------------------------------------------------------------
const saveTimers = new Map();
function scheduleSave(id) {
  if (saveTimers.has(id)) return;
  const t = setTimeout(() => {
    saveTimers.delete(id);
    persist(id);
  }, 500);
  saveTimers.set(id, t);
}

async function persist(id) {
  const map = datasets.get(id);
  const rows = map ? Array.from(map.values()) : [];
  try {
    await chrome.storage.session.set({
      [`dataset:${id}`]: rows,
      [`source:${id}`]: sourceById.get(id) || null,
      [`disabled:${id}`]: commentsDisabled.has(id),
    });
  } catch (err) {
    console.warn("[TTE] persist failed:", err);
  }
}

async function restore(id) {
  if (datasets.has(id)) return;
  try {
    const keys = [`dataset:${id}`, `source:${id}`, `disabled:${id}`];
    const stored = await chrome.storage.session.get(keys);
    const rows = stored[`dataset:${id}`];
    if (Array.isArray(rows)) {
      const map = new Map();
      for (const row of rows) {
        const key =
          rowId(row) ||
          `${row.author || ""}|${(row.review_text || "").slice(0, 80)}`;
        map.set(key, row);
      }
      datasets.set(id, map);
    }
    if (stored[`source:${id}`]) sourceById.set(id, stored[`source:${id}`]);
    if (stored[`disabled:${id}`]) commentsDisabled.add(id);
  } catch (err) {
    console.warn("[TTE] restore failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Badge.
// ---------------------------------------------------------------------------
function abbreviate(n) {
  if (n <= 999) return String(n);
  const k = n / 1000;
  return (k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")) + "k";
}

function tabsForId(id) {
  const ids = [];
  for (const [tabId, ctx] of tabContext.entries()) {
    if (ctx && ctx.id === id) ids.push(tabId);
  }
  return ids;
}

function setBadge(tabId, id) {
  if (!id) {
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    return;
  }
  const total = countsFor(id);
  const active = capturingIds.has(id);
  chrome.action
    .setBadgeBackgroundColor({ tabId, color: active ? BADGE_ACTIVE : BADGE_IDLE })
    .catch(() => {});
  chrome.action
    .setBadgeText({ tabId, text: total > 0 ? abbreviate(total) : "" })
    .catch(() => {});
}

function updateBadgeForId(id) {
  for (const tabId of tabsForId(id)) setBadge(tabId, id);
}

// ---------------------------------------------------------------------------
// State for the popup.
// ---------------------------------------------------------------------------
function buildState(id) {
  const source = id ? sourceById.get(id) || null : null;
  const map = id ? datasets.get(id) : null;
  const rows = map ? Array.from(map.values()) : [];

  const base = {
    source,
    id: id || null,
    videoId: id || null, // backward-compat alias
    total: rows.length,
    capturing: id ? capturingIds.has(id) : false,
  };

  if (source === "tiktok") {
    let topLevel = 0;
    let replies = 0;
    for (const row of rows) row.is_reply ? replies++ : topLevel++;
    base.topLevel = topLevel;
    base.replies = replies;
    base.commentsDisabled = id ? commentsDisabled.has(id) : false;
  } else if (source === "amazon") {
    let verified = 0;
    let sum = 0;
    let rated = 0;
    for (const row of rows) {
      if (row.verified_purchase) verified++;
      const r = Number(row.rating);
      if (r > 0) {
        sum += r;
        rated++;
      }
    }
    base.verified = verified;
    base.avgRating = rated ? Math.round((sum / rated) * 10) / 10 : 0;
  }
  return base;
}

function pushStateUpdate(id) {
  chrome.runtime
    .sendMessage({ type: "STATE_UPDATE", state: buildState(id) })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// MAIN-world injection on TikTok content-script request.
// ---------------------------------------------------------------------------
function injectMainWorld(tabId) {
  chrome.scripting
    .executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["content/injected.js"],
    })
    .catch((err) => console.warn("[TTE] MAIN-world injection failed:", err));
}

function setTabContext(tabId, source, id) {
  if (tabId == null) return;
  if (id) {
    tabContext.set(tabId, { source, id });
    sourceById.set(id, source);
    restore(id).then(() => setBadge(tabId, id));
  } else {
    tabContext.delete(tabId);
    setBadge(tabId, null);
  }
}

// ---------------------------------------------------------------------------
// Message routing.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id;
  const id = msg?.id ?? msg?.videoId ?? null;

  switch (msg?.type) {
    case "INJECT_MAIN_WORLD":
      if (tabId != null) injectMainWorld(tabId);
      sendResponse({ ok: true });
      return false;

    case "VIDEO_CONTEXT":
      setTabContext(tabId, "tiktok", msg.videoId || null);
      sendResponse({ ok: true });
      return false;

    case "AMAZON_CONTEXT":
      setTabContext(tabId, "amazon", msg.asin || null);
      sendResponse({ ok: true });
      return false;

    case "RAW_COMMENT_PAYLOAD":
      ingestTikTok(msg);
      sendResponse({ ok: true });
      return false;

    case "AMAZON_REVIEWS":
      ingestAmazon(msg.asin, msg.rows);
      sendResponse({ ok: true });
      return false;

    case "CAPTURE_STATE":
      if (id) {
        if (msg.capturing) capturingIds.add(id);
        else capturingIds.delete(id);
        updateBadgeForId(id);
        pushStateUpdate(id);
      }
      sendResponse({ ok: true });
      return false;

    case "CAPTURE_COMPLETE":
      if (id) {
        capturingIds.delete(id);
        updateBadgeForId(id);
        pushStateUpdate(id);
      }
      sendResponse({ ok: true });
      return false;

    case "GET_STATE":
      handleGetState(sendResponse);
      return true; // async

    case "GET_ROWS":
      handleGetRows(id, sendResponse);
      return true; // async

    case "CLEAR_REQUEST":
      handleClear(id, sendResponse);
      return true; // async

    default:
      return false;
  }
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function handleGetState(sendResponse) {
  const tab = await activeTab();
  const ctx = detectContext(tab?.url);
  if (ctx) {
    sourceById.set(ctx.id, ctx.source);
    await restore(ctx.id);
  }
  sendResponse({ ...buildState(ctx?.id || null), tabId: tab?.id ?? null });
}

async function handleGetRows(id, sendResponse) {
  if (!id) {
    sendResponse({ rows: [] });
    return;
  }
  await restore(id);
  const map = datasets.get(id);
  sendResponse({ rows: map ? Array.from(map.values()) : [] });
}

async function handleClear(id, sendResponse) {
  if (id) {
    datasets.delete(id);
    commentsDisabled.delete(id);
    try {
      await chrome.storage.session.remove([
        `dataset:${id}`,
        `source:${id}`,
        `disabled:${id}`,
      ]);
    } catch {}
    updateBadgeForId(id);
    pushStateUpdate(id);
  }
  sendResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// Tab lifecycle → keep badge in sync; clear when leaving a supported page.
// ---------------------------------------------------------------------------
function syncTabBadge(tabId, url) {
  const ctx = detectContext(url);
  setTabContext(tabId, ctx?.source || null, ctx?.id || null);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    syncTabBadge(tabId, changeInfo.url || tab?.url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    syncTabBadge(tabId, tab?.url);
  } catch {}
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabContext.delete(tabId);
});
