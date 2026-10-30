/*
 * Voice answers for open-ended survey questions (survey.html and the IDE's survey panel).
 *
 * Click the mic button under an answer box to start recording, click it again to stop. The speech is
 * transcribed by Whisper running inside the browser (transformers.js, in a Web Worker) while the
 * participant talks: the text appears in the answer box every couple of seconds, and a last pass on Stop
 * settles it. The participant can then edit it before submitting.
 * Audio never leaves the device and is never stored: it is discarded as soon as it is transcribed.
 *
 *   VoiceInput.attach(textarea)   adds the button below a textarea (if the browser can't record, e.g. on a
 *                                 plain http:// page, the button explains why when clicked)
 *
 * Each transcription fires a "voiceinput" event on the textarea, detail:
 *   {recording_ms, speech_ms, transcribe_ms, chars, live_passes}   (pages may log it; no audio or text included)
 */
(function () {
    'use strict';

    var LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';
    var MODEL = 'onnx-community/whisper-base.en';  // English, ~80 MB, cached by the browser after the first use
    var MAX_RECORDING_MS = 3 * 60 * 1000;

    var RATE = 16000;            // Whisper's sample rate
    var LIVE_EVERY_MS = 500;     // pause between live passes while recording
    var WINDOW_S = 20;           // the live text is redone over at most this much audio; older audio is settled

    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    var supported = !!(window.Worker && window.WebAssembly && AudioCtx &&
        navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);

    // ── Whisper in a Web Worker (keeps the page responsive while the model runs) ──
    var WORKER_SRC = [
        "import { pipeline } from '" + LIB + "';",
        "let asr = null;",
        "async function load() {",
        "  if (!asr) asr = pipeline('automatic-speech-recognition', '" + MODEL + "', {",
        "    dtype: 'q8', device: 'wasm',",
        "    progress_callback: p => { if (p.status === 'progress') postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total }); }",
        "  });",
        "  return asr;",
        "}",
        "onmessage = async (e) => {",
        "  const m = e.data;",
        "  try {",
        "    const model = await load();",
        "    if (m.type === 'load') { postMessage({ type: 'ready' }); return; }",
        "    const out = await model(m.audio, { chunk_length_s: 30, stride_length_s: 5 });",
        "    postMessage({ type: 'result', id: m.id, text: out.text || '' });",
        "  } catch (err) {",
        "    asr = null;",
        "    postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });",
        "  }",
        "};"
    ].join('\n');

    var worker = null, ready = false, nextId = 1, waiting = {}, progress = {}, progressListeners = [];

    function getWorker() {
        if (worker) return worker;
        var url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
        worker = new Worker(url, { type: 'module' });
        worker.onmessage = function (e) {
            var m = e.data;
            if (m.type === 'progress') {
                progress[m.file] = { loaded: m.loaded || 0, total: m.total || 0 };
                var loaded = 0, total = 0;
                Object.keys(progress).forEach(function (f) { loaded += progress[f].loaded; total += progress[f].total; });
                var pct = total ? Math.round(loaded / total * 100) : 0;
                progressListeners.forEach(function (fn) { fn(pct); });
            } else if (m.type === 'ready') {
                ready = true;
            } else if (m.type === 'result' || m.type === 'error') {
                if (m.type === 'result') ready = true;
                var cb = waiting[m.id];
                delete waiting[m.id];
                if (cb) cb(m);
                else if (m.type === 'error') worker = null;  // failed preload: try again next time
            }
        };
        worker.onerror = function (e) {
            Object.keys(waiting).forEach(function (id) { waiting[id]({ type: 'error', message: e.message || 'worker failed' }); });
            waiting = {};
            worker = null;
        };
        worker.postMessage({ type: 'load' });  // start downloading the model right away
        return worker;
    }

    function transcribe(audio) {
        return new Promise(function (resolve, reject) {
            var id = nextId++;
            waiting[id] = function (m) { if (m.type === 'result') resolve(m.text); else reject(new Error(m.message)); };
            getWorker().postMessage({ type: 'transcribe', id: id, audio: audio }, [audio.buffer]);
        });
    }

    // Whisper writes non-speech as "[BLANK_AUDIO]", "(music)" and so on, and on near-silence it tends
    // to invent filler like "you you you" or "Thank you."
    function cleanText(text) {
        var t = String(text || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
        t = t.replace(/(?:\s*\byou\b[.,!]?){2,}\s*$/i, '').trim();
        return /^(you|thank you|thanks for watching)[.!]?$/i.test(t) ? '' : t;
    }

    // Cut silence at the start and end (Whisper invents words in long silences); null = no speech at all
    function trimSilence(audio) {
        var frame = 480, threshold = 0.012, first = -1, last = -1;  // 30 ms frames at 16 kHz
        for (var i = 0; i + frame <= audio.length; i += frame) {
            var sum = 0;
            for (var j = i; j < i + frame; j++) sum += audio[j] * audio[j];
            if (Math.sqrt(sum / frame) > threshold) { if (first < 0) first = i; last = i + frame; }
        }
        if (first < 0 || last - first < 16000 * 0.25) return null;  // under a quarter second of sound
        var pad = 16000 * 0.3;
        return audio.slice(Math.max(0, first - pad), Math.min(audio.length, last + pad));
    }

    // Microphone samples (at the device rate) -> 16 kHz, averaging each output sample's span
    function to16k(input, rate) {
        if (rate === RATE) return input;
        var ratio = rate / RATE, out = new Float32Array(Math.floor(input.length / ratio));
        for (var i = 0; i < out.length; i++) {
            var a = Math.floor(i * ratio), b = Math.min(input.length, Math.floor((i + 1) * ratio)), sum = 0;
            for (var j = a; j < b; j++) sum += input[j];
            out[i] = b > a ? sum / (b - a) : input[a] || 0;
        }
        return out;
    }

    function isQuiet(audio, at) {  // 30 ms frame starting at `at`
        var sum = 0;
        for (var j = at; j < at + 480; j++) sum += audio[j] * audio[j];
        return Math.sqrt(sum / 480) <= 0.012;
    }

    // Where to settle the live window: the middle of its longest pause after the first half, so no word is cut
    // (a lone quiet frame is not a pause: soft sounds like "s" can be that quiet). -1 = no pause yet.
    function settlePoint(audio, from, to) {
        var run = 0, best = 0, at = -1;
        for (var i = to - 480; i > from + (to - from) / 2; i -= 480) {
            run = isQuiet(audio, i) ? run + 1 : 0;
            if (run > best) { best = run; at = i + run * 240; }
        }
        return best >= 4 ? at : -1;  // 120 ms or more
    }

    // ── Button ───────────────────────────────────────────────────────────
    var MIC = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 10.5a2.5 2.5 0 002.5-2.5V4a2.5 2.5 0 00-5 0v4A2.5 2.5 0 008 10.5zm4-2.5a.5.5 0 011 0 5 5 0 01-4.5 4.97V14.5h2a.5.5 0 010 1h-5a.5.5 0 010-1h2v-1.53A5 5 0 013 8a.5.5 0 011 0 4 4 0 008 0z"/></svg>';
    var STOP = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>';
    var active = null;  // the control that is recording; only one at a time

    function injectStyles() {
        if (document.getElementById('voice-input-styles')) return;
        var st = document.createElement('style');
        st.id = 'voice-input-styles';
        st.textContent = [
            '.voice-input{display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap;}',
            '.voice-input__btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:15px;',
            'border:1px solid #4a4a4a;background:transparent;color:#d4d4d4;font:500 13px/1 system-ui,-apple-system,sans-serif;cursor:pointer;}',
            '.voice-input__btn svg{width:14px;height:14px;}',
            '.voice-input__btn:hover:not(:disabled){border-color:#888;color:#fff;}',
            '.voice-input__btn:disabled{opacity:.6;cursor:default;}',
            '.voice-input__btn.is-recording{background:#c62828;border-color:#c62828;color:#fff;}',
            '.voice-input__btn.is-recording svg{animation:voice-pulse 1.2s ease-in-out infinite;}',
            '@keyframes voice-pulse{50%{opacity:.4;}}',
            '.voice-input__status{font:12px/1.4 system-ui,-apple-system,sans-serif;color:#9d9d9d;}',
            '.voice-input__status.is-error{color:#f48771;}'
        ].join('');
        document.head.appendChild(st);
    }

    function fmtTime(ms) {
        var s = Math.floor(ms / 1000);
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    // Put `text` between the answer's existing text before and after the caret (as it was when recording began)
    function showText(textarea, at, text, done) {
        var before = at.before, after = at.after;
        var piece = text ? (before && !/\s$/.test(before) ? ' ' : '') + text + (after && !/^\s/.test(after) ? ' ' : '') : '';
        var max = textarea.maxLength > 0 ? textarea.maxLength : Infinity;
        piece = piece.slice(0, Math.max(0, max - before.length - after.length));
        textarea.value = before + piece + after;
        var caret = before.length + piece.length;
        textarea.setSelectionRange(caret, caret);
        textarea.scrollTop = textarea.scrollHeight * (caret / Math.max(1, textarea.value.length));
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        if (done) textarea.focus();
    }

    // Why voice can't run here (the button is still shown, and says this when clicked); '' = it can
    function unsupportedReason() {
        if (supported) return '';
        if (!window.isSecureContext) {
            return 'Voice answers need a secure page: open the site with https:// (or on localhost). Please type your answer.';
        }
        return 'This browser cannot record voice answers (try Chrome, Edge or Safari). Please type your answer.';
    }

    function attach(textarea) {
        if (!textarea || textarea.dataset.voiceInput) return;
        textarea.dataset.voiceInput = '1';
        injectStyles();

        var row = document.createElement('div');
        row.className = 'voice-input';
        row.innerHTML = '<button type="button" class="voice-input__btn" title="Answer by voice: click to start, click again to stop">' +
            MIC + '<span>Speak</span></button><span class="voice-input__status" aria-live="polite"></span>';
        textarea.insertAdjacentElement('afterend', row);
        var btn = row.querySelector('button');
        var label = btn.querySelector('span');
        var status = row.querySelector('.voice-input__status');

        var stream = null, ctx = null, node = null, pcm = [], pcmLen = 0, rate = RATE;
        var startedAt = 0, timer = null, autoStop = null, starting = false, recording = false;
        var at = null;            // the answer's text before/after the caret when recording began
        var settled = '', settledAt = 0, live = '';  // text for audio [0, settledAt), and for the rest so far
        var busy = null, liveTimer = null, passes = 0;

        function setStatus(text, isError) {
            status.textContent = text || '';
            status.classList.toggle('is-error', !!isError);
        }
        function idle() {
            btn.disabled = false;
            btn.classList.remove('is-recording');
            btn.innerHTML = MIC + '<span>Speak</span>';
        }
        function join(a, b) { return a && b ? a + ' ' + b : a || b; }
        // Remember where the caret was, so the text goes there
        textarea.addEventListener('blur', function () { textarea.dataset.voiceCursor = String(textarea.selectionStart); });

        function audioSoFar() {  // everything recorded, at 16 kHz
            var all = new Float32Array(pcmLen), o = 0;
            pcm.forEach(function (c) { all.set(c, o); o += c.length; });
            pcm = [all];
            return to16k(all, rate);
        }

        // One live pass: settle the oldest audio once the window is long, then redo the text of the rest
        async function livePass() {
            if (!recording || busy) return;
            if (!ready) { liveTimer = setTimeout(livePass, 500); return; }  // model still downloading
            var audio = audioSoFar();
            busy = (async function () {
                var cut = audio.length - settledAt > WINDOW_S * RATE ? settlePoint(audio, settledAt, audio.length - RATE) : -1;
                // No pause yet: wait for one, unless the window nears Whisper's 30 s limit
                if (cut < 0 && audio.length - settledAt > (WINDOW_S + 7) * RATE) cut = audio.length - RATE;
                if (cut > 0) {
                    var part = trimSilence(audio.slice(settledAt, cut));
                    settled = join(settled, part ? cleanText(await transcribe(part)) : '');
                    settledAt = cut;
                }
                var rest = trimSilence(audio.slice(settledAt));
                live = rest ? cleanText(await transcribe(rest)) : '';
                passes++;
                if (recording) showText(textarea, at, join(settled, live), false);
            })();
            try { await busy; } catch (e) { console.warn('Live transcription pass failed:', e); }
            busy = null;
            if (recording) liveTimer = setTimeout(livePass, LIVE_EVERY_MS);
        }

        async function start() {
            if (active && active !== control) active.stop();
            // Opening the microphone can take a while (the browser may ask for permission): ignore clicks meanwhile
            starting = true;
            btn.disabled = true;
            setStatus('Opening the microphone…');
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
            } catch (e) {
                setStatus(e && e.name === 'NotAllowedError'
                    ? 'Microphone access is blocked. Allow it in your browser, or type your answer.'
                    : 'No microphone found. Please type your answer.', true);
                return;
            } finally {
                starting = false;
                btn.disabled = false;
            }
            getWorker();  // download the model while the participant speaks
            // Raw samples straight from the microphone, so the speech can be transcribed while recording
            ctx = new AudioCtx();
            if (ctx.state === 'suspended' && ctx.resume) await ctx.resume();
            rate = ctx.sampleRate;
            pcm = []; pcmLen = 0;
            node = ctx.createScriptProcessor(4096, 1, 1);
            node.onaudioprocess = function (e) {
                if (!recording) return;
                var c = new Float32Array(e.inputBuffer.getChannelData(0));
                pcm.push(c); pcmLen += c.length;
            };
            ctx.createMediaStreamSource(stream).connect(node);
            node.connect(ctx.destination);  // outputs silence; needed for the processor to run in some browsers

            var v = textarea.value, cursor = textarea.dataset.voiceCursor ? Math.min(Number(textarea.dataset.voiceCursor), v.length) : v.length;
            at = { before: v.slice(0, cursor), after: v.slice(cursor) };
            settled = ''; settledAt = 0; live = ''; passes = 0;
            textarea.readOnly = true;  // the transcript is being written here
            recording = true;
            active = control;
            startedAt = Date.now();
            btn.classList.add('is-recording');
            btn.innerHTML = STOP + '<span>Stop</span>';
            var onProgress = function (pct) { if (recording) setStatus('Listening… (getting the voice model ready, first time only: ' + pct + '%)'); };
            progressListeners.push(onProgress);
            setStatus('Listening… 0:00');
            timer = setInterval(function () {
                if (ready) setStatus('Listening… ' + fmtTime(Date.now() - startedAt) + ' (text appears as you speak)');
            }, 500);
            autoStop = setTimeout(stop, MAX_RECORDING_MS);
            liveTimer = setTimeout(livePass, LIVE_EVERY_MS);
            control.onProgress = onProgress;
        }

        function stop() {
            if (recording) finish();
        }

        async function finish() {
            var recordingMs = Date.now() - startedAt;
            recording = false;
            clearInterval(timer);
            clearTimeout(autoStop);
            clearTimeout(liveTimer);
            if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
            stream = null;
            if (node) node.disconnect();
            if (ctx && ctx.close) ctx.close();
            node = null; ctx = null;
            if (active === control) active = null;
            btn.disabled = true;
            btn.classList.remove('is-recording');
            btn.innerHTML = MIC + '<span>Finishing…</span>';

            var onProgress = control.onProgress;
            if (!ready) setStatus('Getting the voice model ready (first time only)…');
            else setStatus('Finishing the text…');
            var t0 = Date.now(), speechMs = 0;
            try {
                if (busy) await busy.catch(function () {});  // let the running live pass finish
                var audio = audioSoFar();
                pcm = []; pcmLen = 0;  // the recording is not kept
                var rest = trimSilence(audio.slice(settledAt));
                speechMs = Math.round((settledAt + (rest ? rest.length : 0)) / 16);
                var text = join(settled, rest ? cleanText(await transcribe(rest)) : '');
                audio = null;
                showText(textarea, at, text, true);
                if (text) setStatus('Added. You can edit the text before submitting.');
                else setStatus("Didn't catch any speech. Try again, closer to the microphone.", true);
                textarea.dispatchEvent(new CustomEvent('voiceinput', { bubbles: true, detail: {
                    recording_ms: recordingMs, speech_ms: speechMs, transcribe_ms: Date.now() - t0, chars: text.length, live_passes: passes } }));
            } catch (e) {
                console.error('Voice input failed:', e);
                showText(textarea, at, join(settled, live), true);  // keep what the live passes got
                setStatus('Could not transcribe. Please try again or type your answer.', true);
            } finally {
                textarea.readOnly = false;
                var i = progressListeners.indexOf(onProgress);
                if (i >= 0) progressListeners.splice(i, 1);
                idle();
            }
        }

        var control = { stop: stop };
        btn.addEventListener('click', function () {
            if (!supported) { setStatus(unsupportedReason(), true); return; }
            if (starting) return;
            if (recording) stop();
            else start();
        });
    }

    window.VoiceInput = { attach: attach, supported: supported };
})();
