/*
 * Diagram question widget (used by survey.html for pre/post and index.html for the recurrent survey).
 *
 * Three drawing tools, each kept in its own state so switching tools never loses work:
 *   canvas  – whiteboard: pen, shapes, sticky notes, text and arrows that attach to shapes
 *   mermaid – Mermaid source with live preview
 *   upload  – a photo or image of a drawing made elsewhere (e.g. a sketchbook)
 * Answers saved with the retired 'boxes' tool open in the canvas.
 *
 * Every change is written to localStorage (survives reload). "Save diagram" posts the diagram
 * (data + PNG/SVG snapshot) to the server; the saved answer object becomes the question's answer.
 *
 *   const w = DiagramWidget.mount(container, {
 *     question, storageKey, saveUrl, saveContext, initialAnswer, onChange(w), onSaved(answer)
 *   });
 *   w.getAnswer(); w.isEmpty(); w.isDirty(); await w.save(); w.setAnswer(a); w.clearDraft(); w.destroy();
 *   w.fitHeight(px)  – shrink the drawing area so the whole widget fits in px (null = natural size)
 */
(function () {
    'use strict';
    if (window.DiagramWidget) return;

    const W = 1000;
    const H = 620;
    const MIN_FIT_AREA = 240; // fitHeight never makes the drawing area shorter than this
    const MERMAID_SRC = 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js';
    const ALL_TOOLS = ['canvas', 'mermaid', 'upload'];
    const TOOL_LABELS = { canvas: '✏️ Canvas', mermaid: '</> Mermaid code', upload: '📷 Upload image' };
    // Tools that no longer exist, and the tool their answers open in.
    const LEGACY_TOOLS = { boxes: 'canvas' };
    const LEGACY_LABELS = { boxes: 'Boxes & arrows' };
    const UPLOAD_MAX_SIDE = 2000;
    const UPLOAD_MAX_CHARS = 3800000; // stays under the server's snapshot limit
    const TYPE_LABELS = {
        flowchart: 'Flowchart', sequence: 'Sequence diagram', class: 'Class diagram',
        state: 'State diagram', er: 'Entity-relationship diagram'
    };
    // Neutral templates: they show syntax only, never a model answer to the instructor's prompt.
    const MERMAID_TEMPLATES = {
        flowchart: 'flowchart TD\n    A[Start] --> B{Condition?}\n    B -- Yes --> C[Step 1]\n    B -- No --> D[Step 2]\n    C --> E[End]\n    D --> E',
        sequence: 'sequenceDiagram\n    actor Alice\n    participant Bob\n    Alice->>Bob: request\n    Bob-->>Alice: response\n    Note over Alice,Bob: a note',
        class: 'classDiagram\n    class Shape {\n        +String name\n        +area() double\n    }\n    class Circle {\n        +double radius\n    }\n    Shape <|-- Circle',
        state: 'stateDiagram-v2\n    [*] --> First\n    First --> Second : event\n    Second --> [*]',
        er: 'erDiagram\n    CUSTOMER ||--o{ ORDER : places\n    ORDER ||--|{ LINE_ITEM : contains'
    };

    let uidSeq = 0;
    let mermaidPromise = null;
    let mermaidRenderSeq = 0;

    // ------------------------------------------------------------------ helpers

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function button(label, title, onClick, cls) {
        const b = el('button', 'dgw-btn' + (cls ? ' ' + cls : ''), label);
        b.type = 'button';
        if (title) b.title = title;
        b.addEventListener('click', (e) => { e.preventDefault(); onClick(e); });
        return b;
    }

    function escXml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function clone(o) { return JSON.parse(JSON.stringify(o)); }

    function asArray(v) {
        if (Array.isArray(v)) return v;
        // Firebase RTDB returns sparse arrays as objects and drops empty ones.
        if (v && typeof v === 'object') return Object.keys(v).sort((a, b) => a - b).map((k) => v[k]);
        return [];
    }

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    function distToSegment(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        const len2 = dx * dx + dy * dy;
        let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
        t = clamp(t, 0, 1);
        const cx = x1 + t * dx, cy = y1 + t * dy;
        return Math.hypot(px - cx, py - cy);
    }

    function timeLabel(ms) {
        try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
    }

    function svgToPng(svgText, maxWidth) {
        return new Promise((resolve) => {
            try {
                const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
                const svg = doc.documentElement;
                if (!svg || svg.nodeName.toLowerCase() !== 'svg') { resolve(null); return; }
                let w = parseFloat(svg.getAttribute('width'));
                let h = parseFloat(svg.getAttribute('height'));
                const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
                if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
                    if (!(w > 0) || String(svg.getAttribute('width')).indexOf('%') !== -1) w = vb[2];
                    if (!(h > 0) || String(svg.getAttribute('height')).indexOf('%') !== -1) h = vb[3];
                }
                if (!(w > 0 && h > 0)) { w = W; h = H; }
                svg.setAttribute('width', String(w));
                svg.setAttribute('height', String(h));
                svg.removeAttribute('style');
                const str = new XMLSerializer().serializeToString(svg);
                const scale = Math.min(2, (maxWidth || 1600) / w);
                const img = new Image();
                img.onload = () => {
                    try {
                        const c = document.createElement('canvas');
                        c.width = Math.max(1, Math.round(w * scale));
                        c.height = Math.max(1, Math.round(h * scale));
                        const ctx = c.getContext('2d');
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(0, 0, c.width, c.height);
                        ctx.drawImage(img, 0, 0, c.width, c.height);
                        resolve(c.toDataURL('image/png'));
                    } catch (e) {
                        resolve(null); // tainted canvas (e.g. foreignObject); SVG is still saved
                    }
                };
                img.onerror = () => resolve(null);
                img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str);
            } catch (e) {
                resolve(null);
            }
        });
    }

    function ensureMermaid() {
        if (mermaidPromise) return mermaidPromise;
        mermaidPromise = new Promise((resolve, reject) => {
            const init = () => {
                window.mermaid.initialize({
                    startOnLoad: false,
                    securityLevel: 'strict',
                    theme: 'default',
                    htmlLabels: false,
                    flowchart: { htmlLabels: false },
                    class: { htmlLabels: false }
                });
                resolve(window.mermaid);
            };
            if (window.mermaid) { init(); return; }
            const s = document.createElement('script');
            s.src = MERMAID_SRC;
            s.async = true;
            s.onload = init;
            s.onerror = () => { mermaidPromise = null; reject(new Error('Could not load Mermaid. Check your internet connection.')); };
            document.head.appendChild(s);
        });
        return mermaidPromise;
    }

    // ------------------------------------------------------------------ styles

    const CSS = `
.dgw{border:1px solid #3c3c3c;border-radius:8px;background:#252526;color:#d4d4d4;margin-top:10px;font-size:13px;text-align:left;}
.dgw *{box-sizing:border-box;}
.dgw--full{position:fixed;inset:0;z-index:2147483000;margin:0;border:0;border-radius:0;display:flex;flex-direction:column;overflow:auto;}
.dgw--full .dgw-body{flex:1;}
.dgw--full .dgw-stage{width:min(100%, calc((100vh - 150px) * 1000 / 620));margin:0 auto;}
.dgw.dgw--full .dgw-mm textarea,.dgw.dgw--full .dgw-mm-preview{min-height:calc(100vh - 170px);}
.dgw.dgw--full .dgw-up{min-height:calc(100vh - 130px);}
.dgw.dgw--full .dgw-up img{max-height:calc(100vh - 220px);}
body.dgw-noscroll{overflow:hidden !important;}
.dgw-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:8px;border-bottom:1px solid #3c3c3c;}
.dgw-tabs{display:flex;flex-wrap:wrap;gap:4px;}
.dgw-tab{background:#2d2d30;border:1px solid #444;color:#ccc;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px;}
.dgw-tab.is-active{background:#569cd6;border-color:#569cd6;color:#fff;font-weight:600;}
.dgw-hint{padding:8px 10px;color:#aab;font-size:12px;border-bottom:1px solid #333;line-height:1.45;white-space:pre-wrap;}
.dgw-hint strong{color:#f0b37e;}
.dgw-body{padding:8px;}
.dgw-tool{display:none;}
.dgw-tool.is-active{display:block;}
.dgw-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-bottom:6px;}
.dgw-toolbar .dgw-muted{color:#889;font-size:12px;margin-right:2px;}
.dgw-sep{width:1px;height:22px;background:#444;margin:0 4px;}
.dgw-btn{background:#2d2d30;border:1px solid #444;color:#ddd;padding:5px 9px;border-radius:5px;cursor:pointer;font-size:12px;line-height:1.2;}
.dgw-btn:hover{border-color:#569cd6;}
.dgw-btn.is-active{background:#3a5f86;border-color:#569cd6;color:#fff;}
.dgw-btn:disabled{opacity:.5;cursor:default;}
.dgw-select{max-width:240px;background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:5px;padding:4px 6px;font-size:12px;}
.dgw-stage{position:relative;width:100%;border:1px solid #444;border-radius:6px;overflow:hidden;background:#fff;}
.dgw-stage > svg{display:block;width:100%;height:auto;touch-action:none;}
.dgw-wb{outline:none;user-select:none;-webkit-user-select:none;border-color:#d0d5dd;}
.dgw-wb:focus-visible{box-shadow:0 0 0 2px #4465e9;}
.dgw-wb > svg{cursor:crosshair;}
.dgw-wb > svg[data-tool=select]{cursor:default;}
.dgw-wb > svg[data-tool=select] [data-id]{cursor:move;}
.dgw-wb > svg[data-tool=text]{cursor:text;}
.dgw-wb > svg[data-tool=eraser]{cursor:cell;}
.dgw-wb-bar,.dgw-wb-actions,.dgw-wb-style{position:absolute;z-index:3;background:#fff;border:1px solid #e4e7ec;box-shadow:0 2px 8px rgba(16,24,40,.12);}
.dgw-wb-bar{left:50%;bottom:8px;transform:translateX(-50%);display:flex;align-items:center;gap:2px;padding:4px;border-radius:12px;max-width:calc(100% - 16px);overflow-x:auto;}
.dgw-wb-actions{left:8px;top:8px;display:flex;align-items:center;gap:1px;padding:3px;border-radius:10px;}
.dgw-wb-style{right:8px;top:8px;width:148px;padding:6px;border-radius:10px;display:flex;flex-direction:column;gap:4px;max-height:calc(100% - 70px);overflow-y:auto;}
.dgw-wb-style.is-hidden{display:none;}
.dgw-ib{flex:none;width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:8px;background:transparent;color:#344054;cursor:pointer;font:600 12px/1 Helvetica,Arial,sans-serif;}
.dgw-ib svg{width:18px;height:18px;display:block;}
.dgw-ib:hover:not(:disabled){background:#f2f4f7;}
.dgw-ib.is-active,.dgw-ib.is-active:hover{background:#4465e9;color:#fff;}
.dgw-ib:disabled{opacity:.3;cursor:default;}
.dgw-ib--text{width:auto;padding:0 8px;}
.dgw-wb-actions .dgw-ib{width:30px;height:30px;}
.dgw-wb-actions .dgw-ib--text{width:auto;}
.dgw-wb-sep{flex:none;align-self:stretch;width:1px;background:#e4e7ec;margin:4px 3px;}
.dgw-wb-colors{display:grid;grid-template-columns:repeat(4,1fr);gap:2px;}
.dgw-wb-color{height:28px;padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;}
.dgw-wb-color span{display:block;width:16px;height:16px;border-radius:50%;}
.dgw-wb-color:hover{background:#f2f4f7;}
.dgw-wb-color.is-active span{box-shadow:0 0 0 2px #fff,0 0 0 3.5px currentColor;}
.dgw-wb-row{display:grid;gap:2px;padding-top:4px;border-top:1px solid #f2f4f7;}
.dgw-wb-row .dgw-ib{width:auto;height:28px;}
.dgw-wb-row .dgw-ib.is-active,.dgw-wb-row .dgw-ib.is-active:hover{background:#e7ecff;color:#1f3fbf;}
.dgw-wb-empty{position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);width:80%;color:#98a2b3;font-size:14px;line-height:1.6;text-align:center;pointer-events:none;}
.dgw-wb-tip{position:absolute;left:50%;bottom:58px;transform:translateX(-50%);z-index:3;padding:3px 10px;border-radius:999px;background:rgba(16,24,40,.75);color:#fff;font-size:12px;white-space:nowrap;pointer-events:none;}
.dgw-wb--compact .dgw-wb-bar,.dgw-wb--compact .dgw-wb-actions{padding:2px;gap:0;}
.dgw-wb--compact .dgw-ib,.dgw-wb--compact .dgw-wb-actions .dgw-ib{width:26px;height:26px;}
.dgw-wb--compact .dgw-wb-actions .dgw-ib--text{width:auto;padding:0 5px;}
.dgw-wb--compact .dgw-ib svg{width:15px;height:15px;}
.dgw-wb--compact .dgw-wb-sep{margin:3px 1px;}
.dgw-wb--compact .dgw-wb-empty{display:none;}
.dgw-wb-edit{position:absolute;z-index:4;margin:0;padding:0;border:0;outline:none;background:transparent;resize:none;overflow:hidden;font-family:Helvetica,Arial,sans-serif;line-height:1.25;white-space:pre-wrap;word-break:break-word;caret-color:#4465e9;}
.dgw-mm{display:flex;gap:8px;}
.dgw-mm textarea{flex:1;min-width:0;min-height:320px;background:#1e1e1e;color:#e6e6e6;border:1px solid #444;border-radius:6px;padding:8px;font:13px/1.45 Menlo,Consolas,monospace;resize:vertical;tab-size:4;}
.dgw-mm-preview{flex:1;min-width:0;min-height:320px;background:#fff;border:1px solid #444;border-radius:6px;padding:8px;overflow:auto;display:flex;align-items:flex-start;justify-content:center;color:#555;}
.dgw-mm-preview svg{max-width:100%;height:auto;}
.dgw-mm-err{color:#f48771;font-size:12px;margin-top:4px;white-space:pre-wrap;min-height:1em;}
.dgw-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:8px;border-top:1px solid #3c3c3c;}
.dgw-status{font-size:12px;color:#aaa;}
.dgw-status.ok{color:#4ade80;}
.dgw-status.warn{color:#fbbf24;}
.dgw-status.err{color:#f87171;}
.dgw-save{background:linear-gradient(135deg,#f97316,#ea580c);border:none;color:#fff;font-weight:600;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;}
.dgw-save:disabled{opacity:.6;cursor:default;}
.dgw--large .dgw-mm textarea,.dgw--large .dgw-mm-preview{min-height:560px;}
.dgw-up{border:2px dashed #555;border-radius:8px;min-height:300px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:16px;background:#1e1e1e;color:#aaa;text-align:center;}
.dgw--large .dgw-up{min-height:480px;}
.dgw-up.is-over{border-color:#569cd6;background:#1b2633;}
.dgw-up img{max-width:100%;max-height:60vh;border-radius:6px;background:#fff;}
.dgw--large .dgw-up img{max-height:70vh;}
.dgw-up-name{font-size:12px;color:#889;}
.dgw-up-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;}
.dgw--fit:not(.dgw--full) .dgw-stage{width:min(100%, calc(var(--dgw-area) * 1000 / 620));margin:0 auto;}
.dgw.dgw--fit:not(.dgw--full) .dgw-mm textarea,.dgw.dgw--fit:not(.dgw--full) .dgw-mm-preview{min-height:0;height:var(--dgw-area);}
.dgw.dgw--fit:not(.dgw--full) .dgw-up{min-height:var(--dgw-area);}
.dgw.dgw--fit:not(.dgw--full) .dgw-up img{max-height:calc(var(--dgw-area) - 90px);}
@media (max-width:720px){.dgw-mm{flex-direction:column;}.dgw-mm textarea,.dgw-mm-preview{min-height:220px;}
.dgw.dgw--fit:not(.dgw--full) .dgw-mm textarea,.dgw.dgw--fit:not(.dgw--full) .dgw-mm-preview{height:calc(var(--dgw-area) / 2);}}
`;

    function injectCss() {
        if (document.getElementById('dgw-styles')) return;
        const s = document.createElement('style');
        s.id = 'dgw-styles';
        s.textContent = CSS;
        document.head.appendChild(s);
    }

    // ------------------------------------------------------------------ canvas tool (whiteboard)
    //
    // One vector scene of shapes: pen strokes, rectangles, ellipses, diamonds, sticky notes, text and
    // arrows. Arrows dropped on a shape attach to it and follow it when it moves. Double-click a shape
    // to type in it. Older answers (the freehand canvas and the boxes & arrows editor) are converted.

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const PALETTE = ['#1d1d1d', '#9ca3af', '#e085f4', '#ae3ec9', '#4465e9', '#4ba1f1',
        '#f1ac4b', '#e16919', '#099268', '#4cb05e', '#f87777', '#e03131'];
    const SIZES = { s: { stroke: 2, font: 16 }, m: { stroke: 3.5, font: 20 }, l: { stroke: 5, font: 26 }, xl: { stroke: 8, font: 34 } };
    const FONT = 'Helvetica, Arial, sans-serif';
    const LINE_H = 1.25;
    const BOX_TYPES = { rect: 1, ellipse: 1, diamond: 1, note: 1 };
    const SHAPE_TYPES = { draw: 1, arrow: 1, text: 1, rect: 1, ellipse: 1, diamond: 1, note: 1 };
    const DEFAULT_BOX = { rect: [160, 90], ellipse: [160, 100], diamond: [170, 110], note: [170, 150] };
    const WB_TOOLS = [
        ['select', 'Select and move (V)'], ['draw', 'Pen (D)'], ['eraser', 'Eraser (E)'], null,
        ['arrow', 'Arrow: drag from one shape to another (A)'], ['text', 'Text (T)'], ['note', 'Sticky note (N)'],
        ['rect', 'Rectangle (R)'], ['ellipse', 'Ellipse (O)'], ['diamond', 'Diamond, for decisions']
    ];
    const WB_KEYS = { v: 'select', d: 'draw', p: 'draw', e: 'eraser', a: 'arrow', t: 'text', n: 'note', r: 'rect', o: 'ellipse' };
    const ICONS = {
        select: '<path d="M5 3l13 8-6 1.5L9 19z"/>',
        draw: '<path d="M16.5 3.5l4 4L8 20H4v-4z"/>',
        eraser: '<path d="M7 20h13"/><path d="M4.6 15.4l9.8-9.8a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H8.2z"/>',
        arrow: '<path d="M5 19L19 5"/><path d="M9 5h10v10"/>',
        text: '<path d="M5 7V5h14v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
        note: '<path d="M4 4h16v10l-6 6H4z"/><path d="M14 20v-6h6"/>',
        rect: '<rect x="4" y="6" width="16" height="12" rx="1.5"/>',
        ellipse: '<ellipse cx="12" cy="12" rx="9" ry="6.5"/>',
        diamond: '<path d="M12 3l9 9-9 9-9-9z"/>',
        undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
        redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
        duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
        trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
        style: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
        fill_none: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
        fill_semi: '<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" fill-opacity=".2"/>',
        fill_solid: '<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" fill-opacity=".6"/>',
        dash_solid: '<path d="M4 12h16"/>',
        dash_dashed: '<path d="M3 12h4M10 12h4M17 12h4"/>',
        dash_dotted: '<path d="M4 12h.01M8 12h.01M12 12h.01M16 12h.01M20 12h.01" stroke-width="3"/>',
        head_none: '<path d="M5 19L19 5"/>',
        head_end: '<path d="M5 19L19 5"/><path d="M9 5h10v10"/>',
        head_both: '<path d="M5 19L19 5"/><path d="M11 5h8v8"/><path d="M13 19H5v-8"/>'
    };

    function iconSvg(name) {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
    }

    function iconButton(name, title, onClick) {
        const b = el('button', 'dgw-ib');
        b.type = 'button';
        b.title = title;
        b.setAttribute('aria-label', title);
        b.innerHTML = iconSvg(name);
        b.addEventListener('click', (e) => { e.preventDefault(); onClick(e); });
        return b;
    }

    const r1 = (v) => Math.round(v * 10) / 10;

    let measureCtx = null;
    function textWidth(s, size) {
        if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
        measureCtx.font = size + 'px ' + FONT;
        return measureCtx.measureText(s).width;
    }

    /** Lines of text wrapped to maxW (no wrapping when maxW is 0). */
    function wrapLines(text, size, maxW) {
        const out = [];
        String(text || '').split('\n').forEach((para) => {
            if (!maxW) { out.push(para); return; }
            let line = '';
            para.split(/(\s+)/).forEach((word) => {
                if (!word) return;
                const next = line + word;
                if (!line || textWidth(next, size) <= maxW) line = next;
                else { out.push(line.replace(/\s+$/, '')); line = word.replace(/^\s+/, ''); }
                while (line.length > 1 && textWidth(line, size) > maxW) {
                    let i = line.length - 1;
                    while (i > 1 && textWidth(line.slice(0, i), size) > maxW) i--;
                    out.push(line.slice(0, i));
                    line = line.slice(i);
                }
            });
            out.push(line.replace(/\s+$/, ''));
        });
        return out;
    }

    /** Mix a #rrggbb colour with white (t = 0 keeps it, 1 is white). */
    function tint(hex, t) {
        const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
        if (!m) return '#f3f4f6';
        const n = parseInt(m[1], 16);
        return '#' + [n >> 16 & 255, n >> 8 & 255, n & 255]
            .map((v) => Math.round(v + (255 - v) * t).toString(16).padStart(2, '0')).join('');
    }

    function newShapeId() { return 's' + Math.random().toString(36).slice(2, 9); }

    const sizeOf = (s) => SIZES[s.size] || SIZES.m;
    const fontOf = (s) => sizeOf(s).font;
    const arrowFont = (s) => Math.max(14, Math.round(fontOf(s) * 0.8));

    function labelWidth(s) {
        if (s.type === 'ellipse') return s.w * 0.72;
        if (s.type === 'diamond') return s.w * 0.55;
        return s.w - 20;
    }

    /** Grow a box to fit its text; size a text shape to its text. */
    function fitText(s) {
        const f = fontOf(s);
        if (s.type === 'text') {
            const ls = String(s.text || '').split('\n');
            s.w = r1(Math.max(10, ...ls.map((l) => textWidth(l, f))));
            s.h = r1(ls.length * f * LINE_H);
        } else if (BOX_TYPES[s.type] && s.text) {
            const total = wrapLines(s.text, f, labelWidth(s)).length * f * LINE_H;
            const need = s.type === 'diamond' ? total / 0.55 + 10 : s.type === 'ellipse' ? total / 0.72 + 10 : total + 20;
            if (need > s.h) s.h = r1(need);
        }
    }

    function shapeBox(s, ends) {
        if (s.type === 'draw') {
            const p = s.points;
            let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
            for (let i = 0; i < p.length; i += 2) {
                x1 = Math.min(x1, p[i]); x2 = Math.max(x2, p[i]);
                y1 = Math.min(y1, p[i + 1]); y2 = Math.max(y2, p[i + 1]);
            }
            return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        }
        if (s.type === 'arrow') {
            const [a, b] = ends || [[s.x1, s.y1], [s.x2, s.y2]];
            return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
        }
        return { x: s.x, y: s.y, w: s.w, h: s.h };
    }

    /** Point on a shape's outline in the direction of (tx, ty), pushed out by gap. */
    function edgePoint(s, tx, ty, gap) {
        const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
        const dx = tx - cx, dy = ty - cy;
        if (!dx && !dy) return [cx, cy];
        const hw = s.w / 2 + gap, hh = s.h / 2 + gap;
        let t;
        if (s.type === 'ellipse') t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
        else if (s.type === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
        else t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
        return [cx + dx * t, cy + dy * t];
    }

    function dashAttr(dash, sw) {
        if (dash === 'dashed') return ` stroke-dasharray="${r1(sw * 3)} ${r1(sw * 2.5)}"`;
        if (dash === 'dotted') return ` stroke-dasharray="0.1 ${r1(sw * 2.4)}" stroke-linecap="round"`;
        return '';
    }

    function fillOf(s) {
        if (s.type === 'note') return /^#(1d1d1d|9ca3af)$/i.test(s.color || '') ? '#fff1a8' : tint(s.color, 0.72);
        if (s.fill === 'semi') return tint(s.color, 0.9);
        if (s.fill === 'solid') return tint(s.color, 0.62);
        return 'none';
    }

    function textLinesMarkup(lines, x, top, size, color, anchor) {
        const lh = size * LINE_H;
        return `<text x="${r1(x)}" y="${r1(top + lh / 2 + size * 0.35)}" font-family="${FONT}" font-size="${size}" fill="${color}" text-anchor="${anchor}">` +
            lines.map((l, i) => `<tspan x="${r1(x)}" dy="${i ? r1(lh) : 0}">${escXml(l) || ' '}</tspan>`).join('') + '</text>';
    }

    function strokePath(p) {
        if (p.length < 4) return `M${p[0]},${p[1]}`;
        let d = `M${p[0]},${p[1]}`;
        for (let i = 2; i < p.length - 2; i += 2) {
            d += ` Q${p[i]},${p[i + 1]} ${r1((p[i] + p[i + 2]) / 2)},${r1((p[i + 1] + p[i + 3]) / 2)}`;
        }
        return d + ` L${p[p.length - 2]},${p[p.length - 1]}`;
    }

    function arrowHead(tip, from, sw, color) {
        const a = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
        const len = 11 + sw * 2.2;
        const p1 = [tip[0] - len * Math.cos(a - 0.42), tip[1] - len * Math.sin(a - 0.42)];
        const p2 = [tip[0] - len * Math.cos(a + 0.42), tip[1] - len * Math.sin(a + 0.42)];
        return `<path d="M${r1(tip[0])},${r1(tip[1])} L${r1(p1[0])},${r1(p1[1])} L${r1(p2[0])},${r1(p2[1])} Z" fill="${color}" stroke="${color}" stroke-width="1" stroke-linejoin="round"/>`;
    }

    /** Pull a line end back so it stops under the arrowhead instead of poking through it. */
    function pullBack(tip, from, by) {
        const d = Math.hypot(tip[0] - from[0], tip[1] - from[1]);
        if (d < by * 2) return tip;
        return [tip[0] - (tip[0] - from[0]) * by / d, tip[1] - (tip[1] - from[1]) * by / d];
    }

    /** Old freehand-canvas answers: {items:[{t:'pen'|'line'|'arrow'|'rect'|'ellipse'|'text', ...}]}. */
    function fromLegacyCanvas(d) {
        const size = (w) => (w <= 2 ? 's' : w >= 6 ? 'l' : 'm');
        return asArray(d.items).map((it) => {
            if (!it || typeof it !== 'object') return null;
            const base = { id: newShapeId(), color: it.c || PALETTE[0], size: size(it.w || 3), dash: 'solid', fill: 'none' };
            if (it.t === 'pen') return Object.assign(base, { type: 'draw', points: asArray(it.p).map(Number) });
            if (it.t === 'line' || it.t === 'arrow') {
                return Object.assign(base, { type: 'arrow', x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2, start: null, end: null, head: it.t === 'arrow' ? 'end' : 'none', text: '' });
            }
            if (it.t === 'rect' || it.t === 'ellipse') {
                return Object.assign(base, { type: it.t, x: Math.min(it.x1, it.x2), y: Math.min(it.y1, it.y2), w: Math.abs(it.x2 - it.x1), h: Math.abs(it.y2 - it.y1), text: '' });
            }
            if (it.t === 'text') {
                const s = Object.assign(base, { type: 'text', size: 'm', x: it.x, y: it.y, w: 0, h: 0, text: String(it.text || '') });
                fitText(s);
                return s;
            }
            return null;
        }).filter(Boolean);
    }

    /** Old boxes & arrows answers: {nodes:[{id, shape, x, y, w, h, text}], edges:[{from, to, style, label, y}]}. */
    function fromLegacyBoxes(d) {
        const nodes = asArray(d.nodes).filter((n) => n && n.id);
        const edges = asArray(d.edges).filter((e) => e && e.id);
        const byNode = {};
        nodes.forEach((n) => { byNode[n.id] = n; });
        const isMsg = (e) => byNode[e.from] && byNode[e.to] && byNode[e.from].shape === 'lifeline' && byNode[e.to].shape === 'lifeline';
        const out = [];
        const ids = {};
        const base = () => ({ id: newShapeId(), color: PALETTE[0], size: 's', dash: 'solid', fill: 'none' });
        nodes.forEach((n) => {
            const x = Number(n.x) || 0, y = Number(n.y) || 0, w = Number(n.w) || 140, h = Number(n.h) || 60;
            let type = n.shape === 'diamond' || n.shape === 'ellipse' || n.shape === 'note' ? n.shape : 'rect';
            let text = String(n.text || '');
            if (n.shape === 'class') text = [text, String(n.attrs || '').trim(), String(n.methods || '').trim()].filter(Boolean).join('\n');
            const s = Object.assign(base(), { type, x, y, w, h, text });
            fitText(s);
            ids[n.id] = s.id;
            out.push(s);
            if (n.shape === 'lifeline') {
                const ys = edges.filter((e) => (e.from === n.id || e.to === n.id) && isMsg(e)).map((e) => (Number(e.y) || 0) + 30);
                const bottom = clamp(Math.max(y + h + 320, ...ys), 0, H - 8);
                out.unshift(Object.assign(base(), { type: 'arrow', dash: 'dashed', color: PALETTE[1], x1: x + w / 2, y1: y + h, x2: x + w / 2, y2: bottom, start: null, end: null, head: 'none', text: '' }));
            }
        });
        edges.forEach((e) => {
            const a = byNode[e.from], b = byNode[e.to];
            if (!a || !b) return;
            const s = Object.assign(base(), {
                type: 'arrow', dash: e.style === 'dashed' ? 'dashed' : 'solid', head: e.style === 'line' || e.style === 'compose' ? 'none' : 'end',
                text: String(e.label || ''), start: null, end: null
            });
            if (isMsg(e)) {
                const yy = Number(e.y) || (Math.max(a.y + a.h, b.y + b.h) + 40);
                Object.assign(s, { x1: a.x + a.w / 2, y1: yy, x2: a.id === b.id ? a.x + a.w / 2 + 50 : b.x + b.w / 2, y2: yy });
            } else {
                Object.assign(s, { start: ids[a.id], end: ids[b.id], x1: a.x + a.w / 2, y1: a.y + a.h / 2, x2: b.x + b.w / 2, y2: b.y + b.h / 2 });
            }
            out.push(s);
        });
        return out;
    }

    function cleanShapes(list) {
        return asArray(list).filter((s) => s && typeof s === 'object' && SHAPE_TYPES[s.type]).map((s) => {
            const c = clone(s);
            if (!c.id) c.id = newShapeId();
            if (!SIZES[c.size]) c.size = 'm';
            if (c.type === 'draw') c.points = asArray(c.points).map(Number);
            ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2'].forEach((k) => { if (k in c) c[k] = Number(c[k]) || 0; });
            return c;
        }).filter((s) => s.type !== 'draw' || s.points.length >= 2);
    }

    function CanvasTool(widget) {
        const self = this;
        const uid = widget.uid;
        let shapes = [];
        let undo = [], redo = [];
        let sel = null;
        let tool = 'select';
        const style = { color: PALETTE[0], size: 'm', fill: 'none', dash: 'solid', head: 'end' };
        let drag = null;     // the pointer gesture in progress
        let current = null;  // shape being drawn, not yet in the scene
        let bindHint = null; // shape an arrow end would attach to
        let editing = null;  // {id, ta, isNew, before, text0}
        let lastDown = null; // previous pointerdown, to spot double-clicks

        const root = el('div', 'dgw-tool');
        const stage = el('div', 'dgw-stage dgw-wb');
        stage.tabIndex = 0;
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        const pid = 'dgw' + uid;
        svg.innerHTML = `<defs><pattern id="${pid}grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#dde1e6"/></pattern></defs>` +
            `<rect width="${W}" height="${H}" fill="#fbfbfc"/><rect width="${W}" height="${H}" fill="url(#${pid}grid)"/>` +
            '<g data-layer="scene"></g><g data-layer="live"></g><g data-layer="ui"></g>';
        const sceneG = svg.querySelector('[data-layer="scene"]');
        const liveG = svg.querySelector('[data-layer="live"]');
        const uiG = svg.querySelector('[data-layer="ui"]');
        stage.appendChild(svg);

        const empty = el('div', 'dgw-wb-empty');
        empty.innerHTML = 'Pick a tool below to start.<br>Draw shapes, connect them with the arrow tool,<br>and double-click a shape to type in it.';
        stage.appendChild(empty);
        const tip = el('div', 'dgw-wb-tip', 'Enter to finish · Shift+Enter for a new line');
        stage.appendChild(tip);

        // Bottom: drawing tools
        const bar = el('div', 'dgw-wb-bar');
        const toolBtns = {};
        WB_TOOLS.forEach((t) => {
            if (!t) { bar.appendChild(el('span', 'dgw-wb-sep')); return; }
            toolBtns[t[0]] = iconButton(t[0], t[1], () => setTool(t[0]));
            bar.appendChild(toolBtns[t[0]]);
        });
        stage.appendChild(bar);

        // Top left: history and selection actions
        const actions = el('div', 'dgw-wb-actions');
        const undoBtn = iconButton('undo', 'Undo (Ctrl+Z)', () => doUndo());
        const redoBtn = iconButton('redo', 'Redo (Ctrl+Shift+Z)', () => doRedo());
        const dupBtn = iconButton('duplicate', 'Duplicate (Ctrl+D)', () => duplicate());
        const delBtn = iconButton('trash', 'Delete (Del)', () => deleteSelected());
        const clearBtn = el('button', 'dgw-ib dgw-ib--text', 'Clear');
        clearBtn.type = 'button';
        clearBtn.title = 'Remove everything';
        clearBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (!shapes.length || !window.confirm('Remove everything from the canvas?')) return;
            pushUndo(); shapes = []; sel = null; render(); widget.changed();
        });
        const styleBtn = iconButton('style', 'Show or hide colours and styles', () => {
            panel.classList.toggle('is-hidden');
            syncUi();
        });
        [undoBtn, redoBtn, el('span', 'dgw-wb-sep'), dupBtn, delBtn, el('span', 'dgw-wb-sep'), clearBtn, styleBtn]
            .forEach((b) => actions.appendChild(b));
        stage.appendChild(actions);

        // Top right: style panel
        const panel = el('div', 'dgw-wb-style');
        const colorWrap = el('div', 'dgw-wb-colors');
        const colorBtns = PALETTE.map((c) => {
            const b = el('button', 'dgw-wb-color');
            b.type = 'button';
            b.title = 'Colour';
            b.style.color = c;
            b.innerHTML = `<span style="background:${c}"></span>`;
            b.addEventListener('click', (e) => { e.preventDefault(); applyStyle('color', c); });
            colorWrap.appendChild(b);
            return b;
        });
        panel.appendChild(colorWrap);
        const rows = {};
        function styleRow(key, opts) {
            const row = el('div', 'dgw-wb-row');
            row.style.gridTemplateColumns = `repeat(${opts.length}, 1fr)`;
            const btns = {};
            opts.forEach(([v, title, iconName]) => {
                const b = iconName ? iconButton(iconName, title, () => applyStyle(key, v)) : el('button', 'dgw-ib', title);
                if (!iconName) {
                    b.type = 'button';
                    b.title = 'Size ' + title;
                    b.addEventListener('click', (e) => { e.preventDefault(); applyStyle(key, v); });
                }
                btns[v] = b;
                row.appendChild(b);
            });
            rows[key] = { row, btns };
            panel.appendChild(row);
        }
        styleRow('fill', [['none', 'No fill', 'fill_none'], ['semi', 'Light fill', 'fill_semi'], ['solid', 'Solid fill', 'fill_solid']]);
        styleRow('dash', [['solid', 'Solid line', 'dash_solid'], ['dashed', 'Dashed line', 'dash_dashed'], ['dotted', 'Dotted line', 'dash_dotted']]);
        styleRow('size', [['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']]);
        styleRow('head', [['none', 'No arrowhead', 'head_none'], ['end', 'Arrowhead at the end', 'head_end'], ['both', 'Arrowheads at both ends', 'head_both']]);
        stage.appendChild(panel);
        root.appendChild(stage);

        // ---- model helpers

        const byId = (id) => shapes.find((s) => s.id === id) || null;
        const selShape = () => (sel ? byId(sel) : null);
        const snapshot = () => JSON.stringify(shapes);

        function pushUndo() {
            undo.push(snapshot());
            if (undo.length > 100) undo.shift();
            redo = [];
        }
        function doUndo() {
            closeEditing();
            if (!undo.length) return;
            redo.push(snapshot());
            shapes = JSON.parse(undo.pop());
            if (!selShape()) sel = null;
            render(); widget.changed();
        }
        function doRedo() {
            closeEditing();
            if (!redo.length) return;
            undo.push(snapshot());
            shapes = JSON.parse(redo.pop());
            if (!selShape()) sel = null;
            render(); widget.changed();
        }

        function newShape(type, props) {
            return Object.assign({ id: newShapeId(), type, color: style.color, size: style.size, dash: style.dash, fill: style.fill }, props);
        }

        function arrowEnds(a) {
            const A = a.start ? byId(a.start) : null;
            const B = a.end ? byId(a.end) : null;
            let p1 = [a.x1, a.y1], p2 = [a.x2, a.y2];
            const c1 = A ? [A.x + A.w / 2, A.y + A.h / 2] : p1;
            const c2 = B ? [B.x + B.w / 2, B.y + B.h / 2] : p2;
            if (A) p1 = edgePoint(A, c2[0], c2[1], 5);
            if (B) p2 = edgePoint(B, c1[0], c1[1], 5);
            return [p1, p2];
        }

        /** Topmost box or text under (x, y) that an arrow can attach to. */
        function boxAt(x, y, exclude) {
            for (let i = shapes.length - 1; i >= 0; i--) {
                const s = shapes[i];
                if ((!BOX_TYPES[s.type] && s.type !== 'text') || s.id === exclude) continue;
                if (x >= s.x - 4 && x <= s.x + s.w + 4 && y >= s.y - 4 && y <= s.y + s.h + 4) return s;
            }
            return null;
        }

        function hitsShape(s, x, y, tol) {
            const sw = sizeOf(s).stroke / 2;
            if (s.type === 'draw') {
                const p = s.points;
                if (p.length === 2) return Math.hypot(p[0] - x, p[1] - y) < tol + sw;
                for (let i = 2; i < p.length; i += 2) {
                    if (distToSegment(x, y, p[i - 2], p[i - 1], p[i], p[i + 1]) < tol + sw) return true;
                }
                return false;
            }
            if (s.type === 'arrow') {
                const [a, b] = arrowEnds(s);
                return distToSegment(x, y, a[0], a[1], b[0], b[1]) < tol + sw;
            }
            return x >= s.x - tol && x <= s.x + s.w + tol && y >= s.y - tol && y <= s.y + s.h + tol;
        }

        function removeShape(id) {
            shapes = shapes.filter((s) => s.id !== id);
            shapes.forEach((s) => {
                if (s.type !== 'arrow') return;
                if (s.start === id) s.start = null;
                if (s.end === id) s.end = null;
            });
            if (sel === id) sel = null;
        }

        function deleteSelected() {
            if (!selShape()) return;
            closeEditing();
            pushUndo();
            removeShape(sel);
            render(); widget.changed();
        }

        function duplicate() {
            const s = selShape();
            if (!s) return;
            closeEditing();
            pushUndo();
            const c = clone(s);
            c.id = newShapeId();
            if (c.type === 'draw') c.points = c.points.map((v) => r1(v + 24));
            else if (c.type === 'arrow') { c.x1 += 24; c.y1 += 24; c.x2 += 24; c.y2 += 24; c.start = null; c.end = null; }
            else { c.x += 24; c.y += 24; }
            shapes.push(c);
            sel = c.id;
            render(); widget.changed();
        }

        function setTool(t) {
            closeEditing();
            tool = t;
            if (t !== 'select') sel = null;
            render();
            stage.focus({ preventScroll: true });
        }

        function applyStyle(key, value) {
            style[key] = value;
            const s = selShape();
            if (s && s[key] !== value && !(key === 'head' && s.type !== 'arrow')) {
                pushUndo();
                s[key] = value;
                if (key === 'size') fitText(s);
                widget.changed();
            }
            render();
            if (editing) placeEditor();
        }

        // ---- rendering

        function shapeMarkup(s, forExport) {
            const st = sizeOf(s);
            const c = s.color || PALETTE[0];
            const sw = st.stroke;
            const dash = dashAttr(s.dash, sw);
            const hideText = !forExport && editing && editing.id === s.id;
            let m = '';
            if (s.type === 'draw') {
                const d = strokePath(s.points);
                m += `<path d="${d}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`;
                if (!forExport) m += `<path d="${d}" fill="none" stroke="transparent" stroke-width="${sw + 14}" stroke-linecap="round"/>`;
            } else if (s.type === 'arrow') {
                const [a, b] = arrowEnds(s);
                const head = s.head || 'end';
                const len = 11 + sw * 2.2;
                const p1 = head === 'both' ? pullBack(a, b, len * 0.6) : a;
                const p2 = head !== 'none' ? pullBack(b, a, len * 0.6) : b;
                m += `<path d="M${r1(p1[0])},${r1(p1[1])} L${r1(p2[0])},${r1(p2[1])}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round"${dash}/>`;
                if (head !== 'none') m += arrowHead(b, a, sw, c);
                if (head === 'both') m += arrowHead(a, b, sw, c);
                if (!forExport) m += `<path d="M${r1(a[0])},${r1(a[1])} L${r1(b[0])},${r1(b[1])}" stroke="transparent" stroke-width="${sw + 14}"/>`;
                if (s.text && !hideText) {
                    const f = arrowFont(s);
                    const ls = wrapLines(s.text, f, 220);
                    const tw = Math.max(...ls.map((l) => textWidth(l, f))) + 12;
                    const th = ls.length * f * LINE_H + 4;
                    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
                    m += `<rect x="${r1(mx - tw / 2)}" y="${r1(my - th / 2)}" width="${r1(tw)}" height="${r1(th)}" rx="4" fill="#ffffff" fill-opacity="0.92"/>`;
                    m += textLinesMarkup(ls, mx, my - th / 2 + 2, f, c, 'middle');
                }
            } else if (s.type === 'text') {
                if (!hideText) m += textLinesMarkup(String(s.text || '').split('\n'), s.x, s.y, st.font, c, 'start');
                if (!forExport) m += `<rect x="${s.x}" y="${s.y}" width="${Math.max(s.w, 10)}" height="${Math.max(s.h, 10)}" fill="transparent"/>`;
            } else {
                const { x, y, w, h } = s;
                const fill = fillOf(s);
                const paint = fill === 'none' ? (forExport ? 'none' : 'transparent') : fill;
                const common = `fill="${paint}" stroke="${c}" stroke-width="${sw}" stroke-linejoin="round"${dash}`;
                if (s.type === 'rect') m += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" ${common}/>`;
                else if (s.type === 'ellipse') m += `<ellipse cx="${r1(x + w / 2)}" cy="${r1(y + h / 2)}" rx="${r1(w / 2)}" ry="${r1(h / 2)}" ${common}/>`;
                else if (s.type === 'diamond') m += `<polygon points="${r1(x + w / 2)},${y} ${x + w},${r1(y + h / 2)} ${r1(x + w / 2)},${y + h} ${x},${r1(y + h / 2)}" ${common}/>`;
                else if (s.type === 'note') {
                    m += `<rect x="${x + 2}" y="${y + 4}" width="${w}" height="${h}" rx="4" fill="#000000" fill-opacity="0.08"/>`;
                    m += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${fill}"/>`;
                }
                if (s.text && !hideText) {
                    const f = st.font;
                    const ls = wrapLines(s.text, f, labelWidth(s));
                    const textColor = s.type === 'note' ? '#1d1d1d' : c;
                    m += textLinesMarkup(ls, x + w / 2, y + h / 2 - ls.length * f * LINE_H / 2, f, textColor, 'middle');
                }
            }
            return forExport ? m : `<g data-id="${escXml(s.id)}">${m}</g>`;
        }

        /** Scene units per screen pixel, so handles keep the same on-screen size. */
        function unit() {
            const r = svg.getBoundingClientRect();
            return r.width ? W / r.width : 1;
        }

        function outline(b, k, pad) {
            return `<rect x="${r1(b.x - pad)}" y="${r1(b.y - pad)}" width="${r1(b.w + pad * 2)}" height="${r1(b.h + pad * 2)}" rx="${r1(3 * k)}" fill="none" stroke="#4465e9" stroke-width="${r1(1.5 * k)}" pointer-events="none"/>`;
        }

        function renderUi() {
            const s = selShape();
            if (!s || tool !== 'select') { uiG.innerHTML = ''; return; }
            const k = unit();
            const hs = 9 * k;
            if (s.type === 'arrow') {
                const [a, b] = arrowEnds(s);
                uiG.innerHTML = [['start', a], ['end', b]].map(([h, p]) =>
                    `<circle data-handle="${h}" cx="${r1(p[0])}" cy="${r1(p[1])}" r="${r1(6 * k)}" fill="#ffffff" stroke="#4465e9" stroke-width="${r1(1.5 * k)}" style="cursor:grab"/>`).join('');
                return;
            }
            const b = shapeBox(s);
            const pad = 4 * k;
            let m = outline(b, k, pad);
            if (BOX_TYPES[s.type] && !(editing && editing.id === s.id)) {
                const corners = { nw: [b.x - pad, b.y - pad], ne: [b.x + b.w + pad, b.y - pad], sw: [b.x - pad, b.y + b.h + pad], se: [b.x + b.w + pad, b.y + b.h + pad] };
                Object.keys(corners).forEach((h) => {
                    const [cx, cy] = corners[h];
                    m += `<rect data-handle="${h}" x="${r1(cx - hs / 2)}" y="${r1(cy - hs / 2)}" width="${r1(hs)}" height="${r1(hs)}" rx="${r1(2 * k)}" fill="#ffffff" stroke="#4465e9" stroke-width="${r1(1.5 * k)}" style="cursor:${h === 'nw' || h === 'se' ? 'nwse' : 'nesw'}-resize"/>`;
                });
            }
            uiG.innerHTML = m;
        }

        function renderLive() {
            let m = current ? shapeMarkup(current, false) : '';
            const hint = bindHint ? byId(bindHint) : null;
            if (hint) m += outline(hint, unit(), 6);
            liveG.innerHTML = m;
        }

        function render() {
            // Keep stored arrow ends in step with the shapes they are attached to.
            shapes.forEach((s) => {
                if (s.type !== 'arrow' || (!s.start && !s.end)) return;
                const [a, b] = arrowEnds(s);
                s.x1 = r1(a[0]); s.y1 = r1(a[1]); s.x2 = r1(b[0]); s.y2 = r1(b[1]);
            });
            sceneG.innerHTML = shapes.map((s) => shapeMarkup(s, false)).join('');
            renderLive();
            renderUi();
            syncUi();
        }

        function syncUi() {
            Object.keys(toolBtns).forEach((t) => toolBtns[t].classList.toggle('is-active', t === tool));
            svg.dataset.tool = tool;
            const s = selShape();
            undoBtn.disabled = !undo.length;
            redoBtn.disabled = !redo.length;
            dupBtn.disabled = !s;
            delBtn.disabled = !s;
            clearBtn.disabled = !shapes.length;
            styleBtn.classList.toggle('is-active', !panel.classList.contains('is-hidden'));
            const v = s || style;
            colorBtns.forEach((b, i) => b.classList.toggle('is-active', PALETTE[i] === v.color));
            Object.keys(rows).forEach((key) => {
                Object.keys(rows[key].btns).forEach((val) => rows[key].btns[val].classList.toggle('is-active', (v[key] || style[key]) === val));
            });
            const kind = s ? s.type : tool;
            rows.fill.row.style.display = s ? (BOX_TYPES[kind] && kind !== 'note' ? '' : 'none') : (kind === 'draw' || kind === 'eraser' || kind === 'arrow' || kind === 'text' || kind === 'note' ? 'none' : '');
            rows.dash.row.style.display = kind === 'text' || kind === 'note' || kind === 'eraser' ? 'none' : '';
            rows.head.row.style.display = kind === 'arrow' ? '' : 'none';
            empty.style.display = shapes.length || current || editing ? 'none' : '';
            tip.style.display = editing ? '' : 'none';
        }

        // ---- text editing

        function placeEditor() {
            if (!editing) return;
            const s = byId(editing.id);
            if (!s) return;
            const r = svg.getBoundingClientRect(), sr = stage.getBoundingClientRect();
            const k = r.width / W;
            let f = fontOf(s), left, top, width, align = 'center', lines;
            if (s.type === 'arrow') {
                f = arrowFont(s);
                const [a, b] = arrowEnds(s);
                width = 230;
                lines = Math.max(1, wrapLines(s.text, f, 220).length);
                left = (a[0] + b[0]) / 2 - width / 2;
                top = (a[1] + b[1]) / 2 - lines * f * LINE_H / 2;
            } else if (s.type === 'text') {
                align = 'left';
                lines = String(s.text || '').split('\n').length;
                width = Math.max(80, s.w + f * 2);
                left = s.x;
                top = s.y;
            } else {
                width = labelWidth(s);
                lines = Math.max(1, wrapLines(s.text, f, width).length);
                left = s.x + (s.w - width) / 2;
                top = s.y + s.h / 2 - lines * f * LINE_H / 2;
            }
            const ta = editing.ta;
            ta.style.left = (r.left - sr.left + left * k) + 'px';
            ta.style.top = (r.top - sr.top + top * k) + 'px';
            ta.style.width = (width * k) + 'px';
            ta.style.height = (lines * f * LINE_H * k + 2) + 'px';
            ta.style.fontSize = (f * k) + 'px';
            ta.style.textAlign = align;
            ta.style.color = s.type === 'note' ? '#1d1d1d' : (s.color || PALETTE[0]);
        }

        function startEditing(s, isNew) {
            closeEditing();
            const ta = el('textarea', 'dgw-wb-edit');
            ta.value = s.text || '';
            ta.setAttribute('aria-label', 'Text');
            editing = { id: s.id, ta, isNew, before: isNew ? null : snapshot(), text0: s.text || '' };
            stage.appendChild(ta);
            ta.addEventListener('input', () => {
                s.text = ta.value.slice(0, 1000);
                fitText(s);
                render();
                placeEditor();
            });
            ta.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
                    e.preventDefault();
                    closeEditing();
                    stage.focus({ preventScroll: true });
                }
            });
            ta.addEventListener('blur', () => { if (editing && editing.ta === ta) closeEditing(); });
            render();
            placeEditor();
            ta.focus({ preventScroll: true });
            ta.select();
            // A pointerup or click right after this can move focus away again.
            setTimeout(() => { if (editing && editing.ta === ta && document.activeElement !== ta) ta.focus({ preventScroll: true }); }, 0);
        }

        function closeEditing() {
            if (!editing) return;
            const ed = editing;
            editing = null;
            ed.ta.remove();
            const s = byId(ed.id);
            let changed = false;
            if (s) {
                s.text = String(s.text || '').replace(/\s+$/, '');
                if (s.type === 'text' && !s.text) {
                    removeShape(s.id);
                    if (ed.isNew) undo.pop();
                    else { undo.push(ed.before); changed = true; }
                } else {
                    fitText(s);
                    if (ed.isNew) changed = true;
                    else if (s.text !== ed.text0) { undo.push(ed.before); redo = []; changed = true; }
                }
            }
            render();
            if (changed) widget.changed();
        }

        /** Click with the text or note tool: add it and start typing. */
        function place(type, x, y) {
            pushUndo();
            let s;
            if (type === 'note') {
                const [w, h] = DEFAULT_BOX.note;
                s = newShape('note', { x: r1(clamp(x - w / 2, 0, W - w)), y: r1(clamp(y - h / 2, 0, H - h)), w, h, text: '' });
            } else {
                s = newShape('text', { x: r1(x), y: r1(y - fontOf(style) * 0.6), w: 0, h: 0, text: '' });
            }
            shapes.push(s);
            sel = s.id;
            tool = 'select';
            startEditing(s, true);
        }

        // ---- pointer input

        function pointFromEvent(e) {
            const r = svg.getBoundingClientRect();
            return [clamp((e.clientX - r.left) * W / r.width, 0, W), clamp((e.clientY - r.top) * H / r.height, 0, H)];
        }

        function shapeFromEvent(e) {
            const g = e.target.closest && e.target.closest('[data-id]');
            return g && sceneG.contains(g) ? byId(g.getAttribute('data-id')) : null;
        }

        function eraseAt(x, y, d) {
            for (let i = shapes.length - 1; i >= 0; i--) {
                if (hitsShape(shapes[i], x, y, 6)) {
                    removeShape(shapes[i].id);
                    d.erased = true;
                    render();
                    return;
                }
            }
        }

        function moveShape(s, o, dx, dy) {
            if (s.type === 'draw') s.points = o.points.map((v, i) => r1(v + (i % 2 ? dy : dx)));
            else if (s.type === 'arrow') {
                s.start = null; s.end = null;
                s.x1 = r1(o.x1 + dx); s.y1 = r1(o.y1 + dy); s.x2 = r1(o.x2 + dx); s.y2 = r1(o.y2 + dy);
            } else {
                s.x = r1(clamp(o.x + dx, 20 - o.w, W - 20));
                s.y = r1(clamp(o.y + dy, 20 - o.h, H - 20));
            }
        }

        function resizeShape(s, o, corner, x, y) {
            const fx = corner === 'nw' || corner === 'sw' ? o.x + o.w : o.x;
            const fy = corner === 'nw' || corner === 'ne' ? o.y + o.h : o.y;
            s.x = r1(Math.min(fx, x)); s.w = r1(Math.max(20, Math.abs(x - fx)));
            s.y = r1(Math.min(fy, y)); s.h = r1(Math.max(20, Math.abs(y - fy)));
            if (x < fx && s.w === 20) s.x = r1(fx - 20);
            if (y < fy && s.h === 20) s.y = r1(fy - 20);
        }

        svg.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            e.preventDefault();
            stage.focus({ preventScroll: true });
            closeEditing();
            const [x, y] = pointFromEvent(e);
            const handle = e.target.closest && e.target.closest('[data-handle]');
            // Detected here rather than with dblclick: the scene is redrawn between the two clicks.
            const now = Date.now();
            const isDouble = !!lastDown && now - lastDown.t < 450 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 8;
            lastDown = isDouble ? null : { t: now, x: e.clientX, y: e.clientY };
            if (isDouble && tool === 'select' && !handle) {
                const s = shapeFromEvent(e);
                if (s && s.type !== 'draw') { sel = s.id; startEditing(s, false); } else if (!s) place('text', x, y);
                return;
            }
            const hs = selShape();
            if (handle && hs) {
                drag = { kind: 'handle', h: handle.getAttribute('data-handle'), id: hs.id, orig: clone(hs), moved: false };
            } else if (tool === 'select') {
                const s = shapeFromEvent(e);
                sel = s ? s.id : null;
                if (s) drag = { kind: 'move', id: s.id, x0: x, y0: y, orig: clone(s), moved: false };
                render();
            } else if (tool === 'draw') {
                current = newShape('draw', { points: [r1(x), r1(y)] });
                drag = { kind: 'draw' };
                renderLive(); syncUi();
            } else if (tool === 'eraser') {
                drag = { kind: 'erase', before: snapshot(), erased: false };
                eraseAt(x, y, drag);
            } else if (tool === 'arrow') {
                const b = boxAt(x, y);
                current = newShape('arrow', { x1: r1(x), y1: r1(y), x2: r1(x), y2: r1(y), start: b ? b.id : null, end: null, head: style.head, text: '' });
                drag = { kind: 'arrow', x0: x, y0: y };
                renderLive(); syncUi();
            } else if (BOX_TYPES[tool] && tool !== 'note') {
                current = newShape(tool, { x: r1(x), y: r1(y), w: 0, h: 0, text: '' });
                drag = { kind: 'box', x0: x, y0: y };
                renderLive(); syncUi();
            } else if (tool === 'note' || tool === 'text') {
                place(tool, x, y);
                return;
            }
            if (drag) svg.setPointerCapture(e.pointerId);
        });

        svg.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const [x, y] = pointFromEvent(e);
            const d = drag;
            if (d.kind === 'draw') {
                const p = current.points;
                if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) >= 2) { p.push(r1(x), r1(y)); renderLive(); }
            } else if (d.kind === 'erase') {
                eraseAt(x, y, d);
            } else if (d.kind === 'arrow') {
                current.x2 = r1(x); current.y2 = r1(y);
                const b = boxAt(x, y, current.start);
                bindHint = b ? b.id : null;
                renderLive();
            } else if (d.kind === 'box') {
                let w = x - d.x0, h = y - d.y0;
                if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
                current.x = r1(Math.min(d.x0, d.x0 + w)); current.y = r1(Math.min(d.y0, d.y0 + h));
                current.w = r1(Math.abs(w)); current.h = r1(Math.abs(h));
                renderLive();
            } else if (d.kind === 'move') {
                const dx = x - d.x0, dy = y - d.y0;
                if (!d.moved) {
                    if (Math.hypot(dx, dy) < 3) return;
                    pushUndo();
                    d.moved = true;
                }
                const s = byId(d.id);
                if (s) { moveShape(s, d.orig, dx, dy); render(); }
            } else if (d.kind === 'handle') {
                const s = byId(d.id);
                if (!s) return;
                if (!d.moved) { pushUndo(); d.moved = true; }
                if (s.type === 'arrow') {
                    const other = d.h === 'start' ? s.end : s.start;
                    if (d.h === 'start') { s.start = null; s.x1 = r1(x); s.y1 = r1(y); } else { s.end = null; s.x2 = r1(x); s.y2 = r1(y); }
                    const b = boxAt(x, y, other);
                    bindHint = b ? b.id : null;
                } else {
                    resizeShape(s, d.orig, d.h, x, y);
                }
                render();
            }
        });

        const finish = () => {
            if (!drag) return;
            const d = drag;
            drag = null;
            if (d.kind === 'draw') {
                const s = current;
                current = null;
                if (s.points.length === 2) s.points.push(r1(s.points[0] + 0.1), r1(s.points[1] + 0.1));
                pushUndo();
                shapes.push(s);
                render(); widget.changed();
            } else if (d.kind === 'erase') {
                if (d.erased) { undo.push(d.before); redo = []; widget.changed(); }
                render();
            } else if (d.kind === 'arrow') {
                const s = current;
                current = null;
                s.end = bindHint;
                bindHint = null;
                if (s.start && s.start === s.end) s.end = null;
                if (Math.hypot(s.x2 - d.x0, s.y2 - d.y0) < 8) { render(); return; }
                pushUndo();
                shapes.push(s);
                sel = s.id;
                tool = 'select';
                render(); widget.changed();
            } else if (d.kind === 'box') {
                const s = current;
                current = null;
                if (s.w < 8 && s.h < 8) {
                    const [w, h] = DEFAULT_BOX[s.type];
                    s.x = r1(clamp(s.x - w / 2, 0, W - w)); s.y = r1(clamp(s.y - h / 2, 0, H - h)); s.w = w; s.h = h;
                }
                pushUndo();
                shapes.push(s);
                sel = s.id;
                tool = 'select';
                render(); widget.changed();
            } else if (d.kind === 'move') {
                if (d.moved) widget.changed();
            } else if (d.kind === 'handle') {
                const s = byId(d.id);
                if (s && s.type === 'arrow' && d.moved) {
                    if (d.h === 'start') s.start = bindHint; else s.end = bindHint;
                    if (s.start && s.start === s.end) { if (d.h === 'start') s.start = null; else s.end = null; }
                }
                bindHint = null;
                if (s && BOX_TYPES[s.type]) fitText(s);
                render();
                if (d.moved) widget.changed();
            }
        };
        svg.addEventListener('pointerup', finish);
        svg.addEventListener('pointercancel', finish);

        stage.addEventListener('keydown', (e) => {
            if (editing || e.target !== stage) return;
            const mod = e.ctrlKey || e.metaKey;
            const k = e.key.toLowerCase();
            let handled = true;
            if (mod && k === 'z') { if (e.shiftKey) doRedo(); else doUndo(); }
            else if (mod && k === 'y') doRedo();
            else if (mod && k === 'd') duplicate();
            else if (mod || e.altKey) handled = false;
            else if ((k === 'delete' || k === 'backspace') && selShape()) deleteSelected();
            else if (k === 'escape' && (sel || tool !== 'select')) { sel = null; tool = 'select'; render(); }
            else if (k === 'enter' && selShape() && selShape().type !== 'draw') startEditing(selShape(), false);
            else if (WB_KEYS[k]) setTool(WB_KEYS[k]);
            else handled = false;
            if (handled) { e.preventDefault(); e.stopPropagation(); }
        });

        // ---- tool API

        self.root = root;
        self.getData = () => ({ v: 2, w: W, h: H, shapes: clone(shapes) });
        self.setData = (d) => {
            if (editing) { editing.ta.remove(); editing = null; }
            if (d && d.shapes) shapes = cleanShapes(d.shapes);
            else if (d && d.items) shapes = cleanShapes(fromLegacyCanvas(d));
            else if (d && d.nodes) shapes = cleanShapes(fromLegacyBoxes(d));
            else shapes = [];
            undo = []; redo = []; sel = null; current = null; drag = null;
            render();
        };
        self.count = () => shapes.length;
        self.validate = () => null;
        let lastWidth = 0;
        function onResize() {
            const w = stage.offsetWidth;
            if (!w || w === lastWidth) return;
            if (!lastWidth && w < 560) panel.classList.add('is-hidden'); // small screens start with styles folded away
            lastWidth = w;
            stage.classList.toggle('dgw-wb--compact', w < 480);
            renderUi(); // handles keep the same on-screen size
            renderLive();
            if (editing) placeEditor();
            syncUi();
        }
        if (window.ResizeObserver) new ResizeObserver(onResize).observe(stage);
        self.onShow = () => { onResize(); render(); };
        self.exportImage = async () => {
            closeEditing();
            const body = shapes.map((s) => shapeMarkup(s, true)).join('');
            const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#ffffff"/>${body}</svg>`;
            const image = await svgToPng(svgText, 1500);
            return { image, svg: svgText };
        };
        render();
    }

    // ------------------------------------------------------------------ mermaid tool

    function MermaidTool(widget, starter) {
        const self = this;
        let lastSvg = '';
        let lastError = null;
        let renderTimer = null;
        let rendered = Promise.resolve();

        const root = el('div', 'dgw-tool');
        const bar = el('div', 'dgw-toolbar');
        const tplSel = el('select', 'dgw-select');
        const first = el('option', null, 'Insert a template…');
        first.value = '';
        tplSel.appendChild(first);
        Object.keys(MERMAID_TEMPLATES).forEach((k) => { const o = el('option', null, TYPE_LABELS[k]); o.value = k; tplSel.appendChild(o); });
        tplSel.addEventListener('change', () => {
            const k = tplSel.value;
            tplSel.value = '';
            if (!k) return;
            if (ta.value.trim() && !window.confirm('Replace your current Mermaid code with the template?')) return;
            ta.value = MERMAID_TEMPLATES[k];
            schedule(0);
            widget.changed();
        });
        bar.appendChild(tplSel);
        const help = el('a', 'dgw-btn', '? Syntax help');
        help.href = 'https://mermaid.js.org/intro/syntax-reference.html';
        help.target = '_blank';
        help.rel = 'noopener noreferrer';
        help.style.textDecoration = 'none';
        bar.appendChild(help);
        root.appendChild(bar);

        const split = el('div', 'dgw-mm');
        const ta = el('textarea');
        ta.spellcheck = false;
        ta.placeholder = 'flowchart TD\n    A --> B';
        ta.value = starter || '';
        const preview = el('div', 'dgw-mm-preview', 'Preview appears here.');
        split.appendChild(ta);
        split.appendChild(preview);
        root.appendChild(split);
        const err = el('div', 'dgw-mm-err');
        root.appendChild(err);

        ta.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Tab') {
                e.preventDefault();
                const s = ta.selectionStart, en = ta.selectionEnd;
                ta.value = ta.value.slice(0, s) + '    ' + ta.value.slice(en);
                ta.selectionStart = ta.selectionEnd = s + 4;
                schedule();
                widget.changed();
            }
        });
        ta.addEventListener('input', () => { schedule(); widget.changed(); });

        function schedule(delay) {
            if (renderTimer) clearTimeout(renderTimer);
            renderTimer = setTimeout(() => { renderTimer = null; rendered = doRender(); }, delay == null ? 400 : delay);
        }

        async function doRender() {
            const code = ta.value.trim();
            if (!code) {
                lastSvg = ''; lastError = null;
                preview.textContent = 'Preview appears here.';
                err.textContent = '';
                return;
            }
            const seq = ++mermaidRenderSeq;
            const id = 'dgwm' + widget.uid + '_' + seq;
            let m;
            try {
                m = await ensureMermaid();
            } catch (e) {
                lastError = e.message;
                err.textContent = e.message;
                return;
            }
            try {
                await m.parse(code);
                const out = await m.render(id, code);
                if (seq !== mermaidRenderSeq && ta.value.trim() !== code) return;
                preview.innerHTML = out.svg;
                lastSvg = out.svg;
                lastError = null;
                err.textContent = '';
            } catch (e) {
                lastError = String((e && (e.str || e.message)) || e).split('\n').slice(0, 4).join('\n');
                err.textContent = 'Mermaid error: ' + lastError;
                ['d' + id, id].forEach((x) => { const n = document.getElementById(x); if (n) n.remove(); });
            }
        }

        function contentLines() {
            return ta.value.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('%%'));
        }

        self.root = root;
        self.getData = () => ({ code: ta.value });
        self.setData = (d) => { ta.value = (d && typeof d.code === 'string') ? d.code : ''; schedule(0); };
        self.count = () => Math.max(0, contentLines().length - 1);
        self.validate = async () => {
            if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; rendered = doRender(); }
            await rendered;
            return lastError ? 'Fix the Mermaid error before saving.' : null;
        };
        self.onShow = () => schedule(0);
        self.exportImage = async () => {
            await rendered;
            if (!lastSvg) return {};
            return { image: await svgToPng(lastSvg, 1600), svg: lastSvg };
        };
        schedule(0);
    }

    // ------------------------------------------------------------------ upload tool

    function readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = () => reject(new Error('Could not read the file.'));
            r.readAsDataURL(file);
        });
    }

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('This file is not an image the browser can open. Try a JPG or PNG.'));
            img.src = src;
        });
    }

    /** Downscale and re-encode as JPEG (white background) so photos stay a reasonable size. */
    async function compressImage(file) {
        const img = await loadImage(await readFileAsDataUrl(file));
        let side = UPLOAD_MAX_SIDE;
        let quality = 0.85;
        for (let attempt = 0; attempt < 5; attempt++) {
            const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
            const w = Math.max(1, Math.round(img.naturalWidth * scale));
            const h = Math.max(1, Math.round(img.naturalHeight * scale));
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            const url = c.toDataURL('image/jpeg', quality);
            if (url.length <= UPLOAD_MAX_CHARS) return { image: url, w, h };
            side = Math.round(side * 0.75);
            quality = Math.max(0.6, quality - 0.08);
        }
        throw new Error('The image is too large. Try a smaller photo.');
    }

    function blobUrlToDataUrl(url) {
        return fetch(url, { credentials: 'same-origin' })
            .then((r) => { if (!r.ok) throw new Error('Could not load the saved image.'); return r.blob(); })
            .then((b) => readFileAsDataUrl(b));
    }

    function UploadTool(widget) {
        const self = this;
        let image = null; // data URL of a newly chosen image (kept until saved)
        let remoteId = null; // diagram_id of an image already on the server
        let name = '', w = 0, h = 0;

        const root = el('div', 'dgw-tool');
        const zone = el('div', 'dgw-up');
        const input = el('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.display = 'none';
        root.appendChild(input);
        root.appendChild(zone);
        const err = el('div', 'dgw-mm-err');
        root.appendChild(err);

        function render() {
            zone.innerHTML = '';
            const src = image || (remoteId ? widget.fileUrl(remoteId) : null);
            if (src) {
                const img = el('img');
                img.alt = 'Uploaded drawing';
                img.src = src;
                zone.appendChild(img);
                if (name) zone.appendChild(el('div', 'dgw-up-name', name));
                const actions = el('div', 'dgw-up-actions');
                actions.appendChild(button('Replace image', null, () => input.click()));
                actions.appendChild(button('Remove', null, () => {
                    image = null; remoteId = null; name = ''; w = 0; h = 0;
                    render(); widget.changed();
                }));
                zone.appendChild(actions);
            } else {
                zone.appendChild(el('div', null, 'Upload a photo or image of your drawing'));
                zone.appendChild(button('Choose image', null, () => input.click(), 'is-active'));
                zone.appendChild(el('div', 'dgw-up-name', 'or drop it here'));
            }
        }

        async function take(file) {
            if (!file) return;
            err.textContent = '';
            if (file.type && file.type.indexOf('image/') !== 0) {
                err.textContent = 'Please choose an image file.';
                return;
            }
            zone.classList.add('is-over');
            try {
                const out = await compressImage(file);
                image = out.image; w = out.w; h = out.h;
                remoteId = null;
                name = String(file.name || 'image').slice(0, 120);
                render();
                widget.changed();
            } catch (e) {
                err.textContent = e.message;
            } finally {
                zone.classList.remove('is-over');
            }
        }

        input.addEventListener('change', () => { take(input.files && input.files[0]); input.value = ''; });
        zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-over'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('is-over');
            take(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
        });

        self.root = root;
        // Local draft keeps the image itself so it survives a reload before saving.
        self.getData = () => ({ name, w, h, image: image || null, remote_id: image ? null : remoteId });
        // The survey answer never carries the image; the server keeps it under the diagram id.
        self.answerData = () => ({ name, w, h });
        self.setData = (d, answer) => {
            d = d || {};
            image = typeof d.image === 'string' && d.image.indexOf('data:image/') === 0 ? d.image : null;
            remoteId = image ? null : (d.remote_id || (answer && answer.diagram_id) || null);
            name = d.name || ''; w = d.w || 0; h = d.h || 0;
            render();
        };
        self.count = () => (image || remoteId ? 1 : 0);
        self.validate = () => null;
        self.onShow = () => {};
        self.exportImage = async () => {
            if (image) return { image };
            if (remoteId) return { image: await blobUrlToDataUrl(widget.fileUrl(remoteId)) };
            return {};
        };
        render();
    }

    // ------------------------------------------------------------------ widget

    class Widget {
        constructor(container, opts) {
            injectCss();
            this.uid = ++uidSeq;
            this.opts = opts || {};
            this.q = this.opts.question || {};
            const cfg = this.q.diagram || {};
            this.cfg = cfg;
            const tools = [];
            asArray(cfg.tools).map((t) => LEGACY_TOOLS[t] || t).forEach((t) => {
                if (ALL_TOOLS.indexOf(t) !== -1 && tools.indexOf(t) === -1) tools.push(t);
            });
            this.tools = tools.length ? tools : ALL_TOOLS.slice();
            // Uploading a photo (e.g. a paper sketch) is always offered, also for questions saved before it existed.
            if (this.tools.indexOf('upload') === -1) this.tools.push('upload');
            const firstTool = LEGACY_TOOLS[cfg.default_tool] || cfg.default_tool;
            this.tool = this.tools.indexOf(firstTool) !== -1 ? firstTool : this.tools[0];
            this.saved = null;
            this.dirty = false;
            this.version = 0;
            this.updatedAt = 0;
            this._draftTimer = null;
            this._saving = null;

            const type = cfg.diagram_type && TYPE_LABELS[cfg.diagram_type] ? cfg.diagram_type : '';
            const starter = typeof cfg.starter_mermaid === 'string' && cfg.starter_mermaid.trim()
                ? cfg.starter_mermaid
                : (MERMAID_TEMPLATES[type] || '');

            this.build(container, type, starter);
            this.restore(this.opts.initialAnswer || null);

            this._onPageHide = () => this.flushDraft();
            window.addEventListener('pagehide', this._onPageHide);
            this._onKey = (e) => {
                if (e.key === 'Escape' && this.root.classList.contains('dgw--full')) {
                    e.stopPropagation();
                    this.toggleFull(false);
                }
            };
            document.addEventListener('keydown', this._onKey, true);
        }

        build(container, type, starter) {
            const root = el('div', 'dgw' + (this.opts.large ? ' dgw--large' : ''));
            this.root = root;
            const head = el('div', 'dgw-head');
            const tabs = el('div', 'dgw-tabs');
            this.tabBtns = {};
            this.tools.forEach((t) => {
                const b = el('button', 'dgw-tab', TOOL_LABELS[t]);
                b.type = 'button';
                b.addEventListener('click', (e) => { e.preventDefault(); this.switchTool(t); });
                tabs.appendChild(b);
                this.tabBtns[t] = b;
            });
            head.appendChild(tabs);
            this.fullBtn = button('⤢ Full screen', 'Enlarge the drawing area', () => this.toggleFull());
            head.appendChild(this.fullBtn);
            root.appendChild(head);

            const hintParts = [];
            if (type) hintParts.push('<strong>Expected: ' + escXml(TYPE_LABELS[type]) + '</strong>');
            if (this.cfg.instructions) hintParts.push(escXml(this.cfg.instructions));
            if (hintParts.length) {
                const hint = el('div', 'dgw-hint');
                hint.innerHTML = hintParts.join('\n');
                root.appendChild(hint);
            }

            const body = el('div', 'dgw-body');
            this.impls = {};
            this.tools.forEach((t) => {
                const impl = t === 'canvas' ? new CanvasTool(this)
                    : t === 'upload' ? new UploadTool(this)
                    : new MermaidTool(this, starter);
                this.impls[t] = impl;
                body.appendChild(impl.root);
            });
            root.appendChild(body);

            const foot = el('div', 'dgw-foot');
            this.statusEl = el('span', 'dgw-status');
            this.saveBtn = el('button', 'dgw-save', 'Save diagram');
            this.saveBtn.type = 'button';
            this.saveBtn.addEventListener('click', (e) => { e.preventDefault(); this.save(); });
            foot.appendChild(this.statusEl);
            foot.appendChild(this.saveBtn);
            root.appendChild(foot);

            container.appendChild(root);
            this.showTool();
        }

        showTool() {
            Object.keys(this.impls).forEach((t) => {
                this.impls[t].root.classList.toggle('is-active', t === this.tool);
                this.tabBtns[t].classList.toggle('is-active', t === this.tool);
            });
            const impl = this.impls[this.tool];
            if (impl && impl.onShow) impl.onShow();
            this.applyFit();
        }

        /** Size the drawing area so the whole widget (tabs, toolbar, area, Save) is at most px tall. */
        fitHeight(px) {
            this._fitPx = px > 0 ? px : null;
            if (this._fitPx && !this._fitObserver && window.ResizeObserver) {
                // The chrome around the area can change too (e.g. the Mermaid error line).
                this._fitObserver = new ResizeObserver(() => {
                    cancelAnimationFrame(this._fitFrame);
                    this._fitFrame = requestAnimationFrame(() => this.applyFit());
                });
                this._fitObserver.observe(this.root);
            }
            this.applyFit();
        }

        applyFit() {
            const root = this.root;
            if (!root) return;
            if (!this._fitPx) {
                root.classList.remove('dgw--fit');
                root.style.removeProperty('--dgw-area');
                return;
            }
            const area = root.querySelector('.dgw-tool.is-active .dgw-stage, .dgw-tool.is-active .dgw-mm, .dgw-tool.is-active .dgw-up');
            if (!area || !root.offsetHeight) return; // hidden: fit again when shown
            const chrome = root.offsetHeight - area.offsetHeight;
            const h = Math.max(MIN_FIT_AREA, Math.floor(this._fitPx - chrome)) + 'px';
            if (root.style.getPropertyValue('--dgw-area') !== h) root.style.setProperty('--dgw-area', h);
            root.classList.add('dgw--fit');
        }

        switchTool(t) {
            if (t === this.tool || !this.impls[t]) return;
            this.tool = t;
            this.showTool();
            if (this.saved && this.saved.tool !== t) this.changed();
            else this.scheduleDraft();
            this.updateStatus();
        }

        toggleFull(force) {
            const on = typeof force === 'boolean' ? force : !this.root.classList.contains('dgw--full');
            if (on === this.root.classList.contains('dgw--full')) return;
            // Move the widget to <body> while full screen: a parent with transform, filter,
            // backdrop-filter or overflow would otherwise trap position:fixed inside it.
            if (on) {
                this._fullHome = document.createComment('dgw');
                this.root.parentNode.insertBefore(this._fullHome, this.root);
                document.body.appendChild(this.root);
            } else if (this._fullHome && this._fullHome.parentNode) {
                this._fullHome.parentNode.replaceChild(this.root, this._fullHome);
                this._fullHome = null;
            }
            document.body.classList.toggle('dgw-noscroll', on);
            this.root.classList.toggle('dgw--full', on);
            this.fullBtn.textContent = on ? '⤡ Exit full screen' : '⤢ Full screen';
            const impl = this.impls[this.tool];
            if (impl && impl.onShow) impl.onShow();
        }

        // ---- persistence

        readDraft() {
            if (!this.opts.storageKey) return null;
            try {
                const raw = localStorage.getItem(this.opts.storageKey);
                const d = raw ? JSON.parse(raw) : null;
                return d && d.v === 1 && d.state ? d : null;
            } catch (e) {
                return null;
            }
        }

        flushDraft() {
            if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }
            if (!this.opts.storageKey || this._cleared) return;
            const state = {};
            Object.keys(this.impls).forEach((t) => { state[t] = this.impls[t].getData(); });
            try {
                localStorage.setItem(this.opts.storageKey, JSON.stringify({
                    v: 1, updatedAt: this.updatedAt, dirty: this.dirty, tool: this.tool, saved: this.saved, state
                }));
                this._draftError = false;
            } catch (e) {
                this._draftError = true;
            }
        }

        scheduleDraft() {
            if (this._draftTimer) clearTimeout(this._draftTimer);
            this._draftTimer = setTimeout(() => this.flushDraft(), 300);
        }

        /** Remove the local copy (after the survey is submitted); later edits start a new one. */
        clearDraft() {
            this._cleared = true;
            if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }
            if (!this.opts.storageKey) return;
            try { localStorage.removeItem(this.opts.storageKey); } catch (e) { /* ignore */ }
        }

        applyAnswer(ans) {
            const t = LEGACY_TOOLS[ans.tool] || ans.tool;
            if (this.impls[t]) {
                this.tool = t;
                this.impls[t].setData(ans.data || {}, ans);
            }
            this.saved = ans;
            this.dirty = false;
            this.updatedAt = Date.parse(ans.saved_at) || Date.now();
            this.showTool();
        }

        restore(answer) {
            const draft = this.readDraft();
            const ansTime = answer && answer.saved_at ? (Date.parse(answer.saved_at) || 0) : 0;
            if (draft && (draft.updatedAt || 0) >= ansTime) {
                const state = Object.assign({}, draft.state);
                const draftTool = LEGACY_TOOLS[draft.tool] || draft.tool;
                Object.keys(LEGACY_TOOLS).forEach((old) => {
                    if (draft.tool === old && state[old]) state[LEGACY_TOOLS[old]] = state[old];
                });
                Object.keys(this.impls).forEach((t) => {
                    if (state[t]) this.impls[t].setData(state[t]);
                });
                if (this.impls[draftTool]) this.tool = draftTool;
                this.saved = draft.saved && draft.saved.kind === 'diagram' ? draft.saved : (answer && answer.kind === 'diagram' ? answer : null);
                this.dirty = !!draft.dirty;
                this.updatedAt = draft.updatedAt || 0;
                this.showTool();
            } else if (answer && answer.kind === 'diagram') {
                this.applyAnswer(answer);
            }
            this.updateStatus();
        }

        // ---- public API

        /** Apply a server-saved answer; ignored when this device has newer work. */
        setAnswer(answer) {
            if (!answer || typeof answer !== 'object' || answer.kind !== 'diagram') return;
            const ansTime = Date.parse(answer.saved_at) || 0;
            if (ansTime > this.updatedAt) {
                this.applyAnswer(answer);
                this.flushDraft();
            } else if (!this.saved) {
                this.saved = answer;
            }
            this.updateStatus();
        }

        getAnswer() { return this.saved; }

        /** URL of an image stored on the server for this question (upload tool). */
        fileUrl(diagramId) {
            const c = this.opts.saveContext || {};
            return '/diagram/file?session_id=' + encodeURIComponent(c.session_id || '') +
                '&user_id=' + encodeURIComponent(c.user_id || '') +
                '&diagram_id=' + encodeURIComponent(diagramId);
        }
        isDirty() { return this.dirty || (!this.saved && !this.isEmpty()); }
        /** True until the student draws something (an untouched starter template does not count). */
        isEmpty() {
            const impl = this.impls[this.tool];
            if (!impl || impl.count() === 0) return true;
            return !this.dirty && !this.saved;
        }

        changed() {
            this._cleared = false;
            this.version++;
            this.dirty = true;
            this.updatedAt = Date.now();
            this.scheduleDraft();
            this.updateStatus();
            if (this.opts.onChange) {
                try { this.opts.onChange(this); } catch (e) { /* ignore */ }
            }
        }

        setStatus(text, cls) {
            this.statusEl.textContent = text;
            this.statusEl.className = 'dgw-status' + (cls ? ' ' + cls : '');
        }

        updateStatus() {
            if (this._saving) return;
            if (this._draftError) {
                this.setStatus('Browser storage is full. Save now to keep your work.', 'warn');
            } else if (this.saved && !this.dirty) {
                this.setStatus('✓ Saved ' + timeLabel(Date.parse(this.saved.saved_at) || Date.now()), 'ok');
            } else if (!this.isEmpty()) {
                this.setStatus('Unsaved changes', 'warn');
            } else {
                this.setStatus('');
            }
        }

        /** Save the open tool's diagram to the server. Resolves to the answer object, or null on failure. */
        save() {
            if (this._saving) return this._saving;
            const tool = this.tool;
            const impl = this.impls[tool];
            if (this.isEmpty()) {
                this.setStatus('Draw something before saving.', 'err');
                return Promise.resolve(null);
            }
            const startVersion = this.version;
            this.saveBtn.disabled = true;
            this.saveBtn.textContent = 'Saving…';
            this.setStatus('Saving…');
            this._saving = (async () => {
                const problem = await impl.validate();
                if (problem) throw new Error(problem);
                const data = impl.answerData ? impl.answerData() : impl.getData();
                let snap = {};
                try { snap = await impl.exportImage(); } catch (e) { snap = {}; }
                const elements = impl.count();
                // Client clock on purpose: drafts are compared against this time on the same device.
                const savedAt = new Date().toISOString();
                const ctx = this.opts.saveContext || {};
                const res = await fetch(this.opts.saveUrl || '/diagram/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(Object.assign({}, ctx, {
                        tool,
                        diagram_type: this.cfg.diagram_type || null,
                        data,
                        elements,
                        saved_at: savedAt,
                        image: snap.image || null,
                        svg: snap.svg || null
                    }))
                });
                if (!res.ok) {
                    let msg = 'Server error ' + res.status;
                    try { const j = await res.json(); if (j && j.detail) msg = String(j.detail); } catch (e) { /* ignore */ }
                    throw new Error(msg);
                }
                const out = await res.json();
                const answer = {
                    kind: 'diagram',
                    tool,
                    diagram_type: this.cfg.diagram_type || null,
                    data,
                    elements,
                    diagram_id: out.diagram_id || null,
                    saved_at: savedAt
                };
                this.saved = answer;
                this.dirty = this.version !== startVersion;
                if (!this.dirty) this.updatedAt = Math.max(this.updatedAt, Date.parse(answer.saved_at) || 0);
                this.flushDraft();
                return answer;
            })().then((answer) => {
                this._saving = null;
                this.saveBtn.disabled = false;
                this.saveBtn.textContent = 'Save diagram';
                this.updateStatus();
                if (this.opts.onSaved) { try { this.opts.onSaved(answer); } catch (e) { /* ignore */ } }
                if (this.opts.onChange) { try { this.opts.onChange(this); } catch (e) { /* ignore */ } }
                return answer;
            }, (err) => {
                this._saving = null;
                this.saveBtn.disabled = false;
                this.saveBtn.textContent = 'Save diagram';
                this.setStatus('Not saved: ' + (err && err.message ? err.message : 'network error'), 'err');
                return null;
            });
            return this._saving;
        }

        destroy() {
            this.toggleFull(false);
            this.flushDraft();
            window.removeEventListener('pagehide', this._onPageHide);
            document.removeEventListener('keydown', this._onKey, true);
            if (this._fitObserver) this._fitObserver.disconnect();
            cancelAnimationFrame(this._fitFrame);
            if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
        }
    }

    /** Short text for tables/CSV: "[Diagram · Mermaid code · 7 elements]". */
    function summarize(answer) {
        if (!answer || answer.kind !== 'diagram') return '';
        const label = (TOOL_LABELS[answer.tool] || LEGACY_LABELS[answer.tool] || answer.tool || '').replace(/^[^A-Za-z<]+/, '');
        return '[Diagram · ' + label + ' · ' + (answer.elements || 0) + ' elements]';
    }

    window.DiagramWidget = {
        mount(container, opts) { return new Widget(container, opts); },
        summarize,
        TOOLS: ALL_TOOLS.slice(),
        TOOL_LABELS: Object.assign({}, TOOL_LABELS),
        TYPE_LABELS: Object.assign({}, TYPE_LABELS)
    };
})();
