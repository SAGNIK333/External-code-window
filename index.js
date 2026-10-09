// Code Window v1.9 - SillyTavern extension
// Floating, draggable, resizable popup that renders HTML/CSS/JS in a locked-down sandboxed iframe.
// v1.9: edit any message (AI + user), swipe versions kept on regenerate (< 2/3 >), right-panel picture follows the turns (Gallery).
// v1.8: font size (px) controls for the Modern style (Settings page).
// v1.7: Modern style: no top header, compact left menu with Full screen / Close, wider chat.
// v1.6: built-in "Modern style" theme (default): chat, characters, gallery / info / notes / lore panels, theme picker.
// v1.5: colour settings (gear icon) for "dialogue", *italic*, **bold** and [brackets], applied live to the rendered page.
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
        colors: null,             // {quote,italic,bold,bracket: {on, color}} - see colors()
        fs: null,                 // Modern style font sizes in px {chat, menu, panel}; 0 = auto
        heroTurn: true,           // right-panel big picture cycles through Gallery pictures each AI turn
        theme: 'modern',          // 'modern' (built-in UI) | 'custom' (your code tabs)
        rp: null,                 // {notes:{}, lore:{}} per character
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

    // ---------- text colours ----------
    const COLOR_KEYS = [
        ['quote', 'Dialogue  "quotes"', 'st-q'],
        ['italic', 'Italic  *asterisk*', 'st-i'],
        ['bold', 'Bold  **double asterisk**', 'st-b'],
        ['bracket', 'Brackets  [ square ]', 'st-br'],
    ];
    const COLOR_DEF_OLD = { quote: '#ffd27f', italic: '#b9a7ff', bold: '#ff9ec4', bracket: '#7fd1ff' };   // v1.5 defaults
    const COLOR_DEF = { quote: '#f4eae6', italic: '#d3bdb6', bold: '#ffffff', bracket: '#e8a0a8' };
    function colors() {
        const s = settings();
        if (!s.colors || typeof s.colors !== 'object') s.colors = {};
        for (const [k] of COLOR_KEYS) {
            let c = s.colors[k];
            if (!c || typeof c !== 'object') c = s.colors[k] = { on: true, color: COLOR_DEF[k] };
            c.on = c.on !== false;
            if (typeof c.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(c.color)) c.color = COLOR_DEF[k];   // only plain hex ever reaches CSS
        }
        if (s.colorsVer !== 2) {     // one-time: move untouched v1.5 defaults to the new Modern-style defaults
            for (const [k] of COLOR_KEYS) if (s.colors[k].color.toLowerCase() === COLOR_DEF_OLD[k]) s.colors[k].color = COLOR_DEF[k];
            s.colorsVer = 2; save();
        }
        return s.colors;
    }
    function styleCss() {
        const c = colors();
        return COLOR_KEYS.map(([k, , cls]) => c[k].on ? `.${cls}{color:${c[k].color}}` : '').filter(Boolean).join('\n');
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

    // Shared formatter (also serialised into the sandboxed page, so it must stay self-contained)
    function makeFmt() {
        var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
        var INNER = '([^*\\s](?:[^*]*?[^*\\s])?)';
        var RE3 = new RegExp('\\*\\*\\*' + INNER + '\\*\\*\\*', 'g');
        var RE2 = new RegExp('\\*\\*' + INNER + '\\*\\*', 'g');
        var RE1 = new RegExp('\\*' + INNER + '\\*', 'g');
        var RES = /~~([^~\s](?:[^~]*?[^~\s])?)~~/g;
        function fmt(text) {
            var h = esc(text), codes = [];
            h = h.replace(/`([^`\n]+)`/g, function (_, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
            // [brackets] and "dialogue" first (quotes are already &quot; so our own class="" attributes can't be matched)
            h = h.replace(/\[(?:(?!\n\n)[^\[\]])+\]/g, function (m) { return '<span class="st-br">' + m + '</span>'; });
            h = h.replace(/&quot;(?:(?!&quot;|\n\n)[\s\S])+?&quot;/g, function (m) { return '<span class="st-q">' + m + '</span>'; });
            h = h.replace(/\u201c(?:(?![\u201c\u201d]|\n\n)[\s\S])+?\u201d/g, function (m) { return '<span class="st-q">' + m + '</span>'; });
            h = h.replace(RE3, '<strong class="st-b"><em class="st-i">$1</em></strong>').replace(RE2, '<strong class="st-b">$1</strong>').replace(RE1, '<em class="st-i">$1</em>').replace(RES, '<del>$1</del>');
            return h.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + codes[i] + '</code>'; });
        }
        return { esc: esc, fmt: fmt };
    }

    // ---------- helper injected into every rendered page (runs INSIDE the sandbox) ----------
    // API:  ST.state / ST.onUpdate(fn) / ST.send / ST.insert / ST.append / ST.setVar / ST.stop
    //       ST.format(text) -> safe HTML with *italic* **bold** ***both*** ~~strike~~ `code` and line breaks
    //       ST.render(el, text) -> el.innerHTML = ST.format(text)
    //       Auto mode ("MD" switch): plain text containing * ** etc is formatted automatically.
    //       Add the attribute data-st-raw to any element to opt it out.
    function pageHelper() {
        var cfg = window.__ST_CFG || {};
        var F = makeFmt();
        var esc = F.esc, fmt = F.fmt;
        var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, CODE: 1, PRE: 1, NOSCRIPT: 1, OPTION: 1, SELECT: 1, HEAD: 1, TITLE: 1 };
        function skip(n) {
            for (var p = n.parentNode; p && p.nodeType === 1; p = p.parentNode) {
                if (p.getAttribute && /\bst-(?:q|i|b|br)\b/.test(p.getAttribute('class') || '')) return true;   // already formatted
                if (SKIP[p.nodeName] || p.isContentEditable || (p.hasAttribute && p.hasAttribute('data-st-raw'))) return true;
            }
            return false;
        }
        function processText(n) {
            var t = n.nodeValue;
            if (!t || !/[*`"\u201c\[]|~~/.test(t)) return;
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
            if (d && d.type === 'st-style' && typeof d.css === 'string') {
                var se = document.getElementById('st-fmt-style');
                if (se) se.textContent = d.css;
                return;
            }
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
        return `<style id="st-fmt-style">${styleCss()}</style><script>window.__ST_CFG=${cfg};var makeFmt=${makeFmt.toString()};(${pageHelper.toString()})();<\/script>`;
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
    function run() { settings().theme = 'custom'; save(); runCustom(); }   // explicit "run my code"
    function runCustom() {
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
        const w = $id('cw_window'), s = settings();
        w.classList.remove('cw_away'); $id('cw_pill').classList.remove('cw_show');
        w.classList.add('cw_open');
        if (s.fullscreen) enterBrowserFs();
        if (s.mode === 'run') {
            if (s.theme === 'modern') mxShow();
            else if (!rendered) runCustom();   // your code only runs once you open the window
        }
        setTimeout(pushState, 100);
    }
    function closeWindow() { exitBrowserFs(); closeSettings(); $id('cw_pill').classList.remove('cw_show'); $id('cw_window').classList.remove('cw_away', 'cw_open'); }
    function toggleWindow() { $id('cw_window').classList.contains('cw_open') ? closeWindow() : openWindow(); }
    function setFullscreen(on) {
        $id('cw_window').classList.toggle('cw_full', on);
        $id('cw_btn_max').classList.toggle('cw_on', on);
        settings().fullscreen = on; save();
        if (on) enterBrowserFs(); else exitBrowserFs();
        setVh();
        if (typeof mxSyncFs === 'function' && mx.built) setTimeout(mxSyncFs, 250);
    }
    function setMode(m) {
        const s = settings();
        s.mode = m; save();
        closeSettings();
        syncTheme();
        $id('cw_window').classList.toggle('cw_mode_code', m === 'code');
        $id('cw_m_code').classList.toggle('cw_on', m === 'code');
        $id('cw_m_run').classList.toggle('cw_on', m === 'run');
        if (m === 'code') { renderTabs(); loadEditor(); }
        else if (s.theme === 'modern' && $id('cw_window').classList.contains('cw_open')) mxShow();
    }
    function syncTheme() { $id('cw_window').classList.toggle('cw_theme_modern', settings().theme === 'modern'); }
    function updateThemeCards() {
        document.querySelectorAll('.cw_theme').forEach((c) => c.classList.toggle('cw_on', c.dataset.theme === settings().theme));
    }
    function setTheme(t) {
        const s = settings();
        s.theme = t === 'custom' ? 'custom' : 'modern'; save();
        syncTheme(); updateThemeCards(); closeSettings();
        if (s.mode === 'run') { if (s.theme === 'modern') mxShow(); else runCustom(); }
    }

    // ---------- colour settings page ----------
    const FS_KEYS = [['chat', 'Chat text', 20], ['menu', 'Left menu', 14], ['panel', 'Right panel', 14]];
    function fsCfg() {
        const s = settings();
        if (!s.fs || typeof s.fs !== 'object') s.fs = {};
        for (const [k] of FS_KEYS) { const v = Number(s.fs[k]); s.fs[k] = v >= 10 && v <= 40 ? Math.round(v) : 0; }
        return s.fs;
    }
    function applyFs() {
        const f = fsCfg(), el = $id('cw_modern');
        if (!el) return;
        const set = (n, v) => { if (v) el.style.setProperty(n, v + 'px'); else el.style.removeProperty(n); };
        set('--mx-fs-chat', f.chat); set('--mx-fs-name', f.chat && Math.round(f.chat * 1.15)); set('--mx-fs-in', f.chat);
        set('--mx-fs-menu', f.menu);
        set('--mx-fs-panel', f.panel); set('--mx-fs-panelst', f.panel && f.panel + 3); set('--mx-fs-tab', f.panel && f.panel + 2);
    }
    function buildFsRows() {
        const box = $id('cw_fslist'), f = fsCfg();
        box.textContent = '';
        FS_KEYS.forEach(([k, label, def]) => {
            const row = document.createElement('div'); row.className = 'cw_setrow';
            const name = document.createElement('span'); name.className = 'cw_setname'; name.textContent = label;
            const rng = document.createElement('input'); rng.type = 'range'; rng.min = 10; rng.max = 36; rng.step = 1; rng.value = f[k] || def; rng.className = 'cw_rng';
            const val = document.createElement('code'); val.textContent = f[k] ? f[k] + ' px' : 'Auto';
            const auto = document.createElement('label'); auto.className = 'cw_autolbl';
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !f[k];
            auto.append(cb, document.createTextNode(' Auto'));
            const sync = () => { val.textContent = f[k] ? f[k] + ' px' : 'Auto'; applyFs(); save(); };
            rng.oninput = () => { f[k] = Number(rng.value); cb.checked = false; sync(); };
            cb.onchange = () => { f[k] = cb.checked ? 0 : Number(rng.value); sync(); };
            row.append(name, auto, rng, val);
            box.appendChild(row);
        });
    }
    function applyColors() {
        const css = styleCss();
        $id('cw_pv_style').textContent = css.replace(/^\./gm, '#cw_setpane .');
        const mxs = document.getElementById('cw_mx_colors');
        if (mxs) mxs.textContent = css.replace(/^\./gm, '#cw_modern .');
        save();
        const f = $id('cw_frame');
        try { if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'st-style', css }, '*'); } catch { /* ignore */ }
    }
    function buildSettingsPane() {
        const list = $id('cw_setlist'), c = colors();
        list.textContent = '';
        updateThemeCards();
        buildFsRows();
        COLOR_KEYS.forEach(([k, label, cls]) => {
            const row = document.createElement('div'); row.className = 'cw_setrow';
            const on = document.createElement('input'); on.type = 'checkbox'; on.checked = c[k].on; on.title = 'Colour on/off';
            const name = document.createElement('span'); name.className = 'cw_setname ' + cls; name.textContent = label;
            const pick = document.createElement('input'); pick.type = 'color'; pick.value = c[k].color;
            const hex = document.createElement('code'); hex.textContent = c[k].color;
            on.onchange = () => { c[k].on = on.checked; applyColors(); };
            pick.oninput = () => { c[k].color = pick.value; hex.textContent = pick.value; applyColors(); };
            row.append(on, name, pick, hex);
            list.appendChild(row);
        });
        applyColors();
    }
    function resetColors() {
        const c = colors();
        for (const [k] of COLOR_KEYS) { c[k].on = true; c[k].color = COLOR_DEF[k]; }
        buildSettingsPane();
    }
    function openSettings() { buildSettingsPane(); $id('cw_window').classList.add('cw_set_open'); }
    function closeSettings() { const w = $id('cw_window'); if (w) w.classList.remove('cw_set_open'); }

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
    <span class="cw_btn" id="cw_btn_set" title="Text colours (dialogue, italic, bold, brackets)">&#9881;</span>
    <span class="cw_btn" id="cw_btn_max" title="Full screen on/off">&#9974;</span>
    <span class="cw_btn" id="cw_btn_close" title="Close">&#10005;</span>
  </div>
  <div id="cw_float">
    <span class="cw_btn" id="cw_f_set" title="Text colours">&#9881;</span>
    <span class="cw_btn" id="cw_f_code" title="Back to code">&lt;/&gt; Code</span>
    <span class="cw_btn" id="cw_f_exit" title="Exit full screen">&#9974;</span>
    <span class="cw_btn" id="cw_f_close" title="Close">&#10005;</span>
  </div>
  <div id="cw_body">
    <iframe id="cw_frame" sandbox="allow-scripts allow-forms allow-modals" referrerpolicy="no-referrer"></iframe>
    <div id="cw_modern"></div>
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
    <div id="cw_setpane">
      <style id="cw_pv_style"></style>
      <div id="cw_setbar">
        <span class="cw_btn" id="cw_set_back">&larr; Back</span>
        <span id="cw_set_title">Settings</span>
        <span class="cw_btn" id="cw_set_reset" title="Reset colours to default">Reset colours</span>
      </div>
      <div class="cw_sethead">Theme</div>
      <div id="cw_themes">
        <div class="cw_theme" data-theme="modern"><b>Modern style</b><span>Built-in roleplay UI: chat, characters, gallery, info, notes, lore.</span></div>
        <div class="cw_theme" data-theme="custom"><b>My code</b><span>Runs your own tabs (index.html, style.css ...).</span></div>
      </div>
      <div class="cw_sethead">Right panel picture</div>
      <label class="cw_chk"><input type="checkbox" id="cw_o_hero"> Change the big picture every AI turn (cycles through your Gallery pictures)</label>
      <div class="cw_sethead">Text size (Modern style)</div>
      <div id="cw_fslist"></div>
      <div class="cw_sethead">Text colours</div>
      <div id="cw_setlist"></div>
      <div id="cw_pv_label">Preview</div>
      <div id="cw_pv"><span class="st-q">"I didn't think you'd come,"</span> <em class="st-i">she says softly, setting the cup down.</em> <strong class="st-b">Stay.</strong> <span class="st-br">[ 8:48 PM | Living Room ]</span></div>
      <div class="cw_sethead">Window</div>
      <div id="cw_winbtns">
        <span class="cw_btn" id="cw_w_code">&lt;/&gt; Code editor</span>
        <span class="cw_btn" id="cw_w_full">Full screen</span>
        <span class="cw_btn" id="cw_w_close">Close window</span>
      </div>
      <div id="cw_sethint">Applies live to your rendered page. Colours are used by the built-in formatting (MD switch / <code>ST.format()</code>). You can still override them in your own CSS with <code>.st-q .st-i .st-b .st-br</code>.</div>
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
        document.body.insertAdjacentHTML('beforeend', '<div id="cw_pill" title="Back to Code Window">&#8617; Code Window</div>');
        document.head.insertAdjacentHTML('beforeend', '<style id="cw_mx_colors"></style>');
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
        $id('cw_btn_set').onclick = openSettings;
        $id('cw_f_set').onclick = openSettings;
        $id('cw_set_back').onclick = closeSettings;
        $id('cw_pill').onclick = backToWindow;
        document.querySelectorAll('.cw_theme').forEach((c) => { c.onclick = () => setTheme(c.dataset.theme); });
        $id('cw_w_code').onclick = () => { closeSettings(); setMode('code'); };
        $id('cw_w_full').onclick = () => { closeSettings(); setFullscreen(!w.classList.contains('cw_full')); };
        $id('cw_w_close').onclick = closeWindow;
        $id('cw_set_reset').onclick = resetColors;
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
                if (rerun && rendered && s.mode === 'run' && s.theme === 'custom') runCustom();
                if (key === 'allowBridge' && el.checked) pushState();
            };
        };
        bind('cw_opt_scripts', 'allowScripts', true);
        bind('cw_opt_bridge', 'allowBridge', false);
        bind('cw_opt_md', 'autoFormat', true);
        bind('cw_opt_ext', 'allowExternal', true);
        bind('cw_opt_auto', 'autoRender', false);

        const hero = $id('cw_o_hero');
        hero.checked = s.heroTurn !== false;
        hero.onchange = () => { s.heroTurn = hero.checked; save(); if (mx.built) { mx.heroTurn = -1; mxHero(); } };
        syncTheme();
        applyFs();
        applyColors();
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


    // =====================================================================
    //  MODERN STYLE THEME  (built-in default UI, rendered natively - no user code involved)
    // =====================================================================
    const mxEsc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const mxFmt = makeFmt().fmt;
    const mxHtml = (t) => mxFmt(t == null ? '' : t).replace(/\r?\n/g, '<br>');
    const toast = (m) => { try { if (window.toastr) window.toastr.info(m); else console.log('[Code Window]', m); } catch { /* ignore */ } };
    const mxThumb = (f) => `/thumbnail?type=avatar&file=${encodeURIComponent(f)}`;
    const mxFull = (f) => `/characters/${encodeURIComponent(f)}`;

    const SV = (d) => `<svg class="mx_i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    const IC = {
        chat: '<svg class="mx_i" viewBox="0 0 24 24"><path fill="#ff5d7d" d="M5 4h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-7l-5 4v-4H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z"/><circle cx="8.5" cy="11" r="1.2" fill="#fff"/><circle cx="12" cy="11" r="1.2" fill="#fff"/><circle cx="15.5" cy="11" r="1.2" fill="#fff"/></svg>',
        characters: SV('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14.2c2.6.3 4.5 2.4 4.5 5.8"/>'),
        lorebook: SV('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
        worldinfo: SV('<circle cx="12" cy="12" r="9"/><path d="M12 7v10M7 12h10"/>'),
        extensions: SV('<path d="M10 4a2 2 0 1 1 4 0v1h3a1 1 0 0 1 1 1v3h1a2 2 0 1 1 0 4h-1v3a1 1 0 0 1-1 1h-3v-1a2 2 0 1 0-4 0v1H7a1 1 0 0 1-1-1v-3H5a2 2 0 1 1 0-4h1V6a1 1 0 0 1 1-1h3z"/>'),
        generation: SV('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>'),
        settings: SV('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
        search: SV('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
        image: SV('<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 4 4 3-3 4 4"/>'),
        dots: SV('<circle cx="12" cy="5" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="19" r="1.7" fill="currentColor"/>'),
        plus: SV('<path d="M12 5v14M5 12h14"/>'),
        spark: '<svg class="mx_i" viewBox="0 0 24 24"><path fill="#ffc94d" d="M10 3l1.8 5.2L17 10l-5.2 1.8L10 17l-1.8-5.2L3 10l5.2-1.8z"/><path fill="#ffc94d" d="M18 14l.9 2.6 2.6.9-2.6.9L18 21l-.9-2.6-2.6-.9 2.6-.9z"/></svg>',
        mic: SV('<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
        send: '<svg class="mx_i" viewBox="0 0 24 24"><path fill="currentColor" d="M4 3l17 9-17 9 3-9z"/></svg>',
        stop: '<svg class="mx_i" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
        chev: SV('<path d="M9 6l6 6-6 6"/>'),
        full: SV('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
        close: SV('<path d="M6 6l12 12M18 6L6 18"/>'),
        edit: SV('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>'),
        menu: SV('<path d="M4 7h16M4 12h16M4 17h16"/>'),
        logo: '<svg class="mx_logo_i" viewBox="0 0 48 48" fill="none" stroke="#ff7a93" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M24 7c6 4 10 10 8 16-2 5-6 8-8 17-2-9-6-12-8-17-2-6 2-12 8-16z"/><path d="M7 21c6-2 12 0 17 7M41 21c-6-2-12 0-17 7"/><path d="M13 36c5-5 9-5 11-2M35 36c-5-5-9-5-11-2"/></svg>',
    };
    const NAV = [['chat', 'Chat'], ['characters', 'Characters'], ['lorebook', 'Lorebook'], ['worldinfo', 'World Info'], ['extensions', 'Extensions'], ['generation', 'Generation'], ['settings', 'Settings']];

    const mx = { built: false, view: 'chat', tab: 'gallery', limit: 60, search: '', stick: true, gen: false, galVer: 0, heroUrls: [], heroKey: null, heroVer: -1, heroTok: 0, heroTurn: -1, avatarFull: '', avatarThumb: '' };
    const mxNodes = new Map();
    const rp = () => {
        const s = settings();
        if (!s.rp || typeof s.rp !== 'object') s.rp = {};
        if (!s.rp.notes || typeof s.rp.notes !== 'object') s.rp.notes = {};
        if (!s.rp.lore || typeof s.rp.lore !== 'object') s.rp.lore = {};
        return s.rp;
    };

    // ----- ST data helpers -----
    function curChar() {
        const c = ctx();
        if (c.groupId || c.characterId === undefined || c.characterId === null) return null;
        return (c.characters && c.characters[c.characterId]) || null;
    }
    function charKey() {
        const ch = curChar();
        if (ch) return String(ch.avatar || ch.name || '');
        const c = ctx();
        return c.groupId ? 'group_' + c.groupId : '';
    }
    const subst = (t, ch) => String(t || '').replace(/\{\{char\}\}/gi, (ch && ch.name) || '').replace(/\{\{user\}\}/gi, ctx().name1 || 'You');
    function firstLine(t, max) {
        const l = String(t || '').replace(/[*_`#>]/g, '').split(/\n/).map((x) => x.trim()).find(Boolean) || '';
        return l.length > max ? l.slice(0, max - 1) + '…' : l;
    }
    const tagline = (ch) => firstLine(subst(ch.creatorcomment, ch), 70) || firstLine(subst(ch.personality, ch), 70) || firstLine(subst(ch.description, ch), 70);
    function quoteOf(ch) {
        const t = subst(ch.first_mes, ch);
        const m = t.match(/[“"]([^”"\n]{12,140})[”"]/);
        return m ? '“' + m[1] + '”' : firstLine(t, 110);
    }
    function mxUserAv() {
        const c = ctx();
        let f = c.user_avatar || c.userAvatar;
        if (!f) { const sel = document.querySelector('#user_avatar_block .avatar.selected'); f = sel && sel.getAttribute('imgfile'); }
        return f ? `/thumbnail?type=persona&file=${encodeURIComponent(f)}` : '';
    }
    function mxTime(v) {
        if (!v) return '';
        const d = new Date(v);
        if (!isNaN(d)) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        if (typeof v === 'string') {
            const m = v.match(/(\d{1,2}):(\d{2})\s*([ap]m)?/i);
            if (m) return `${+m[1]}:${m[2]}` + (m[3] ? ' ' + m[3].toUpperCase() : '');
        }
        return '';
    }
    function stOpen(sel) {
        const holder = document.querySelector(sel);
        const tog = holder && holder.querySelector('.drawer-toggle');
        if (!tog) { toast('That SillyTavern panel was not found'); return; }
        exitBrowserFs();
        $id('cw_window').classList.add('cw_away');
        $id('cw_pill').classList.add('cw_show');
        setTimeout(() => {
            const content = holder.querySelector('.drawer-content');
            if (!(content && content.classList.contains('openDrawer'))) tog.click();
        }, 150);
    }
    function backToWindow() {
        $id('cw_window').classList.remove('cw_away');
        $id('cw_pill').classList.remove('cw_show');
        if (settings().fullscreen) enterBrowserFs();
        setTimeout(() => { setVh(); if (mxActive()) mxAll(); }, 200);
    }
    const stClick = (id, label) => { const el = $id(id); if (el) el.click(); else toast((label || id) + ' is not available'); };

    // ----- gallery storage (IndexedDB, so settings.json stays small) -----
    const gdb = (() => {
        let p = null;
        const open = () => p || (p = new Promise((res, rej) => {
            const r = indexedDB.open('code_window_gallery', 1);
            r.onupgradeneeded = () => { const st = r.result.createObjectStore('img', { keyPath: 'id', autoIncrement: true }); st.createIndex('char', 'char'); };
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        }));
        const tx = (mode, fn) => open().then((db) => new Promise((res, rej) => {
            const t = db.transaction('img', mode);
            const req = fn(t.objectStore('img'));
            t.oncomplete = () => res(req && req.result);
            t.onerror = () => rej(t.error);
        }));
        return {
            add: (char, blob) => tx('readwrite', (st) => st.add({ char, blob, ts: Date.now() })),
            list: (char) => tx('readonly', (st) => st.index('char').getAll(char)),
            del: (id) => tx('readwrite', (st) => st.delete(id)),
        };
    })();
    async function shrinkImage(file) {
        const bmp = await createImageBitmap(file);
        const k = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
        const g = cv.getContext('2d');
        g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
        g.drawImage(bmp, 0, 0, cv.width, cv.height);
        return new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.86));
    }
    let galUrls = [];

    // ----- build -----
    function mxBuild() {
        if (mx.built) return;
        const host = $id('cw_modern');
        host.innerHTML = `
<div class="mx" id="mx">
  <div class="mx_bg" id="mx_bg"></div>
  <aside class="mx_left" id="mx_left">
    <div class="mx_logo">${IC.logo}<span>SillyTavern</span></div>
    <nav class="mx_nav" id="mx_nav">${NAV.map(([id, label]) => `<button class="mx_navb" data-nav="${id}">${IC[id]}<span>${label}</span></button>`).join('')}</nav>
    <div class="mx_navfoot"><button class="mx_navb" id="mx_fs">${IC.full}<span>Full screen</span></button><button class="mx_navb" id="mx_cl">${IC.close}<span>Close</span></button></div>
  </aside>
  <main class="mx_mid">
    <header class="mx_head" hidden>
      <button class="mx_ib mx_burger" id="mx_burger" title="Menu">${IC.menu}</button>
      <div class="mx_who" id="mx_who">
        <img class="mx_hav" id="mx_h_av" alt="">
        <div class="mx_wt"><div class="mx_hn"><span id="mx_h_name"></span><span class="mx_heart">&#9829;</span><span class="mx_sp">&#10022;</span></div><div class="mx_htag"><span id="mx_h_tag"></span> <span class="mx_heart">&#9829;</span></div></div>
      </div>
      <div class="mx_hicons">
        <button class="mx_ib" id="mx_b_search" title="Search messages">${IC.search}</button>
        <button class="mx_ib" id="mx_b_img" title="Add pictures to the gallery">${IC.image}</button>
        <button class="mx_ib" id="mx_b_more" data-menu title="More">${IC.dots}</button>
      </div>
    </header>
    <button class="mx_fab mx_fab_l" id="mx_fab_l" title="Menu">${IC.menu}</button>
    <button class="mx_fab mx_fab_r" id="mx_fab_r" title="Character panel">${IC.image}</button>
    <div class="mx_sbar" id="mx_sbar" hidden><input id="mx_sin" placeholder="Search messages..." autocomplete="off"><button class="mx_ib" id="mx_sx">&#10005;</button></div>
    <section class="mx_chatview" id="mx_chatview"><div class="mx_scroll" id="mx_scroll">
      <button class="mx_more" id="mx_more" hidden>Load earlier messages</button>
      <div class="mx_msgs" id="mx_msgs"></div>
      <div class="mx_row mx_char" id="mx_typing" hidden><div class="mx_bub"><div class="mx_dots"><i></i><i></i><i></i></div></div></div>
    </div></section>
    <section class="mx_charview" id="mx_charview" hidden><div class="mx_cvh">Characters</div><div class="mx_grid" id="mx_grid"></div></section>
    <footer class="mx_comp" id="mx_comp">
      <button class="mx_plus" id="mx_b_plus" data-menu title="Actions">${IC.plus}</button>
      <textarea id="mx_in" rows="1" placeholder="Type a message..." spellcheck="true"></textarea>
      <button class="mx_ib" id="mx_b_spark" title="Impersonate">${IC.spark}</button>
      <button class="mx_ib" id="mx_b_img2" title="Add pictures to the gallery">${IC.image}</button>
      <button class="mx_ib" id="mx_b_mic" title="Voice input">${IC.mic}</button>
      <button class="mx_send" id="mx_send" title="Send">${IC.send}</button>
    </footer>
  </main>
  <aside class="mx_right" id="mx_right">
    <div class="mx_hero"><img id="mx_hero_img" alt=""><div class="mx_hero_fade"></div>
      <div class="mx_hero_txt"><div class="mx_hero_name"><span id="mx_r_name"></span><span class="mx_heart">&#9829;</span></div><div class="mx_hero_quote" id="mx_r_quote"></div></div></div>
    <div class="mx_tabs" id="mx_tabs"><button data-tab="gallery">Gallery</button><button data-tab="info">Info</button><button data-tab="notes">Notes</button><button data-tab="lore">Lore</button></div>
    <div class="mx_tabbody" id="mx_tabbody"></div>
  </aside>
  <div class="mx_scrim" id="mx_scrim"></div>
  <div class="mx_menu" id="mx_menu" hidden></div>
  <div class="mx_lb" id="mx_lb" hidden><img id="mx_lb_img" alt=""><div class="mx_lb_bar"><button id="mx_lb_del">Delete</button><button id="mx_lb_x">Close</button></div></div>
  <input type="file" id="mx_file" accept="image/*" multiple hidden>
</div>`;
        const root = $id('mx');
        $id('mx_nav').onclick = (e) => { const b = e.target.closest('[data-nav]'); if (b) mxNav(b.dataset.nav); };
        $id('mx_tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) mxTab(b.dataset.tab); };
        $id('mx_burger').onclick = () => root.classList.toggle('mx_l_open');
        $id('mx_fab_l').onclick = () => root.classList.toggle('mx_l_open');
        $id('mx_fab_r').onclick = () => root.classList.toggle('mx_r_open');
        $id('mx_fs').onclick = () => { setFullscreen(!mxRealFs()); setTimeout(mxSyncFs, 250); };
        $id('mx_cl').onclick = closeWindow;
        document.addEventListener('fullscreenchange', () => setTimeout(mxSyncFs, 150));
        document.addEventListener('webkitfullscreenchange', () => setTimeout(mxSyncFs, 150));
        $id('mx_who').onclick = () => root.classList.toggle('mx_r_open');
        $id('mx_scrim').onclick = () => root.classList.remove('mx_l_open', 'mx_r_open');
        $id('mx_b_search').onclick = () => {
            const sb = $id('mx_sbar'); sb.hidden = !sb.hidden;
            if (!sb.hidden) $id('mx_sin').focus(); else { mx.search = ''; $id('mx_sin').value = ''; mxRender(); }
        };
        $id('mx_sx').onclick = () => { $id('mx_sbar').hidden = true; mx.search = ''; $id('mx_sin').value = ''; mxRender(); };
        $id('mx_sin').oninput = (e) => { mx.search = e.target.value.trim().toLowerCase(); mxRender(); };
        const pickImg = () => { mxTab('gallery'); root.classList.add('mx_r_open'); $id('mx_file').click(); };
        $id('mx_b_img').onclick = pickImg;
        $id('mx_b_img2').onclick = pickImg;
        $id('mx_file').onchange = async (e) => { const f = [...e.target.files]; e.target.value = ''; await mxAddImages(f); };
        $id('mx_b_more').onclick = () => mxMenu('top', [
            ['Scroll to latest', () => mxScroll(true)],
            ['Regenerate last reply', mxRegen],
            ['Open code editor', () => setMode('code')],
            [$id('cw_window').classList.contains('cw_full') ? 'Exit full screen' : 'Full screen', () => setFullscreen(!$id('cw_window').classList.contains('cw_full'))],
            ['Close Code Window', closeWindow],
        ]);
        $id('mx_b_plus').onclick = () => mxMenu('bottom', [
            ['Search messages', () => $id('mx_b_search').click()],
            ['Scroll to latest', () => mxScroll(true)],
            ['Regenerate (keeps old versions)', mxRegen],
            ['Continue', () => stClick('option_continue', 'Continue')],
            ['Impersonate', () => stClick('option_impersonate', 'Impersonate')],
            ['Stop generating', () => stClick('mes_stop', 'Stop')],
        ]);
        $id('mx_b_spark').onclick = () => stClick('option_impersonate', 'Impersonate');
        $id('mx_b_mic').onclick = () => { const m = $id('microphone_button'); if (m) m.click(); else toast('Enable the Speech Recognition extension in SillyTavern to use the microphone'); };
        $id('mx_send').onclick = mxSend;
        const ta = $id('mx_in');
        ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 130) + 'px'; };
        ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); mxSend(); } };
        $id('mx_more').onclick = () => { mx.limit += 60; mxRender(); };
        $id('mx_msgs').onclick = (e) => {
            const row = e.target.closest('.mx_row');
            if (!row) return;
            if (e.target.closest('.mx_ed')) mxEdit(row);
            else if (e.target.closest('.mx_swl')) mxSwipe('left');
            else if (e.target.closest('.mx_swr')) { if (!isGenerating()) mxSwipe('right'); }
        };
        $id('mx_scroll').onscroll = (e) => { const s = e.target; mx.stick = s.scrollHeight - s.scrollTop - s.clientHeight < 160; };
        root.addEventListener('click', (e) => { if (!e.target.closest('#mx_menu') && !e.target.closest('[data-menu]')) $id('mx_menu').hidden = true; });
        $id('mx_lb').onclick = (e) => { if (e.target.id === 'mx_lb') $id('mx_lb').hidden = true; };
        $id('mx_lb_x').onclick = () => { $id('mx_lb').hidden = true; };
        mx.built = true;
    }
    const mxRealFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
    function mxSyncFs() {
        const b = $id('mx_fs');
        if (!b) return;
        const on = mxRealFs();
        b.querySelector('span').textContent = on ? 'Exit full screen' : 'Full screen';
    }
    function mxMenu(where, items) {
        const m = $id('mx_menu');
        if (!m.hidden && m.dataset.where === where) { m.hidden = true; return; }
        m.textContent = '';
        items.forEach(([label, fn]) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.onclick = () => { m.hidden = true; fn(); };
            m.appendChild(b);
        });
        m.dataset.where = where;
        m.className = 'mx_menu mx_menu_' + where;
        m.hidden = false;
    }
    function mxSend() {
        const st = $id('send_textarea');
        if (!st) { toast('SillyTavern chat box not found'); return; }
        if (isGenerating()) { $id('mes_stop')?.click(); return; }
        const ta = $id('mx_in');
        st.value = ta.value.trim();
        st.dispatchEvent(new Event('input', { bubbles: true }));
        $id('send_but')?.click();
        ta.value = ''; ta.style.height = 'auto';
        mx.stick = true;
        setTimeout(() => mxScroll(true), 150);
    }
    function mxScroll(force) { const s = $id('mx_scroll'); if (s && (force || mx.stick)) s.scrollTop = s.scrollHeight; }
    function mxActive() {
        const w = $id('cw_window'), s = settings();
        return mx.built && w && w.classList.contains('cw_open') && !w.classList.contains('cw_away') && s.theme === 'modern' && s.mode === 'run';
    }

    // ----- navigation -----
    function mxNav(id) {
        $id('mx').classList.remove('mx_l_open');
        if (id === 'chat' || id === 'characters') { mxView(id); return; }
        if (id === 'lorebook' || id === 'worldinfo') stOpen('#WI-SP-button');
        else if (id === 'extensions') stOpen('#extensions-settings-button');
        else if (id === 'generation') stOpen('#ai-config-button');
        else if (id === 'settings') openSettings();
    }
    function mxView(v) {
        mx.view = v;
        $id('mx_chatview').hidden = v !== 'chat';
        $id('mx_charview').hidden = v !== 'characters';
        $id('mx_comp').hidden = v !== 'chat';
        document.querySelectorAll('#mx_nav .mx_navb').forEach((b) => b.classList.toggle('mx_on', b.dataset.nav === v));
        if (v === 'characters') mxCharacters(); else setTimeout(() => mxScroll(true), 30);
    }
    function mxCharacters() {
        const c = ctx(), grid = $id('mx_grid');
        grid.textContent = '';
        (c.characters || []).forEach((ch, idx) => {
            const b = document.createElement('button');
            b.className = 'mx_card' + (!c.groupId && String(c.characterId) === String(idx) ? ' mx_on' : '');
            const img = document.createElement('img'); img.loading = 'lazy'; img.alt = ''; img.src = mxThumb(ch.avatar);
            const nm = document.createElement('div'); nm.className = 'mx_cn'; nm.textContent = ch.name || '';
            const tg = document.createElement('div'); tg.className = 'mx_ct'; tg.textContent = tagline(ch);
            b.append(img, nm, tg);
            b.onclick = () => mxPick(idx);
            grid.appendChild(b);
        });
        if (!grid.children.length) grid.textContent = 'No characters found.';
    }
    async function mxPick(idx) {
        const c = ctx();
        try {
            if (typeof c.selectCharacterById === 'function') await c.selectCharacterById(String(idx), { switchMenu: false });
            else if (window.$) window.$(`#rm_print_characters_block .character_select[chid="${idx}"]`).first().trigger('click');
        } catch (e) { console.warn('[Code Window] select character failed', e); toast('Could not open that character'); }
        mxView('chat');
        setTimeout(() => mxReset(), 400);
    }

    // ----- chat -----
    function mxFill(el, m, lastAi) {
        const user = !!m.is_user;
        el.className = 'mx_row ' + (user ? 'mx_user' : 'mx_char');
        const ch = curChar();
        const av = m.force_avatar || (user ? mxUserAv() : (m.original_avatar ? mxThumb(m.original_avatar) : (ch ? mxThumb(ch.avatar) : '')));
        const paras = String(m.mes || '').split(/\n+/).filter((p) => p.trim()).map((p) => `<p>${mxFmt(p)}</p>`).join('') || '<p class="mx_dim">...</p>';
        el.innerHTML = `<div class="mx_bub"><img class="mx_ava" alt="" src="${mxEsc(av)}"><div class="mx_main"><div class="mx_meta"><span class="mx_nm">${mxEsc(user ? 'You' : (m.name || ''))}</span>${user ? '' : '<span class="mx_heart">&#9829;</span>'}<span class="mx_time">${mxEsc(mxTime(m.send_date))}</span><button class="mx_ed" title="Edit message">${IC.edit}</button></div><div class="mx_body">${paras}</div>${lastAi ? `<div class="mx_sw"><button class="mx_swl" title="Previous version">&#8249;</button><span>${(Number(m.swipe_id) || 0) + 1}/${(m.swipes && m.swipes.length) || 1}</span><button class="mx_swr" title="Next version / generate a new one">&#8250;</button></div>` : ''}</div></div>`;
        const img = el.querySelector('img');
        if (!av) img.style.visibility = 'hidden';
        img.onerror = () => { img.style.visibility = 'hidden'; };
    }
    function mxRender() {
        if (!mx.built) return;
        const c = ctx(), list = $id('mx_msgs');
        const items = [];
        (c.chat || []).forEach((m, i) => { if (m && !m.is_system) items.push([i, m]); });
        const start = Math.max(0, items.length - mx.limit);
        const shown = items.slice(start);
        $id('mx_more').hidden = start <= 0;
        const keep = new Set(shown.map((x) => x[0]));
        for (const [i, el] of mxNodes) if (!keep.has(i)) { el.remove(); mxNodes.delete(i); }
        let prev = null;
        const lastIdx = shown.length ? shown[shown.length - 1][0] : -1;
        for (const [i, m] of shown) {
            let el = mxNodes.get(i);
            if (!el) { el = document.createElement('div'); mxNodes.set(i, el); }
            el._idx = i;
            const lastAi = i === lastIdx && !m.is_user;
            const sig = `${m.is_user ? 1 : 0}|${m.name}|${m.swipe_id || 0}|${m.swipes ? m.swipes.length : 1}|${lastAi ? 1 : 0}|${m.mes}|${m.force_avatar || ''}`;
            if (el._sig !== sig && !el._editing) { mxFill(el, m, lastAi); el._sig = sig; }
            el.classList.toggle('mx_hide', !!mx.search && !String(m.mes || '').toLowerCase().includes(mx.search));
            const want = prev ? prev.nextSibling : list.firstChild;
            if (el !== want) list.insertBefore(el, want);
            prev = el;
        }
        mxTyping();
        mxScroll(false);
        const turns = mxTurns();
        if (turns !== mx.heroTurn) { mx.heroTurn = turns; mxHero(); }
    }
    const mxTurns = () => (ctx().chat || []).filter((m) => m && !m.is_system && !m.is_user).length;

    // ----- edit message (AI + user) -----
    function mxEdit(row) {
        const i = row._idx, m = ctx().chat && ctx().chat[i];
        if (!m || row._editing) return;
        row._editing = true;
        const body = row.querySelector('.mx_body');
        body.textContent = '';
        const ta = document.createElement('textarea'); ta.className = 'mx_eta'; ta.value = m.mes || '';
        const bar = document.createElement('div'); bar.className = 'mx_ebar';
        const ok = document.createElement('button'); ok.textContent = 'Save'; ok.className = 'mx_esave';
        const no = document.createElement('button'); no.textContent = 'Cancel';
        const size = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 4, 420) + 'px'; };
        ta.oninput = size;
        const done = () => { row._editing = false; row._sig = null; mxRender(); };
        no.onclick = done;
        ok.onclick = async () => { ok.disabled = true; await mxSaveEdit(i, ta.value); done(); };
        bar.append(ok, no);
        body.append(ta, bar);
        size(); ta.focus();
    }
    async function mxSaveEdit(i, text) {
        const c = ctx(), m = c.chat && c.chat[i];
        if (!m) return;
        m.mes = text;
        if (Array.isArray(m.swipes) && m.swipes.length) m.swipes[Number(m.swipe_id) || 0] = text;   // keep the active version in sync
        try { if (typeof c.updateMessageBlock === 'function') c.updateMessageBlock(i, m); } catch { /* ignore */ }
        try {
            const T = c.eventTypes || {};
            if (T.MESSAGE_EDITED) await c.eventSource.emit(T.MESSAGE_EDITED, i);
            if (T.MESSAGE_UPDATED) await c.eventSource.emit(T.MESSAGE_UPDATED, i);
        } catch { /* ignore */ }
        try { const f = c.saveChat || c.saveChatConditional; if (typeof f === 'function') await f.call(c); else toast('Edited, but SillyTavern could not save the chat automatically'); }
        catch (e) { console.warn('[Code Window] save failed', e); toast('Edit applied but saving failed'); }
    }

    // ----- swipes: regenerate keeps every previous version -----
    function mxSwipe(dir) {
        const el = document.querySelector('#chat .last_mes .swipe_' + dir);
        if (!el) { toast('Swipe is not available for this message'); return false; }
        el.click();
        return true;
    }
    function mxRegen() {
        const items = (ctx().chat || []).filter((m) => m && !m.is_system);
        const last = items[items.length - 1];
        if (!last) return;
        if (last.is_user) { stClick('option_regenerate', 'Regenerate'); return; }
        let guard = 0;
        const step = () => {                        // go to the newest version, then one more click generates a NEW version
            const m = (ctx().chat || []).filter((x) => x && !x.is_system).pop();
            if (!m || guard++ > 25) return;
            const atEnd = !m.swipes || (Number(m.swipe_id) || 0) >= m.swipes.length - 1;
            if (!mxSwipe('right')) return;
            if (!atEnd) setTimeout(step, 600);
        };
        step();
    }

    // ----- right panel big picture: follows the turns -----
    function mxHeroList(key) {     // one shared load per (character, gallery version) so quick repeated calls can't race
        if (mx.heroP && mx.heroPKey === key && mx.heroPVer === mx.galVer) return mx.heroP;
        mx.heroPKey = key; mx.heroPVer = mx.galVer;
        mx.heroP = (async () => {
            let items = [];
            try { items = key ? await gdb.list(key) : []; } catch { /* no gallery */ }
            items.sort((a, b) => a.ts - b.ts);
            mx.heroUrls.forEach((u) => URL.revokeObjectURL(u));
            mx.heroUrls = items.map((it) => URL.createObjectURL(it.blob));
        })();
        return mx.heroP;
    }
    async function mxHero() {
        const img = $id('mx_hero_img');
        if (!img || !mx.built) return;
        const key = charKey(), tok = ++mx.heroTok;
        await mxHeroList(key);
        if (tok !== mx.heroTok) return;
        const n = mx.heroUrls.length;
        let src = mx.avatarFull || '';
        if (settings().heroTurn !== false && n) src = mx.heroUrls[(Math.max(1, mxTurns()) - 1) % n];
        if (img._want === src) return;
        img._want = src;
        img.style.opacity = 0;
        setTimeout(() => {
            if (img._want !== src) return;
            img.onload = () => { img.style.opacity = 1; };
            img.onerror = () => { if (mx.avatarThumb && img.src.indexOf(mx.avatarThumb) < 0) img.src = mx.avatarThumb; else img.style.opacity = 1; };
            img.style.visibility = src ? '' : 'hidden';
            if (src) img.src = src;
        }, 180);
    }
    function mxTyping() {
        const items = (ctx().chat || []).filter((m) => m && !m.is_system);
        const last = items[items.length - 1];
        const t = $id('mx_typing');
        if (t) t.hidden = !(mx.gen && last && last.is_user);
        const sb = $id('mx_send');
        if (sb) { sb.innerHTML = mx.gen ? IC.stop : IC.send; sb.classList.toggle('mx_stop', mx.gen); sb.title = mx.gen ? 'Stop' : 'Send'; }
    }
    function mxGenTick() {
        if (!mxActive()) return;
        const g = isGenerating();
        if (g !== mx.gen) { mx.gen = g; mxTyping(); mxScroll(false); }
    }
    let mxTimer = 0;
    function mxSoon() {
        if (!mxActive() || mxTimer) return;
        mxTimer = setTimeout(() => { mxTimer = 0; mxRender(); }, 120);
    }
    function mxReset() {
        if (!mx.built) return;
        mxNodes.clear(); $id('mx_msgs').textContent = '';
        mx.limit = 60; mx.stick = true;
        mxAll();
        setTimeout(() => mxScroll(true), 60);
    }

    // ----- header / right panel -----
    function mxBg() {
        let img = 'none';
        try {
            const a = document.getElementById('bg_custom'), b = document.getElementById('bg1');
            const ia = a ? getComputedStyle(a).backgroundImage : 'none', ib = b ? getComputedStyle(b).backgroundImage : 'none';
            img = ia && ia !== 'none' ? ia : ib;
        } catch { /* ignore */ }
        $id('mx_bg').style.backgroundImage = img && img !== 'none' ? img : 'radial-gradient(120% 90% at 30% 20%, #3a1f2b 0%, #160d12 55%, #0b0709 100%)';
    }
    function mxHeader() {
        const c = ctx(), ch = curChar();
        let name = 'SillyTavern', tag = '', av = '', quote = '', hero = '';
        if (ch) { name = ch.name; tag = tagline(ch); av = mxThumb(ch.avatar); hero = mxFull(ch.avatar); quote = quoteOf(ch); }
        else if (c.groupId) { const g = (c.groups || []).find((x) => String(x.id) === String(c.groupId)); name = (g && g.name) || 'Group chat'; tag = 'Group chat'; }
        else tag = 'Pick a character to begin';
        $id('mx_h_name').textContent = name;
        $id('mx_h_tag').textContent = tag;
        $id('mx_r_name').textContent = name;
        $id('mx_r_quote').textContent = quote;
        const h = $id('mx_h_av'); h.style.visibility = av ? '' : 'hidden'; h.src = av || '';
        mx.avatarFull = hero; mx.avatarThumb = av;
        mxHero();
    }
    function mxAll() {
        if (!mx.built) return;
        mxBg(); mxHeader(); mxTab(mx.tab); mxRender();
        if (mx.view === 'characters') mxCharacters();
    }
    function mxShow() { mxBuild(); mxView(mx.view); mxAll(); mxSyncFs(); setTimeout(() => mxScroll(true), 80); }

    function mxTab(name) {
        mx.tab = name;
        document.querySelectorAll('#mx_tabs button').forEach((b) => b.classList.toggle('mx_on', b.dataset.tab === name));
        const body = $id('mx_tabbody');
        body.textContent = '';
        if (name === 'gallery') mxGallery(body);
        else if (name === 'info') mxInfo(body);
        else if (name === 'notes') mxNotes(body);
        else mxLore(body);
    }
    async function mxGallery(body) {
        galUrls.forEach((u) => URL.revokeObjectURL(u)); galUrls = [];
        const key = charKey();
        const grid = document.createElement('div'); grid.className = 'mx_gal';
        body.appendChild(grid);
        let items = [];
        try { items = key ? await gdb.list(key) : []; } catch (e) { console.warn('[Code Window] gallery read failed', e); }
        if (mx.tab !== 'gallery' || key !== charKey()) return;
        items.sort((a, b) => b.ts - a.ts).forEach((it) => {
            const url = URL.createObjectURL(it.blob); galUrls.push(url);
            const im = document.createElement('img'); im.className = 'mx_tile'; im.src = url; im.alt = '';
            im.onclick = () => {
                $id('mx_lb_img').src = url; $id('mx_lb').hidden = false;
                $id('mx_lb_del').onclick = async () => { $id('mx_lb').hidden = true; try { await gdb.del(it.id); } catch { /* ignore */ } mx.galVer++; mxTab('gallery'); mxHero(); };
            };
            grid.appendChild(im);
        });
        const add = document.createElement('button'); add.className = 'mx_tile mx_addtile'; add.innerHTML = IC.image + '<span>Add</span>';
        add.onclick = () => $id('mx_file').click();
        grid.appendChild(add);
    }
    async function mxAddImages(files) {
        const key = charKey();
        if (!key) { toast('Select a character first'); return; }
        let have = 0;
        try { have = (await gdb.list(key)).length; } catch { /* ignore */ }
        let added = 0;
        for (const f of files.slice(0, 20)) {
            if (!/^image\//.test(f.type)) continue;
            if (have + added >= 60) { toast('Gallery limit reached (60 pictures)'); break; }
            try { const blob = await shrinkImage(f); await gdb.add(key, blob); added++; } catch (e) { console.warn('[Code Window] image add failed', e); }
        }
        if (added) toast(`Added ${added} picture${added > 1 ? 's' : ''}`);
        mx.galVer++;
        mxTab('gallery');
        mxHero();
    }
    function mxInfo(body) {
        const ch = curChar();
        if (!ch) { body.textContent = 'No character selected.'; return; }
        const secs = [['Description', ch.description], ['Personality', ch.personality], ['Scenario', ch.scenario], ['First message', ch.first_mes], ['Example dialogue', ch.mes_example], ['Creator notes', ch.creatorcomment]];
        let n = 0;
        for (const [title, text] of secs) {
            const t = subst(text, ch).trim();
            if (!t) continue;
            n++;
            const d = document.createElement('div'); d.className = 'mx_sec';
            d.innerHTML = `<div class="mx_sh">${mxEsc(title)}</div><div class="mx_st">${mxHtml(t)}</div>`;
            body.appendChild(d);
        }
        const tags = Array.isArray(ch.tags) ? ch.tags : [];
        if (tags.length) { const d = document.createElement('div'); d.className = 'mx_chips'; d.innerHTML = tags.map((t) => `<span>${mxEsc(t)}</span>`).join(''); body.appendChild(d); n++; }
        const by = ch.data && ch.data.creator;
        if (by) { const d = document.createElement('div'); d.className = 'mx_by'; d.textContent = 'Created by ' + by; body.appendChild(d); }
        if (!n) body.textContent = 'This card has no details.';
    }
    function mxNotes(body) {
        const key = charKey();
        if (!key) { body.textContent = 'Select a character to keep notes.'; return; }
        const ta = document.createElement('textarea'); ta.className = 'mx_note';
        ta.placeholder = 'Your private RP notes (plot threads, promises, reminders...). Never sent to the AI.';
        ta.maxLength = 20000; ta.value = rp().notes[key] || '';
        ta.oninput = () => { rp().notes[key] = ta.value; save(); };
        body.appendChild(ta);
    }
    const clampInt = (v, lo, hi, d) => { v = parseInt(v, 10); return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); };
    function applyLore() {
        try {
            const c = ctx();
            if (typeof c.setExtensionPrompt !== 'function') return;
            const key = charKey(), e = (key && rp().lore[key]) || {};
            const text = String(e.text || '').trim();
            const role = [0, 1, 2].includes(Number(e.role)) ? Number(e.role) : 0;
            c.setExtensionPrompt(MODULE + '_lore', text, 1, clampInt(e.depth, 0, 200, 4), false, role);
        } catch (err) { console.warn('[Code Window] lore inject failed', err); }
    }
    function mxLore(body) {
        const key = charKey();
        if (!key) { body.textContent = 'Select a character to write a lore summary.'; return; }
        const e = rp().lore[key] || (rp().lore[key] = { text: '', depth: 4, role: 0 });
        body.innerHTML = `<textarea class="mx_note" maxlength="20000" placeholder="Write a summary of the story so far / world facts the AI must remember. It is sent with every request."></textarea>
<div class="mx_lrow"><label>Depth <input type="number" min="0" max="200" class="mx_depth"></label><label>Role <select class="mx_role"><option value="0">System</option><option value="1">User</option><option value="2">Assistant</option></select></label><span class="mx_lstat"></span></div>
<div class="mx_hint">Depth 0 = right after the newest message, 4 = four messages back. Leave empty to turn it off.</div>`;
        const ta = body.querySelector('textarea'), dp = body.querySelector('.mx_depth'), rl = body.querySelector('.mx_role'), st = body.querySelector('.mx_lstat');
        ta.value = e.text || ''; dp.value = clampInt(e.depth, 0, 200, 4); rl.value = String(e.role || 0);
        const stat = () => { st.textContent = ta.value.trim() ? '● active' : 'off'; st.className = 'mx_lstat' + (ta.value.trim() ? ' mx_live' : ''); };
        let t = 0;
        const upd = () => {
            e.text = ta.value; e.depth = clampInt(dp.value, 0, 200, 4); e.role = Number(rl.value) || 0;
            save(); stat(); clearTimeout(t); t = setTimeout(applyLore, 350);
        };
        ta.oninput = upd; dp.oninput = upd; rl.onchange = upd;
        stat();
    }

    // ----- hooks -----
    function mxHooks() {
        const { eventSource, eventTypes: T } = ctx();
        const on = (t, fn) => t && eventSource.on(t, fn);
        [T.CHARACTER_MESSAGE_RENDERED, T.USER_MESSAGE_RENDERED, T.MESSAGE_UPDATED, T.MESSAGE_SWIPED, T.MESSAGE_DELETED,
         T.MESSAGE_RECEIVED, T.GENERATION_STARTED, T.GENERATION_ENDED, T.GENERATION_STOPPED, T.STREAM_TOKEN_RECEIVED]
            .forEach((t) => on(t, mxSoon));
        on(T.CHAT_CHANGED, () => setTimeout(() => { applyLore(); if (mxActive()) mxReset(); }, 200));
        on(T.APP_READY, () => setTimeout(applyLore, 300));
        setTimeout(applyLore, 2500);
        setInterval(mxGenTick, 500);
    }

    jQuery(() => {
        createWindow();
        addMenuButton();
        mxHooks();
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
