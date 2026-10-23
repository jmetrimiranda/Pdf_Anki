// Card iframe shim (spec 8.4; docs/tecnico/anki-web-and-reviewer.md §4-§5). Loaded by reviewer.html BEFORE
// webview.js/reviewer.js inside <iframe sandbox="allow-scripts"> (opaque origin, no Tauri IPC). It stands in for the
// desktop's Qt bridge: `pycmd`/`bridgeCommand` become postMessage to the host (the study screen), and the host drives
// reviewer.js (_showQuestion/_showAnswer/_drawFlag/_drawMark/getTypedAnswer) through messages. It only ever talks to
// window.parent: messages from anywhere else are ignored, and what it sends is not secret (targetOrigin '*', because
// an opaque origin cannot name the host's).
(function () {
  'use strict';
  var host = window.parent;
  var seq = 0;
  var callbacks = new Map();

  function post(msg) {
    try {
      host.postMessage(msg, '*');
    } catch (e) {
      // The host went away; nothing to do.
    }
  }

  // ------------------------------------------------------------ pycmd / bridgeCommand

  function postShown() {
    post({ t: 'shown' });
  }

  function bridgeCommand(cmd, cb) {
    cmd = String(cmd);
    if (cmd === 'updateToolbar') {
      // reviewer.js sends this after the new HTML is in and before it runs onShownHook (which _updateQA resets on
      // every show): the moment to ask for a 'shown' once MathJax and the template's hooks are done.
      if (Array.isArray(window.onShownHook)) window.onShownHook.push(postShown);
      return false;
    }
    var id = 0;
    if (typeof cb === 'function') {
      id = ++seq;
      callbacks.set(id, cb);
    }
    post({ t: 'pycmd', cmd: cmd, id: id });
    return false;
  }
  window.pycmd = bridgeCommand;
  window.bridgeCommand = bridgeCommand;

  // ------------------------------------------------------------ storage in an opaque origin

  // localStorage/sessionStorage throw a SecurityError in a sandboxed frame; some shared-deck templates use them.
  function memoryStorage() {
    var data = new Map();
    return {
      get length() {
        return data.size;
      },
      key: function (i) {
        var keys = Array.from(data.keys());
        return i >= 0 && i < keys.length ? keys[i] : null;
      },
      getItem: function (k) {
        k = String(k);
        return data.has(k) ? data.get(k) : null;
      },
      setItem: function (k, v) {
        data.set(String(k), String(v));
      },
      removeItem: function (k) {
        data.delete(String(k));
      },
      clear: function () {
        data.clear();
      },
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    var ok = false;
    try {
      ok = window[name] !== null && window[name] !== undefined;
      if (ok) window[name].getItem('__leitor');
    } catch (e) {
      ok = false;
    }
    if (ok) return;
    var stub = memoryStorage();
    try {
      Object.defineProperty(window, name, { configurable: true, get: function () { return stub; } });
    } catch (e) {
      // Not configurable here: templates that use storage keep failing as they would in any sandbox.
    }
  });

  // ------------------------------------------------------------ host → card

  function setNight(night) {
    var html = document.documentElement;
    html.classList.toggle('night-mode', !!night);
    html.setAttribute('data-bs-theme', night ? 'dark' : 'light');
    if (document.body) {
      document.body.classList.toggle('nightMode', !!night);
      document.body.classList.toggle('night_mode', !!night);
    }
  }

  var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  // RUN_STATE_MUTATION (qt/aqt/reviewer.py): statesMutated is always sent, even when the user's JS is broken. It
  // carries the card's key so the host can tell a late report of a previous card from the current one.
  function mutateStates(key, js) {
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      bridgeCommand('statesMutated:' + String(key));
    }
    try {
      var mutator = new AsyncFunction('states', 'customData', 'ctx', String(js));
      var anki = globalThis.anki;
      if (!anki || typeof anki.mutateNextCardStates !== 'function') {
        finish();
        return;
      }
      Promise.resolve(anki.mutateNextCardStates(String(key), mutator))
        .catch(function (e) {
          console.warn('card: custom scheduling failed', e);
        })
        .finally(finish);
    } catch (e) {
      console.warn('card: custom scheduling failed', e);
      finish();
    }
  }

  function call(name, args) {
    var fn = window[name];
    if (typeof fn !== 'function') {
      console.warn('card: ' + name + ' is not available');
      return undefined;
    }
    return fn.apply(window, args);
  }

  window.addEventListener('message', function (e) {
    if (e.source !== host) return;
    var m = e.data;
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'showQuestion':
        call('_showQuestion', [String(m.q), String(m.a), String(m.bodyclass)]);
        break;
      case 'showAnswer':
        call('_showAnswer', [String(m.a)]);
        break;
      case 'flag':
        call('_drawFlag', [m.flag | 0]);
        break;
      case 'mark':
        call('_drawMark', [!!m.mark]);
        break;
      case 'getTypedAnswer': {
        var v = null;
        try {
          v = call('getTypedAnswer', []);
        } catch (err) {
          v = null;
        }
        post({ t: 'typed', v: v == null ? '' : String(v) });
        break;
      }
      case 'mutateStates':
        mutateStates(m.key, m.js);
        break;
      case 'theme':
        setNight(!!m.night);
        break;
      case 'cb': {
        var cb = callbacks.get(m.id);
        callbacks.delete(m.id);
        if (cb) cb(m.v);
        break;
      }
      default:
        break;
    }
  });

  // ------------------------------------------------------------ card → host

  function editable(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return !!el.isContentEditable;
  }

  window.addEventListener('keydown', function (e) {
    if (e.isComposing || editable(e.target)) return;
    // The host decides what the key does (show answer, answer, mark…); keep the frame from scrolling on Space.
    if (e.key === ' ' || e.key === 'Enter') e.preventDefault();
    post({
      t: 'key',
      key: e.key,
      code: e.code,
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey,
      meta: e.metaKey,
    });
  });

  document.addEventListener(
    'click',
    function (e) {
      var target = e.target;
      var a = target && target.closest ? target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (/^leitor:/i.test(href)) {
        e.preventDefault();
        post({ t: 'link', href: href });
      }
    },
    true,
  );

  function onReady() {
    post({ t: 'ready' });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();
})();
