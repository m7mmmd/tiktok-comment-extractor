# Build Prompt: TikTok Comment Extractor (Chrome/Edge MV3 Extension)

You are building a Chrome/Edge Manifest V3 browser extension called **TikTok Comment Extractor**. Read this entire prompt before writing any code. Build it as a complete, loadable unpacked extension.

## Mission

On any TikTok video page (`https://www.tiktok.com/@*/video/*`), passively intercept TikTok's own internal comment API network responses (do NOT scrape the DOM for data), assemble top-level comments and their replies into one flat dataset, show a live count on the extension's toolbar badge, and let the user export the full dataset to **CSV (UTF-8 with BOM)** and **native XLSX** with one click each. Arabic and all other Unicode text must survive perfectly into both formats.

## Step 0 — Mandatory reconnaissance before writing the parser

Before writing `background.js`'s parsing logic, you must determine TikTok's *current* actual comment API shape — do not assume the field names below are still accurate by the time you build this, TikTok rotates these periodically.

1. Open a TikTok video page in a real browser with DevTools Network tab open, filtered to Fetch/XHR.
2. Open the comment panel and scroll. Identify the request URL pattern (expected to live under a path containing `comment/list`) and the request URL pattern for expanding replies (expected to live under a path containing `comment/list/reply`).
3. Inspect one real response JSON body. Identify the actual field names for: comment ID, parent/root references, comment text, author username, author display name (nickname), like count, reply count, and timestamp (likely a Unix seconds integer under a key like `create_time`).
4. Write a single `normalize(rawComment, parentId)` function in `background.js` that maps whatever the real field names are to the canonical schema in Step 3 below. Use optional chaining and defensive fallbacks (`?? null` / `?? 0`) everywhere so a missing/renamed field doesn't throw — log a console warning and skip the row instead of crashing.

This reconnaissance step is the single most important part of this build. Everything else is standard extension plumbing around it.

## Canonical comment schema

Every row, whether top-level or reply, normalizes to this flat object (note: do NOT nest replies inside parent objects — flatten everything into one array/table):

```ts
{
  comment_id: string,
  parent_comment_id: string | "",   // "" for top-level comments
  is_reply: boolean,
  username: string,                 // @handle
  display_name: string,             // nickname, may be Arabic/non-Latin
  comment_text: string,             // raw UTF-8, untouched — no transliteration, no stripping
  like_count: number,
  reply_count: number,
  created_at: string,                // ISO 8601 UTC, converted from TikTok's unix seconds
  video_id: string,
  captured_at: string                // ISO 8601 UTC, when this extension captured the row
}
```

Column order in every export (CSV and XLSX) must match this exact order.

## Architecture

### File structure
```
/manifest.json
/background.js          (MV3 service worker)
/content/content-script.js   (ISOLATED world)
/content/injected.js         (MAIN world — fetch/XHR patcher)
/popup/popup.html
/popup/popup.js
/popup/popup.css
/lib/xlsx.full.min.js   (vendored SheetJS build — do NOT load from CDN, MV3 CSP will block it)
/lib/exporter.js        (CSV + XLSX builders, shared by background or popup depending on where you trigger downloads from)
/icons/icon16.png, icon32.png, icon48.png, icon128.png
```

### manifest.json requirements
- `"manifest_version": 3`
- `"permissions"`: `["scripting", "storage", "activeTab", "downloads"]`
- `"host_permissions"`: `["*://*.tiktok.com/*"]`
- `"background"`: service worker pointing to `background.js`, `"type": "module"` if you use ES module imports
- `"action"`: with default_popup `popup/popup.html` and default icons
- `"content_scripts"`: matches `*://www.tiktok.com/*`, `js: ["content/content-script.js"]`, `run_at: "document_idle"`
- Do NOT declare `injected.js` as a content script in the manifest — it must be injected programmatically via `chrome.scripting.executeScript` with `world: "MAIN"` from `content-script.js` or `background.js`, since that's the only way to get MV3 MAIN-world execution with a clean message bridge back to the isolated world.

### injected.js (MAIN world)
- On load, immediately wrap `window.fetch`: keep a reference to the original, replace it with an async function that calls the original, clones the response, and — if `response.url` matches a comment-list or comment-reply-list pattern (use a regex constant you'll finalize after Step 0 recon) — reads the cloned response body as text/json and does `window.postMessage({ source: "tte-injected", type: "RAW_COMMENT_PAYLOAD", url: response.url, payload: <parsed json> }, "*")`, then returns the *original* (unread) response untouched so TikTok's own code isn't broken.
- Also wrap `XMLHttpRequest.prototype.open` and `.send` as a fallback in case TikTok uses XHR instead of fetch for this particular endpoint — same postMessage contract on `readystatechange`/`load` when status is 200 and URL matches.
- Use a narrow, specific origin check pattern and a custom `source` field on every posted message so the isolated content script can reliably filter only this extension's messages and ignore the page's other postMessage traffic.

### content-script.js (ISOLATED world)
- On `document_idle`, ask the background worker (via `chrome.runtime.sendMessage`) to inject `injected.js` into the page's MAIN world via `chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["content/injected.js"] })` — this must be triggered from background.js since content scripts can't call `chrome.scripting` directly, so have content-script.js send a one-time "ready, please inject" message on load.
- Listen for `window.addEventListener("message", ...)`, filter for `event.source === window && event.data?.source === "tte-injected"`, and relay valid payloads to the background worker via `chrome.runtime.sendMessage({ type: "RAW_COMMENT_PAYLOAD", ... })`.
- Extract the current video ID from `location.pathname` (pattern: `/@[^/]+/video/(\d+)/`) and send it to background on load and on every URL change.
- Implement URL-change detection for TikTok's SPA navigation: patch `history.pushState`/`replaceState` and listen for `popstate`, OR poll `location.href` every 500ms as a simpler fallback — either is acceptable, poll is simpler and adequate here given low overhead.
- Implement `startAutoScroll()` / `stopAutoScroll()`, exposed via `chrome.runtime.onMessage` listeners (`START_CAPTURE` / `STOP_CAPTURE` actions from the popup):
  - Find the comment panel's scrollable container (you'll need to identify a stable-ish selector or fall back to scrolling `document.body`/the nearest scrollable ancestor of a comment item — note in your code comments that this selector may need future maintenance since it's the one DOM dependency in the whole extension).
  - Scroll it down by a randomized amount (e.g. 400–900px) every randomized interval (e.g. 700–1400ms) to trigger TikTok's infinite-scroll pagination.
  - Track time since the last `RAW_COMMENT_PAYLOAD` was relayed; if no new payload arrives within a 6-second window, auto-stop and notify the popup (via a `CAPTURE_COMPLETE` message) that capture appears finished.
  - Also implement reply expansion: periodically query for "view replies" / "view N replies" clickable elements within visible comment items (again, selector may need maintenance) that haven't been clicked yet, and click them at the same throttled pace, so the reply-list API fires.
- If the comment panel isn't open yet when `START_CAPTURE` is received, programmatically click whatever UI element opens it before starting the scroll loop.

### background.js (service worker)
- Maintain an in-memory `Map<videoId, Map<commentId, CanonicalRow>>` for dedup-by-ID, mirrored into `chrome.storage.session` (not `local`) in batched writes (debounce ~500ms) rather than per-message writes, to handle large threads without excessive I/O.
- On `RAW_COMMENT_PAYLOAD` messages: run the `normalize()` function from Step 0 over the payload's comment array, set `parent_comment_id` appropriately (empty string for top-level list responses, the relevant parent ID for reply-list responses — the URL or payload should tell you which), dedupe against the existing Map by `comment_id`, then update the badge.
- Badge update: `chrome.action.setBadgeText({ tabId, text })` where `text` is the total row count for that tab's current video, abbreviated to e.g. `"1.2k"` above 999 (4-char Chrome badge limit). `chrome.action.setBadgeBackgroundColor` — dark gray (`#5A5A5A`) when idle, green (`#1DB954`) while a capture session is active for that tab. Clear badge (`text: ""`) when the active tab navigates away from a TikTok video page pattern — listen on `chrome.tabs.onUpdated` and `chrome.tabs.onActivated` for this.
- On `EXPORT_REQUEST` messages from the popup (`{ format: "csv" | "xlsx", videoId }`): pull the full row array for that video from the Map/storage, hand off to `lib/exporter.js` functions, get back a Blob or data URL, and trigger `chrome.downloads.download({ url, filename })`. Filename pattern: `tiktok-comments-{videoId}-{YYYYMMDD-HHmm}.csv` / `.xlsx`.
- On `CLEAR_REQUEST`: delete that video's entry from the Map and from `chrome.storage.session`, reset badge to `0`.
- Expose a `GET_STATE` request/response (used by popup on open) returning `{ videoId, total, topLevel, replies, capturing: boolean }` for the currently active tab.

### lib/exporter.js
- **CSV builder**: manually build the string (don't rely on a library for this one, it's simple) — header row from the canonical schema's column names, then one row per comment. Every field run through an RFC 4180 quoting function: wrap in `"..."` if the field contains a comma, double-quote, or newline; double any internal `"` characters. Prepend `\uFEFF` (UTF-8 BOM) to the very start of the final string before creating the Blob, so Excel auto-detects UTF-8 and Arabic text renders correctly instead of as mojibake. Create as `new Blob([bom + csvString], { type: "text/csv;charset=utf-8" })`.
- **XLSX builder**: use the vendored SheetJS (`lib/xlsx.full.min.js`) — `XLSX.utils.json_to_sheet(rows, { header: [...canonical column order...] })` → `XLSX.utils.book_new()` → `XLSX.utils.book_append_sheet()` → `XLSX.write(wb, { bookType: "xlsx", type: "array" })` → wrap in a Blob with the correct `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` MIME type. No special Arabic handling needed here since SheetJS writes proper UTF-8 shared strings natively — just don't pre-process the text.
- Both builders take the same canonical row array as input so they stay trivially in sync if the schema changes.

### popup/popup.html + popup.js
Build a small, clean popup (vanilla JS, no framework needed — this is small enough not to justify one):
- On open, send `GET_STATE` to background, render:
  - Video ID (truncated) or "Open a TikTok video to begin" empty state if not on a matching page.
  - Three stat numbers: Total / Top-level / Replies.
  - One primary button toggling between "Start Capture" and "Stop Capture" (sends `START_CAPTURE`/`STOP_CAPTURE` to the content script via `chrome.tabs.sendMessage`), with a small animated dot/spinner while `capturing: true`.
  - Two equal-weight buttons: "Export CSV" and "Export XLSX" (disabled/greyed when total === 0), sending `EXPORT_REQUEST` to background.
  - A small destructive text link "Clear data for this video" requiring a second confirm click (toggle its own label to "Click again to confirm" for 3 seconds, then revert) before actually sending `CLEAR_REQUEST`.
  - Footer microcopy: "Data stays local to this browser and is cleared when the tab closes unless exported."
- Re-fetch state every ~1.5s while popup is open (simple `setInterval`) so counts visibly tick up live during a capture session, OR (cleaner) have background push `STATE_UPDATE` messages and have popup just listen — prefer this push model if you have time, it's a better UX with no flicker.

## Explicit non-goals (do not build these)

- No sentiment/topic clustering or NLP — "clusters" means clean structured columns, nothing more.
- No multi-video batch mode.
- No cloud sync / accounts / remote storage / analytics / telemetry of any kind.
- No live-stream comment support.
- No Firefox manifest — Chromium MV3 only (this same build loads in Edge unmodified).
- No in-page floating panel injected into the TikTok page — all UI lives in the toolbar popup + icon badge only.
- Do not attempt to replicate or guess TikTok's own request-signing headers (e.g. anti-bot signature headers) to make direct API calls — this extension only ever *reads* responses to requests TikTok's own page already made. Never construct or send your own requests to TikTok's comment endpoints.

## Edge cases to explicitly handle

- Comments disabled on the video → detect from the API response shape (status flag or explicitly empty-with-flag) and show "Comments are disabled on this video" in the popup instead of a bare zero.
- User opens the popup before the comment panel has ever been opened → "Start Capture" should programmatically open the panel first.
- Rapid SPA navigation between videos → cancel any in-flight auto-scroll loop, switch the active dataset key, badge updates to the new video's count (0 if unvisited).
- Duplicate rows from overlapping pagination pages → handled by comment_id dedup at ingestion, not at export time.
- TikTok renames/restructures response fields after this build ships → `normalize()` should fail soft (skip + console.warn the malformed item), never throw and break the whole pipeline.
- Mixed Arabic + emoji + Latin in a single comment → no text manipulation anywhere in the pipeline, stored and exported byte-for-byte.
- Very large threads (10k+ comments) → batched storage writes, and the auto-scroll loop's own 6-second-no-new-data timeout is the natural "done" signal rather than a hardcoded scroll-count limit.

## Anti-detection posture (build this in, don't bolt it on later)

Auto-scroll timing and distance must be randomized (not a fixed interval/distance) to avoid a detectably robotic pattern — this is a correctness requirement, not a nice-to-have, since a fixed-interval scroll loop is the most common signal automated-traffic heuristics look for. Use a random range for both interval and scroll distance as specified above, and consider adding occasional longer "pause" gaps (e.g. a 1-in-8 chance of a 2-4s pause instead of a normal-length one) to better mimic human reading behavior.

## Definition of done

1. Extension loads with no console errors via `chrome://extensions` → Load unpacked.
2. On a real TikTok video page with Arabic-language comments present, clicking "Start Capture" visibly increments the badge count within a few seconds, and continues until the panel is exhausted or stopped.
3. Replies are captured and correctly flagged with their parent's `comment_id` in `parent_comment_id`.
4. Export CSV opens cleanly in Excel with Arabic text rendering correctly (not mojibake), correctly quoted fields, and the full expected row count.
5. Export XLSX opens cleanly in Excel/Numbers/Google Sheets with Arabic text and RTL rendering correctly natively.
6. Navigating to a different TikTok video in the same tab resets the badge/state to that new video without requiring an extension reload.
7. No requests are ever sent by the extension to TikTok's servers — verify in the Network tab that the extension's traffic footprint is exactly zero; it only reads, never writes/calls.

Build the entire file structure now, starting with `manifest.json`, then `background.js`'s `normalize()` stub (flagging clearly where Step 0 recon output needs to be plugged in), then the rest of the files in the order listed above.
