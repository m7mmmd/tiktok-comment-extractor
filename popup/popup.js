// popup.js — toolbar UI for both sources (TikTok comments / Amazon reviews).
// Talks to the background worker for state/rows and to the active tab's content
// script for capture control. Exports are built here (popup context has
// URL.createObjectURL and the SheetJS global available).

const TTE = window.TTEExporter;
const el = (id) => document.getElementById(id);

const ui = {
  videoLine: el("videoLine"),
  disabledBanner: el("disabledBanner"),
  emptyState: el("emptyState"),
  main: el("main"),
  statN1: el("statN1"),
  statN2: el("statN2"),
  statN3: el("statN3"),
  statL1: el("statL1"),
  statL2: el("statL2"),
  statL3: el("statL3"),
  captureBtn: el("captureBtn"),
  captureLabel: el("captureLabel"),
  captureDot: el("captureDot"),
  captureHint: el("captureHint"),
  csvBtn: el("csvBtn"),
  xlsxBtn: el("xlsxBtn"),
  clearLink: el("clearLink"),
  // settings
  settingsBtn: el("settingsBtn"),
  settingsOverlay: el("settingsOverlay"),
  settingsClose: el("settingsClose"),
  colSrcTiktok: el("colSrcTiktok"),
  colSrcAmazon: el("colSrcAmazon"),
  columnList: el("columnList"),
  colsAll: el("colsAll"),
  colsNone: el("colsNone"),
  setCaptureReplies: el("setCaptureReplies"),
  setScrollSpeed: el("setScrollSpeed"),
  setIdleTimeout: el("setIdleTimeout"),
  setAutoPaginate: el("setAutoPaginate"),
  setMaxPages: el("setMaxPages"),
  setDefaultFormat: el("setDefaultFormat"),
  resetSettings: el("resetSettings"),
  savedHint: el("savedHint"),
};

let state = {
  source: null,
  id: null,
  total: 0,
  topLevel: 0,
  replies: 0,
  verified: 0,
  avgRating: 0,
  capturing: false,
  commentsDisabled: false,
  tabId: null,
};
let clearArmed = false;
let clearTimer = null;

// --- settings --------------------------------------------------------------
const SETTINGS_KEY = "tte:settings";

function defaultColumns(source) {
  const o = {};
  for (const c of TTE.columnsFor(source)) o[c] = true;
  return o;
}

const DEFAULT_SETTINGS = {
  columns: {
    tiktok: defaultColumns("tiktok"),
    amazon: defaultColumns("amazon"),
  },
  tiktok: { captureReplies: true, scrollSpeed: "normal", idleTimeoutSec: 6 },
  amazon: { autoPaginate: true, maxPages: 0 },
  defaultFormat: "xlsx",
};

let settings = structuredClone(DEFAULT_SETTINGS);
let colSource = "tiktok"; // which column set the settings panel is editing
let savedHintTimer = null;

// Migrate older flat settings ({ columns:{...tiktokCols}, captureReplies, ... }).
function migrateSettings(saved) {
  if (!saved || typeof saved !== "object") return null;
  const looksOld =
    saved.columns &&
    (saved.columns.comment_id !== undefined || !saved.columns.tiktok);
  if (!looksOld) return saved;
  return {
    columns: {
      tiktok: { ...defaultColumns("tiktok"), ...(saved.columns || {}) },
      amazon: defaultColumns("amazon"),
    },
    tiktok: {
      captureReplies: saved.captureReplies ?? true,
      scrollSpeed: saved.scrollSpeed ?? "normal",
      idleTimeoutSec: saved.idleTimeoutSec ?? 6,
    },
    amazon: { autoPaginate: true, maxPages: 0 },
    defaultFormat: saved.defaultFormat ?? "xlsx",
  };
}

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const saved = migrateSettings(stored[SETTINGS_KEY]);
    if (saved) {
      settings = {
        ...structuredClone(DEFAULT_SETTINGS),
        ...saved,
        columns: {
          tiktok: { ...defaultColumns("tiktok"), ...(saved.columns?.tiktok || {}) },
          amazon: { ...defaultColumns("amazon"), ...(saved.columns?.amazon || {}) },
        },
        tiktok: { ...DEFAULT_SETTINGS.tiktok, ...(saved.tiktok || {}) },
        amazon: { ...DEFAULT_SETTINGS.amazon, ...(saved.amazon || {}) },
      };
    }
  } catch {}
  enforceRequired();
}

function enforceRequired() {
  for (const src of ["tiktok", "amazon"]) {
    for (const req of TTE.requiredFor(src)) settings.columns[src][req] = true;
  }
}

async function saveSettings() {
  enforceRequired();
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

function selectedColumns(source) {
  return TTE.columnsFor(source).filter((c) => settings.columns[source][c]);
}

// --- main UI ---------------------------------------------------------------
function render() {
  const onSupported = !!state.source;

  ui.emptyState.classList.toggle("hidden", onSupported);
  ui.main.classList.toggle("hidden", !onSupported);
  ui.disabledBanner.classList.toggle(
    "hidden",
    !(state.source === "tiktok" && state.commentsDisabled)
  );

  if (state.source === "amazon") {
    ui.videoLine.textContent = `Product ${state.id || ""}`;
    setStat(ui.statN1, ui.statL1, state.total, "Reviews");
    setStat(ui.statN2, ui.statL2, state.avgRating ? state.avgRating : "—", "Avg \u2605");
    setStat(ui.statN3, ui.statL3, state.verified, "Verified");
    ui.captureHint.textContent =
      "Auto-paginates through Amazon's review pages. Start on a product or 'all reviews' page.";
    ui.captureHint.classList.remove("hidden");
  } else if (state.source === "tiktok") {
    ui.videoLine.textContent = `Video ${truncate(state.id)}`;
    setStat(ui.statN1, ui.statL1, state.total, "Total");
    setStat(ui.statN2, ui.statL2, state.topLevel, "Top-level");
    setStat(ui.statN3, ui.statL3, state.replies, "Replies");
    ui.captureHint.classList.add("hidden");
  } else {
    ui.videoLine.textContent = "Not on a supported page";
    ui.captureHint.classList.add("hidden");
  }

  ui.captureLabel.textContent = state.capturing ? "Stop Capture" : "Start Capture";
  ui.captureBtn.classList.toggle("capturing", state.capturing);
  ui.captureDot.classList.toggle("hidden", !state.capturing);

  const noData = state.total === 0;
  ui.csvBtn.disabled = noData;
  ui.xlsxBtn.disabled = noData;
}

function setStat(numEl, labelEl, value, label) {
  numEl.textContent = value;
  labelEl.textContent = label;
}

function truncate(id) {
  if (!id) return "";
  return id.length > 12 ? id.slice(0, 6) + "\u2026" + id.slice(-4) : id;
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
    if (!state.id || msg.state.id === state.id) {
      applyState({ ...msg.state, tabId: state.tabId });
    }
  }
});

setInterval(loadState, 1500);

// --- capture toggle --------------------------------------------------------
ui.captureBtn.addEventListener("click", async () => {
  if (!state.tabId || !state.source) return;
  const starting = !state.capturing;
  const type = starting ? "START_CAPTURE" : "STOP_CAPTURE";
  applyState({ capturing: starting });

  let options;
  if (starting) {
    options =
      state.source === "amazon"
        ? {
            autoPaginate: settings.amazon.autoPaginate,
            maxPages: settings.amazon.maxPages,
          }
        : {
            captureReplies: settings.tiktok.captureReplies,
            scrollSpeed: settings.tiktok.scrollSpeed,
            idleTimeoutSec: settings.tiktok.idleTimeoutSec,
          };
  }
  try {
    await chrome.tabs.sendMessage(state.tabId, { type, options });
  } catch {
    loadState();
  }
});

// --- exports ---------------------------------------------------------------
async function fetchRows() {
  const res = await chrome.runtime.sendMessage({
    type: "GET_ROWS",
    id: state.id,
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

  const options = { columns: selectedColumns(state.source) };
  const blob =
    format === "csv"
      ? TTE.buildCsvBlob(rows, options)
      : TTE.buildXlsxBlob(rows, options);

  const url = URL.createObjectURL(blob);
  const prefix = state.source === "amazon" ? "amazon-reviews" : "tiktok-comments";
  const filename = `${prefix}-${state.id}-${timestamp()}.${format}`;
  try {
    await chrome.downloads.download({ url, filename, saveAs: false });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

ui.csvBtn.addEventListener("click", () => doExport("csv"));
ui.xlsxBtn.addEventListener("click", () => doExport("xlsx"));

// --- destructive clear (two-click confirm) ---------------------------------
function resetClearLink() {
  clearArmed = false;
  ui.clearLink.classList.remove("confirm");
  ui.clearLink.textContent = "Clear data for this item";
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
}

async function handleClear() {
  if (!state.id) return;
  if (!clearArmed) {
    clearArmed = true;
    ui.clearLink.classList.add("confirm");
    ui.clearLink.textContent = "Click again to confirm";
    clearTimer = setTimeout(resetClearLink, 3000);
    return;
  }
  resetClearLink();
  await chrome.runtime.sendMessage({ type: "CLEAR_REQUEST", id: state.id });
  applyState({ total: 0, topLevel: 0, replies: 0, verified: 0, avgRating: 0 });
  loadState();
}

ui.clearLink.addEventListener("click", handleClear);
ui.clearLink.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") handleClear();
});

// --- settings UI -----------------------------------------------------------
function renderColumnList() {
  ui.columnList.innerHTML = "";
  const cols = TTE.columnsFor(colSource);
  const required = TTE.requiredFor(colSource);
  const bag = settings.columns[colSource];
  for (const col of cols) {
    const locked = required.includes(col);
    const label = document.createElement("label");
    label.className = "check-item" + (locked ? " locked" : "");

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!bag[col];
    input.disabled = locked;
    input.addEventListener("change", () => {
      bag[col] = input.checked;
      saveSettings();
    });

    const span = document.createElement("span");
    span.textContent = col;

    label.appendChild(input);
    label.appendChild(span);
    ui.columnList.appendChild(label);
  }
}

function setColSource(src) {
  colSource = src;
  ui.colSrcTiktok.classList.toggle("active", src === "tiktok");
  ui.colSrcAmazon.classList.toggle("active", src === "amazon");
  renderColumnList();
}

function applySettingsToControls() {
  ui.setCaptureReplies.checked = !!settings.tiktok.captureReplies;
  ui.setScrollSpeed.value = settings.tiktok.scrollSpeed;
  ui.setIdleTimeout.value = String(settings.tiktok.idleTimeoutSec);
  ui.setAutoPaginate.checked = !!settings.amazon.autoPaginate;
  ui.setMaxPages.value = String(settings.amazon.maxPages);
  ui.setDefaultFormat.value = settings.defaultFormat;
  setColSource(state.source === "amazon" ? "amazon" : "tiktok");
  markDefaultFormat();
}

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

ui.colSrcTiktok.addEventListener("click", () => setColSource("tiktok"));
ui.colSrcAmazon.addEventListener("click", () => setColSource("amazon"));

ui.setCaptureReplies.addEventListener("change", () => {
  settings.tiktok.captureReplies = ui.setCaptureReplies.checked;
  saveSettings();
});
ui.setScrollSpeed.addEventListener("change", () => {
  settings.tiktok.scrollSpeed = ui.setScrollSpeed.value;
  saveSettings();
});
ui.setIdleTimeout.addEventListener("change", () => {
  settings.tiktok.idleTimeoutSec = Number(ui.setIdleTimeout.value);
  saveSettings();
});
ui.setAutoPaginate.addEventListener("change", () => {
  settings.amazon.autoPaginate = ui.setAutoPaginate.checked;
  saveSettings();
});
ui.setMaxPages.addEventListener("change", () => {
  settings.amazon.maxPages = Number(ui.setMaxPages.value);
  saveSettings();
});
ui.setDefaultFormat.addEventListener("change", () => {
  settings.defaultFormat = ui.setDefaultFormat.value;
  markDefaultFormat();
  saveSettings();
});

function setAllColumns(value) {
  const bag = settings.columns[colSource];
  for (const col of TTE.columnsFor(colSource)) bag[col] = value;
  enforceRequired();
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
  await loadState();
  applySettingsToControls();
}

init();
