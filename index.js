// Code Window v1.4 - SillyTavern extension
// Floating, draggable, resizable popup that renders HTML/CSS/JS in a locked-down sandboxed iframe.
// v1.4: multi-file projects (tabs + imports), Code / Run Code switch, built-in *italic* / **bold** formatting,
//       safe project export/import (+undo), fullscreen editor fix, CSP lock-down of the rendered page.
// v1.3: full screen mode, viewport-height fix, real generating detection, ST.stop().
// v1.2: streaming updates, ST.state.generating.  v1.1: `ST` bridge object for rendered pages.
(() => {
    const MODULE = 'code_window';
    const FORMAT = 'st-code-window-project';
    const FORMAT_VERSION = 2;
    const MAX_FILE = 1000000, MAX_TOTAL = 3000000, MAX_FILES = 40;
    const ctx = () => SillyTavern.getContext();
    const $id = (id) => document.getElementById(id);

    const defaults = Object.freeze({
        left: null, top: null, width: 720, height: 600,
        fullscreen: true,
        allowScripts: true,       // run <script> inside the page
        allowBridge: true,        // page may read chat state + fill/send the chat input
        allowExternal: true,      // page may load https images/fonts/CSS/CDN scripts (never allows network calls)
        autoFormat: true,         // render *italic* / **bold** in the page's text automatically
        autoRender: false,        // auto-render last code block of new AI messages
        mode: 'run',              // 'code' | 'run'
        files: null,              // [{name, content}] - files[0] is always the entry (index.html)
        active: 'index.html',
        backup: null,             // one-level undo slot for import / delete / new
        lastCode: '',             // legacy (v1.3), migrated into files[0]
    });

    // ---------- settings + project model ----------
    function settings() {
        const { extensionSettings } = ctx();
        if (!extensionSettings[MODULE]) extensionSettings[MODULE] = {};
        const s = extensionSettings[MODULE];
        for (const k of Object.keys(defaults)) if (s[k] === undefined) s[k] = defaults[k];
        return s;
    }
    const save = () => ctx().saveSettingsDebounced();

    function starterFiles() {
        return [
            { name: 'index.html', content:
`<!-- ENTRY FILE. Import your other tabs here: -->
<!-- @import style.css -->

<div id="app">
  <h3 id="who">Hello</h3>
  <div id="msg">...</div>
</div>

<!-- @import app.js -->
` },
            { name: 'style.css', content:
`body { margin: 0; font-family: system-ui, sans-serif; background: #14121f; color: #eee; }
#app { padding: 14px; }
#msg { white-space: pre-wrap; line-height: 1.5; }
em { color: #b9a7ff; }
` },
            { name: 'app.js', content:
`// ST.format() turns *italic* and **bold** into real HTML (safely).
ST.onUpdate(function (s) {
  document.getElementById('who').textContent = s.char || 'Hello';
  document.getElementById('msg').innerHTML = ST.format(s.lastCharMessage || '');
});
` },
        ];
    }

    function cleanName(raw) {
        let n = String(raw || '').trim().replace(/[^\w.\- ]/g, '').replace(/\s+/g, '-').slice(0, 40);
        if (!n || n.startsWith('.')) return '';
        return n;
    }
    function uniqueName(base, files) {
        const has = (x) => files.some((f) => f.name.toLowerCase() === x.toLowerCase());
        let n = base, i = 2;
        while (has(n)) {
            const m = base.match(/^(.*?)(\.[^.]*)?$/);
            n = `${m[1]}-${i++}${m[2] || ''}`;
        }
        return n;
    }

    function ensureProject() {
        const s = settings();
        let ok = Array.isArray(s.files) && s.files.length > 0 &&
            s.files.every((f) => f && typeof f.name === 'string' && typeof f.content === 'string');
        if (!ok) {
            s.files = s.lastCode ? [{ name: 'index.html', content: String(s.lastCode) }] : starterFiles();
            s.active = 'index.html';
        }
        s.files[0].name = 'index.html';
        if (!s.files.some((f) => f.name === s.active)) s.active = s.files[0].name;
        return s;
    }
    const activeFile = () => { const s = ensureProject(); return s.files.find((f) => f.name === s.active) || s.files[0]; };

    // ---------- import resolution (tabs -> one document) ----------
    const kindOf = (name) => /\.css$/i.test(name) ? 'css' : /\.m?js$/i.test(name) ? 'js' : 'html';
    const stripExt = (n) => n.replace(/\.[^.]*$/, '');
    function findFile(files, ref) {
        const r = String(ref).trim().replace(/^\.?\//, '').toLowerCase();
        const exact = files.find((f) => f.name.toLowerCase() === r);
        if (exact) return exact;
        const c = files.filter((f) => stripExt(f.name).toLowerCase() === r);
        return c.length === 1 ? c[0] : null;
    }
    const isRemote = (u) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u.trim());
    const safeJs = (t) => t.replace(/<\/(script)/gi, '<\\/$1');
    const safeCss = (t) => t.replace(/<\/(style)/gi, '<\\/$1');
    const attr = (tag, name) => {
        const m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i'));
        return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
    };

    function assemble(files) {
        const warnings = [];
        const idx = files[0];

        function resolveCss(content, stack) {
            return content.replace(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?\s*;?/gi, (m, ref) => {
                if (isRemote(ref)) return m;
                const f = findFile(files, ref);
                if (!f) { warnings.push(`missing CSS import "${ref}"`); return `/* missing import: ${ref} */`; }
                if (stack.includes(f.name)) { warnings.push(`circular import "${f.name}"`); return ''; }
                return resolveCss(f.content, stack.concat(f.name));
            });
        }
        function inline(ref, stack, original) {
            const f = findFile(files, ref);
            if (!f) { warnings.push(`missing import "${ref}"`); return `<!-- missing import: ${ref.replace(/-->/g, '')} -->`; }
            if (stack.includes(f.name)) { warnings.push(`circular import "${f.name}"`); return ''; }
            const st = stack.concat(f.name);
            const k = kindOf(f.name);
            if (k === 'css') return `<style>\n/* ${f.name} */\n${safeCss(resolveCss(f.content, st))}\n</style>`;
            if (k === 'js') return `<script>\n// ${f.name}\n${safeJs(f.content)}\n</script>`;
            return resolveHtml(f.content, st);
        }
        function resolveHtml(content, stack) {
            const re = /<!--\s*@import\s+([^\s>]+?)\s*-->|<link\b[^>]*>|<script\b[^>]*\bsrc\s*=[^>]*>\s*<\/script>/gi;
            return content.replace(re, (m, ref) => {
                if (ref) return inline(ref, stack, m);
                if (/^<link/i.test(m)) {
                    const href = attr(m, 'href'), rel = attr(m, 'rel') || '';
                    if (!href || !/stylesheet/i.test(rel) || isRemote(href)) return m;
                    return inline(href.replace(/[?#].*$/, ''), stack, m);
                }
                const src = attr(m, 'src');
                if (!src || isRemote(src)) return m;
                const f = findFile(files, src.replace(/[?#].*$/, ''));
                if (!f) { warnings.push(`missing script "${src}"`); return `<!-- missing script: ${src.replace(/-->/g, '')} -->`; }
                if (stack.includes(f.name)) { warnings.push(`circular import "${f.name}"`); return ''; }
                const type = attr(m, 'type');
                return `<script${type ? ` type="${type.replace(/"/g, '')}"` : ''}>\n// ${f.name}\n${safeJs(f.content)}\n</script>`;
            });
        }
        return { code: resolveHtml(idx.content, [idx.name]), warnings };
    }

    // ---------- helper injected into every rendered page (runs INSIDE the sandbox) ----------
    // API:  ST.state / ST.onUpdate(fn) / ST.send / ST.insert / ST.append / ST.setVar / ST.stop
    //       ST.format(text) -> safe HTML with *italic* **bold** ***both*** ~~strike~~ `code` and line breaks
    //       ST.render(el, text) -> el.innerHTML = ST.format(text)
    //       Auto mode ("MD" switch): plain text containing * ** etc is formatted automatically.
    //       Add the attribute data-st-raw to any element to opt it out.
    function pageHelper() {
        var cfg = window.__ST_CFG || {};
        var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
        var INNER = '([^*\\s](?:[^*]*?[^*\\s])?)';
        var RE3 = new RegExp('\\*\\*\\*' + INNER + '\\*\\*\\*', 'g');
        var RE2 = new RegExp('\\*\\*' + INNER + '\\*\\*', 'g');
        var RE1 = new RegExp('\\*' + INNER + '\\*', 'g');
        var RES = /~~([^~\s](?:[^~]*?[^~\s])?)~~/g;
        function fmt(text) {
            var h = esc(text), codes = [];
            h = h.replace(/`([^`\n]+)`/g, function (_, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
            h = h.replace(RE3, '<strong><em>$1</em></strong>').replace(RE2, '<strong>$1</strong>').replace(RE1, '<em>$1</em>').replace(RES, '<del>$1</del>');
            return h.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + codes[i] + '</code>'; });
        }
        var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, CODE: 1, PRE: 1, NOSCRIPT: 1, OPTION: 1, SELECT: 1, HEAD: 1, TITLE: 1 };
        function skip(n) {
            for (var p = n.parentNode; p && p.nodeType === 1; p = p.parentNode) {
                if (SKIP[p.nodeName] || p.isContentEditable || (p.hasAttribute && p.hasAttribute('data-st-raw'))) return true;
            }
            return false;
        }
        function processText(n) {
            var t = n.nodeValue;
            if (!t || (t.indexOf('*') < 0 && t.indexOf('`') < 0 && t.indexOf('~~') < 0)) return;
            var h = fmt(t);
            if (h === esc(t)) return;
            var tpl = document.createElement('template');
            tpl.innerHTML = h;          // safe: text was HTML-escaped first, only our own tags were added
            n.parentNode.replaceChild(tpl.content, n);
        }
        function walk(root) {
            var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), list = [], n;
            while ((n = tw.nextNode())) list.push(n);
            list.forEach(function (x) { if (x.parentNode && !skip(x)) processText(x); });
        }

        window.ST = {
            state: {}, _cbs: [],
            format: function (t) { return fmt(t == null ? '' : t).replace(/\r?\n/g, '<br>'); },
            render: function (el, t) { el.innerHTML = this.format(t); },
            onUpdate: function (cb) { this._cbs.push(cb); if (this.state.ready) { try { cb(this.state); } catch (x) { console.error(x); } } },
            send: function (t) { parent.postMessage({ type: 'st-send', text: String(t) }, '*'); },
            insert: function (t) { parent.postMessage({ type: 'st-insert', text: String(t) }, '*'); },
            append: function (t) { parent.postMessage({ type: 'st-append', text: String(t) }, '*'); },
            setVar: function (n, v) { parent.postMessage({ type: 'st-setvar', name: String(n), value: v }, '*'); },
            stop: function () { parent.postMessage({ type: 'st-stop' }, '*'); },
            request: function () { parent.postMessage({ type: 'st-request' }, '*'); }
        };
        addEventListener('message', function (e) {
            var d = e.data;
            if (d && d.type === 'st-state') {
                ST.state = Object.assign({ ready: true }, d.state);
                ST._cbs.forEach(function (cb) { try { cb(ST.state); } catch (x) { console.error(x); } });
            }
        });
        addEventListener('DOMContentLoaded', function () { ST.request(); if (cfg.md) walk(document.body); });

        if (cfg.md) {
            var busy = false;
            var opts = { childList: true, subtree: true, characterData: true };
            var obs = new MutationObserver(function (recs) {
                if (busy) return;
                busy = true; obs.disconnect();
                try {
                    recs.forEach(function (r) {
                        if (r.type === 'characterData') {
                            if (r.target.parentNode && !skip(r.target)) processText(r.target);
                        } else {
                            Array.prototype.forEach.call(r.addedNodes, function (n) {
                                if (!n.parentNode) return;
                                if (n.nodeType === 3) { if (!skip(n)) processText(n); }
                                else if (n.nodeType === 1) walk(n);
                            });
                        }
                    });
                } catch (x) { console.error(x); }
                obs.observe(document.documentElement, opts);
                busy = false;
            });
            obs.observe(document.documentElement, opts);
        }
    }

    function helperTag(s) {
        const cfg = JSON.stringify({ md: !!s.autoFormat });
        return `<script>window.__ST_CFG=${cfg};(${pageHelper.toString()})();<\/script>`;
    }

    // Security policy applied INSIDE the rendered page. connect-src 'none' means the page can never make
    // fetch/XHR/WebSocket calls, so nothing it sees can be sent anywhere.
    function cspMeta(s) {
        const ext = s.allowExternal ? ' https:' : '';
        const cdn = s.allowExternal ? ' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com' : '';
        const csp = [
            "default-src 'none'",
            s.allowScripts ? `script-src 'unsafe-inline' 'unsafe-eval'${cdn}` : "script-src 'none'",
            `style-src 'unsafe-inline'${ext}`,
            `img-src data: blob:${ext}`,
            `font-src data:${ext}`,
            `media-src data: blob:${ext}`,
            "connect-src 'none'", "frame-src 'none'", "object-src 'none'",
            "form-action 'none'", "base-uri 'none'",
        ].join('; ');
        return `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
    }
    const sandboxAttr = (s) => s.allowScripts ? 'allow-scripts allow-forms allow-modals' : '';

    function buildDoc(code, s) {
        const head = cspMeta(s) + helperTag(s);
        const trimmed = code.trim();
        if (/^<!doctype|^<html/i.test(trimmed)) {
            if (/<head(?=[\s>])[^>]*>/i.test(code)) return code.replace(/<head(?=[\s>])[^>]*>/i, (m) => m + head);
            if (/<html(?=[\s>])[^>]*>/i.test(code)) return code.replace(/<html(?=[\s>])[^>]*>/i, (m) => m + '<head>' + head + '</head>');
            return head + code;
        }
        if (!/<[a-z!][\s\S]*>/i.test(trimmed) && /[{};:]/.test(trimmed)) {
            return `<!doctype html><html><head><meta charset="utf-8">${head}<style>${safeCss(code)}</style></head><body></body></html>`;
        }
        return `<!doctype html><html><head><meta charset="utf-8">${head}
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;padding:8px;font-family:system-ui,sans-serif;}</style>
</head><body>${code}</body></html>`;
    }

    // ---------- run / preview ----------
    let rendered = false;
    function showDoc(code) {
        const s = settings();
        const frame = $id('cw_frame');
        frame.setAttribute('sandbox', sandboxAttr(s));
        frame.srcdoc = buildDoc(code, s);
        rendered = true;
    }
    function run() {
        const s = ensureProject();
        flushEditor();
        const { code, warnings } = assemble(s.files);
        setMode('run');
        showDoc(code);
        const n = s.files.length;
        setStatus(`Ran ${n} file${n > 1 ? 's' : ''}, ${code.length} chars` + (warnings.length ? ` | ⚠ ${[...new Set(warnings)].slice(0, 2).join('; ')}` : ''));
    }
    function previewRaw(code) {
        setMode('run');
        showDoc(code);
        setStatus('Previewing chat snippet (not saved into your project)');
    }
    function setStatus(t) { const el = $id('cw_status'); if (el) el.textContent = t; }

    // Chat code block -> window. Single-file projects behave like before; multi-file projects are never overwritten silently.
    function renderFromChat(code, auto) {
        const s = ensureProject();
        openWindow();
        if (s.files.length === 1) {
            replaceProject([{ name: 'index.html', content: code }], 'index.html', false);
            run();
        } else if (auto) {
            previewRaw(code);
        } else if (confirm('Replace the content of index.html with this code block?\n(Your other files are kept. You can press Undo afterwards.)')) {
            pushBackup();
            s.files[0].content = code; s.active = 'index.html';
            replaceProject(s.files, s.active, false);
            run();
        } else {
            previewRaw(code);
        }
    }

    // ---------- chat state -> page ----------
    function isGenerating() {
        const stop = $id('mes_stop');
        if (!stop) return false;
        const cs = getComputedStyle(stop);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
    }
    // Whitelist only: nothing from settings, secrets or API config is ever included here.
    function getState() {
        const c = ctx();
        const chat = c.chat || [];
        const toMsg = (m) => ({ name: m.name, text: m.mes, isUser: !!m.is_user });
        const visible = chat.filter((m) => !m.is_system);
        const last = visible[visible.length - 1];
        const lastChar = [...visible].reverse().find((m) => !m.is_user);
        return {
            user: c.name1,
            char: c.name2,
            lastMessage: last ? toMsg(last) : null,
            lastCharMessage: lastChar ? lastChar.mes : '',
            messages: visible.slice(-20).map(toMsg),
            generating: isGenerating(),
            vars: { ...((c.chatMetadata && c.chatMetadata.variables) || {}) },
        };
    }
    function pushState() {
        if (!settings().allowBridge) return;
        const w = $id('cw_window'), frame = $id('cw_frame');
        if (!w || !frame || !frame.contentWindow || !w.classList.contains('cw_open')) return;
        try { frame.contentWindow.postMessage({ type: 'st-state', state: getState() }, '*'); } catch (e) { console.warn('[Code Window] pushState failed', e); }
    }
    let lastPush = 0, pushTimer = null;
    function pushThrottled() {
        const now = Date.now();
        if (now - lastPush > 120) { lastPush = now; pushState(); return; }
        if (!pushTimer) pushTimer = setTimeout(() => { pushTimer = null; lastPush = Date.now(); pushState(); }, 130);
    }
    function setVh() {
        const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
        document.documentElement.style.setProperty('--cw-vh', h + 'px');
    }

    // ---------- window ----------
    // Real browser full screen (hides the address bar + Android nav bar). Needs a user tap, so it is
    // requested from button / menu clicks; if the browser refuses, the CSS full-window mode still works.
    function enterBrowserFs() {
        const w = $id('cw_window');
        if (document.fullscreenElement || document.webkitFullscreenElement) return;
        const rf = w.requestFullscreen || w.webkitRequestFullscreen;
        if (!rf) return;
        try {
            const p = rf.call(w, { navigationUI: 'hide' });
            if (p && p.catch) p.catch(() => {});
        } catch { /* ignore */ }
    }
    function exitBrowserFs() {
        if (!(document.fullscreenElement || document.webkitFullscreenElement)) return;
        const ef = document.exitFullscreen || document.webkitExitFullscreen;
        try { const p = ef && ef.call(document); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ }
    }
    function openWindow() {
        $id('cw_window').classList.add('cw_open');
        if (settings().fullscreen) enterBrowserFs();
        if (settings().mode === 'run' && !rendered) run();   // untrusted code only runs once you open the window
        setTimeout(pushState, 100);
    }
    function closeWindow() { exitBrowserFs(); $id('cw_window').classList.remove('cw_open'); }
    function toggleWindow() { $id('cw_window').classList.contains('cw_open') ? closeWindow() : openWindow(); }
    function setFullscreen(on) {
        $id('cw_window').classList.toggle('cw_full', on);
        $id('cw_btn_max').classList.toggle('cw_on', on);
        settings().fullscreen = on; save();
        if (on) enterBrowserFs(); else exitBrowserFs();
        setVh();
    }
    function setMode(m) {
        const s = settings();
        s.mode = m; save();
        $id('cw_window').classList.toggle('cw_mode_code', m === 'code');
        $id('cw_m_code').classList.toggle('cw_on', m === 'code');
        $id('cw_m_run').classList.toggle('cw_on', m === 'run');
        if (m === 'code') { renderTabs(); loadEditor(); }
    }

    function clampIntoView(w) {
        const r = w.getBoundingClientRect();
        w.style.left = Math.min(Math.max(0, r.left), window.innerWidth - 80) + 'px';
        w.style.top = Math.min(Math.max(0, r.top), window.innerHeight - 40) + 'px';
        w.style.right = 'auto';
    }
    function makeDraggable(w, handle) {
        let sx, sy, ox, oy, dragging = false;
        handle.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.cw_btn, .cw_seg') || w.classList.contains('cw_full')) return;
            dragging = true;
            const r = w.getBoundingClientRect();
            sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
            w.style.right = 'auto';
            w.classList.add('cw_dragging');
            handle.setPointerCapture(e.pointerId);
        });
        handle.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            w.style.left = (ox + e.clientX - sx) + 'px';
            w.style.top = (oy + e.clientY - sy) + 'px';
        });
        const end = () => {
            if (!dragging) return;
            dragging = false;
            w.classList.remove('cw_dragging');
            clampIntoView(w);
            persistGeometry();
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }
    function persistGeometry() {
        const w = $id('cw_window');
        if (w.classList.contains('cw_full')) return;
        const s = settings(), r = w.getBoundingClientRect();
        s.left = Math.round(r.left); s.top = Math.round(r.top);
        s.width = Math.round(r.width); s.height = Math.round(r.height);
        save();
    }

    // ---------- editor / tabs ----------
    let editorFile = null;   // name of the file currently shown in the textarea
    function loadEditor() {
        const ta = $id('cw_editor'), f = activeFile();
        editorFile = f.name;
        ta.value = f.content;
        ta.placeholder = f === ensureProject().files[0]
            ? 'ENTRY FILE (index.html)\nImport other tabs with:\n  <!-- @import ui.html -->\n  <link rel="stylesheet" href="style.css">\n  <script src="app.js"></script>'
            : `${f.name}\n(import it from index.html)`;
    }
    function flushEditor() {
        if (editorFile === null) return;
        const f = ensureProject().files.find((x) => x.name === editorFile);
        if (f) f.content = $id('cw_editor').value;
    }
    function renderTabs() {
        const s = ensureProject(), box = $id('cw_tabs');
        box.textContent = '';
        s.files.forEach((f, i) => {
            const t = document.createElement('span');
            t.className = 'cw_tab' + (f.name === s.active ? ' cw_on' : '');
            t.textContent = f.name;
            t.title = i === 0 ? 'Entry file' : f.name;
            t.onclick = () => { flushEditor(); s.active = f.name; save(); renderTabs(); loadEditor(); };
            box.appendChild(t);
        });
        const on = box.querySelector('.cw_on');
        if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    function replaceProject(files, active, redraw = true) {
        const s = settings();
        editorFile = null;                 // prevents a stale textarea from overwriting the new files
        s.files = files; s.active = active;
        ensureProject(); save();
        if (redraw) { renderTabs(); loadEditor(); }
    }
    function pushBackup() {
        const s = ensureProject();
        s.backup = { files: JSON.parse(JSON.stringify(s.files)), active: s.active };
    }
    function undo() {
        const s = ensureProject();
        if (!s.backup) { setStatus('Nothing to undo'); return; }
        flushEditor();
        const cur = { files: JSON.parse(JSON.stringify(s.files)), active: s.active };
        const b = s.backup;
        s.backup = cur;                    // undo twice = redo
        replaceProject(b.files, b.active);
        setStatus('Undone (press Undo again to redo)');
    }
    function addFile() {
        const s = ensureProject();
        flushEditor();
        const raw = prompt('New file name.\nUse .css / .js / .html (no extension = HTML snippet).\nExamples: style.css, app.js, ui.html', 'ui.html');
        if (raw === null) return;
        const name = cleanName(raw);
        if (!name) { setStatus('Invalid file name'); return; }
        if (s.files.length >= MAX_FILES) { setStatus(`Max ${MAX_FILES} files`); return; }
        const finalName = uniqueName(name, s.files);
        s.files.push({ name: finalName, content: '' });
        s.active = finalName; save(); renderTabs(); loadEditor();
        $id('cw_editor').focus();
    }
    function renameFile() {
        const s = ensureProject(), f = activeFile();
        if (f === s.files[0]) { setStatus('index.html is the entry file and cannot be renamed'); return; }
        const raw = prompt('Rename file (remember to update imports that used the old name):', f.name);
        if (raw === null) return;
        const name = cleanName(raw);
        if (!name) { setStatus('Invalid file name'); return; }
        const others = s.files.filter((x) => x !== f);
        const finalName = uniqueName(name, others);
        flushEditor();
        const old = f.name;
        f.name = finalName; s.active = finalName; editorFile = finalName;
        save(); renderTabs();
        setStatus(`Renamed ${old} → ${finalName}. Update any import that used "${old}".`);
    }
    function deleteFile() {
        const s = ensureProject(), f = activeFile();
        if (f === s.files[0]) { setStatus('index.html cannot be deleted'); return; }
        if (!confirm(`Delete "${f.name}"? (Undo is available)`)) return;
        flushEditor(); pushBackup();
        replaceProject(s.files.filter((x) => x !== f), s.files[0].name);
        setStatus(`Deleted ${f.name}`);
    }
    function newProject() {
        if (!confirm('Start a new project? The current one is kept in Undo.')) return;
        flushEditor(); pushBackup();
        replaceProject(starterFiles(), 'index.html');
        setStatus('New project');
    }

    // ---------- export / import ----------
    function exportProject() {
        const s = ensureProject();
        flushEditor();
        const data = {
            format: FORMAT, version: FORMAT_VERSION, exportedAt: new Date().toISOString(),
            files: s.files.map((f) => ({ name: f.name, content: f.content })),
        };
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url; a.download = `code-window-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        setStatus(`Exported ${s.files.length} file(s)`);
    }

    // Validates everything; never trusts the file. Returns a clean files[] with index.html first.
    function parseProject(text) {
        let data;
        try { data = JSON.parse(text); } catch { throw new Error('not valid JSON'); }
        let list = null;
        if (Array.isArray(data)) list = data;
        else if (data && typeof data === 'object' && data.format === FORMAT && Array.isArray(data.files)) {
            if (typeof data.version === 'number' && data.version > FORMAT_VERSION) throw new Error('made by a newer Code Window version');
            list = data.files;
        }
        if (!list) throw new Error('not a Code Window project file');
        if (!list.length || list.length > MAX_FILES) throw new Error(`file count must be 1-${MAX_FILES}`);
        const out = []; let total = 0;
        for (const item of list) {
            if (!item || typeof item.name !== 'string' || typeof item.content !== 'string') throw new Error('corrupt file entry');
            const name = cleanName(item.name);
            if (!name) throw new Error(`bad file name "${String(item.name).slice(0, 30)}"`);
            total += item.content.length;
            if (item.content.length > MAX_FILE || total > MAX_TOTAL) throw new Error('project too large');
            out.push({ name: uniqueName(name, out), content: item.content });
        }
        return normalizeEntry(out);
    }
    function normalizeEntry(files) {
        const find = (re) => files.findIndex((f) => re.test(f.name));
        let i = find(/^index\.html$/i);
        if (i < 0) i = find(/^index$/i);
        if (i < 0) i = find(/^index\.htm$/i);
        if (i >= 0) {
            const [e] = files.splice(i, 1);
            e.name = 'index.html';
            return [e, ...files.map((f) => f.name.toLowerCase() === 'index.html' ? { ...f, name: uniqueName('index-old.html', files) } : f)];
        }
        // no entry in the file: build one that imports everything
        const body = files.map((f) => `<!-- @import ${f.name} -->`).join('\n');
        return [{ name: 'index.html', content: body + '\n' }, ...files];
    }

    async function importFiles(fileList) {
        const s = ensureProject();
        const files = [...fileList];
        if (!files.length) return;
        try {
            const json = files.find((f) => /\.json$/i.test(f.name));
            if (json) {
                if (json.size > MAX_TOTAL * 1.5) throw new Error('file too large');
                const parsed = parseProject(await json.text());
                if (!confirm(`Replace the whole project with ${parsed.length} imported file(s)?\n(Current project is kept: press Undo to bring it back.)`)) { setStatus('Import cancelled'); return; }
                flushEditor(); pushBackup();
                replaceProject(parsed, parsed[0].name);
                setStatus(`Imported project: ${parsed.length} file(s)` + (files.length > 1 ? ' (other selected files ignored)' : ''));
                return;
            }
            // plain files -> new tabs
            flushEditor();
            let added = 0, skipped = 0;
            for (const f of files) {
                const name = cleanName(f.name);
                if (!name || f.size > MAX_FILE || s.files.length >= MAX_FILES) { skipped++; continue; }
                const text = await f.text();
                if (text.includes('\u0000')) { skipped++; continue; }   // binary file
                s.files.push({ name: uniqueName(name, s.files), content: text });
                added++;
            }
            if (added) { s.active = s.files[s.files.length - 1].name; save(); renderTabs(); loadEditor(); }
            setStatus(`Imported ${added} file(s)` + (skipped ? `, skipped ${skipped}` : ''));
        } catch (e) {
            setStatus('Import failed: ' + e.message + ' (nothing was changed)');
        }
    }

    // ---------- build UI ----------
    function createWindow() {
        const s = ensureProject();
        const html = `
<div id="cw_window" class="${s.fullscreen ? 'cw_full' : ''}" style="width:${s.width}px;height:${s.height}px;${s.left !== null ? `left:${s.left}px;top:${s.top}px;right:auto;` : ''}">
  <div id="cw_header">
    <span id="cw_title">Code Window</span>
    <span id="cw_mode">
      <span class="cw_seg" id="cw_m_code" title="Edit code">&lt;/&gt; Code</span><span class="cw_seg" id="cw_m_run" title="Run the project (click again to re-run)">&#9654; Run Code</span>
    </span>
    <span class="cw_btn" id="cw_btn_max" title="Full screen on/off">&#9974;</span>
    <span class="cw_btn" id="cw_btn_close" title="Close">&#10005;</span>
  </div>
  <div id="cw_float">
    <span class="cw_btn" id="cw_f_code" title="Back to code">&lt;/&gt; Code</span>
    <span class="cw_btn" id="cw_f_exit" title="Exit full screen">&#9974;</span>
    <span class="cw_btn" id="cw_f_close" title="Close">&#10005;</span>
  </div>
  <div id="cw_body">
    <iframe id="cw_frame" sandbox="allow-scripts allow-forms allow-modals" referrerpolicy="no-referrer"></iframe>
    <div id="cw_codepane">
      <div id="cw_tabrow"><div id="cw_tabs"></div><span class="cw_btn" id="cw_t_add" title="New file">+</span></div>
      <div id="cw_tools">
        <span class="cw_btn" id="cw_t_rename">Rename</span>
        <span class="cw_btn" id="cw_t_delete">Delete</span>
        <span class="cw_btn" id="cw_t_export" title="Download the whole project as JSON">Export</span>
        <span class="cw_btn" id="cw_t_import" title="Import a project .json, or .html/.css/.js files as new tabs">Import</span>
        <span class="cw_btn" id="cw_t_undo" title="Undo last import / delete / new / chat replace">Undo</span>
        <span class="cw_btn" id="cw_t_new" title="Start a fresh project">New</span>
        <input type="file" id="cw_import_input" multiple accept=".json,.html,.htm,.css,.js,.txt" hidden>
      </div>
      <textarea id="cw_editor" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off"></textarea>
    </div>
  </div>
  <div id="cw_footer">
    <span id="cw_status">Ready</span>
    <label title="Allow JavaScript inside the page"><input type="checkbox" id="cw_opt_scripts"> JS</label>
    <label title="Let the page read chat/variables and fill or send the chat input"><input type="checkbox" id="cw_opt_bridge"> Bridge</label>
    <label title="Auto-format *italic* and **bold** in the page's text"><input type="checkbox" id="cw_opt_md"> MD</label>
    <label title="Allow https images / fonts / CSS / CDN scripts. Off = fully offline page. Network calls are always blocked."><input type="checkbox" id="cw_opt_ext"> Ext</label>
    <label title="Auto-render the last code block of each new AI message"><input type="checkbox" id="cw_opt_auto"> Auto</label>
  </div>
</div>`;
        document.body.insertAdjacentHTML('beforeend', html);
        const w = $id('cw_window'), frame = $id('cw_frame'), ta = $id('cw_editor');
        makeDraggable(w, $id('cw_header'));
        setVh();
        window.addEventListener('resize', setVh);
        if (window.visualViewport) window.visualViewport.addEventListener('resize', setVh);
        document.addEventListener('fullscreenchange', () => setTimeout(setVh, 100));
        document.addEventListener('webkitfullscreenchange', () => setTimeout(setVh, 100));
        $id('cw_btn_max').classList.toggle('cw_on', !!s.fullscreen);
        new ResizeObserver(() => { if (w.classList.contains('cw_open')) persistGeometry(); }).observe(w);
        frame.addEventListener('load', () => setTimeout(pushState, 50));

        $id('cw_btn_close').onclick = closeWindow;
        $id('cw_f_close').onclick = closeWindow;
        $id('cw_btn_max').onclick = () => setFullscreen(!w.classList.contains('cw_full'));
        $id('cw_f_exit').onclick = () => setFullscreen(false);
        $id('cw_m_code').onclick = () => setMode('code');
        $id('cw_f_code').onclick = () => setMode('code');
        $id('cw_m_run').onclick = run;

        $id('cw_t_add').onclick = addFile;
        $id('cw_t_rename').onclick = renameFile;
        $id('cw_t_delete').onclick = deleteFile;
        $id('cw_t_export').onclick = exportProject;
        $id('cw_t_undo').onclick = undo;
        $id('cw_t_new').onclick = newProject;
        const inp = $id('cw_import_input');
        $id('cw_t_import').onclick = () => inp.click();
        inp.onchange = async () => { await importFiles(inp.files); inp.value = ''; };

        // every keystroke is kept in settings (ST debounces the disk write), so edits are never lost
        ta.addEventListener('input', () => {
            const f = ensureProject().files.find((x) => x.name === editorFile);
            if (f) { f.content = ta.value; save(); }
        });
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Tab' && !e.shiftKey) {
                e.preventDefault();
                if (!document.execCommand('insertText', false, '  ')) {
                    ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                }
            } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault(); run();
            }
        });

        const bind = (id, key, rerun) => {
            const el = $id(id);
            el.checked = !!s[key];
            el.onchange = () => {
                s[key] = el.checked; save();
                if (rerun && rendered && s.mode === 'run') run();
                if (key === 'allowBridge' && el.checked) pushState();
            };
        };
        bind('cw_opt_scripts', 'allowScripts', true);
        bind('cw_opt_bridge', 'allowBridge', false);
        bind('cw_opt_md', 'autoFormat', true);
        bind('cw_opt_ext', 'allowExternal', true);
        bind('cw_opt_auto', 'autoRender', false);

        setMode(s.mode === 'code' ? 'code' : 'run');
    }

    // ---------- bridge: page <-> chat ----------
    const SAFE_VAR = /^[\w.\-]{1,64}$/;
    const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    let lastSend = 0;
    window.addEventListener('message', (e) => {
        const frame = $id('cw_frame');
        if (!frame || e.source !== frame.contentWindow) return;   // only our own sandboxed iframe
        if (!settings().allowBridge) return;
        const d = e.data;
        if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
        const c = ctx();

        if (d.type === 'st-request') { pushState(); return; }
        if (d.type === 'st-stop') { $id('mes_stop')?.click(); return; }

        if (d.type === 'st-setvar') {
            if (typeof d.name !== 'string' || !SAFE_VAR.test(d.name) || BAD_KEYS.has(d.name)) return;
            if (!c.chatMetadata) return;
            let val;
            try {
                const json = JSON.stringify(d.value);
                if (json === undefined || json.length > 20000) return;
                val = JSON.parse(json);
            } catch { return; }
            if (!c.chatMetadata.variables) c.chatMetadata.variables = {};
            c.chatMetadata.variables[d.name] = val;
            if (typeof c.saveMetadata === 'function') c.saveMetadata();
            pushState();
            return;
        }

        if (typeof d.text !== 'string' || d.text.length > 20000) return;
        const ta = $id('send_textarea');
        if (!ta) return;
        if (d.type === 'st-insert' || d.type === 'st-send') {
            if (d.type === 'st-send') {
                const now = Date.now();
                if (now - lastSend < 1500) { setStatus('Blocked: page tried to send too fast'); return; }
                lastSend = now;
            }
            ta.value = d.text;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            if (d.type === 'st-send') $id('send_but')?.click();
        } else if (d.type === 'st-append') {
            ta.value += d.text;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });

    // ---------- chat integration ----------
    function decorateMessages() {
        document.querySelectorAll('#chat .mes_text pre').forEach((pre) => {
            if (pre.dataset.cwDone) return;
            const codeEl = pre.querySelector('code');
            if (!codeEl) return;
            pre.dataset.cwDone = '1';
            const btn = document.createElement('div');
            btn.className = 'cw_render_btn';
            btn.textContent = '▶ Render';
            btn.onclick = () => renderFromChat(codeEl.textContent, false);
            pre.parentNode.insertBefore(btn, pre);
        });
    }
    function autoRenderLast() {
        if (!settings().autoRender) return;
        const blocks = document.querySelectorAll('#chat .mes.last_mes .mes_text pre code');
        if (blocks.length) renderFromChat(blocks[blocks.length - 1].textContent, true);
    }
    function addMenuButton() {
        const item = $(`<div id="cw_menu_btn" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
            <div class="fa-solid fa-code extensionsMenuExtensionButton"></div>Code Window</div>`);
        item.on('click', toggleWindow);
        $('#extensionsMenu').append(item);
    }

    jQuery(() => {
        createWindow();
        addMenuButton();
        const { eventSource, eventTypes: T } = ctx();
        const refresh = () => setTimeout(() => { decorateMessages(); pushState(); }, 150);
        [T.CHARACTER_MESSAGE_RENDERED, T.USER_MESSAGE_RENDERED, T.MESSAGE_UPDATED,
         T.MESSAGE_SWIPED, T.MESSAGE_DELETED, T.CHAT_CHANGED]
            .forEach((t) => t && eventSource.on(t, refresh));
        eventSource.on(T.CHARACTER_MESSAGE_RENDERED, () => setTimeout(autoRenderLast, 250));
        const on = (t, fn) => t && eventSource.on(t, fn);
        const soon = () => setTimeout(pushState, 80);
        on(T.GENERATION_STARTED, soon);
        on(T.GENERATION_ENDED, soon);
        on(T.GENERATION_STOPPED, soon);
        on(T.MESSAGE_RECEIVED, soon);
        let wasGen = false;
        setInterval(() => { const g = isGenerating(); if (g !== wasGen) { wasGen = g; pushState(); } }, 600);
        on(T.STREAM_TOKEN_RECEIVED, pushThrottled);
        refresh();
    });
})();
