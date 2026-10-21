// AI assistance per study condition, included by index.html:
//   1 = No AI, 2 = inline ghost-text suggestions (Copilot-style), 3 = coding agent (Cursor-style).
// Relies on globals from index.html: currentSession, logActivity; and window.WS (workspace.js).
(function () {
    'use strict';

    var CONDITION = { NO_AI: 1, SUGGESTION: 2, AGENT: 3 };
    var GHOST_DEBOUNCE_MS = 150;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function lang() { return currentSession.programmingLanguage || 'javascript'; }
    function log(type, details) { try { logActivity(type, details || {}); } catch (e) { /* ignore */ } }


    // ── Condition 2: inline ghost-text completions ────────────────────────────
    function initGhostText(monaco, editor) {
        editor.updateOptions({ inlineSuggest: { enabled: true } });
        var shown = new Set();
        var cache = new Map();
        var pending = {};  // suggestion_id -> time shown (ms), until accepted / rejected / ignored
        var live = {};     // suggestion_id -> completion lists still holding it (cached hits are re-offered)
        function resolve(id, decision, reason) {
            var t = pending[id];
            if (t === undefined) return;
            delete pending[id];
            log('inline_suggestion_dismissed', { suggestion_id: id, decision: decision, reason: reason, time_to_decision_ms: Date.now() - t });
        }
        var acceptCmd = editor.addCommand(0, function (_ctx, meta) {
            var t = pending[meta.suggestion_id];
            delete pending[meta.suggestion_id];
            log('inline_suggestion_accepted', Object.assign({}, meta, {
                time_to_decision_ms: t === undefined ? null : Date.now() - t
            }));
        }, '');
        // Esc while ghost text is visible = explicit reject
        editor.onKeyDown(function (e) {
            if (e.keyCode === monaco.KeyCode.Escape) {
                Object.keys(pending).forEach(function (id) { resolve(id, 'rejected', 'escape'); });
            }
        });

        monaco.languages.registerInlineCompletionsProvider(lang(), {
            provideInlineCompletions: async function (model, position, context, token) {
                if (editor.getOption(monaco.editor.EditorOption.readOnly)) return { items: [] };
                var last = model.getLineCount();
                var prefix = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column));
                var suffix = model.getValueInRange(new monaco.Range(position.lineNumber, position.column, last, model.getLineMaxColumn(last)));
                if (!prefix.trim()) return { items: [] };

                var key = prefix.slice(-3000) + '\u0000' + suffix.slice(0, 500);
                var hit = cache.get(key);
                if (!hit) {
                    if (context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Automatic) {
                        await sleep(GHOST_DEBOUNCE_MS);
                    }
                    if (token.isCancellationRequested) return { items: [] };
                    var ctrl = new AbortController();
                    token.onCancellationRequested(function () { ctrl.abort(); });
                    var started = Date.now();
                    try {
                        var res = await fetch('/complete', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            signal: ctrl.signal,
                            body: JSON.stringify({
                                session_id: currentSession.sessionId,
                                language: lang(),
                                filename: activeFileName(),
                                prefix: prefix,
                                suffix: suffix
                            })
                        });
                        if (!res.ok) return { items: [] };
                        var data = await res.json();
                        hit = { id: data.id || '', text: data.completion || '', latency_ms: Date.now() - started };
                    } catch (e) {
                        return { items: [] };
                    }
                    cache.set(key, hit);
                    if (cache.size > 200) cache.delete(cache.keys().next().value);
                }
                if (!hit.text || token.isCancellationRequested) return { items: [] };

                var meta = {
                    suggestion_id: hit.id,
                    file: activeFileName(),
                    line: position.lineNumber,
                    column: position.column,
                    lines: hit.text.split('\n').length,
                    text: hit.text.slice(0, 2000),
                    latency_ms: hit.latency_ms
                };
                // Code in the IDE when the suggestion appeared (logged once, with the "shown" event)
                var snapshot = (prefix + suffix).slice(0, 10000);
                live[hit.id] = (live[hit.id] || 0) + 1;
                return {
                    items: [{
                        insertText: hit.text,
                        range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
                        command: { id: acceptCmd, title: 'Accept suggestion', arguments: [meta] },
                        _meta: meta,
                        _snapshot: snapshot
                    }]
                };
            },
            handleItemDidShow: function (_completions, item) {
                var meta = item && item._meta;
                if (meta && !shown.has(meta.suggestion_id)) {
                    shown.add(meta.suggestion_id);
                    pending[meta.suggestion_id] = Date.now();
                    log('inline_suggestion_shown', Object.assign({}, meta, { code_snapshot: item._snapshot || '' }));
                }
            },
            // Monaco drops a suggestion when it no longer applies (the student kept typing or moved on).
            // Wait briefly: on Tab the accept command can run just after this.
            freeInlineCompletions: function (completions) {
                (completions && completions.items || []).forEach(function (item) {
                    var id = item._meta && item._meta.suggestion_id;
                    if (!id) return;
                    live[id] = Math.max(0, (live[id] || 1) - 1);
                    setTimeout(function () {
                        if (!live[id]) { delete live[id]; resolve(id, 'ignored', 'typed_over'); }
                    }, 400);
                });
            }
        });
    }

    function activeFileName() { return window.WS ? WS.activeName() : 'main'; }

    // ── Condition 3: Cursor-style agent ───────────────────────────────────────
    var SVG = {
        agent: '<svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M4.5 5.5c-1.7 0-3 1.1-3 2.5s1.3 2.5 3 2.5c2.4 0 4.6-5 7-5 1.7 0 3 1.1 3 2.5s-1.3 2.5-3 2.5c-2.4 0-4.6-5-7-5z"/></svg>',
        plan: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M2 3h1.5v1.5H2zm3 .25h9v1H5zM2 7.25h1.5v1.5H2zm3 .25h9v1H5zM2 11.5h1.5V13H2zm3 .25h9v1H5z"/></svg>',
        debug: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M5.5 3.5a2.5 2.5 0 015 0v.6l1.6-1 .5.9-1.9 1.1c.2.4.3.8.3 1.2v.2h2v1h-2v.5c0 .4 0 .7-.1 1l2 1.2-.5.9-1.9-1.1A3.5 3.5 0 018 13a3.5 3.5 0 01-3-1.6L3.1 12.5l-.5-.9 2-1.2c-.1-.3-.1-.6-.1-1V9h-2V8h2v-.2c0-.4.1-.8.3-1.2L2.9 5.5l.5-.9 1.6 1v-.6zm1 .4v.3h3v-.3a1.5 1.5 0 00-3 0zM6 7.8V9.4a2 2 0 004 0V7.8a1.5 1.5 0 00-1.5-1.5h-1A1.5 1.5 0 006 7.8z"/></svg>',
        ask: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v6a1.5 1.5 0 01-1.5 1.5H6.2L3 13.7V11h0a1.5 1.5 0 01-1-1.4v-6zM3.5 3a.5.5 0 00-.5.5v6a.5.5 0 00.5.5H4v1.6L5.8 10h6.7a.5.5 0 00.5-.5v-6a.5.5 0 00-.5-.5h-9z"/></svg>',
        chevron: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M4 6l4 4 4-4z"/></svg>',
        send: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 2.5l4.5 4.5-.9.9L8.6 5v8.5H7.4V5L4.4 7.9l-.9-.9z"/></svg>',
        stop: '<svg viewBox="0 0 16 16"><rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor"/></svg>',
        plus: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M7.4 2.5h1.2v4.9h4.9v1.2H8.6v4.9H7.4V8.6H2.5V7.4h4.9z"/></svg>',
        history: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 2a6 6 0 11-5.6 3.9l1.1.4A4.8 4.8 0 108 3.2a4.8 4.8 0 00-3.6 1.6H6V6H2.5V2.5h1.2v1.4A6 6 0 018 2zm-.6 2.5h1.2v3.2l2.1 1.3-.6 1-2.7-1.6z"/></svg>',
        more: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M3.5 7a1 1 0 110 2 1 1 0 010-2zm4.5 0a1 1 0 110 2 1 1 0 010-2zm4.5 0a1 1 0 110 2 1 1 0 010-2z"/></svg>',
        file: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M10 1H3.5L3 1.5v13l.5.5h9l.5-.5V4l-3-3zm0 1.4L11.6 4H10V2.4zM12 14H4V2h5v3h3v9z"/></svg>',
        read: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 3.5c3 0 5.3 2.1 6 4.5-.7 2.4-3 4.5-6 4.5S2.7 10.4 2 8c.7-2.4 3-4.5 6-4.5zm0 1.2c-2.3 0-4.1 1.5-4.8 3.3.7 1.8 2.5 3.3 4.8 3.3s4.1-1.5 4.8-3.3C12.1 6.2 10.3 4.7 8 4.7zm0 1.3a2 2 0 110 4 2 2 0 010-4z"/></svg>',
        run: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M2 3h12v10H2V3zm1 1v8h10V4H3zm1.3 1.7l2.5 2.3-2.5 2.3-.7-.7L5.4 8 3.6 6.4l.7-.7zM7.5 10h4v1h-4v-1z"/></svg>',
        skill: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M9.3 1.5L4 9h3.5l-1 5.5L12 7H8.5z"/></svg>'
    };

    var MODES = [
        { id: 'agent', label: 'Agent', icon: 'agent', hint: 'Plan, search, and edit your files' },
        { id: 'plan', label: 'Plan', icon: 'plan', hint: 'Draft a step-by-step plan before changes' },
        { id: 'debug', label: 'Debug', icon: 'debug', hint: 'Run your code to find and fix bugs' },
        { id: 'ask', label: 'Ask', icon: 'ask', hint: 'Ask questions; no changes to files' }
    ];
    function modeOf(id) { return MODES.find(function (m) { return m.id === id; }) || MODES[0]; }

    function renderMarkdown(src) {
        return String(src).split('```').map(function (part, i) {
            if (i % 2 === 1) {
                var nl = part.indexOf('\n');
                var code = nl >= 0 ? part.slice(nl + 1) : part;
                return '<pre class="agent-code"><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>';
            }
            var h = esc(part)
                .replace(/`([^`\n]+)`/g, '<code>$1</code>')
                .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
                .replace(/^#{1,4} (.+)$/gm, '<div class="agent-h">$1</div>')
                .replace(/^\s*[-*] (.+)$/gm, '<div class="agent-li"><span>•</span><span>$1</span></div>')
                .replace(/^\s*(\d+)\. (.+)$/gm, '<div class="agent-li"><span>$1.</span><span>$2</span></div>')
                .replace(/_\(([^)]+)\)_/g, '<em>($1)</em>');
            return h.replace(/<\/div>\n/g, '</div>');
        }).join('');
    }

    // Line numbers (1-based) in `after` that are new or changed relative to `before` (LCS).
    function changedLines(before, after) {
        var a = before.split('\n'), b = after.split('\n');
        if (a.length * b.length > 400000) return b.map(function (_, i) { return i + 1; });
        var n = a.length, m = b.length, dp = [];
        for (var i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
        for (i = n - 1; i >= 0; i--) {
            for (var j = m - 1; j >= 0; j--) {
                dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
        var out = [];
        i = 0; j = 0;
        while (i < n && j < m) {
            if (a[i] === b[j]) { i++; j++; }
            else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
            else { out.push(j + 1); j++; }
        }
        for (; j < m; j++) out.push(j + 1);
        return out;
    }

    function lineCounts(before, after) {
        var added = changedLines(before || '', after || '').length;
        var removed = changedLines(after || '', before || '').length;
        return { added: added, removed: removed };
    }

    var Agent = {
        monaco: null,
        editor: null,
        mode: 'agent',
        busy: false,
        abort: null,
        chats: [],            // [{id, title, mode, history:[{role, content}]}]
        chatId: '',
        pending: {},          // filename -> {baseline: string|null, turn_id}
        respondedAt: {},      // turn_id -> Date.now() when the agent finished (for time to Keep/Undo)
        decorations: {},      // filename -> decoration ids
        skills: [],           // [{name, instructions, source, enabled}]
        attachedSkills: [],   // skills picked with "/" for the next message
        popup: null,          // {kind: 'slash'|'at'|'mode', items, index, start}
        reviewOpen: false,
        els: {},

        storageKey: function () { return 'agentChats_' + currentSession.sessionId; },
        chat: function () { var id = this.chatId; return this.chats.find(function (c) { return c.id === id; }); },

        init: function (monaco, editor) {
            this.monaco = monaco;
            this.editor = editor;
            this.loadSkills();
            this.loadChats();
            this.buildPanel();
            this.renderChat();
            var self = this;
            var t = null;
            editor.onDidChangeModelContent(function () {
                if (!Object.keys(self.pending).length) return;
                clearTimeout(t);
                t = setTimeout(function () { self.refreshDecorations(); self.renderReview(); }, 300);
            });
            WS.listeners.push(function (ev) {
                if (ev.type === 'rename' && self.pending[ev.from]) {
                    self.pending[ev.name] = self.pending[ev.from];
                    delete self.pending[ev.from];
                    self.syncBadges();
                    self.renderReview();
                }
                if (ev.type === 'open') self.refreshDecorations();
            });
        },

        // Chats ----------------------------------------------------------------
        loadChats: function () {
            try {
                var saved = JSON.parse(sessionStorage.getItem(this.storageKey()) || 'null');
                if (saved && Array.isArray(saved.chats) && saved.chats.length) {
                    this.chats = saved.chats;
                    this.chatId = saved.current;
                }
            } catch (e) { /* ignore */ }
            if (!this.chat()) this.newChat(true);
            this.mode = this.chat().mode || 'agent';
        },
        persist: function () {
            try {
                var chats = this.chats.slice(-15).map(function (c) {
                    return { id: c.id, title: c.title, mode: c.mode, history: c.history.slice(-40) };
                });
                sessionStorage.setItem(this.storageKey(), JSON.stringify({ chats: chats, current: this.chatId }));
            } catch (e) { /* ignore */ }
        },
        newChat: function (silent) {
            var current = this.chat();
            if (current && !current.history.length && !silent) { this.els.input && this.els.input.focus(); return; }
            var id = 'c' + Date.now().toString(36);
            this.chats.push({ id: id, title: 'New Agent', mode: this.mode || 'agent', history: [] });
            this.chatId = id;
            this.persist();
            if (!silent) {
                if (this.busy) this.stop();
                log('agent_new_chat', {});
                this.renderChat();
                this.els.input.focus();
            }
        },
        switchChat: function (id) {
            if (this.busy || id === this.chatId) return;
            this.chatId = id;
            this.setMode(this.chat().mode || 'agent');
            this.persist();
            this.renderChat();
        },

        // Skills ---------------------------------------------------------------
        loadSkills: function () {
            var instr = (currentSession.agentSkillsInstructor || []).map(function (s) {
                return { name: s.name, instructions: s.instructions, source: 'instructor', enabled: true };
            });
            var mine = (currentSession.agentSkillsStudent || []).map(function (s) {
                return { name: s.name, instructions: s.instructions, source: 'student', enabled: true };
            });
            var off = [];
            try { off = JSON.parse(localStorage.getItem('agentSkillsOff_' + currentSession.sessionId) || '[]'); } catch (e) { /* ignore */ }
            this.skills = instr.concat(mine).map(function (s) { s.enabled = off.indexOf(s.source + ':' + s.name) < 0; return s; });
        },
        saveSkillToggles: function () {
            var off = this.skills.filter(function (s) { return !s.enabled; }).map(function (s) { return s.source + ':' + s.name; });
            try { localStorage.setItem('agentSkillsOff_' + currentSession.sessionId, JSON.stringify(off)); } catch (e) { /* ignore */ }
        },
        saveStudentSkills: function () {
            var mine = this.skills.filter(function (s) { return s.source === 'student'; })
                .map(function (s) { return { name: s.name, instructions: s.instructions }; });
            fetch('/agent/skills', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: currentSession.sessionId, skills: mine })
            }).catch(function () { /* ignore */ });
            try {
                var ad = JSON.parse(sessionStorage.getItem('authData') || '{}');
                ad.agentSkillsStudent = mine;
                sessionStorage.setItem('authData', JSON.stringify(ad));
            } catch (e) { /* ignore */ }
            currentSession.agentSkillsStudent = mine;
        },

        // Layout ---------------------------------------------------------------
        setupResize: function (handle, card) {
            var app = document.getElementById('application');
            try {
                var saved = parseInt(localStorage.getItem('agentCardWidth') || '', 10);
                if (saved >= 280) app.style.setProperty('--agent-w', saved + 'px');
            } catch (e) { /* ignore */ }
            handle.addEventListener('mousedown', function (e) {
                e.preventDefault();
                document.body.style.cursor = 'ew-resize';
                function move(ev) {
                    var w = Math.max(280, Math.min(window.innerWidth * 0.45, window.innerWidth - ev.clientX - 8));
                    app.style.setProperty('--agent-w', w + 'px');
                    if (window.editor) window.editor.layout();
                }
                function up() {
                    document.body.style.cursor = '';
                    document.removeEventListener('mousemove', move);
                    document.removeEventListener('mouseup', up);
                    try { localStorage.setItem('agentCardWidth', String(Math.round(card.getBoundingClientRect().width))); } catch (e) { /* ignore */ }
                }
                document.addEventListener('mousemove', move);
                document.addEventListener('mouseup', up);
            });
        },

        buildPanel: function () {
            // The agent gets its own card on the right, so the problem (left) and the
            // chat (right) are visible at the same time, with the code in the middle.
            var app = document.getElementById('application');
            if (!app) return;
            var handle = document.createElement('div');
            handle.id = 'resize-agent';
            var card = document.createElement('div');
            card.id = 'agentCard';
            card.className = 'lc-card agent-card';
            card.innerHTML =
                '<div class="lc-card__header">' +
                '  <span class="lc-card__title" id="problemTabAgent">' +
                '    <svg viewBox="0 0 16 16" class="tab-icon" style="color:#a78bfa"><path fill="currentColor" d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6zM13 11l.7 1.3L15 13l-1.3.7L13 15l-.7-1.3L11 13l1.3-.7z"/></svg>Agent' +
                '  </span>' +
                '</div>';
            app.appendChild(handle);
            app.appendChild(card);
            app.classList.add('has-agent');

            var tab = card.querySelector('#problemTabAgent');
            var panel = document.createElement('div');
            panel.className = 'agent-panel';
            panel.id = 'problemPanelAgent';
            panel.innerHTML =
                '<div class="agent-head">' +
                '  <div class="agent-head__title" id="agentTitle">New Agent</div>' +
                '  <button type="button" class="agent-ibtn" id="agentNewChatBtn" title="New chat">' + SVG.plus + '</button>' +
                '  <button type="button" class="agent-ibtn" id="agentHistoryBtn" title="Chat history">' + SVG.history + '</button>' +
                '  <button type="button" class="agent-ibtn" id="agentMoreBtn" title="Skills">' + SVG.more + '</button>' +
                '</div>' +
                '<div class="agent-body" id="agentBody">' +
                '  <div class="agent-messages" id="agentMessages"></div>' +
                '  <div class="agent-dock" id="agentDock">' +
                '    <div class="agent-review" id="agentReview" hidden></div>' +
                '    <div class="agent-composer" id="agentComposer">' +
                '      <div class="agent-chips" id="agentChips"></div>' +
                '      <textarea id="agentInput" rows="1" placeholder="Plan, Build, / for skills, @ for context" aria-label="Message the agent"></textarea>' +
                '      <div class="agent-composer__row">' +
                '        <button type="button" class="agent-mode-pill" id="agentModeBtn" aria-haspopup="listbox"></button>' +
                '        <span class="agent-model" title="Model used by the agent">gpt-4.1-mini</span>' +
                '        <button type="button" class="agent-send" id="agentSendBtn" title="Send (Enter)" aria-label="Send">' + SVG.send + '</button>' +
                '      </div>' +
                '    </div>' +
                '    <div class="agent-popup" id="agentPopup" hidden role="listbox"></div>' +
                '  </div>' +
                '</div>' +
                '<div class="agent-sheet" id="agentSheet" hidden></div>';
            card.appendChild(panel);
            this.setupResize(handle, card);

            var els = this.els = {
                tab: tab, panel: panel,
                title: panel.querySelector('#agentTitle'),
                body: panel.querySelector('#agentBody'),
                messages: panel.querySelector('#agentMessages'),
                dock: panel.querySelector('#agentDock'),
                input: panel.querySelector('#agentInput'),
                chips: panel.querySelector('#agentChips'),
                send: panel.querySelector('#agentSendBtn'),
                modeBtn: panel.querySelector('#agentModeBtn'),
                review: panel.querySelector('#agentReview'),
                popup: panel.querySelector('#agentPopup'),
                sheet: panel.querySelector('#agentSheet')
            };
            var self = this;

            els.input.addEventListener('focus', function () {
                if (!self._focusLogged) { self._focusLogged = true; log('agent_panel_opened', {}); }
            });

            els.send.addEventListener('click', function () { if (self.busy) self.stop(); else self.send(); });
            els.input.addEventListener('input', function () { self.autosize(); self.updatePopup(); });
            els.input.addEventListener('keydown', function (e) { self.onKey(e); });
            els.input.addEventListener('blur', function () { setTimeout(function () { if (self.popup && self.popup.kind !== 'mode') self.closePopup(); }, 150); });
            els.modeBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                if (self.popup && self.popup.kind === 'mode') self.closePopup(); else self.openModeMenu();
            });
            panel.querySelector('#agentNewChatBtn').addEventListener('click', function () { self.newChat(); });
            panel.querySelector('#agentHistoryBtn').addEventListener('click', function (e) { e.stopPropagation(); self.openHistory(); });
            panel.querySelector('#agentMoreBtn').addEventListener('click', function () { self.openSkillsSheet(); });
            document.addEventListener('click', function (e) {
                if (!self.popup || els.popup.contains(e.target)) return;
                if (e.target !== els.input || self.popup.kind === 'mode' || self.popup.kind === 'history') self.closePopup();
            });
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && self.popup) { self.closePopup(); els.input.focus(); }
            });
            this.setMode(this.mode);
        },

        autosize: function () {
            var t = this.els.input;
            t.style.height = 'auto';
            t.style.height = Math.min(t.scrollHeight, 200) + 'px';
        },

        setMode: function (mode, byUser) {
            this.mode = mode;
            var m = modeOf(mode);
            this.els.modeBtn.innerHTML = SVG[m.icon] + '<span>' + m.label + '</span>' + SVG.chevron;
            this.els.modeBtn.title = m.hint;
            this.els.modeBtn.dataset.mode = mode;
            var c = this.chat();
            if (c) c.mode = mode;
            if (byUser) { log('agent_mode_changed', { mode: mode }); this.persist(); }
        },

        // "/" skills, "@" files, and the mode menu share one popup -------------
        updatePopup: function () {
            var t = this.els.input, pos = t.selectionStart, before = t.value.slice(0, pos);
            var m = before.match(/(^|\s)([\/@])([\w.-]*)$/);
            if (!m) { if (this.popup) this.closePopup(); return; }
            var kind = m[2] === '/' ? 'slash' : 'at', q = m[3].toLowerCase();
            var items;
            if (kind === 'slash') {
                items = this.skills.filter(function (s) { return s.name.toLowerCase().indexOf(q) >= 0; })
                    .map(function (s) { return { value: s.name, label: s.name, desc: s.source === 'instructor' ? 'Instructor skill' : 'Your skill', icon: SVG.skill }; });
                items.push({ value: '__new__', label: 'Create a skill…', desc: 'Reusable instructions for the agent', icon: SVG.plus });
            } else {
                items = WS.names().filter(function (n) { return n.toLowerCase().indexOf(q) >= 0; })
                    .map(function (n) { return { value: n, label: n, desc: 'File', icon: SVG.file }; });
            }
            this.popup = { kind: kind, items: items, index: 0, start: pos - m[3].length - 1 };
            this.renderPopup(kind === 'slash' ? 'Skills' : 'Files');
        },
        openModeMenu: function () {
            var self = this;
            this.popup = {
                kind: 'mode', index: Math.max(0, MODES.findIndex(function (m) { return m.id === self.mode; })),
                items: MODES.map(function (m) { return { value: m.id, label: m.label, desc: m.hint, icon: SVG[m.icon] }; })
            };
            this.renderPopup('Mode');
        },
        renderPopup: function (title) {
            var self = this, p = this.popup, box = this.els.popup;
            if (!p.items.length) { box.hidden = true; return; }
            box.className = 'agent-popup agent-popup--' + p.kind;
            box.innerHTML = '<div class="agent-popup__title">' + title + '</div>' + p.items.map(function (it, i) {
                return '<div class="agent-popup__item' + (i === p.index ? ' is-active' : '') + '" data-i="' + i + '" role="option">' +
                    '<span class="agent-popup__icon">' + it.icon + '</span><span class="agent-popup__label">' + esc(it.label) + '</span>' +
                    '<span class="agent-popup__desc">' + esc(it.desc) + '</span>' +
                    (p.kind === 'mode' && it.value === self.mode ? '<span class="agent-popup__check">✓</span>' : '') + '</div>';
            }).join('');
            box.hidden = false;
            box.querySelectorAll('[data-i]').forEach(function (el) {
                el.addEventListener('mousedown', function (e) { e.preventDefault(); self.pick(+el.dataset.i); });
            });
        },
        closePopup: function () { this.popup = null; this.els.popup.hidden = true; },
        pick: function (i) {
            var p = this.popup;
            if (!p) return;
            var it = p.items[i];
            this.closePopup();
            if (!it) return;
            if (p.kind === 'mode') { this.setMode(it.value, true); this.els.input.focus(); return; }
            var t = this.els.input, end = t.selectionStart;
            if (p.kind === 'slash') {
                t.value = t.value.slice(0, p.start) + t.value.slice(end);
                t.setSelectionRange(p.start, p.start);
                if (it.value === '__new__') { this.openSkillsSheet(true); return; }
                if (this.attachedSkills.indexOf(it.value) < 0) this.attachedSkills.push(it.value);
                this.renderChips();
            } else {
                var insert = '@' + it.value + ' ';
                t.value = t.value.slice(0, p.start) + insert + t.value.slice(end);
                t.setSelectionRange(p.start + insert.length, p.start + insert.length);
            }
            this.autosize();
            t.focus();
        },
        renderChips: function () {
            var self = this;
            this.els.chips.innerHTML = this.attachedSkills.map(function (n, i) {
                return '<span class="agent-chip-tag">' + SVG.skill + esc(n) + '<button type="button" data-rm="' + i + '" aria-label="Remove">×</button></span>';
            }).join('');
            this.els.chips.querySelectorAll('[data-rm]').forEach(function (b) {
                b.addEventListener('click', function () { self.attachedSkills.splice(+b.dataset.rm, 1); self.renderChips(); });
            });
        },
        onKey: function (e) {
            var p = this.popup;
            if (p && !this.els.popup.hidden) {
                if (e.key === 'ArrowDown') { e.preventDefault(); p.index = (p.index + 1) % p.items.length; this.renderPopup(this.els.popup.querySelector('.agent-popup__title').textContent); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); p.index = (p.index - 1 + p.items.length) % p.items.length; this.renderPopup(this.els.popup.querySelector('.agent-popup__title').textContent); return; }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.pick(p.index); return; }
                if (e.key === 'Escape') { e.preventDefault(); this.closePopup(); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                if (!this.busy) this.send();
            } else if (e.key === 'Backspace' && !this.els.input.value && this.attachedSkills.length) {
                this.attachedSkills.pop();
                this.renderChips();
            } else if ((e.metaKey || e.ctrlKey) && e.key === '.') {
                e.preventDefault();
                this.openModeMenu();
            }
        },

        openHistory: function () {
            var self = this;
            var items = this.chats.slice().reverse().filter(function (c) { return c.history.length || c.id === self.chatId; });
            this.popup = {
                kind: 'history', index: 0,
                items: items.map(function (c) {
                    return { value: c.id, label: c.title, desc: c.history.length ? Math.ceil(c.history.length / 2) + ' messages' : 'Empty', icon: SVG[modeOf(c.mode).icon] };
                })
            };
            this.renderPopup('Chats');
            var box = this.els.popup, me = this;
            box.querySelectorAll('[data-i]').forEach(function (el) {
                el.onmousedown = function (e) { e.preventDefault(); me.closePopup(); me.switchChat(items[+el.dataset.i].id); };
            });
        },

        openSkillsSheet: function (startNew) {
            var self = this, sheet = this.els.sheet;
            sheet.hidden = false;
            sheet.innerHTML =
                '<div class="agent-sheet__head"><span>Skills</span><button type="button" class="agent-ibtn" id="agentSheetClose" aria-label="Close">×</button></div>' +
                '<p class="agent-sheet__hint">Skills are instructions the agent follows. Enabled skills apply to every message; type <code>/</code> in the chat to attach one to a single message.</p>' +
                (this.skills.length ? '' : '<p class="agent-sheet__hint">No skills yet.</p>') +
                this.skills.map(function (s, i) {
                    return '<div class="agent-skill"><label class="agent-switch"><input type="checkbox" data-i="' + i + '"' + (s.enabled ? ' checked' : '') + '><span></span></label>' +
                        '<div class="agent-skill__main"><div class="agent-skill__name">' + esc(s.name) +
                        (s.source === 'instructor' ? ' <span class="agent-skill__tag">Instructor</span>' : '') + '</div>' +
                        '<div class="agent-skill__text">' + esc(s.instructions) + '</div></div>' +
                        (s.source === 'student' ? '<button type="button" class="agent-link" data-del="' + i + '">Delete</button>' : '') + '</div>';
                }).join('') +
                '<div class="agent-skill-new"' + (startNew ? '' : ' hidden') + ' id="agentSkillForm">' +
                '<input type="text" id="agentSkillName" maxlength="60" placeholder="Skill name, e.g. explain-simply">' +
                '<textarea id="agentSkillText" rows="4" maxlength="4000" placeholder="Instructions for the agent…"></textarea>' +
                '<div class="agent-skill-new__row"><button type="button" class="agent-btn" id="agentSkillCancel">Cancel</button>' +
                '<button type="button" class="agent-btn agent-btn--primary" id="agentSkillAdd">Add skill</button></div></div>' +
                '<button type="button" class="agent-btn" id="agentSkillShow"' + (startNew ? ' hidden' : '') + '>' + SVG.plus + ' New skill</button>';
            sheet.querySelector('#agentSheetClose').onclick = function () { sheet.hidden = true; self.els.input.focus(); };
            sheet.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
                cb.onchange = function () {
                    var s = self.skills[+cb.dataset.i];
                    s.enabled = cb.checked;
                    self.saveSkillToggles();
                    log('agent_skill_toggled', { name: s.name, source: s.source, enabled: s.enabled });
                };
            });
            sheet.querySelectorAll('[data-del]').forEach(function (b) {
                b.onclick = function () {
                    var skill = self.skills[+b.dataset.del];
                    var ask = window.UIMotion
                        ? UIMotion.confirm({ title: 'Delete this skill?', message: 'The agent will stop following it.', item: skill.name, confirmText: 'Delete skill' })
                        : Promise.resolve(window.confirm('Delete skill ' + skill.name + '?'));
                    ask.then(function (ok) {
                        if (!ok) return;
                        var row = b.closest('.agent-skill');
                        (row && window.UIMotion ? UIMotion.remove(row) : Promise.resolve()).then(function () {
                            var i = self.skills.indexOf(skill);
                            if (i < 0) return;
                            self.skills.splice(i, 1);
                            log('agent_skill_deleted', { name: skill.name });
                            self.saveStudentSkills();
                            self.saveSkillToggles();
                            self.openSkillsSheet();
                        });
                    });
                };
            });
            var form = sheet.querySelector('#agentSkillForm'), show = sheet.querySelector('#agentSkillShow');
            show.onclick = function () { form.hidden = false; show.hidden = true; sheet.querySelector('#agentSkillName').focus(); };
            sheet.querySelector('#agentSkillCancel').onclick = function () { form.hidden = true; show.hidden = false; };
            sheet.querySelector('#agentSkillAdd').onclick = function () {
                var name = sheet.querySelector('#agentSkillName').value.trim();
                var text = sheet.querySelector('#agentSkillText').value.trim();
                if (!name || !text) return;
                self.skills.push({ name: name, instructions: text, source: 'student', enabled: true });
                log('agent_skill_created', { name: name, length: text.length });
                self.saveStudentSkills();
                self.saveSkillToggles();
                self.openSkillsSheet();
            };
            if (startNew) sheet.querySelector('#agentSkillName').focus();
        },

        // Messages ---------------------------------------------------------------
        renderChat: function () {
            var c = this.chat(), self = this;
            this.els.title.textContent = c.title;
            this.els.messages.innerHTML = '';
            c.history.forEach(function (m) {
                if (m.role === 'user') self.addUser(m.content);
                else {
                    var turn = self.newTurn();
                    var div = document.createElement('div');
                    div.className = 'agent-text';
                    div.innerHTML = renderMarkdown(m.content);
                    turn.appendChild(div);
                }
            });
            this.els.body.classList.toggle('agent-body--empty', !c.history.length);
            this.scroll();
        },
        addUser: function (text) {
            this.els.body.classList.remove('agent-body--empty');
            var div = document.createElement('div');
            div.className = 'agent-user';
            div.textContent = text;
            this.els.messages.appendChild(div);
            this.scroll();
        },
        newTurn: function () {
            var turn = document.createElement('div');
            turn.className = 'agent-turn';
            this.els.messages.appendChild(turn);
            return turn;
        },
        addStep: function (turn, icon, html, cls) {
            var row = document.createElement('div');
            row.className = 'agent-step' + (cls ? ' ' + cls : '');
            row.innerHTML = '<span class="agent-step__icon">' + icon + '</span><span class="agent-step__text">' + html + '</span>';
            turn.appendChild(row);
            this.scroll();
            return row;
        },
        scroll: function () { var m = this.els.messages; m.scrollTop = m.scrollHeight; },
        stop: function () { if (this.abort) this.abort.abort(); log('agent_stopped', { mode: this.mode }); },
        setBusy: function (busy) {
            this.busy = busy;
            this.els.send.innerHTML = busy ? SVG.stop : SVG.send;
            this.els.send.title = busy ? 'Stop' : 'Send (Enter)';
            this.els.send.classList.toggle('agent-send--stop', busy);
        },

        send: async function (override) {
            var text = (override || this.els.input.value || '').trim();
            if (!text || this.busy) return;
            if (this.editor.getOption(this.monaco.editor.EditorOption.readOnly)) return;
            var chat = this.chat(), mode = this.mode, self = this;
            if (!override) { this.els.input.value = ''; this.autosize(); }
            this.closePopup();
            this.addUser(text);
            if (!chat.history.length) { chat.title = text.length > 40 ? text.slice(0, 40) + '…' : text; this.els.title.textContent = chat.title; }

            var attached = this.attachedSkills.slice();
            this.attachedSkills = [];
            this.renderChips();
            var skills = this.skills.filter(function (s) { return s.enabled || attached.indexOf(s.name) >= 0; })
                .map(function (s) { return { name: s.name, instructions: s.instructions, source: s.source }; });
            var mentions = (text.match(/@([\w.-]+)/g) || []).map(function (m) { return m.slice(1); })
                .filter(function (n) { return WS.get(n) !== null; });
            var term = document.getElementById('terminalOutput');
            var payload = {
                session_id: currentSession.sessionId,
                mode: mode,
                message: text + (mentions.length ? '\n\n(Files the student referenced: ' + mentions.join(', ') + ')' : ''),
                language: lang(),
                files: WS.list(),
                active_file: WS.activeName(),
                history: chat.history.slice(-20),
                skills: skills,
                terminal_output: term ? term.innerText.slice(-3000) : ''
            };
            log('agent_message_sent', { mode: mode, length: text.length, skills: skills.map(function (s) { return s.name; }), mentions: mentions, attached_skills: attached });

            var turn = this.newTurn();
            var textEl = null, blockText = '', answer = '', turnId = '', failed = false;
            var thinking = this.addStep(turn, '<span class="agent-spinner"></span>', '<span class="agent-shimmer">Thinking</span>', 'agent-step--thinking');
            this.setBusy(true);
            this.abort = new AbortController();

            function handle(ev) {
                if (ev.type === 'start') { turnId = ev.turn_id; return; }  // keeps "Thinking" visible
                if (thinking) { thinking.remove(); thinking = null; }
                if (ev.type === 'text') {
                    if (!textEl) {
                        textEl = document.createElement('div');
                        textEl.className = 'agent-text';
                        turn.appendChild(textEl);
                        blockText = '';
                        if (answer) answer += '\n\n';
                    }
                    blockText += ev.delta;
                    answer += ev.delta;
                    textEl.innerHTML = renderMarkdown(blockText);
                    self.scroll();
                } else if (ev.type === 'tool') {
                    textEl = null;
                    if (ev.name === 'list_files') self.addStep(turn, SVG.file, 'Listed files');
                    else if (ev.name === 'read_file') self.addStep(turn, SVG.read, 'Read <span class="agent-file">' + esc(ev.filename) + '</span>');
                } else if (ev.type === 'file') {
                    self.applyFileEvent(ev, turnId);
                    var verb = ev.action === 'delete' ? 'Deleted' : ev.action === 'create' ? 'Created' : 'Edited';
                    var row = self.addStep(turn, SVG.file, verb + ' <button type="button" class="agent-file agent-file--link">' + esc(ev.filename) + '</button>' +
                        (ev.action === 'delete' ? '' : ' <span class="agent-add">+' + ev.added + '</span> <span class="agent-del">-' + ev.removed + '</span>'));
                    var link = row.querySelector('.agent-file--link');
                    if (link) link.onclick = function () { WS.open(ev.filename); };
                } else if (ev.type === 'run') {
                    var out = ((ev.output || '') + (ev.error ? '\n' + ev.error : '')).trim();
                    var r = self.addStep(turn, SVG.run,
                        '<details><summary>Ran <span class="agent-file">' + esc(ev.filename) + '</span> <span class="' + (ev.success ? 'agent-ok' : 'agent-err') + '">' +
                        (ev.success ? 'succeeded' : 'failed') + '</span></summary><pre class="agent-code">' + esc(out || '(no output)') + '</pre></details>');
                    r.classList.add('agent-step--run');
                } else if (ev.type === 'done') {
                    turnId = ev.turn_id;
                } else if (ev.type === 'error') {
                    failed = true;
                    self.addStep(turn, '!', esc(ev.message), 'agent-step--err');
                }
            }

            try {
                var res = await fetch('/agent/chat', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload), signal: this.abort.signal
                });
                if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
                var reader = res.body.getReader(), decoder = new TextDecoder(), buf = '';
                while (true) {
                    var chunk = await reader.read();
                    if (chunk.done) break;
                    buf += decoder.decode(chunk.value, { stream: true });
                    var parts = buf.split('\n\n');
                    buf = parts.pop();
                    parts.forEach(function (p) {
                        if (p.indexOf('data: ') === 0) { try { handle(JSON.parse(p.slice(6))); } catch (e) { console.warn('agent event', e); } }
                    });
                }
            } catch (e) {
                if (thinking) { thinking.remove(); thinking = null; }
                if (e.name === 'AbortError') self.addStep(turn, SVG.stop, 'Stopped', 'agent-step--muted');
                else { failed = true; self.addStep(turn, '!', 'Could not reach the agent. Please try again.', 'agent-step--err'); }
            }
            if (thinking) thinking.remove();
            this.setBusy(false);
            this.abort = null;

            chat.history.push({ role: 'user', content: text });
            if (answer) chat.history.push({ role: 'assistant', content: answer });
            this.persist();
            if (turnId) this.respondedAt[turnId] = Date.now();
            log('agent_response_received', { mode: mode, turn_id: turnId, length: answer.length, failed: failed });

            if (mode === 'plan' && answer && !failed) {
                var build = document.createElement('button');
                build.type = 'button';
                build.className = 'agent-btn agent-btn--primary agent-build';
                build.innerHTML = SVG.agent + ' Build this plan';
                build.addEventListener('click', function () {
                    build.remove();
                    log('agent_plan_build', { turn_id: turnId });
                    self.setMode('agent', true);
                    self.send('Implement the plan above.');
                });
                turn.appendChild(build);
                this.scroll();
            }
        },

        // Edits: applied immediately, reviewed with Keep / Undo ------------------
        applyFileEvent: function (ev, turnId) {
            var name = ev.filename;
            if (!(name in this.pending)) this.pending[name] = { baseline: WS.get(name), turn_id: turnId };
            if (ev.action === 'delete') {
                WS.remove(name, { source: 'agent' });
            } else {
                WS.set(name, ev.content, { source: 'agent' });
                WS.open(name);
            }
            log('agent_file_change', { filename: name, action: ev.action, added: ev.added || 0, removed: ev.removed || 0 });
            this.syncBadges();
            this.renderReview();
            this.refreshDecorations();
        },
        syncBadges: function () {
            var self = this;
            Object.keys(WS.badges).forEach(function (n) { if (!self.pending[n]) delete WS.badges[n]; });
            Object.keys(this.pending).forEach(function (n) {
                WS.badges[n] = '<span class="agent-tree-dot" title="Changed by the agent — review in the Agent panel">' +
                    (self.pending[n].baseline === null ? 'U' : 'M') + '</span>';
            });
            WS.render();
        },
        renderReview: function () {
            var self = this, names = Object.keys(this.pending), box = this.els.review;
            box.hidden = !names.length;
            if (!names.length) { box.innerHTML = ''; return; }
            var rows = names.map(function (n) {
                var cur = WS.get(n), p = self.pending[n];
                var counts = cur === null ? null : lineCounts(p.baseline, cur);
                return '<div class="agent-review__row">' +
                    '<button type="button" class="agent-review__file" data-open="' + esc(n) + '">' + SVG.file + '<span>' + esc(n) + '</span></button>' +
                    (cur === null ? '<span class="agent-del">deleted</span>' : '<span class="agent-add">+' + counts.added + '</span><span class="agent-del">-' + counts.removed + '</span>') +
                    '<button type="button" class="agent-link" data-undo="' + esc(n) + '">Undo</button>' +
                    '<button type="button" class="agent-link agent-link--keep" data-keep="' + esc(n) + '">Keep</button></div>';
            }).join('');
            box.innerHTML =
                '<div class="agent-review__head"><button type="button" class="agent-review__toggle" data-toggle="1">' +
                '<span class="agent-review__chev' + (this.reviewOpen ? ' is-open' : '') + '">' + SVG.chevron + '</span>' +
                names.length + ' File' + (names.length > 1 ? 's' : '') + '</button>' +
                '<span class="agent-review__actions"><button type="button" class="agent-btn" data-all="undo">Undo All</button>' +
                '<button type="button" class="agent-btn agent-btn--primary" data-all="keep">Keep All</button></span></div>' +
                (this.reviewOpen ? '<div class="agent-review__list">' + rows + '</div>' : '');
            box.querySelector('[data-toggle]').onclick = function () { self.reviewOpen = !self.reviewOpen; self.renderReview(); };
            box.querySelectorAll('[data-open]').forEach(function (b) { b.onclick = function () { WS.open(b.dataset.open); }; });
            box.querySelectorAll('[data-undo]').forEach(function (b) { b.onclick = function () { self.decide(b.dataset.undo, 'undo'); }; });
            box.querySelectorAll('[data-keep]').forEach(function (b) { b.onclick = function () { self.decide(b.dataset.keep, 'keep'); }; });
            box.querySelectorAll('[data-all]').forEach(function (b) {
                b.onclick = function () { Object.keys(self.pending).forEach(function (n) { self.decide(n, b.dataset.all); }); };
            });
        },
        decide: function (name, decision) {
            var p = this.pending[name];
            if (!p) return;
            delete this.pending[name];
            if (decision === 'undo') {
                if (p.baseline === null) WS.remove(name, { source: 'agent_undo' });
                else WS.set(name, p.baseline, { source: 'agent_undo' });
            }
            var doneAt = this.respondedAt[p.turn_id];
            log('agent_edit_decision', { filename: name, decision: decision, turn_id: p.turn_id,
                time_to_decision_ms: doneAt ? Math.max(0, Date.now() - doneAt) : null });
            this.syncBadges();
            this.renderReview();
            this.refreshDecorations();
        },
        refreshDecorations: function () {
            if (!this.monaco) return;
            var self = this, monaco = this.monaco;
            WS.files.forEach(function (f) {
                var p = self.pending[f.name];
                var lines = !p ? [] : p.baseline === null
                    ? f.model.getValue().split('\n').map(function (_, i) { return i + 1; })
                    : changedLines(p.baseline, f.model.getValue());
                self.decorations[f.name] = f.model.deltaDecorations(self.decorations[f.name] || [], lines.map(function (ln) {
                    return { range: new monaco.Range(ln, 1, ln, 1), options: { isWholeLine: true, className: 'agent-line-added', linesDecorationsClassName: 'agent-line-gutter' } };
                }));
            });
        }
    };

    var STYLES = [
        '.agent-panel{display:flex;flex-direction:column;padding:0!important;min-height:0;height:100%;position:relative;font-family:var(--font-ui-sans);}',
        '.agent-panel[hidden]{display:none!important;}',
        '.agent-head{display:flex;align-items:center;gap:2px;height:36px;padding:0 6px 0 12px;border-bottom:1px solid var(--ide-border,#2b2b2b);flex-shrink:0;}',
        '.agent-head__title{flex:1;min-width:0;font:var(--fw-medium) var(--fs-md)/1.4 var(--ui-font);color:var(--ui-text-strong);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.agent-ibtn{width:24px;height:24px;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--ui-text);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;transition:background-color var(--dur-fast) var(--ease-out);}',
        '.agent-ibtn svg{width:16px;height:16px;}',
        '.agent-ibtn:hover{background:#2a2d2e;}',
        '.agent-body{flex:1;min-height:0;display:flex;flex-direction:column;}',
        '.agent-body--empty{flex-direction:column-reverse;justify-content:flex-end;}',
        '.agent-messages{flex:1;min-height:0;overflow-y:auto;padding:12px 12px 4px;display:flex;flex-direction:column;gap:10px;}',
        '.agent-body--empty .agent-messages{display:none;}',
        '.agent-dock{position:relative;padding:8px 10px 10px;flex-shrink:0;}',
        '.agent-body--empty .agent-dock{padding-top:12px;}',
        '.agent-composer{background:var(--ui-surface);border:1px solid var(--ui-border-strong);border-radius:var(--radius-xl);padding:8px 8px 6px 10px;transition:border-color var(--dur) var(--ease-out),box-shadow var(--dur) var(--ease-out);}',
        '.agent-composer:focus-within{border-color:#5a5a5a;box-shadow:0 0 0 3px rgba(255,255,255,.03);}',
        '.agent-composer textarea{display:block;width:100%;min-height:22px;max-height:200px;resize:none;border:0;outline:none;background:transparent;color:#e7e7e7;font:13px/1.5 var(--font-ui-sans);padding:2px 0 6px;}',
        '.agent-body--empty .agent-composer textarea{min-height:88px;}',
        '.agent-composer textarea::placeholder{color:#6f6f6f;}',
        '.agent-composer__row{display:flex;align-items:center;gap:6px;}',
        '.agent-mode-pill{display:inline-flex;align-items:center;gap:4px;height:var(--h-btn-sm);padding:0 6px 0 8px;border:0;border-radius:999px;background:#2b2b2b;color:var(--ui-text);font:var(--fw-medium) var(--fs-sm)/1 var(--ui-font);cursor:pointer;transition:background-color var(--dur-fast) var(--ease-out),color var(--dur) var(--ease-out);}',
        '.agent-mode-pill:hover{background:#353535;}',
        '.agent-mode-pill svg{width:13px;height:13px;}',
        '.agent-mode-pill[data-mode=plan]{color:#e5c07b;}',
        '.agent-mode-pill[data-mode=debug]{color:#e06c75;}',
        '.agent-mode-pill[data-mode=ask]{color:#61afef;}',
        '.agent-model{font:var(--fs-sm)/1 var(--ui-font);color:var(--ui-text-muted);margin-right:auto;}',
        '.agent-send{width:var(--h-btn);height:var(--h-btn);border:0;border-radius:50%;background:var(--ui-text-strong);color:var(--ui-bg);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:background-color var(--dur-fast) var(--ease-out),transform var(--dur-fast) var(--ease-out);}',
        '.agent-send svg{width:15px;height:15px;}',
        '.agent-send:hover{background:#fff;}','.agent-send:active{transform:scale(.92);}',
        '.agent-send--stop{background:#3c3c3c;color:#e7e7e7;}',
        '.agent-chips{display:flex;flex-wrap:wrap;gap:4px;}',
        '.agent-chips:not(:empty){margin-bottom:6px;}',
        '.agent-chip-tag{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 4px 0 6px;border:1px solid #3c3c3c;border-radius:5px;background:#252526;color:#cccccc;font-size:12px;}',
        '.agent-chip-tag svg{width:11px;height:11px;color:#e5c07b;}',
        '.agent-chip-tag button{border:0;background:none;color:#8b8b8b;cursor:pointer;font-size:13px;padding:0 2px;}',
        '.agent-popup{position:absolute;left:10px;right:10px;bottom:calc(100% - 6px);max-height:260px;overflow-y:auto;background:var(--ui-raised);border:1px solid var(--ui-border-strong);border-radius:var(--radius-lg);box-shadow:var(--shadow-pop);padding:4px;z-index:20;animation:ui-pop-in var(--dur-fast) var(--ease-out);transform-origin:bottom center;}',
        '.agent-body--empty .agent-popup{bottom:auto;top:calc(100% - 4px);animation-name:ui-pop-in-down;transform-origin:top center;}',
        '.agent-popup__title{font:var(--fs-xs)/1 var(--ui-font);color:var(--ui-text-muted);padding:6px 8px 4px;}',
        '.agent-popup__item{display:flex;align-items:center;gap:8px;height:28px;padding:0 8px;border-radius:var(--radius-sm);cursor:pointer;font:var(--fs-md)/1 var(--ui-font);color:var(--ui-text);transition:background-color 80ms linear;}',
        '.agent-popup__item.is-active,.agent-popup__item:hover{background:#04395e;color:#fff;}',
        '.agent-popup__icon{width:14px;height:14px;display:inline-flex;flex-shrink:0;}',
        '.agent-popup__icon svg{width:14px;height:14px;}',
        '.agent-popup__label{white-space:nowrap;}',
        '.agent-popup__desc{color:var(--ui-text-muted);font-size:var(--fs-sm);margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.agent-popup__item.is-active .agent-popup__desc{color:#c5c5c5;}',
        '.agent-popup__check{color:#cccccc;margin-left:4px;}',
        '.agent-user{background:var(--ui-raised);border:1px solid #333;border-radius:var(--radius-lg);padding:8px 10px;color:var(--ui-text-strong);font:var(--fs-md)/1.5 var(--ui-font);white-space:pre-wrap;word-wrap:break-word;animation:ui-rise-in var(--dur) var(--ease-out) both;}',
        '.agent-turn{display:flex;flex-direction:column;gap:6px;padding:0 2px;}','.agent-turn>*{animation:ui-rise-in var(--dur) var(--ease-out) both;}',
        '.agent-text{font:var(--fs-md)/1.6 var(--ui-font);color:var(--ui-text);white-space:pre-wrap;word-wrap:break-word;}',
        '.agent-text code{background:#2b2b2b;border-radius:4px;padding:1px 4px;font-family:var(--font-code-mono);font-size:12px;color:#e7e7e7;}',
        '.agent-code{background:#181818;border:1px solid #2b2b2b;border-radius:6px;padding:8px 10px;overflow-x:auto;white-space:pre;font:12px/1.5 var(--font-code-mono);color:#d4d4d4;margin:4px 0;}',
        '.agent-code code{background:none;padding:0;}',
        '.agent-h{font-weight:600;color:#e7e7e7;margin-top:6px;}',
        '.agent-li{display:flex;gap:6px;padding-left:4px;}',
        '.agent-li>span:first-child{color:#8b8b8b;flex-shrink:0;}',
        '.agent-step{display:flex;align-items:flex-start;gap:7px;font:var(--fs-sm)/1.5 var(--ui-font);color:#9d9d9d;}',
        '.agent-step__icon{width:14px;height:14px;margin-top:2px;flex-shrink:0;display:inline-flex;color:#8b8b8b;}',
        '.agent-step__icon svg{width:14px;height:14px;}',
        '.agent-step__text{min-width:0;flex:1;}',
        '.agent-step details summary{cursor:pointer;list-style:none;}',
        '.agent-step details summary::-webkit-details-marker{display:none;}',
        '.agent-step--err{color:#f48771;}',
        '.agent-step--muted{color:#6f6f6f;}',
        '.agent-file{color:#cccccc;font-family:var(--font-code-mono);font-size:12px;}',
        '.agent-file--link{background:none;border:0;padding:0;cursor:pointer;text-decoration:underline;text-decoration-color:#555;text-underline-offset:2px;}',
        '.agent-file--link:hover{color:#fff;}',
        '.agent-ok{color:#89d185;}.agent-err{color:#f48771;}',
        '.agent-add{color:#89d185;font-family:var(--font-code-mono);font-size:12px;}',
        '.agent-del{color:#f48771;font-family:var(--font-code-mono);font-size:12px;}',
        '.agent-spinner{display:inline-block;width:11px;height:11px;border:1.5px solid #555;border-top-color:#cccccc;border-radius:50%;animation:agentspin .8s linear infinite;}',
        '@keyframes agentspin{to{transform:rotate(360deg);}}',
        '.agent-shimmer{background:linear-gradient(90deg,#6f6f6f 0%,#e7e7e7 50%,#6f6f6f 100%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:agentshim 1.6s linear infinite;}',
        '@keyframes agentshim{from{background-position:200% 0;}to{background-position:-200% 0;}}',
        '.agent-btn{display:inline-flex;align-items:center;gap:5px;height:var(--h-btn);padding:0 12px;border:1px solid var(--ui-border-strong);border-radius:var(--radius);background:transparent;color:var(--ui-text);font:var(--fw-medium) var(--fs-sm)/1 var(--ui-font);cursor:pointer;transition:background-color var(--dur-fast) var(--ease-out),transform var(--dur-fast) var(--ease-out);}','.agent-btn:active{transform:scale(.97);}',
        '.agent-btn svg{width:13px;height:13px;}',
        '.agent-btn:hover{background:#2a2d2e;}',
        '.agent-btn--primary{background:var(--ui-accent);border-color:transparent;color:#fff;}',
        '.agent-btn--primary:hover{background:var(--ui-accent-hover);}',
        '.agent-build{align-self:flex-start;margin-top:4px;}',
        '.agent-link{background:none;border:0;color:var(--ui-text-muted);cursor:pointer;font:var(--fs-sm)/1 var(--ui-font);padding:4px 6px;border-radius:var(--radius-sm);transition:background-color var(--dur-fast),color var(--dur-fast);}',
        '.agent-link:hover{color:#e7e7e7;background:#2a2d2e;}',
        '.agent-link--keep{color:#cccccc;}',
        '.agent-review{border:1px solid var(--ui-border-strong);border-bottom:0;border-radius:var(--radius-lg) var(--radius-lg) 0 0;margin:0 8px;background:#1c1c1c;padding:4px 6px;font:var(--fs-sm)/1.4 var(--ui-font);color:var(--ui-text);animation:ui-rise-in var(--dur) var(--ease-out);}',
        '.agent-review+.agent-composer{border-top-left-radius:12px;border-top-right-radius:12px;}',
        '.agent-review__head{display:flex;align-items:center;justify-content:space-between;gap:6px;}',
        '.agent-review__toggle{display:inline-flex;align-items:center;gap:4px;border:0;background:none;color:#cccccc;font:12px var(--font-ui-sans);cursor:pointer;padding:2px;}',
        '.agent-review__chev{display:inline-flex;transform:rotate(-90deg);transition:transform .15s;}',
        '.agent-review__chev.is-open{transform:none;}',
        '.agent-review__chev svg{width:12px;height:12px;}',
        '.agent-review__actions{display:flex;gap:4px;}',
        '.agent-review__actions .agent-btn{height:var(--h-btn-sm);padding:0 8px;}',
        '.agent-review__list{margin-top:4px;border-top:1px solid var(--ui-border);padding-top:2px;animation:ui-fade-in var(--dur) var(--ease-out);}',
        '.agent-review__row{display:flex;align-items:center;gap:6px;padding:2px 0;}',
        '.agent-review__file{display:inline-flex;align-items:center;gap:5px;border:0;background:none;color:#cccccc;cursor:pointer;font:12px var(--font-code-mono);margin-right:auto;padding:2px;min-width:0;}',
        '.agent-review__file svg{width:13px;height:13px;flex-shrink:0;color:#8b8b8b;}',
        '.agent-review__file span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.agent-review__file:hover{color:#fff;}',
        '.agent-sheet{position:absolute;inset:36px 0 0 0;background:var(--ui-bg);z-index:30;overflow-y:auto;padding:0 12px 12px;animation:ui-rise-in var(--dur) var(--ease-out);}',
        '.agent-sheet__head{display:flex;align-items:center;justify-content:space-between;height:36px;font:var(--fw-semibold) var(--fs-md)/1 var(--ui-font);color:var(--ui-text-strong);}',
        '.agent-sheet__hint{font:var(--fs-sm)/1.5 var(--ui-font);color:var(--ui-text-muted);margin:0 0 10px;}',
        '.agent-sheet__hint code{background:#2b2b2b;padding:0 4px;border-radius:3px;}',
        '.agent-skill{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid #2b2b2b;}',
        '.agent-skill__main{flex:1;min-width:0;}',
        '.agent-skill__name{font:var(--fw-medium) var(--fs-md)/1.4 var(--ui-font);color:var(--ui-text-strong);}',
        '.agent-skill__tag{font-size:10px;color:#8b8b8b;border:1px solid #3c3c3c;border-radius:4px;padding:0 4px;margin-left:4px;}',
        '.agent-skill__text{font:var(--fs-sm)/1.5 var(--ui-font);color:var(--ui-text-muted);white-space:pre-wrap;margin-top:2px;}',
        '.agent-switch{position:relative;width:28px;height:16px;flex-shrink:0;margin-top:2px;}',
        '.agent-switch input{opacity:0;width:0;height:0;position:absolute;}',
        '.agent-switch span{position:absolute;inset:0;background:#3c3c3c;border-radius:16px;cursor:pointer;transition:background .15s;}',
        '.agent-switch span::after{content:"";position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:#cccccc;transition:transform .15s;}',
        '.agent-switch input:checked+span{background:var(--ui-accent);}',
        '.agent-switch input:checked+span::after{transform:translateX(12px);background:#fff;}',
        '.agent-skill-new{display:flex;flex-direction:column;gap:6px;margin:10px 0;}',
        '.agent-skill-new input,.agent-skill-new textarea{width:100%;box-sizing:border-box;background:#1f1f1f;border:1px solid #3c3c3c;color:#e7e7e7;border-radius:6px;padding:6px 8px;font:13px var(--font-ui-sans);outline:none;}',
        '.agent-skill-new input:focus,.agent-skill-new textarea:focus{border-color:#0078d4;}',
        '.agent-skill-new__row{display:flex;justify-content:flex-end;gap:6px;}',
        '.agent-line-added{background:rgba(137,209,133,.10);transition:background-color var(--dur-slow);}',
        '.agent-line-gutter{background:#89d185;width:3px!important;margin-left:3px;}'
    ].join('\n');

    window.AIModes = {
        // The agent lives in its own right-hand card, so the Problem tab stays as index.html set it.
        onProblemTabsReady: function () {},
        init: function (monaco, editor) {
            var condition = Number(currentSession.condition);
            var historyTab = document.getElementById('problemTabAiHistory');
            if (historyTab) historyTab.style.display = 'none'; // legacy interpretation history is retired

            if (condition === CONDITION.SUGGESTION) {
                initGhostText(monaco, editor);
            } else if (condition === CONDITION.AGENT) {
                var style = document.createElement('style');
                style.textContent = STYLES;
                document.head.appendChild(style);
                Agent.init(monaco, editor);
            }
        }
    };
})();
