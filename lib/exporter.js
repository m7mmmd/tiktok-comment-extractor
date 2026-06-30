// exporter.js — CSV + XLSX builders, shared by the popup.
// Loaded as a plain script (after lib/xlsx.full.min.js) and exposed on
// window.TTEExporter. Both builders take the same canonical row array so the
// two formats stay trivially in sync if the schema changes.

(function () {
  // Canonical TikTok comment column order.
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

  // Canonical Amazon review column order.
  const AMAZON_COLUMNS = [
    "review_id",
    "product_asin",
    "rating",
    "title",
    "author",
    "review_date",
    "location",
    "verified_purchase",
    "helpful_votes",
    "variant",
    "review_text",
    "captured_at",
  ];

  const BOM = "\uFEFF";

  // Primary keys per source (always exported, locked in the settings UI).
  const REQUIRED_BY_SOURCE = {
    tiktok: ["comment_id"],
    amazon: ["review_id"],
  };

  function columnsFor(source) {
    return source === "amazon" ? AMAZON_COLUMNS.slice() : COLUMNS.slice();
  }

  function requiredFor(source) {
    return (REQUIRED_BY_SOURCE[source] || REQUIRED_BY_SOURCE.tiktok).slice();
  }

  // Resolve the effective column list. When the caller supplies an explicit
  // ordered list (the popup does, per source), trust it as-is; otherwise fall
  // back to the full TikTok canonical order.
  function resolveColumns(options) {
    const requested =
      options && Array.isArray(options.columns) && options.columns.length
        ? options.columns
        : null;
    return requested ? requested.slice() : COLUMNS.slice();
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
    AMAZON_COLUMNS,
    columnsFor,
    requiredFor,
    buildCsvBlob,
    buildXlsxBlob,
  };
})();
