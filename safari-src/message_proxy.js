// Safari legacy (.safariextension) isolated-world injected script.
//
// Three jobs:
//   1. Inject content_script.js into the page's own JavaScript world so it can
//      hook the EME APIs the page uses. Safari injected scripts run in an
//      isolated world and cannot override page globals, so the hooks must live
//      in a <script> element added to the page.
//   2. Bridge the DOM CustomEvents that content_script.js uses ('response' /
//      'responseReceived') to the extension's global page over Safari's
//      messaging API, preserving the request/response correlation id.
//   3. Host the device-file import. Extension pages cannot read file bytes --
//      WebKit refuses to load blob: URLs on the safari-extension scheme -- but
//      an ordinary web page can, so the file is dropped here and its bytes are
//      handed to the global page.

// The page-world hook source is embedded at build time so it can be injected
// inline, which executes synchronously at document-start (before the page's own
// scripts run) -- matching the original extension's world:MAIN behaviour.
var CONTENT_SCRIPT_SOURCE = __CONTENT_SCRIPT__;

(function () {
    // Safari can evaluate an injected script more than once for the same
    // document. Running twice would install a second set of EME hooks and a
    // second message listener, which duplicates every license request: Widevine
    // challenges carry a fresh nonce, so the second challenge would replace the
    // first in the background while the player sends the first to the license
    // server, and the returned license would then fail signature verification.
    const MARKER = "data-vineless";
    const root = document.documentElement;
    if (root) {
        if (root.hasAttribute(MARKER)) {
            return;
        }
        root.setAttribute(MARKER, "");
    }

    // --- Inject the page-world hook script ---
    try {
        const script = document.createElement('script');
        script.textContent = CONTENT_SCRIPT_SOURCE;
        (document.head || document.documentElement || document).appendChild(script);
        script.remove();
    } catch (e) {
        // If injection is blocked (e.g. by a strict page CSP) the EME hooks
        // cannot be installed; playback falls back to the browser's own CDM.
    }

    const isTopFrame = (window === window.top);

    // --- Page world -> global page ---
    document.addEventListener('response', function (event) {
        const detail = event.detail;
        safari.self.tab.dispatchMessage('request', {
            type: detail.type,
            body: detail.body,
            requestId: detail.requestId,
            origin: location.origin
        });
    });

    // ------------------------------------------------------------------ //
    // Device-file import overlay
    // ------------------------------------------------------------------ //
    let overlay = null;
    let statusLine = null;
    let pending = 0;

    function closeOverlay() {
        if (!overlay) return;
        try { overlay.remove(); } catch (e) { /* ignore */ }
        overlay = null;
        statusLine = null;
        pending = 0;
    }

    function setStatus(text, isError) {
        if (!statusLine) return;
        statusLine.textContent = text;
        statusLine.style.color = isError ? '#ff8080' : '#a0ffa0';
    }

    function bytesToBase64(bytes) {
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    function sendFile(file) {
        const reader = new FileReader();
        reader.onload = function () {
            const bytes = new Uint8Array(reader.result);
            safari.self.tab.dispatchMessage('importFile', {
                name: file.name,
                data: bytesToBase64(bytes)
            });
        };
        reader.onerror = function () {
            pending--;
            setStatus('Could not read ' + file.name, true);
        };
        reader.readAsArrayBuffer(file);
    }

    function handleFiles(files) {
        if (!files || !files.length) return;
        pending = files.length;
        setStatus('Importing ' + files.length + ' file(s)...');
        for (let i = 0; i < files.length; i++) {
            sendFile(files[i]);
        }
    }

    function showOverlay() {
        if (overlay) return;

        overlay = document.createElement('div');
        overlay.style.cssText =
            'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;' +
            'background:rgba(0,0,0,0.8);color:#fff;' +
            'font:16px -apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif;' +
            'display:flex;align-items:center;justify-content:center;text-align:center;';

        const box = document.createElement('div');
        box.style.cssText =
            'border:3px dashed #fff;border-radius:12px;padding:40px 60px;max-width:80%;';

        const title = document.createElement('div');
        title.textContent = 'Drop your Vineless device file here';
        title.style.cssText = 'font-size:22px;font-weight:bold;margin-bottom:12px;';

        const hint = document.createElement('div');
        hint.textContent = '.wvd, .prd, or a remote CDM .json file';
        hint.style.cssText = 'opacity:0.8;margin-bottom:16px;';

        const escape = document.createElement('div');
        escape.textContent = 'Press Esc or click outside the box to cancel';
        escape.style.cssText = 'font-size:13px;opacity:0.6;';

        statusLine = document.createElement('div');
        statusLine.style.cssText = 'margin-top:16px;min-height:20px;';

        box.appendChild(title);
        box.appendChild(hint);
        box.appendChild(escape);
        box.appendChild(statusLine);
        overlay.appendChild(box);
        (document.body || document.documentElement).appendChild(overlay);

        overlay.addEventListener('dragover', function (e) {
            e.preventDefault();
            box.style.borderColor = '#4d9fff';
        });
        overlay.addEventListener('dragleave', function () {
            box.style.borderColor = '#fff';
        });
        overlay.addEventListener('drop', function (e) {
            e.preventDefault();
            box.style.borderColor = '#fff';
            handleFiles(e.dataTransfer && e.dataTransfer.files);
        });
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeOverlay();
        });
        document.addEventListener('keydown', function onKey(e) {
            if (e.key === 'Escape' || e.keyCode === 27) {
                document.removeEventListener('keydown', onKey);
                closeOverlay();
            }
        });
    }

    // --- Global page -> page world (and control messages) ---
    safari.self.addEventListener('message', function (event) {
        const msg = event.message || {};
        switch (event.name) {
            case 'response': {
                const requestId = msg.requestId;
                // Chrome delivers `undefined` (as the string "undefined") when the
                // background sends no response; several call sites depend on that.
                let response = ('response' in msg) ? msg.response : undefined;
                if (response === null) {
                    response = undefined;
                }
                document.dispatchEvent(new CustomEvent('responseReceived', {
                    detail: requestId.concat(response)
                }));
                break;
            }
            case 'reloadTab':
                if (isTopFrame) {
                    location.reload();
                }
                break;
            case 'importMode':
                if (isTopFrame) {
                    showOverlay();
                }
                break;
            case 'bgLog': {
                // The global page has no inspector of its own in Safari 7.
                if (!isTopFrame) return;
                const level = msg.level === 'debug' ? 'log' : (msg.level || 'log');
                (console[level] || console.log).call(console, '[Vineless BG]', msg.text);
                break;
            }
            case 'importResult': {
                if (!overlay) return;
                pending--;
                if (msg.ok) {
                    setStatus('Imported ' + msg.name);
                    if (pending <= 0) {
                        setTimeout(closeOverlay, 1200);
                    }
                } else {
                    setStatus('Could not import ' + msg.name +
                        (msg.error ? ': ' + msg.error : ''), true);
                }
                break;
            }
            case 'executeScript': {
                if (!isTopFrame) {
                    return;
                }
                let result = null;
                try {
                    const fn = (0, eval)('(' + msg.code + ')');
                    result = fn.apply(null, msg.args || []);
                } catch (e) {
                    result = null;
                }
                safari.self.tab.dispatchMessage('executeScriptResult', {
                    execId: msg.execId,
                    result: result
                });
                break;
            }
        }
    }, false);
})();
