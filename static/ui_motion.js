/* Shared UI motion: confirm dialogs, animated removal, toasts, busy buttons, entrance animations.
 * Used by the instructor pages and the student IDE. Respects prefers-reduced-motion.
 *
 *   UIMotion.confirm({ title, message, item, confirmText, danger }) -> Promise<boolean>
 *   UIMotion.remove(el)              -> Promise (flash, slide out, collapse, then el.remove())
 *   UIMotion.toast(msg, 'success' | 'error' | 'info')
 *   UIMotion.busy(button, 'Deleting…') -> restore()
 *   UIMotion.shake(el)
 *   UIMotion.enter(elements)          -> staggered fade-up
 */
(function () {
    if (window.UIMotion) return;

    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function ms(n) { return reduced ? 1 : n; }

    var css = [
        '.uim-backdrop{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;',
        'background:rgba(2,6,23,.62);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}',
        '.uim-dialog{width:100%;max-width:420px;background:#111827;color:#f1f5f9;border:1px solid #1f2937;border-radius:14px;',
        'box-shadow:0 24px 64px rgba(0,0,0,.5);padding:22px 22px 18px;font:14px/1.5 Inter,system-ui,sans-serif}',
        '.uim-icon{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;margin-bottom:14px;',
        'background:rgba(56,189,248,.12);color:#38bdf8}',
        '.uim-dialog.danger .uim-icon{background:rgba(239,68,68,.14);color:#f87171}',
        '.uim-title{font-size:1.02rem;font-weight:650;margin:0 0 6px;letter-spacing:-.01em}',
        '.uim-msg{color:#94a3b8;font-size:.86rem;margin:0}',
        '.uim-item{display:block;margin:12px 0 0;padding:8px 10px;border-radius:8px;background:#0b1120;border:1px solid #1f2937;',
        'color:#e2e8f0;font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;white-space:pre-wrap;max-height:160px;overflow:auto}',
        '.uim-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}',
        '.uim-btn{font:inherit;font-size:.84rem;font-weight:600;padding:8px 16px;border-radius:9px;border:1px solid #334155;',
        'background:transparent;color:#cbd5e1;cursor:pointer;transition:background .15s,border-color .15s,transform .1s}',
        '.uim-btn:hover{background:#1e293b}',
        '.uim-btn:active{transform:scale(.97)}',
        '.uim-btn:focus-visible{outline:2px solid #38bdf8;outline-offset:2px}',
        '.uim-btn.primary{background:#0284c7;border-color:#0284c7;color:#fff}',
        '.uim-btn.primary:hover{background:#0369a1}',
        '.uim-dialog.danger .uim-btn.primary{background:#dc2626;border-color:#dc2626}',
        '.uim-dialog.danger .uim-btn.primary:hover{background:#b91c1c}',
        '.uim-toasts{position:fixed;right:16px;bottom:16px;z-index:10001;display:flex;flex-direction:column;gap:8px;',
        'align-items:flex-end;pointer-events:none;max-width:calc(100vw - 32px)}',
        '.uim-toast{pointer-events:auto;position:relative;overflow:hidden;display:flex;align-items:center;gap:10px;min-width:240px;',
        'max-width:420px;padding:11px 14px 13px;border-radius:10px;background:#111827;color:#f1f5f9;border:1px solid #1f2937;',
        'box-shadow:0 12px 32px rgba(0,0,0,.4);font:13px/1.4 Inter,system-ui,sans-serif}',
        '.uim-toast .uim-ti{flex:none;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center}',
        '.uim-toast.success .uim-ti{background:rgba(16,185,129,.16);color:#34d399}',
        '.uim-toast.error .uim-ti{background:rgba(239,68,68,.16);color:#f87171}',
        '.uim-toast.info .uim-ti{background:rgba(56,189,248,.14);color:#38bdf8}',
        '.uim-toast .uim-bar{position:absolute;left:0;bottom:0;height:2px;width:100%;transform-origin:left;opacity:.7}',
        '.uim-toast.success .uim-bar{background:#34d399}.uim-toast.error .uim-bar{background:#f87171}.uim-toast.info .uim-bar{background:#38bdf8}',
        '.uim-spin{display:inline-block;width:12px;height:12px;margin-right:6px;vertical-align:-1px;border:2px solid currentColor;',
        'border-right-color:transparent;border-radius:50%;animation:uim-rot .7s linear infinite}',
        '@keyframes uim-rot{to{transform:rotate(360deg)}}',
        '.uim-busy{pointer-events:none;opacity:.75}',
    ].join('');
    var style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);

    var ICONS = {
        trash: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
        info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
        success: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>',
        error: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
        dot: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 8h.01M12 12v4"/></svg>',
    };
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
    }
    function animate(el, frames, opts) {
        if (!el.animate) return Promise.resolve();
        var a = el.animate(frames, Object.assign({ fill: 'forwards' }, opts, { duration: ms(opts.duration) }));
        return a.finished ? a.finished.catch(function () {}) : new Promise(function (r) { a.onfinish = r; });
    }

    function confirmDialog(opts) {
        opts = opts || {};
        var danger = opts.danger !== false;
        return new Promise(function (resolve) {
            var prevFocus = document.activeElement;
            var back = document.createElement('div');
            back.className = 'uim-backdrop';
            back.innerHTML =
                '<div class="uim-dialog' + (danger ? ' danger' : '') + '" role="alertdialog" aria-modal="true" aria-labelledby="uimTitle" aria-describedby="uimMsg">' +
                '<div class="uim-icon">' + (danger ? ICONS.trash : ICONS.info) + '</div>' +
                '<h2 class="uim-title" id="uimTitle">' + esc(opts.title || 'Are you sure?') + '</h2>' +
                '<p class="uim-msg" id="uimMsg">' + esc(opts.message || '') + '</p>' +
                (opts.item ? '<code class="uim-item">' + esc(opts.item) + '</code>' : '') +
                '<div class="uim-actions"><button type="button" class="uim-btn" data-r="0">' + esc(opts.cancelText || 'Cancel') + '</button>' +
                '<button type="button" class="uim-btn primary" data-r="1">' + esc(opts.confirmText || (danger ? 'Delete' : 'OK')) + '</button></div></div>';
            document.body.appendChild(back);
            var dialog = back.firstChild;
            var buttons = back.querySelectorAll('.uim-btn');
            animate(back, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
            animate(dialog, [{ opacity: 0, transform: 'translateY(8px) scale(.96)' }, { opacity: 1, transform: 'none' }],
                { duration: 220, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
            buttons[0].focus();  // safe default for destructive actions

            var done = false;
            function close(result) {
                if (done) return;
                done = true;
                document.removeEventListener('keydown', onKey, true);
                Promise.all([
                    animate(back, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-in' }),
                    animate(dialog, [{ transform: 'none' }, { transform: 'scale(.97)' }], { duration: 140, easing: 'ease-in' }),
                ]).then(function () {
                    back.remove();
                    if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (e) { /* ignore */ }
                    resolve(result);
                });
            }
            function onKey(e) {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
                else if (e.key === 'Tab') {  // keep focus inside the dialog
                    e.preventDefault();
                    (document.activeElement === buttons[0] ? buttons[1] : buttons[0]).focus();
                }
            }
            document.addEventListener('keydown', onKey, true);
            back.addEventListener('mousedown', function (e) { if (e.target === back) close(false); });
            buttons.forEach(function (b) { b.addEventListener('click', function () { close(b.dataset.r === '1'); }); });
        });
    }

    /** Red flash, slide out, then collapse the space so neighbours glide up; finally remove. */
    function remove(el, opts) {
        if (!el || !el.parentNode) return Promise.resolve();
        opts = opts || {};
        var cs = getComputedStyle(el);
        var h = el.offsetHeight;
        var isRow = el.tagName === 'TR';
        el.style.pointerEvents = 'none';
        var flash = animate(el, [
            { backgroundColor: 'rgba(239,68,68,0)' },
            { backgroundColor: 'rgba(239,68,68,.16)', offset: 0.35 },
            { backgroundColor: 'rgba(239,68,68,.10)' },
        ], { duration: 260, easing: 'ease-out' });
        return flash.then(function () {
            if (isRow) {
                // Table rows cannot collapse height reliably: fade/slide the cells, then drop the row.
                return animate(el, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-24px)' }],
                    { duration: 260, easing: 'ease-in' });
            }
            el.style.overflow = 'hidden';
            el.style.boxSizing = 'border-box';
            return animate(el, [
                { opacity: 1, transform: 'none', height: h + 'px', marginTop: cs.marginTop, marginBottom: cs.marginBottom,
                  paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom },
                { opacity: 0, transform: opts.direction === 'up' ? 'translateY(-8px) scale(.98)' : 'translateX(-28px) scale(.98)',
                  height: h + 'px', marginTop: cs.marginTop, marginBottom: cs.marginBottom,
                  paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, offset: 0.55 },
                { opacity: 0, transform: 'translateX(-28px) scale(.98)', height: '0px', marginTop: '0px', marginBottom: '0px',
                  paddingTop: '0px', paddingBottom: '0px' },
            ], { duration: 420, easing: 'cubic-bezier(.4,0,.2,1)' });
        }).then(function () { if (el.parentNode) el.remove(); });
    }

    function shake(el) {
        if (!el) return Promise.resolve();
        return animate(el, [
            { transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' },
            { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' },
        ], { duration: 360, easing: 'ease-in-out', fill: 'none' });
    }

    var stack = null;
    function toast(msg, type, opts) {
        type = type || 'info';
        opts = opts || {};
        if (!stack || !stack.isConnected) {
            stack = document.createElement('div');
            stack.className = 'uim-toasts';
            stack.setAttribute('aria-live', 'polite');
            document.body.appendChild(stack);
        }
        var t = document.createElement('div');
        t.className = 'uim-toast ' + type;
        t.setAttribute('role', type === 'error' ? 'alert' : 'status');
        t.innerHTML = '<span class="uim-ti">' + (ICONS[type] || ICONS.dot) + '</span><span>' + esc(msg) + '</span><span class="uim-bar"></span>';
        stack.appendChild(t);
        var life = opts.duration || (type === 'error' ? 6000 : 3500);
        animate(t, [{ opacity: 0, transform: 'translateY(12px) scale(.96)' }, { opacity: 1, transform: 'none' }],
            { duration: 240, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
        animate(t.querySelector('.uim-bar'), [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: life, easing: 'linear' });
        setTimeout(function () {
            animate(t, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(24px)' }], { duration: 220, easing: 'ease-in' })
                .then(function () { t.remove(); });
        }, life);
        return t;
    }

    function busy(btn, label) {
        if (!btn) return function () {};
        var html = btn.innerHTML, disabled = btn.disabled;
        btn.disabled = true;
        btn.classList.add('uim-busy');
        // label '' = spinner only (icon buttons); undefined = default text
        btn.innerHTML = '<span class="uim-spin" aria-hidden="true"' + (label === '' ? ' style="margin-right:0"' : '') + '></span>' +
            esc(label === undefined ? 'Working…' : label);
        return function restore() {
            btn.disabled = disabled;
            btn.classList.remove('uim-busy');
            btn.innerHTML = html;
        };
    }

    function enter(els, opts) {
        opts = opts || {};
        var list = Array.prototype.slice.call(els || []);
        list.forEach(function (el, i) {
            animate(el, [{ opacity: 0, transform: 'translateY(' + (opts.distance || 10) + 'px)' }, { opacity: 1, transform: 'none' }],
                { duration: 320, delay: reduced ? 0 : Math.min(i, 12) * (opts.stagger || 45), easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' });
        });
    }

    window.UIMotion = { confirm: confirmDialog, remove: remove, shake: shake, toast: toast, busy: busy, enter: enter, reduced: reduced };
})();
