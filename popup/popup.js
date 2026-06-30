// popup.js — toolbar UI. Talks to the background worker for state/rows and to
// the content script for capture control. Exports are built here (popup context
// has URL.createObjectURL and the SheetJS global available).

const el = (id) => document.getElementById(id);

const ui = {
  videoLine: el("videoLine"),
  disabledBanner: el("disabledBanner"),
  emptyState: el("emptyState"),
  main: el("main"),
  statTotal: el("statTotal"),
  statTop: el("statTop"),
  statReplies: el("statReplies"),
  captureBtn: el("captureBtn"),
  captureLabel: el("captureLabel"),
  captureDot: el("captureDot"),
  csvBtn: el("csvBtn"),
  xlsxBtn: el("xlsxBtn"),
  clearLink: el("clearLink"),
};

let state = {
  videoId: null,
  total: 0,
  topLevel: 0,
  replies: 0,
  capturing: false,
  commentsDisabled: false,
  tabId: null,
};
let clearArmed = false;
let clearTimer = null;

function render() {
  const onVideo = !!state.videoId;

  ui.emptyState.classList.toggle("hidden", onVideo);
  ui.main.classList.toggle("hidden", !onVideo);
  ui.disabledBanner.classList.toggle(
    "hidden",
    !(onVideo && state.commentsDisabled)
  );

  ui.videoLine.textContent = onVideo
    ? `Video ${truncate(state.videoId)}`
    : "Not on a TikTok video";

  ui.statTotal.textContent = state.total;
  ui.statTop.textContent = state.topLevel;
  ui.statReplies.textContent = state.replies;

  ui.captureLabel.textContent = state.capturing ? "Stop Capture" : "Start Capture";
  ui.captureBtn.classList.toggle("capturing", state.capturing);
  ui.captureDot.classList.toggle("hidden", !state.capturing);

  const noData = state.total === 0;
  ui.csvBtn.disabled = noData;
  ui.xlsxBtn.disabled = noData;
}

function truncate(id) {
  if (!id) return "";
  return id.length > 12 ? id.slice(0, 6) + "…" + id.slice(-4) : id;
}

function applyState(next) {
  state = { ...state, ...next };
  render();
}

// --- initial + live state --------------------------------------------------
async function loadState() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    if (res) applyState(res);
  } catch {}
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "STATE_UPDATE" && msg.state) {
    // Only adopt updates for the video we're currently showing.
    if (!state.videoId || msg.state.videoId === state.videoId) {
      applyState({ ...msg.state, tabId: state.tabId });
    }
  }
});

// Light polling as a fallback in case a push is missed.
setInterval(loadState, 1500);

// --- capture toggle --------------------------------------------------------
ui.captureBtn.addEventListener("click", async () => {
  if (!state.tabId) return;
  const type = state.capturing ? "STOP_CAPTURE" : "START_CAPTURE";
  // Optimistic flip for snappy UI.
  applyState({ capturing: !state.capturing });
  try {
    await chrome.tabs.sendMessage(state.tabId, { type });
  } catch {
    // Content script may not be ready; revert and reload truth.
    loadState();
  }
});

// --- exports ---------------------------------------------------------------
async function fetchRows() {
  const res = await chrome.runtime.sendMessage({
    type: "GET_ROWS",
    videoId: state.videoId,
  });
  return res?.rows ?? [];
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    "-" +
    p(d.getHours()) +
    p(d.getMinutes())
  );
}

async function doExport(format) {
  const rows = await fetchRows();
  if (!rows.length) return;

  let blob;
  if (format === "csv") {
    blob = window.TTEExporter.buildCsvBlob(rows);
  } else {
    blob = window.TTEExporter.buildXlsxBlob(rows);
  }

  const url = URL.createObjectURL(blob);
  const filename = `tiktok-comments-${state.videoId}-${timestamp()}.${format}`;
  try {
    await chrome.downloads.download({ url, filename, saveAs: false });
  } finally {
    // Revoke shortly after the download has had a chance to start.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

ui.csvBtn.addEventListener("click", () => doExport("csv"));
ui.xlsxBtn.addEventListener("click", () => doExport("xlsx"));

// --- destructive clear (two-click confirm) ---------------------------------
function resetClearLink() {
  clearArmed = false;
  ui.clearLink.classList.remove("confirm");
  ui.clearLink.textContent = "Clear data for this video";
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
}

async function handleClear() {
  if (!state.videoId) return;
  if (!clearArmed) {
    clearArmed = true;
    ui.clearLink.classList.add("confirm");
    ui.clearLink.textContent = "Click again to confirm";
    clearTimer = setTimeout(resetClearLink, 3000);
    return;
  }
  resetClearLink();
  await chrome.runtime.sendMessage({
    type: "CLEAR_REQUEST",
    videoId: state.videoId,
  });
  applyState({ total: 0, topLevel: 0, replies: 0 });
  loadState();
}

ui.clearLink.addEventListener("click", handleClear);
ui.clearLink.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") handleClear();
});

loadState();
