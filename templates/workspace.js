// Multi-file workspace for the IDE (all conditions), included by index.html.
// One Monaco model per file, an Explorer (create / rename / delete), editor tabs, and
// persistence (localStorage on every change + the server's editor checkpoint).
// Relies on globals from index.html: currentSession, logActivity.
(function () {
    'use strict';

    var MAX_FILES = 20;
    var NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
    var EXTRA_EXT = ['txt', 'md', 'csv', 'json'];
    var LANG_EXT = { python: ['py'], c: ['c', 'h'], cpp: ['cpp', 'hpp', 'h', 'cc'], java: ['java'], javascript: ['js'] };
    var MONACO_LANG = { py: 'python', c: 'c', h: 'cpp', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', java: 'java',
                        js: 'javascript', json: 'json', md: 'markdown' };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function lang() { return currentSession.programmingLanguage || 'python'; }
    function ext(name) { var i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; }
    function log(type, d) { try { logActivity(type, d || {}); } catch (e) { /* ignore */ } }

    var ICONS = {
        py: '<svg viewBox="0 0 16 16" class="ws-icon" style="color:#4b8bbe"><path fill="currentColor" d="M7.9 1C4.3 1 4.5 2.6 4.5 2.6v1.6h3.5v.5H3.1S1 4.4 1 8c0 3.6 1.8 3.5 1.8 3.5h1.1V9.8s-.1-1.8 1.8-1.8h3.4s1.7 0 1.7-1.7V2.8S11 1 7.9 1zM6 2.1a.6.6 0 110 1.2.6.6 0 010-1.2z"/><path fill="#ffd43b" d="M8.1 15c3.6 0 3.4-1.6 3.4-1.6v-1.6H8v-.5h4.9S15 11.6 15 8c0-3.6-1.8-3.5-1.8-3.5h-1.1v1.7s.1 1.8-1.8 1.8H6.9S5.2 8 5.2 9.7v3.5S5 15 8.1 15zm1.9-1.1a.6.6 0 110-1.2.6.6 0 010 1.2z"/></svg>',
        c: '<span class="ws-icon ws-icon--text" style="color:#659ad2">C</span>',
        h: '<span class="ws-icon ws-icon--text" style="color:#a074c4">h</span>',
        cpp: '<span class="ws-icon ws-icon--text" style="color:#f34b7d">C++</span>',
        cc: '<span class="ws-icon ws-icon--text" style="color:#f34b7d">C++</span>',
        hpp: '<span class="ws-icon ws-icon--text" style="color:#a074c4">h</span>',
        java: '<span class="ws-icon ws-icon--text" style="color:#ea8a2e">J</span>',
        js: '<span class="ws-icon ws-icon--text" style="color:#e8d44d">JS</span>',
        json: '<span class="ws-icon ws-icon--text" style="color:#cbcb41">{}</span>',
        md: '<span class="ws-icon ws-icon--text" style="color:#519aba">M↓</span>',
        _: '<svg viewBox="0 0 16 16" class="ws-icon" style="color:#9d9d9d"><path fill="currentColor" d="M10 1H3.5C2.7 1 2 1.7 2 2.5v11c0 .8.7 1.5 1.5 1.5h9c.8 0 1.5-.7 1.5-1.5V5l-4-4zm0 1.4L12.6 5H10V2.4zM12.5 14h-9a.5.5 0 01-.5-.5v-11a.5.5 0 01.5-.5H9v4h4v7.5a.5.5 0 01-.5.5z"/></svg>'
    };
    function icon(name) { return ICONS[ext(name)] || ICONS._; }

    var WS = {
        monaco: null,
        editor: null,
        files: [],          // [{name, model}]
        tabs: [],           // open tab names, in order
        active: '',
        badges: {},         // name -> html shown after the file name (e.g. agent changes)
        listeners: [],      // fn(event) on create / rename / delete / open
        _saveTimer: null,

        // ── Model ────────────────────────────────────────────────────────
        allowedExt: function () { return (LANG_EXT[lang()] || []).concat(EXTRA_EXT); },
        defaultName: function () { return (lang() === 'java' ? 'Main.' : 'main.') + (LANG_EXT[lang()] || ['txt'])[0]; },
        find: function (name) { return this.files.find(function (f) { return f.name === name; }) || null; },
        names: function () { return this.files.map(function (f) { return f.name; }); },
        list: function () {
            return this.files.map(function (f) { return { filename: f.name, content: f.model.getValue() }; });
        },
        get: function (name) { var f = this.find(name); return f ? f.model.getValue() : null; },
        activeName: function () { return this.active; },
        storageKey: function () {
            return 'ide_files_' + currentSession.sessionId + '_' + (currentSession.currentProblemIndex || 0);
        },

        validateName: function (name, except) {
            name = String(name || '').trim();
            if (!name) return 'Enter a file name.';
            if (!NAME_RE.test(name)) return 'Use letters, numbers, "_", "-" and "." only (no folders or spaces).';
            if (this.allowedExt().indexOf(ext(name)) < 0) return 'Allowed file types: ' + this.allowedExt().map(function (e) { return '.' + e; }).join(', ');
            if (name !== except && this.find(name)) return 'A file named ' + name + ' already exists.';
            return '';
        },

        _addModel: function (name, content) {
            this._seq = (this._seq || 0) + 1;
            var uri = this.monaco.Uri.parse('file:///project/' + this._seq + '/' + name);
            var model = this.monaco.editor.createModel(content, MONACO_LANG[ext(name)] || 'plaintext', uri);
            var self = this;
            model.onDidChangeContent(function () { self.scheduleSave(); });
            this.files.push({ name: name, model: model });
            return model;
        },

        create: function (name, content, opts) {
            opts = opts || {};
            if (this.find(name)) return false;
            if (this.files.length >= MAX_FILES) return false;
            this._addModel(name, content || '');
            if (opts.open !== false) this.open(name);
            this.render();
            this.scheduleSave();
            this.emit({ type: 'create', name: name, source: opts.source || 'student' });
            return true;
        },

        // Replace a file's text as one undoable edit (creates the file if needed).
        set: function (name, content, opts) {
            var f = this.find(name);
            if (!f) return this.create(name, content, opts);
            if (f.model.getValue() === content) return true;
            f.model.pushStackElement();
            f.model.pushEditOperations([], [{ range: f.model.getFullModelRange(), text: content }], function () { return null; });
            f.model.pushStackElement();
            return true;
        },

        rename: function (from, to) {
            var f = this.find(from);
            if (!f || this.validateName(to, from)) return false;
            f.name = to;
            var lang = MONACO_LANG[ext(to)] || 'plaintext';
            if (f.model.getLanguageId() !== lang) this.monaco.editor.setModelLanguage(f.model, lang);
            var t = this.tabs.indexOf(from);
            if (t >= 0) this.tabs[t] = to;
            if (this.active === from) this.active = to;
            if (this.badges[from]) { this.badges[to] = this.badges[from]; delete this.badges[from]; }
            this.render();
            this.scheduleSave();
            this.emit({ type: 'rename', name: to, from: from });
            return true;
        },

        remove: function (name, opts) {
            var f = this.find(name);
            if (!f || this.files.length === 1) return false;
            this.files.splice(this.files.indexOf(f), 1);
            var t = this.tabs.indexOf(name);
            if (t >= 0) this.tabs.splice(t, 1);
            delete this.badges[name];
            if (this.active === name) {
                var next = this.tabs[Math.max(0, t - 1)] || this.files[0].name;
                this.open(next);
            }
            f.model.dispose();
            this.render();
            this.scheduleSave();
            this.emit({ type: 'delete', name: name, source: (opts && opts.source) || 'student' });
            return true;
        },

        open: function (name) {
            var f = this.find(name);
            if (!f) return false;
            if (this.tabs.indexOf(name) < 0) this.tabs.push(name);
            if (this.active !== name) {
                this.active = name;
                this.editor.setModel(f.model);
                this.emit({ type: 'open', name: name });
            }
            this.render();
            this.editor.focus();
            return true;
        },

        closeTab: function (name) {
            var t = this.tabs.indexOf(name);
            if (t < 0 || this.tabs.length === 1) return;
            this.tabs.splice(t, 1);
            if (this.active === name) this.open(this.tabs[Math.max(0, t - 1)]);
            this.render();
        },

        emit: function (ev) {
            this.listeners.forEach(function (fn) { try { fn(ev); } catch (e) { console.warn(e); } });
        },

        // ── Persistence ──────────────────────────────────────────────────
        scheduleSave: function () {
            var self = this;
            clearTimeout(this._saveTimer);
            if (window.updateAutosaveIndicator) updateAutosaveIndicator('saving');
            if (window.noteAutosaveOnce && this._ready) noteAutosaveOnce();
            this._saveTimer = setTimeout(function () { self.saveLocal(); }, 800);
        },
        saveLocal: function () {
            try {
                localStorage.setItem(this.storageKey(), JSON.stringify({
                    files: this.list(), active: this.active, tabs: this.tabs, saved_at: Date.now()
                }));
                if (window.updateAutosaveIndicator) updateAutosaveIndicator('saved');
            } catch (e) {
                if (window.updateAutosaveIndicator) updateAutosaveIndicator('error', 'Could not save in this browser');
            }
        },
        loadLocal: function () {
            try { return JSON.parse(localStorage.getItem(this.storageKey()) || 'null'); } catch (e) { return null; }
        },

        // ── Setup ────────────────────────────────────────────────────────
        init: function (monaco, editor, initialCode) {
            this.monaco = monaco;
            this.editor = editor;
            var initialModel = editor.getModel();
            monaco.editor.defineTheme('ide-dark', {
                base: 'vs-dark', inherit: true, rules: [],
                colors: {
                    'editor.background': '#262626',
                    'editor.lineHighlightBackground': '#ffffff0a',
                    'editor.lineHighlightBorder': '#00000000',
                    'editorLineNumber.foreground': '#6e7681',
                    'editorLineNumber.activeForeground': '#cccccc',
                    'editorGutter.background': '#262626',
                    'editorWidget.background': '#303030',
                    'editorWidget.border': '#ffffff29',
                    'editorInlayHint.foreground': '#8b8b8b',
                    'editorGhostText.foreground': '#8b8b8b',
                    'minimap.background': '#262626'
                }
            });
            monaco.editor.setTheme('ide-dark');

            var saved = this.loadLocal();
            var server = currentSession.editorDraftFiles;
            var starter = currentSession.starterFiles;
            var files, active, tabs;
            if (saved && Array.isArray(saved.files) && saved.files.length) {
                files = saved.files; active = saved.active; tabs = saved.tabs;
            } else if (Array.isArray(server) && server.length) {
                files = server; active = currentSession.editorDraftActiveFile;
            } else if (Array.isArray(starter) && starter.length) {
                files = starter.map(function (f) { return { filename: f.filename, content: f.content || '' }; });
                // A resumed single-file draft or starter code goes into the first file.
                if (initialCode && !files.some(function (f) { return f.content; })) files[0].content = initialCode;
                else if (currentSession.editorDraftCode) files[0].content = currentSession.editorDraftCode;
            } else {
                files = [{ filename: this.defaultName(), content: initialCode || '' }];
            }

            var self = this;
            files.forEach(function (f) {
                var name = String(f.filename || '').trim();
                if (name && !self.find(name)) self._addModel(name, f.content || '');
            });
            if (!this.files.length) this._addModel(this.defaultName(), initialCode || '');
            this.tabs = (tabs || []).filter(function (n) { return self.find(n); });
            active = this.find(active) ? active : this.files[0].name;
            this.open(active);
            if (initialModel && initialModel !== editor.getModel()) initialModel.dispose();

            this.buildExplorer();
            this.render();
            this.saveLocal();
            this._ready = true;
        },

        // ── Explorer + tabs UI ───────────────────────────────────────────
        buildExplorer: function () {
            var header = document.querySelector('#fileTreeSidebar .file-tree__header');
            if (header && !document.getElementById('wsNewFileBtn')) {
                var actions = document.createElement('div');
                actions.className = 'ws-explorer-actions';
                actions.innerHTML =
                    '<button type="button" class="ws-icon-btn" id="wsNewFileBtn" title="New File…">' +
                    '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M9.5 1.1l3.4 3.5.1.4v2h-1V6H8V2H3v11h4v1H2.5l-.5-.5v-12l.5-.5h6.7l.3.1zM9 2v3h2.9L9 2zm4 14h-1v-3H9v-1h3V9h1v3h3v1h-3v3z"/></svg></button>';
                header.appendChild(actions);
                var self = this;
                actions.querySelector('#wsNewFileBtn').addEventListener('click', function (e) {
                    e.stopPropagation();
                    self.promptName('', function (name) {
                        if (self.create(name, '')) log('file_created', { filename: name, file_count: self.files.length });
                    });
                });
            }
            var list = document.getElementById('fileTreeList');
            if (list && !list._wsBound) {
                list._wsBound = true;
                var me = this;
                list.addEventListener('contextmenu', function (e) {
                    var li = e.target.closest('[data-file]');
                    if (!li) return;
                    e.preventDefault();
                    me.showMenu(li.dataset.file, e.clientX, e.clientY);
                });
                document.addEventListener('click', function () { me.hideMenu(); });
                document.addEventListener('keydown', function (e) { if (e.key === 'Escape') me.hideMenu(); });
            }
        },

        // Inline name input inside the Explorer (new file / rename), like VS Code.
        promptName: function (current, done) {
            var list = document.getElementById('fileTreeList');
            if (!list) return;
            var self = this;
            var li = document.createElement('li');
            li.className = 'file-tree__item ws-rename';
            li.innerHTML = icon(current || this.defaultName()) + '<input type="text" spellcheck="false" autocomplete="off">' +
                '<div class="ws-name-error" hidden></div>';
            var input = li.querySelector('input');
            var err = li.querySelector('.ws-name-error');
            input.value = current;
            if (current) {
                var existing = list.querySelector('[data-file="' + CSS.escape(current) + '"]');
                if (existing) existing.replaceWith(li); else list.appendChild(li);
            } else {
                list.appendChild(li);
            }
            input.focus();
            if (current) input.setSelectionRange(0, current.lastIndexOf('.') > 0 ? current.lastIndexOf('.') : current.length);
            var finished = false;
            function finish(commit) {
                if (finished) return;
                var name = input.value.trim();
                if (commit && name && name !== current) {
                    if (!/\.[A-Za-z0-9]+$/.test(name)) name += '.' + (LANG_EXT[lang()] || ['txt'])[0];
                    var problem = self.validateName(name, current);
                    if (problem) { err.textContent = problem; err.hidden = false; input.focus(); return; }
                    finished = true;
                    li.remove();
                    done(name);
                } else {
                    finished = true;
                    li.remove();
                }
                self.render();
            }
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); finish(true); }
                else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
                else { err.hidden = true; }
            });
            input.addEventListener('blur', function () { setTimeout(function () { finish(true); }, 120); });
        },

        showMenu: function (name, x, y) {
            this.hideMenu();
            var self = this;
            var menu = document.createElement('div');
            menu.className = 'ws-menu';
            menu.id = 'wsMenu';
            menu.innerHTML =
                '<button type="button" data-act="open">Open</button>' +
                '<button type="button" data-act="rename">Rename…<span>F2</span></button>' +
                '<button type="button" data-act="delete"' + (this.files.length === 1 ? ' disabled' : '') + '>Delete</button>';
            menu.style.left = x + 'px';
            menu.style.top = y + 'px';
            document.body.appendChild(menu);
            menu.addEventListener('click', function (e) {
                var act = e.target.closest('button') && e.target.closest('button').dataset.act;
                e.stopPropagation();
                self.hideMenu();
                if (act === 'open') self.open(name);
                else if (act === 'rename') self.startRename(name);
                else if (act === 'delete') self.confirmDelete(name);
            });
        },
        hideMenu: function () { var m = document.getElementById('wsMenu'); if (m) m.remove(); },
        startRename: function (name) {
            var self = this;
            this.promptName(name, function (to) {
                if (self.rename(name, to)) log('file_renamed', { from: name, to: to });
            });
        },
        confirmDelete: function (name) {
            var self = this;
            if (this.files.length === 1) return;
            var ask = window.UIMotion
                ? UIMotion.confirm({ title: 'Delete this file?', message: 'Its code is removed from your workspace. This cannot be undone.', item: name, confirmText: 'Delete file' })
                : Promise.resolve(window.confirm('Delete ' + name + '? This cannot be undone.'));
            ask.then(function (ok) {
                if (!ok) return;
                var li = document.querySelector('#fileTreeList [data-file="' + (window.CSS && CSS.escape ? CSS.escape(name) : name) + '"]');
                var gone = li && window.UIMotion ? UIMotion.remove(li) : Promise.resolve();
                gone.then(function () {
                    if (self.remove(name)) {
                        log('file_deleted', { filename: name, file_count: self.files.length });
                        if (window.UIMotion) UIMotion.toast('Deleted ' + name, 'success');
                    }
                });
            });
        },

        render: function () {
            var self = this;
            var list = document.getElementById('fileTreeList');
            if (list && !list.querySelector('.ws-rename')) {
                list.innerHTML = this.files.map(function (f) {
                    return '<li class="file-tree__item' + (f.name === self.active ? ' active' : '') + '" data-file="' + esc(f.name) + '" title="' + esc(f.name) + '" tabindex="0">' +
                        icon(f.name) + '<span class="ws-name">' + esc(f.name) + '</span>' + (self.badges[f.name] || '') +
                        '<button type="button" class="ws-row-btn" data-more="' + esc(f.name) + '" title="More actions" aria-label="More actions for ' + esc(f.name) + '">⋯</button></li>';
                }).join('');
                list.querySelectorAll('[data-file]').forEach(function (li) {
                    li.addEventListener('click', function (e) {
                        var more = e.target.closest('[data-more]');
                        if (more) {
                            e.stopPropagation();
                            var r = more.getBoundingClientRect();
                            self.showMenu(li.dataset.file, r.left, r.bottom + 2);
                            return;
                        }
                        self.open(li.dataset.file);
                    });
                    li.addEventListener('dblclick', function () { self.startRename(li.dataset.file); });
                    li.addEventListener('keydown', function (e) {
                        if (e.key === 'F2') { e.preventDefault(); self.startRename(li.dataset.file); }
                        else if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) { e.preventDefault(); self.confirmDelete(li.dataset.file); }
                        else if (e.key === 'Enter') self.open(li.dataset.file);
                    });
                });
            }
            var bar = document.getElementById('editorTabs');
            if (bar) {
                bar.innerHTML = this.tabs.map(function (n) {
                    return '<div class="ws-tab' + (n === self.active ? ' ws-tab--active' : '') + '" data-tab="' + esc(n) + '" title="' + esc(n) + '">' +
                        icon(n) + '<span>' + esc(n) + '</span>' +
                        (self.tabs.length > 1 ? '<button type="button" class="ws-tab__close" data-close="' + esc(n) + '" aria-label="Close ' + esc(n) + '">×</button>' : '') +
                        '</div>';
                }).join('');
                bar.querySelectorAll('[data-tab]').forEach(function (t) {
                    t.addEventListener('click', function (e) {
                        if (e.target.closest('[data-close]')) { e.stopPropagation(); self.closeTab(t.dataset.tab); return; }
                        self.open(t.dataset.tab);
                    });
                    t.addEventListener('auxclick', function (e) { if (e.button === 1) self.closeTab(t.dataset.tab); });
                });
            }
        }
    };

    window.WS = WS;
})();
