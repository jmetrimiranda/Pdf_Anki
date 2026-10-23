// Leitor de Estudos — bridge for Anki's SvelteKit pages (served on the `anki` origin, injected before SvelteKit
// boots by the app's `anki` protocol). It replaces what Anki desktop's QWebEngine host does around these pages
// (qt/aqt/webview.py): `bridgeCommand`, the post-load styling and body classes, theme changes and closing.
//
// Protocol with the host (web/src/features/anki/pages/AnkiWebPage.tsx), every message to the parent carries
// `source: 'leitor-anki-page'`:
//   page → host  {t:'bridgeCommand', cmd} · {t:'close'} (Escape, or no pending-changes hook) · {t:'loaded'}
//   host → page  {t:'requestClose'} · {t:'theme', night}
// Only messages whose source is `window.parent` are accepted. The script only uses `window.*` so tests can run it
// against a stand-in window.
(function (window) {
  "use strict";
  if (window.__leitorPageBridge) return;
  window.__leitorPageBridge = true;

  var SOURCE = "leitor-anki-page";
  var parentWin = window.parent;
  var doc = window.document;

  function post(msg) {
    if (!parentWin || parentWin === window) return;
    msg.source = SOURCE;
    // The host checks this frame's origin and source window; the payload carries nothing secret.
    parentWin.postMessage(msg, "*");
  }

  // Anki pages call `bridgeCommand(cmd)` without a guard (ts/lib/tslib/bridgecommand.ts), e.g. the graphs page
  // ("browserSearch: …") and congrats ("unbury", "customStudy").
  function bridgeCommand(cmd) {
    post({ t: "bridgeCommand", cmd: String(cmd) });
    return false;
  }
  window.bridgeCommand = bridgeCommand;
  window.pycmd = bridgeCommand;

  function platformClass() {
    var ua = (window.navigator && window.navigator.userAgent) || "";
    if (/Windows/i.test(ua)) return "isWin";
    if (/Mac OS X|Macintosh|iPhone|iPad/i.test(ua)) return "isMac";
    return "isLin";
  }

  // webview.py:989-1013 (on_theme_did_change).
  function applyTheme(night) {
    var root = doc.documentElement;
    var body = doc.body;
    root.dataset.bsTheme = night ? "dark" : "light";
    root.classList.toggle("night-mode", !!night);
    if (body) {
      body.classList.toggle("night_mode", !!night);
      body.classList.toggle("nightMode", !!night);
    }
  }

  function initialNight() {
    return (
      window.location.hash === "#night" ||
      doc.documentElement.classList.contains("night-mode")
    );
  }

  var STYLE =
    "body { background-color: var(--canvas); }\n" +
    'html { font-family: system-ui, -apple-system, "Segoe UI", Ubuntu, Cantarell, "Noto Sans", sans-serif; }\n' +
    "button { font-family: inherit; }\n" +
    'textarea:focus, input:focus, input[type]:focus, div[contenteditable="true"]:focus ' +
    "{ outline: 0 none; border-color: var(--border-focus, #2a7ae2); }\n";

  // webview.py:910-935 (add_dynamic_styling_and_props_then_show): style, body classes, night mode; title kept.
  function styleOnLoad() {
    var title = doc.title;
    var style = doc.createElement("style");
    style.setAttribute("data-leitor", "page-bridge");
    style.textContent = STYLE;
    (doc.head || doc.documentElement).appendChild(style);
    if (doc.body) {
      doc.body.classList.add(platformClass());
      doc.body.classList.add("fancy");
    }
    applyTheme(initialNight());
    if (title) doc.title = title;
    post({ t: "loaded" });
  }

  function requestClose() {
    var anki = window.anki;
    if (anki && typeof anki.deckOptionsPendingChanges === "function") {
      // Deck options: commits the editing, may confirm(), then POSTs deckOptionsRequireClose; the core emits the
      // Close event to the host.
      Promise.resolve()
        .then(function () {
          return anki.deckOptionsPendingChanges();
        })
        .catch(function () {
          post({ t: "close" });
        });
    } else {
      post({ t: "close" });
    }
  }

  window.addEventListener("message", function (e) {
    if (e.source !== parentWin || parentWin === window) return;
    var data = e.data;
    if (!data || typeof data !== "object") return;
    if (data.t === "requestClose") requestClose();
    else if (data.t === "theme") applyTheme(!!data.night);
  });

  window.addEventListener("keydown", function (e) {
    if (
      e.key === "Escape" &&
      !e.defaultPrevented &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey
    )
      requestClose();
  });

  if (doc.readyState === "complete") styleOnLoad();
  else window.addEventListener("load", styleOnLoad);
})(window);
