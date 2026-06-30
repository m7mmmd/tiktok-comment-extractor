// injected.js — runs in the page's MAIN world.
// It monkey-patches window.fetch and XMLHttpRequest so it can read the body of
// the comment-list / comment-reply-list responses that TikTok's OWN code requests.
// It never issues its own requests; it only observes and re-posts what already came back.
//
// Captured payloads are forwarded to the ISOLATED-world content script via
// window.postMessage with a namespaced { source: "tte-injected" } envelope.

(() => {
  // Guard against double-injection (SPA re-injection, multiple executeScript calls).
  if (window.__tteInjected) return;
  window.__tteInjected = true;

  const SOURCE = "tte-injected";

  // ---------------------------------------------------------------------------
  // STEP 0 RECON HOOK — URL matchers.
  //
  // These are the endpoint patterns to confirm in DevTools → Network (Fetch/XHR)
  // before shipping, since TikTok rotates paths/params periodically. As of the
  // last known shape, top-level comments live under a path containing
  // `comment/list/` and replies under `comment/list/reply/`. The reply matcher
  // is intentionally checked FIRST because the reply path is a superset of the
  // list path (it also contains "comment/list").
  // ---------------------------------------------------------------------------
  const REPLY_URL_RE = /\/comment\/list\/reply(\/|\?|$)/i;
  const LIST_URL_RE = /\/comment\/list(\/|\?|$)/i;

  function classifyUrl(url) {
    if (typeof url !== "string") return null;
    if (REPLY_URL_RE.test(url)) return "reply";
    if (LIST_URL_RE.test(url)) return "list";
    return null;
  }

  function post(kind, url, payload) {
    try {
      window.postMessage(
        { source: SOURCE, type: "RAW_COMMENT_PAYLOAD", kind, url, payload },
        "*"
      );
    } catch (err) {
      // Posting can throw if payload is not structured-cloneable; fail soft.
      // eslint-disable-next-line no-console
      console.warn("[TTE] postMessage failed:", err);
    }
  }

  function safeParse(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // --- fetch patch ----------------------------------------------------------
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const url = response && response.url;
        const kind = classifyUrl(url);
        if (kind && response.ok) {
          // Clone so TikTok's own code still gets an unread body.
          const clone = response.clone();
          clone
            .text()
            .then((text) => {
              const json = safeParse(text);
              if (json) post(kind, url, json);
            })
            .catch(() => {});
        }
      } catch (err) {
        // Never let our instrumentation break the page's fetch.
        // eslint-disable-next-line no-console
        console.warn("[TTE] fetch hook error:", err);
      }
      // Always return the ORIGINAL untouched response.
      return response;
    };
  }

  // --- XHR patch (fallback for endpoints TikTok serves over XMLHttpRequest) --
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url, ...rest) {
      this.__tteUrl = url;
      this.__tteKind = classifyUrl(url);
      return originalOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.send = function (...sendArgs) {
      if (this.__tteKind) {
        this.addEventListener("load", () => {
          try {
            if (this.status >= 200 && this.status < 300) {
              const text =
                this.responseType === "" || this.responseType === "text"
                  ? this.responseText
                  : typeof this.response === "string"
                  ? this.response
                  : null;
              const json =
                this.responseType === "json" && this.response
                  ? this.response
                  : safeParse(text);
              if (json) post(this.__tteKind, this.__tteUrl, json);
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn("[TTE] XHR hook error:", err);
          }
        });
      }
      return originalSend.apply(this, sendArgs);
    };
  }
})();
