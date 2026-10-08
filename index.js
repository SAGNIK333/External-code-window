// Code Window v1.3 - SillyTavern extension
// Floating, draggable, resizable popup that renders HTML/CSS/JS in a sandboxed iframe.
// v1.3: full screen mode (default) with floating close button, viewport-height fix, real generating detection, ST.stop().
// v1.2: streaming updates, ST.state.generating, maximize button.
// v1.1: pages get a global `ST` object (live chat state, variables, send/insert helpers).
(() => {
    const MODULE = 'code_window';
    const ctx = () => SillyTavern.getContext();

    const defaults = Object.freeze({
        left: null, top: null, width: 720, height: 600,
        fullscreen: true,         // cover the whole screen (floating close button top-right)
        allowScripts: true,       // run <script> inside the page
        allowBridge: true,        // page may read chat state + fill/send the chat input
        autoRender: false,        // auto-render last code block of new AI messages
        lastCode: '',
    });

    function settings() {
        const { extensionSettings } = ctx();
        if (!extensionSettings[MODULE]) extensionSettings[MODULE] = {};
        for (const k of Object.keys(defaults)) {
            if (extensionSettings[MODULE][k] === undefined) extensionSettings[MODULE][k] = defaults[k];
        }
        return extensionSettings[MODULE];
    }
    const save = () => ctx().saveSettingsDebounced();

    // ---------- helper injected into every rendered page ----------
    //   ST.state                 latest chat data: user, char, lastMessage, lastCharMessage, messages[], vars{}
    //   ST.onUpdate(fn)          fn(state) runs now (once data arrives) and after every new/edited message
    //   ST.send(t) / ST.insert(t) / ST.append(t)   chat input helpers
    //   ST.setVar(name, value)   save a chat variable (shows up in ST.state.vars)
    //   ST.stop()                stop the current generation
    const HELPER = `<script>
window.ST={state:{},_cbs:[],
onUpdate:function(cb){this._cbs.push(cb);if(this.state.ready){try{cb(this.state)}catch(x){console.error(x)}}},
send:function(t){parent.postMessage({type:'st-send',text:String(t)},'*')},
insert:function(t){parent.postMessage({type:'st-insert',text:String(t)},'*')},
append:function(t){parent.postMessage({type:'st-append',text:String(t)},'*')},
setVar:function(n,v){parent.postMessage({type:'st-setvar',name:String(n),value:v},'*')},
stop:function(){parent.postMessage({type:'st-stop'},'*')},
request:function(){parent.postMessage({type:'st-request'},'*')}};
addEventListener('message',function(e){var d=e.data;if(d&&d.type==='st-state'){ST.state=Object.assign({ready:true},d.state);ST._cbs.forEach(function(cb){try{cb(ST.state)}catch(x){console.error(x)}})}});
addEventListener('DOMContentLoaded',function(){ST.request()});
<\/script>`;

    // ---------- rendering ----------
    function buildDoc(code) {
        const trimmed = code.trim();
        // Full document -> keep as is, inject helper into <head>
        if (/^<!doctype|^<html/i.test(trimmed)) {
            if (/<head[^>]*>/i.test(code)) return code.replace(/<head[^>]*>/i, (m) => m + HELPER);
            return HELPER + code;
        }
        // Pure CSS (no tags) -> wrap in a style on an empty body
        if (!/<[a-z!][\s\S]*>/i.test(trimmed) && /[{};:]/.test(trimmed)) {
            return `<!doctype html><html><head><meta charset="utf-8">${HELPER}<style>${code}</style></head><body></body></html>`;
        }
        return `<!doctype html><html><head><meta charset="utf-8">${HELPER}
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;padding:8px;font-family:system-ui,sans-serif;}</style>
</head><body>${code}</body></html>`;
    }

    function render(code) {
        const s = settings();
        s.lastCode = code;
        save();
        const frame = document.getElementById('cw_frame');
        frame.setAttribute('sandbox', s.allowScripts ? 'allow-scripts allow-forms allow-modals' : '');
        frame.srcdoc = buildDoc(code);
        document.getElementById('cw_editor').value = code;
        setStatus(`Rendered ${code.length} chars`);
        openWindow();
        setEditing(false);
    }

    function setStatus(t) { const el = document.getElementById('cw_status'); if (el) el.textContent = t; }

    // ---------- chat state -> page ----------
    // True while ST is generating: ST shows its Stop button only then (more reliable than events).
    function isGenerating() {
        const stop = document.getElementById('mes_stop');
        if (!stop) return false;
        const cs = getComputedStyle(stop);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
    }
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
        const w = document.getElementById('cw_window');
        const frame = document.getElementById('cw_frame');
        if (!w || !frame || !frame.contentWindow || !w.classList.contains('cw_open')) return;
        try { frame.contentWindow.postMessage({ type: 'st-state', state: getState() }, '*'); } catch (e) { console.warn('[Code Window] pushState failed', e); }
    }

    let lastPush = 0, pushTimer = null;
    function pushThrottled() {
        const now = Date.now();
        if (now - lastPush > 120) { lastPush = now; pushState(); return; }
        if (!pushTimer) pushTimer = setTimeout(() => { pushTimer = null; lastPush = Date.now(); pushState(); }, 130);
    }

    // Real visible height (handles mobile browser bars and the on-screen keyboard)
    function setVh() {
        const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
        document.documentElement.style.setProperty('--cw-vh', h + 'px');
    }

    // ---------- window ----------
    function openWindow() {
        document.getElementById('cw_window').classList.add('cw_open');
    }
    function closeWindow() { document.getElementById('cw_window').classList.remove('cw_open'); }
    function toggleWindow() {
        const w = document.getElementById('cw_window');
        w.classList.toggle('cw_open');
        if (w.classList.contains('cw_open')) setTimeout(pushState, 100);
    }
    function setFullscreen(on) {
        const w = document.getElementById('cw_window');
        w.classList.toggle('cw_full', on);
        document.getElementById('cw_btn_max').classList.toggle('cw_on', on);
        settings().fullscreen = on; save();
        setVh();
    }
    function setEditing(on) {
        const w = document.getElementById('cw_window');
        w.classList.toggle('cw_editing', on);
        document.getElementById('cw_btn_edit').classList.toggle('cw_on', on);
    }

    function clampIntoView(w) {
        const r = w.getBoundingClientRect();
        const left = Math.min(Math.max(0, r.left), window.innerWidth - 80);
        const top = Math.min(Math.max(0, r.top), window.innerHeight - 40);
        w.style.left = left + 'px';
        w.style.top = top + 'px';
        w.style.right = 'auto';
    }

    function makeDraggable(w, handle) {
        let sx, sy, ox, oy, dragging = false;
        handle.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.cw_btn')) return;
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
        const w = document.getElementById('cw_window');
        if (w.classList.contains('cw_full')) return;
        const s = settings();
        const r = w.getBoundingClientRect();
        s.left = Math.round(r.left); s.top = Math.round(r.top);
        s.width = Math.round(r.width); s.height = Math.round(r.height);
        save();
    }

    function createWindow() {
        const s = settings();
        const html = `
<div id="cw_window" class="${s.fullscreen ? 'cw_full' : ''}" style="width:${s.width}px;height:${s.height}px;${s.left !== null ? `left:${s.left}px;top:${s.top}px;right:auto;` : ''}">
  <div id="cw_header">
    <span id="cw_title">Code Window</span>
    <span class="cw_btn" id="cw_btn_edit" title="Edit code">&lt;/&gt;</span>
    <span class="cw_btn" id="cw_btn_max" title="Full screen on/off">&#9974;</span>
    <span class="cw_btn" id="cw_btn_run" title="Re-run">&#9654;</span>
    <span class="cw_btn" id="cw_btn_clear" title="Clear">&#8855;</span>
    <span class="cw_btn" id="cw_btn_close" title="Close">&#10005;</span>
  </div>
  <div id="cw_float">
    <span class="cw_btn" id="cw_f_exit" title="Exit full screen">&#9974;</span>
    <span class="cw_btn" id="cw_f_close" title="Close">&#10005;</span>
  </div>
  <div id="cw_body">
    <iframe id="cw_frame" sandbox="allow-scripts allow-forms allow-modals"></iframe>
    <textarea id="cw_editor" spellcheck="false" placeholder="Paste HTML / CSS / JS here, then press Run"></textarea>
  </div>
  <div id="cw_footer">
    <span id="cw_status">Ready</span>
    <label title="Allow JavaScript inside the page"><input type="checkbox" id="cw_opt_scripts"> JS</label>
    <label title="Let the page read chat/variables and fill or send the chat input"><input type="checkbox" id="cw_opt_bridge"> Bridge</label>
    <label title="Auto-render the last code block of each new AI message"><input type="checkbox" id="cw_opt_auto"> Auto</label>
  </div>
</div>`;
        document.body.insertAdjacentHTML('beforeend', html);
        const w = document.getElementById('cw_window');
        const frame = document.getElementById('cw_frame');
        makeDraggable(w, document.getElementById('cw_header'));
        setVh();
        window.addEventListener('resize', setVh);
        if (window.visualViewport) window.visualViewport.addEventListener('resize', setVh);
        document.getElementById('cw_btn_max').classList.toggle('cw_on', !!s.fullscreen);

        new ResizeObserver(() => { if (w.classList.contains('cw_open')) persistGeometry(); }).observe(w);

        frame.addEventListener('load', () => setTimeout(pushState, 50));

        document.getElementById('cw_btn_close').onclick = closeWindow;
        document.getElementById('cw_btn_max').onclick = () => setFullscreen(!w.classList.contains('cw_full'));
        document.getElementById('cw_f_exit').onclick = () => setFullscreen(false);
        document.getElementById('cw_f_close').onclick = closeWindow;
        document.getElementById('cw_btn_edit').onclick = () => setEditing(!w.classList.contains('cw_editing'));
        document.getElementById('cw_btn_run').onclick = () => render(document.getElementById('cw_editor').value || settings().lastCode);
        document.getElementById('cw_btn_clear').onclick = () => {
            document.getElementById('cw_editor').value = '';
            frame.srcdoc = '';
            settings().lastCode = ''; save(); setStatus('Cleared');
        };

        const bind = (id, key) => {
            const el = document.getElementById(id);
            el.checked = !!s[key];
            el.onchange = () => {
                s[key] = el.checked; save();
                if (key === 'allowScripts' && s.lastCode) render(document.getElementById('cw_editor').value);
                if (key === 'allowBridge' && el.checked) pushState();
            };
        };
        bind('cw_opt_scripts', 'allowScripts');
        bind('cw_opt_bridge', 'allowBridge');
        bind('cw_opt_auto', 'autoRender');

        document.getElementById('cw_editor').value = s.lastCode || '';
        if (s.lastCode) frame.srcdoc = buildDoc(s.lastCode);
    }

    // ---------- bridge: page <-> chat ----------
    window.addEventListener('message', (e) => {
        const frame = document.getElementById('cw_frame');
        if (!frame || e.source !== frame.contentWindow) return;
        if (!settings().allowBridge) return;
        const d = e.data || {};
        const c = ctx();

        if (d.type === 'st-request') { pushState(); return; }
        if (d.type === 'st-stop') { document.getElementById('mes_stop')?.click(); return; }

        if (d.type === 'st-setvar') {
            if (typeof d.name !== 'string' || !d.name) return;
            if (!c.chatMetadata) return;
            if (!c.chatMetadata.variables) c.chatMetadata.variables = {};
            c.chatMetadata.variables[d.name] = d.value;
            if (typeof c.saveMetadata === 'function') c.saveMetadata();
            pushState();
            return;
        }

        if (typeof d.text !== 'string') return;
        const ta = document.getElementById('send_textarea');
        if (!ta) return;
        if (d.type === 'st-insert' || d.type === 'st-send') {
            ta.value = d.text;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            if (d.type === 'st-send') document.getElementById('send_but')?.click();
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
            btn.onclick = () => render(codeEl.textContent);
            pre.parentNode.insertBefore(btn, pre);
        });
    }

    function autoRenderLast() {
        if (!settings().autoRender) return;
        const blocks = document.querySelectorAll('#chat .mes.last_mes .mes_text pre code');
        if (blocks.length) render(blocks[blocks.length - 1].textContent);
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
        // safety net: catch any generating on/off change events might miss
        let wasGen = false;
        setInterval(() => { const g = isGenerating(); if (g !== wasGen) { wasGen = g; pushState(); } }, 600);
        on(T.STREAM_TOKEN_RECEIVED, pushThrottled);
        refresh();
    });
})();
