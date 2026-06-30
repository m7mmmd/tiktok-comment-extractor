// exporter.js — CSV + XLSX builders, shared by the popup.
// Loaded as a plain script (after lib/xlsx.full.min.js) and exposed on
// window.TTEExporter. Both builders take the same canonical row array so the
// two formats stay trivially in sync if the schema changes.

(function () {
  // Canonical column order — must match the schema in background.js exactly.
  const COLUMNS = [
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

  const BOM = "\uFEFF";

  // comment_id is the dedup/primary key and is always exported.
  const REQUIRED_COLUMNS = ["comment_id"];

  // Resolve the effective column list from caller options, preserving canonical
  // order and always including the required columns.
  function resolveColumns(options) {
    const requested = options && Array.isArray(options.columns) ? options.columns : null;
    if (!requested) return COLUMNS.slice();
    const set = new Set(requested);
    for (const req of REQUIRED_COLUMNS) set.add(req);
    return COLUMNS.filter((col) => set.has(col));
  }

  // RFC 4180 quoting: wrap in quotes if the field contains comma, quote, CR or
  // LF; double any internal quotes.
  function csvCell(value) {
    let s;
    if (value === null || value === undefined) {
      s = "";
    } else if (typeof value === "boolean") {
      s = value ? "TRUE" : "FALSE";
    } else {
      s = String(value);
    }
    if (/[",\r\n]/.test(s)) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function buildCsvBlob(rows, options) {
    const cols = resolveColumns(options);
    const lines = [];
    lines.push(cols.join(","));
    for (const row of rows) {
      lines.push(cols.map((col) => csvCell(row[col])).join(","));
    }
    // CRLF line endings per RFC 4180; BOM so Excel detects UTF-8 (Arabic safe).
    const csv = BOM + lines.join("\r\n");
    return new Blob([csv], { type: "text/csv;charset=utf-8" });
  }

  function buildXlsxBlob(rows, options) {
    if (typeof XLSX === "undefined") {
      throw new Error("SheetJS (XLSX) is not loaded.");
    }
    const cols = resolveColumns(options);
    // Normalize booleans to TRUE/FALSE strings so the sheet matches the CSV and
    // is filterable in Excel; leave all other text untouched (no Arabic munging).
    const normalized = rows.map((row) => {
      const out = {};
      for (const col of cols) {
        const v = row[col];
        out[col] = typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : v ?? "";
      }
      return out;
    });
    const sheet = XLSX.utils.json_to_sheet(normalized, { header: cols });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "comments");
    const arrayBuffer = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    return new Blob([arrayBuffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }

  window.TTEExporter = {
    COLUMNS,
    REQUIRED_COLUMNS,
    buildCsvBlob,
    buildXlsxBlob,
  };
})();
