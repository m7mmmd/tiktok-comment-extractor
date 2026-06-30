// background.js — MV3 service worker.
//
// Central brain: receives raw comment payloads from the content script, maps
// them to the canonical schema, dedupes by comment_id, mirrors per-video
// datasets into chrome.storage.session (batched), maintains the toolbar badge,
// and serves state/rows/exports to the popup.

const CANONICAL_COLUMNS = [
  "comment_id",
  "parent_comment_id",
  "is_reply",
  "username",
  "display_name",
  "comment_text",
  "like_count",
  "reply_count",
  "created_at",
  "video_id",
  "captured_at",
];

const BADGE_IDLE = "#5A5A5A";
const BADGE_ACTIVE = "#1DB954";
const VIDEO_RE = /\/@[^/]+\/video\/(\d+)/;

// In-memory state (rebuilt from storage.session on worker wake).
const datasets = new Map(); // videoId -> Map<commentId, row>
const capturingVideos = new Set(); // videoId currently auto-scrolling
const commentsDisabled = new Set(); // videoId flagged comments-disabled
const tabVideo = new Map(); // tabId -> videoId

// ---------------------------------------------------------------------------
// STEP 0 RECON HOOK — normalize().
//
// Maps TikTok's raw comment object to the canonical schema. The field names
// below reflect the last-known TikTok comment API shape and MUST be verified in
// DevTools at build time (TikTok rotates these). Everything uses optional
// chaining + nullish fallbacks so a renamed/missing field skips the row with a
// console warning instead of throwing.
//
//   raw.cid                       -> comment_id
//   raw.text                      -> comment_text  (raw UTF-8, untouched)
//   raw.user.unique_id            -> username (@handle)
//   raw.user.nickname             -> display_name (may be Arabic/non-Latin)
//   raw.digg_count                -> like_count
//   raw.reply_comment_total       -> reply_count
//   raw.create_time (unix secs)   -> created_at (ISO 8601 UTC)
//   raw.aweme_id                  -> video_id
// ---------------------------------------------------------------------------
function normalize(raw, parentId, videoId) {
  try {
    const commentId =
      raw?.cid ?? raw?.comment_id ?? raw?.id ?? null;
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

    const isReply = !!parentId;

    return {
      comment_id: String(commentId),
      parent_comment_id: parentId ? String(parentId) : "",
      is_reply: isReply,
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

// Derive the root comment id for a reply-list payload from the request URL
// (?comment_id=...) with a fallback to a field on the payload.
function deriveParentId(url, payload) {
  try {
    const u = new URL(url);
    const fromUrl =
      u.searchParams.get("comment_id") || u.searchParams.get("item_id");
    if (fromUrl) return fromUrl;
  } catch {}
  return payload?.comment_id ?? payload?.reply_id ?? null;
}

function getDataset(videoId) {
  let map = datasets.get(videoId);
  if (!map) {
    map = new Map();
    datasets.set(videoId, map);
  }
  return map;
}

function countsFor(videoId) {
  const map = datasets.get(videoId);
  let topLevel = 0;
  let replies = 0;
  if (map) {
    for (const row of map.values()) {
      if (row.is_reply) replies++;
      else topLevel++;
    }
  }
  return { total: topLevel + replies, topLevel, replies };
}

// ---------------------------------------------------------------------------
// Payload ingestion.
// ---------------------------------------------------------------------------
function ingest({ kind, url, payload, videoId }) {
  const vid = String(videoId ?? payload?.comments?.[0]?.aweme_id ?? "");
  if (!vid) return;

  // Comments-disabled detection (defensive — flag may move/rename).
  const list = Array.isArray(payload?.comments) ? payload.comments : null;
  if (kind === "list") {
    const disabledFlag =
      payload?.comment_config?.disabled ??
      payload?.comments_disabled ??
      (list === null && (payload?.status_code === 0 || payload?.total === 0));
    if (disabledFlag === true) {
      commentsDisabled.add(vid);
    }
  }

  if (!list || list.length === 0) {
    scheduleSave(vid);
    return;
  }
  commentsDisabled.delete(vid);

  const parentId = kind === "reply" ? deriveParentId(url, payload) : null;
  const map = getDataset(vid);

  for (const raw of list) {
    const row = normalize(raw, parentId, vid);
    if (!row) continue;
    map.set(row.comment_id, row); // dedup by comment_id

    // A reply-list response may also embed the reply's own sub-replies; if any
    // nested array exists, flatten it too (reply-to-reply via parent chain).
    const nested = Array.isArray(raw?.reply_comment) ? raw.reply_comment : null;
    if (nested) {
      for (const r2 of nested) {
        const childRow = normalize(r2, row.comment_id, vid);
        if (childRow) map.set(childRow.comment_id, childRow);
      }
    }
  }

  scheduleSave(vid);
  updateBadgeForVideo(vid);
  pushStateUpdate(vid);
}

// ---------------------------------------------------------------------------
// Batched persistence to chrome.storage.session (debounced ~500ms per video).
// ---------------------------------------------------------------------------
const saveTimers = new Map();
function scheduleSave(videoId) {
  if (saveTimers.has(videoId)) return;
  const t = setTimeout(() => {
    saveTimers.delete(videoId);
    persist(videoId);
  }, 500);
  saveTimers.set(videoId, t);
}

async function persist(videoId) {
  const map = datasets.get(videoId);
  const rows = map ? Array.from(map.values()) : [];
  try {
    await chrome.storage.session.set({
      [`dataset:${videoId}`]: rows,
      [`disabled:${videoId}`]: commentsDisabled.has(videoId),
    });
  } catch (err) {
    console.warn("[TTE] persist failed:", err);
  }
}

async function restoreVideo(videoId) {
  if (datasets.has(videoId)) return;
  try {
    const key = `dataset:${videoId}`;
    const dkey = `disabled:${videoId}`;
    const stored = await chrome.storage.session.get([key, dkey]);
    const rows = stored[key];
    if (Array.isArray(rows)) {
      const map = new Map();
      for (const row of rows) map.set(row.comment_id, row);
      datasets.set(videoId, map);
    }
    if (stored[dkey]) commentsDisabled.add(videoId);
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

function tabsForVideo(videoId) {
  const ids = [];
  for (const [tabId, vid] of tabVideo.entries()) {
    if (vid === videoId) ids.push(tabId);
  }
  return ids;
}

function setBadge(tabId, videoId) {
  if (!videoId) {
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    return;
  }
  const { total } = countsFor(videoId);
  const active = capturingVideos.has(videoId);
  chrome.action
    .setBadgeBackgroundColor({ tabId, color: active ? BADGE_ACTIVE : BADGE_IDLE })
    .catch(() => {});
  chrome.action
    .setBadgeText({ tabId, text: total > 0 ? abbreviate(total) : "" })
    .catch(() => {});
}

function updateBadgeForVideo(videoId) {
  for (const tabId of tabsForVideo(videoId)) setBadge(tabId, videoId);
}

// ---------------------------------------------------------------------------
// Push state to an open popup (best-effort; popup may be closed).
// ---------------------------------------------------------------------------
function buildState(videoId) {
  const counts = countsFor(videoId);
  return {
    videoId: videoId || null,
    ...counts,
    capturing: videoId ? capturingVideos.has(videoId) : false,
    commentsDisabled: videoId ? commentsDisabled.has(videoId) : false,
  };
}

function pushStateUpdate(videoId) {
  chrome.runtime
    .sendMessage({ type: "STATE_UPDATE", state: buildState(videoId) })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// MAIN-world injection on content-script request.
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

// ---------------------------------------------------------------------------
// Message routing.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id;

  switch (msg?.type) {
    case "INJECT_MAIN_WORLD":
      if (tabId != null) injectMainWorld(tabId);
      sendResponse({ ok: true });
      return false;

    case "VIDEO_CONTEXT": {
      const vid = msg.videoId || null;
      if (tabId != null) {
        if (vid) tabVideo.set(tabId, vid);
        else tabVideo.delete(tabId);
        if (vid) restoreVideo(vid).then(() => setBadge(tabId, vid));
        else setBadge(tabId, null);
      }
      sendResponse({ ok: true });
      return false;
    }

    case "RAW_COMMENT_PAYLOAD":
      ingest(msg);
      sendResponse({ ok: true });
      return false;

    case "CAPTURE_STATE": {
      const vid = msg.videoId;
      if (vid) {
        if (msg.capturing) capturingVideos.add(vid);
        else capturingVideos.delete(vid);
        updateBadgeForVideo(vid);
        pushStateUpdate(vid);
      }
      sendResponse({ ok: true });
      return false;
    }

    case "CAPTURE_COMPLETE":
      if (msg.videoId) {
        capturingVideos.delete(msg.videoId);
        updateBadgeForVideo(msg.videoId);
        pushStateUpdate(msg.videoId);
      }
      sendResponse({ ok: true });
      return false;

    case "GET_STATE":
      handleGetState(sendResponse);
      return true; // async

    case "GET_ROWS":
      handleGetRows(msg.videoId, sendResponse);
      return true; // async

    case "CLEAR_REQUEST":
      handleClear(msg.videoId, sendResponse);
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
  let videoId = null;
  if (tab?.url) {
    const m = tab.url.match(VIDEO_RE);
    videoId = m ? m[1] : null;
  }
  if (videoId) await restoreVideo(videoId);
  sendResponse({ ...buildState(videoId), tabId: tab?.id ?? null });
}

async function handleGetRows(videoId, sendResponse) {
  if (!videoId) {
    sendResponse({ rows: [] });
    return;
  }
  await restoreVideo(videoId);
  const map = datasets.get(videoId);
  sendResponse({ rows: map ? Array.from(map.values()) : [] });
}

async function handleClear(videoId, sendResponse) {
  if (videoId) {
    datasets.delete(videoId);
    commentsDisabled.delete(videoId);
    try {
      await chrome.storage.session.remove([
        `dataset:${videoId}`,
        `disabled:${videoId}`,
      ]);
    } catch {}
    updateBadgeForVideo(videoId);
    pushStateUpdate(videoId);
  }
  sendResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// Tab lifecycle → clear badge when leaving a TikTok video page.
// ---------------------------------------------------------------------------
function syncTabBadge(tabId, url) {
  const m = url ? url.match(VIDEO_RE) : null;
  const vid = m ? m[1] : null;
  if (vid) {
    tabVideo.set(tabId, vid);
    restoreVideo(vid).then(() => setBadge(tabId, vid));
  } else {
    tabVideo.delete(tabId);
    setBadge(tabId, null);
  }
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
  tabVideo.delete(tabId);
});
