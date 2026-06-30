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
  // settings
  settingsBtn: el("settingsBtn"),
  settingsOverlay: el("settingsOverlay"),
  settingsClose: el("settingsClose"),
  columnList: el("columnList"),
  colsAll: el("colsAll"),
  colsNone: el("colsNone"),
  setCaptureReplies: el("setCaptureReplies"),
  setScrollSpeed: el("setScrollSpeed"),
  setIdleTimeout: el("setIdleTimeout"),
  setDefaultFormat: el("setDefaultFormat"),
  resetSettings: el("resetSettings"),
  savedHint: el("savedHint"),
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

// --- settings --------------------------------------------------------------
const SETTINGS_KEY = "tte:settings";
const ALL_COLUMNS = window.TTEExporter.COLUMNS;
const REQUIRED_COLUMNS = window.TTEExporter.REQUIRED_COLUMNS;

const DEFAULT_SETTINGS = {
  columns: ALL_COLUMNS.reduce((acc, c) => ((acc[c] = true), acc), {}),
  captureReplies: true,
  scrollSpeed: "normal",
  idleTimeoutSec: 6,
  defaultFormat: "xlsx",
};

let settings = structuredClone(DEFAULT_SETTINGS);
let savedHintTimer = null;

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const saved = stored[SETTINGS_KEY];
    if (saved) {
      settings = {
        ...structuredClone(DEFAULT_SETTINGS),
        ...saved,
        columns: { ...DEFAULT_SETTINGS.columns, ...(saved.columns || {}) },
      };
    }
  } catch {}
  // Required columns can never be disabled.
  for (const req of REQUIRED_COLUMNS) settings.columns[req] = true;
}

async function saveSettings() {
  for (const req of REQUIRED_COLUMNS) settings.columns[req] = true;
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    flashSaved();
  } catch {}
}

function flashSaved() {
  ui.savedHint.classList.add("show");
  if (savedHintTimer) clearTimeout(savedHintTimer);
  savedHintTimer = setTimeout(() => ui.savedHint.classList.remove("show"), 1200);
}

function selectedColumns() {
  return ALL_COLUMNS.filter((c) => settings.columns[c]);
}

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
  const starting = !state.capturing;
  const type = starting ? "START_CAPTURE" : "STOP_CAPTURE";
  // Optimistic flip for snappy UI.
  applyState({ capturing: starting });
  const options = starting
    ? {
        captureReplies: settings.captureReplies,
        scrollSpeed: settings.scrollSpeed,
        idleTimeoutSec: settings.idleTimeoutSec,
      }
    : undefined;
  try {
    await chrome.tabs.sendMessage(state.tabId, { type, options });
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

  const options = { columns: selectedColumns() };
  let blob;
  if (format === "csv") {
    blob = window.TTEExporter.buildCsvBlob(rows, options);
  } else {
    blob = window.TTEExporter.buildXlsxBlob(rows, options);
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

// --- settings UI -----------------------------------------------------------
function renderColumnList() {
  ui.columnList.innerHTML = "";
  for (const col of ALL_COLUMNS) {
    const locked = REQUIRED_COLUMNS.includes(col);
    const label = document.createElement("label");
    label.className = "check-item" + (locked ? " locked" : "");

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!settings.columns[col];
    input.disabled = locked;
    input.dataset.col = col;
    input.addEventListener("change", () => {
      settings.columns[col] = input.checked;
      saveSettings();
    });

    const span = document.createElement("span");
    span.textContent = col;

    label.appendChild(input);
    label.appendChild(span);
    ui.columnList.appendChild(label);
  }
}

function applySettingsToControls() {
  ui.setCaptureReplies.checked = !!settings.captureReplies;
  ui.setScrollSpeed.value = settings.scrollSpeed;
  ui.setIdleTimeout.value = String(settings.idleTimeoutSec);
  ui.setDefaultFormat.value = settings.defaultFormat;
  renderColumnList();
  markDefaultFormat();
}

// Visually mark the default export button.
function markDefaultFormat() {
  const csvDefault = settings.defaultFormat === "csv";
  ui.csvBtn.classList.toggle("default-format", csvDefault);
  ui.xlsxBtn.classList.toggle("default-format", !csvDefault);
}

function openSettings() {
  ui.settingsOverlay.classList.remove("hidden");
}

function closeSettings() {
  ui.settingsOverlay.classList.add("hidden");
}

ui.settingsBtn.addEventListener("click", openSettings);
ui.settingsClose.addEventListener("click", closeSettings);
ui.settingsOverlay.addEventListener("click", (e) => {
  if (e.target === ui.settingsOverlay) closeSettings();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !ui.settingsOverlay.classList.contains("hidden")) {
    closeSettings();
  }
});

ui.setCaptureReplies.addEventListener("change", () => {
  settings.captureReplies = ui.setCaptureReplies.checked;
  saveSettings();
});
ui.setScrollSpeed.addEventListener("change", () => {
  settings.scrollSpeed = ui.setScrollSpeed.value;
  saveSettings();
});
ui.setIdleTimeout.addEventListener("change", () => {
  settings.idleTimeoutSec = Number(ui.setIdleTimeout.value);
  saveSettings();
});
ui.setDefaultFormat.addEventListener("change", () => {
  settings.defaultFormat = ui.setDefaultFormat.value;
  markDefaultFormat();
  saveSettings();
});

function setAllColumns(value) {
  for (const col of ALL_COLUMNS) settings.columns[col] = value;
  for (const req of REQUIRED_COLUMNS) settings.columns[req] = true;
  renderColumnList();
  saveSettings();
}

ui.colsAll.addEventListener("click", () => setAllColumns(true));
ui.colsNone.addEventListener("click", () => setAllColumns(false));

ui.resetSettings.addEventListener("click", () => {
  settings = structuredClone(DEFAULT_SETTINGS);
  applySettingsToControls();
  saveSettings();
});

// --- init ------------------------------------------------------------------
async function init() {
  await loadSettings();
  applySettingsToControls();
  await loadState();
}

init();
