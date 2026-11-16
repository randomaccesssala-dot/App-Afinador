/**
 * Random Tune — interfaz y audio.
 */
import { PitchDetector } from './pitch.js';
import { INSTRUMENTS, parseNote, midiToFreq, noteLabel, assignString, nearestNote } from './music.js';
import { NoteTracker } from './tracker.js';

// ---------- Constantes ----------

const IN_TUNE = 3; // cents para entrar en "afinada"
const OUT_TUNE = 4.5; // cents para salir (histéresis, evita parpadeo)
const CONFIRM_MS = 450; // tiempo sostenido para confirmar una cuerda
const DRIFT_CENTS = 10; // una cuerda marcada pierde la marca si se corre más que esto
const DRIFT_MS = 500;
const A4_MIN = 415;
const A4_MAX = 466;
const GAUGE = { cx: 160, cy: 300, radius: 264, maxAngle: 34, range: 50 };
const SVG_NS = 'http://www.w3.org/2000/svg';
const numberFormat = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// ---------- Preferencias ----------

const STORAGE_KEY = 'random-tune:v1';
const defaults = {
  instrument: 'guitar',
  tuning: { guitar: 'standard', bass: 'standard' },
  a4: 440,
  notation: 'en',
  vibrate: true,
};

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const prefs = { ...defaults, ...saved, tuning: { ...defaults.tuning, ...(saved.tuning || {}) } };
    if (!INSTRUMENTS[prefs.instrument]) prefs.instrument = defaults.instrument;
    for (const key of ['guitar', 'bass']) {
      if (!INSTRUMENTS[key].tunings.some((t) => t.id === prefs.tuning[key])) prefs.tuning[key] = 'standard';
    }
    prefs.a4 = Math.min(A4_MAX, Math.max(A4_MIN, Math.round(Number(prefs.a4)) || 440));
    if (prefs.notation !== 'lat') prefs.notation = 'en';
    prefs.vibrate = prefs.vibrate !== false;
    return prefs;
  } catch {
    return structuredClone(defaults);
  }
}

function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* modo privado o almacenamiento bloqueado: la app funciona igual */
  }
}

const prefs = loadPrefs();

// ---------- Elementos ----------

const $ = (id) => document.getElementById(id);
const app = $('app');
const els = {
  ticks: $('ticks'),
  needle: $('needle'),
  note: $('note'),
  noteBase: $('noteBase'),
  noteAcc: $('noteAcc'),
  noteOct: $('noteOct'),
  cents: $('cents'),
  hz: $('hz'),
  hint: $('hint'),
  strings: $('strings'),
  tuningName: $('tuningName'),
  tuningNotes: $('tuningNotes'),
  tuningList: $('tuningList'),
  startLabel: $('startLabel'),
  startNote: $('startNote'),
  toneLabel: $('toneLabel'),
  announce: $('announce'),
  toast: $('toast'),
  a4Value: $('a4Value'),
};
const btn = {
  start: $('btnStart'),
  auto: $('btnAuto'),
  tone: $('btnTone'),
  tuning: $('btnTuning'),
  settings: $('btnSettings'),
  share: $('btnShare'),
};
const sheets = {
  tuning: $('sheetTuning'),
  settings: $('sheetSettings'),
  share: $('sheetShare'),
};

// ---------- Estado ----------

/** Cuerdas de la afinación actual: [{ note, freq }] de grave a aguda. */
let strings = [];
/** Índice de la cuerda fijada a mano, o -1 en automático. */
let locked = -1;
/** Cuerdas ya confirmadas como afinadas. */
const tuned = new Set();

const audio = {
  ctx: null,
  stream: null,
  source: null,
  analyser: null,
  sink: null,
  buffer: null,
  running: false,
  resumeOnVisible: false,
};
let detector = null;
let windowSize = 0;
let detectInterval = 40;
let lastDetect = 0;
let pausedUntil = 0;
const tracker = new NoteTracker();

/** Lo que se está mostrando. */
const view = { key: null, stringIndex: -1, cents: 0, has: false };
const tune = { key: null, inTune: false, since: 0, confirmed: false, driftSince: 0 };
let needle = 0;
let needleTarget = 0;
let litIndex = 0;
let lastFrame = 0;
let noisySince = 0;
let wakeLock = null;
let tone = null;
let toastTimer = 0;
let confirmTimer = 0;

// ---------- Aguja ----------

const tickEls = [];
for (let c = -GAUGE.range; c <= GAUGE.range; c += 5) {
  const line = document.createElementNS(SVG_NS, 'line');
  const length = c === 0 ? 26 : c % 10 === 0 ? 16 : 9;
  const top = GAUGE.cy - GAUGE.radius;
  line.setAttribute('x1', GAUGE.cx);
  line.setAttribute('x2', GAUGE.cx);
  line.setAttribute('y1', top);
  line.setAttribute('y2', top + length);
  line.setAttribute('transform', `rotate(${(c / GAUGE.range) * GAUGE.maxAngle} ${GAUGE.cx} ${GAUGE.cy})`);
  line.setAttribute('class', c === 0 ? 'tick tick-zero' : c % 10 === 0 ? 'tick tick-mid' : 'tick');
  els.ticks.append(line);
  tickEls.push({ step: c / 5, el: line });
}

function drawNeedle(cents) {
  const clamped = Math.max(-GAUGE.range - 4, Math.min(GAUGE.range + 4, cents));
  const angle = (clamped / GAUGE.range) * GAUGE.maxAngle;
  els.needle.setAttribute('transform', `rotate(${angle.toFixed(2)} ${GAUGE.cx} ${GAUGE.cy})`);
  const index = view.has ? Math.round(Math.max(-GAUGE.range, Math.min(GAUGE.range, cents)) / 5) : 0;
  if (index !== litIndex) {
    litIndex = index;
    for (const { step, el } of tickEls) {
      const lit = step !== 0 && (index > 0 ? step > 0 && step <= index : step < 0 && step >= index);
      el.classList.toggle('lit', lit);
    }
  }
}

// ---------- Texto en pantalla ----------

const shown = {};
function setText(key, el, value) {
  if (shown[key] !== value) {
    shown[key] = value;
    el.textContent = value;
  }
}

function setAttr(name, value) {
  if (app.dataset[name] !== value) app.dataset[name] = value;
}

function showNote(label) {
  setText('base', els.noteBase, label ? label.base : '');
  setText('acc', els.noteAcc, label ? label.acc : '');
  setText('oct', els.noteOct, label ? String(label.octave) : '');
  els.note.classList.toggle('is-empty', !label);
}

function ordinal(index) {
  return `${strings.length - index}ª`;
}

function idleHint() {
  if (prefs.instrument === 'chromatic') return 'Tocá una nota';
  if (locked >= 0) return `Tocá la ${ordinal(locked)} cuerda`;
  if (strings.length && tuned.size === strings.length) return 'Todo afinado';
  return 'Tocá una cuerda';
}

function formatCents(cents) {
  const n = Math.round(cents);
  if (n === 0) return '0 cents';
  return `${n > 0 ? '+' : '−'}${Math.abs(n)} ${Math.abs(n) === 1 ? 'cent' : 'cents'}`;
}

function tuneHint(cents, inTune) {
  if (inTune) return 'Afinada';
  const far = Math.abs(cents) > 50;
  const near = Math.abs(cents) <= 15;
  if (cents < 0) return far ? '↑ Muy baja' : near ? '↑ Subí un poco' : '↑ Subí';
  return far ? '↓ Muy alta' : near ? '↓ Bajá un poco' : '↓ Bajá';
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2400);
}

// ---------- Instrumento y afinación ----------

function currentTuning() {
  const instrument = INSTRUMENTS[prefs.instrument];
  return instrument.tunings.find((t) => t.id === prefs.tuning[prefs.instrument]) || instrument.tunings[0] || null;
}

function notesText(tuning) {
  return tuning.notes.map((n) => noteLabel(parseNote(n), prefs.notation).text).join(' ');
}

function applyInstrument({ keepMarks = false } = {}) {
  const tuning = currentTuning();
  strings = tuning
    ? tuning.notes.map((name) => {
        const note = parseNote(name);
        return { note, freq: midiToFreq(note.midi, prefs.a4) };
      })
    : [];
  if (!keepMarks) {
    locked = -1;
    tuned.clear();
  }
  resetReading();
  stopTone();

  setAttr('instrument', prefs.instrument);
  setAttr('notation', prefs.notation);
  for (const el of document.querySelectorAll('.mode')) {
    el.setAttribute('aria-pressed', String(el.dataset.instrument === prefs.instrument));
  }

  const customA4 = prefs.a4 !== 440;
  if (tuning) {
    els.tuningName.textContent = tuning.name;
    els.tuningNotes.textContent = notesText(tuning) + (customA4 ? ` · ${prefs.a4} Hz` : '');
    btn.tuning.setAttribute('aria-label', `Afinación: ${tuning.name}. Cambiar`);
  } else {
    els.tuningName.textContent = 'Todas las notas';
    els.tuningNotes.textContent = `${noteLabel(parseNote('A4'), prefs.notation).text} = ${prefs.a4} Hz`;
    btn.tuning.setAttribute('aria-label', `Cromático, La de referencia en ${prefs.a4} Hz. Cambiar`);
  }
  els.toneLabel.textContent =
    prefs.instrument === 'chromatic' ? `${noteLabel(parseNote('A4'), prefs.notation).text} ${prefs.a4}` : 'Escuchar';

  renderStrings();
  configureDetector();
  renderIdle();
}

function renderStrings() {
  els.strings.dataset.count = String(strings.length);
  els.strings.replaceChildren(
    ...strings.map((s, i) => {
      const label = noteLabel(s.note, prefs.notation);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'string';
      el.dataset.index = String(i);
      el.innerHTML =
        `<span class="string-dot"><span class="string-label">${label.base}` +
        (label.acc ? `<span class="acc">${label.acc}</span>` : '') +
        `</span><svg class="string-star" aria-hidden="true"><use href="#i-destello"/></svg></span>` +
        `<span class="string-num" aria-hidden="true">${ordinal(i)}</span>`;
      return el;
    }),
  );
  paintStrings(true);
}

let paintedStrings = '';
function paintStrings(force = false) {
  const signature = `${locked}|${view.has ? view.stringIndex : -1}|${[...tuned].join(',')}`;
  if (!force && signature === paintedStrings) return;
  paintedStrings = signature;
  const children = els.strings.children;
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    const isLocked = i === locked;
    const isTuned = tuned.has(i);
    el.classList.toggle('is-locked', isLocked);
    el.classList.toggle('is-active', !isLocked && view.has && view.stringIndex === i);
    el.classList.toggle('is-tuned', isTuned);
    el.setAttribute('aria-pressed', String(isLocked));
    const label = noteLabel(strings[i].note, prefs.notation);
    el.setAttribute(
      'aria-label',
      `Cuerda ${strings.length - i}, ${label.text}${isTuned ? ', afinada' : ''}${isLocked ? ', fijada' : ''}`,
    );
  }
  btn.auto.setAttribute('aria-pressed', String(locked < 0));
}

function renderTuningList() {
  const instrument = INSTRUMENTS[prefs.instrument];
  const current = prefs.tuning[prefs.instrument];
  els.tuningList.replaceChildren(
    ...instrument.tunings.map((t) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.tuning = t.id;
      if (t.id === current) b.setAttribute('aria-current', 'true');
      b.innerHTML =
        `<svg class="t-star" aria-hidden="true"><use href="#i-destello"/></svg>` +
        `<span class="t-name"></span><span class="t-notes"></span>`;
      b.querySelector('.t-name').textContent = t.name;
      b.querySelector('.t-notes').textContent = notesText(t);
      li.append(b);
      return li;
    }),
  );
}

// ---------- Lectura ----------

function resetReading() {
  tracker.reset();
  view.has = false;
  view.key = null;
  view.stringIndex = -1;
  tune.key = null;
  tune.inTune = false;
  tune.confirmed = false;
  tune.driftSince = 0;
  noisySince = 0;
}

/** Sin nota sonando. */
function renderIdle(heardNoise = false) {
  view.has = false;
  view.stringIndex = -1;
  setAttr('tune', 'none');
  setAttr('live', 'true');
  if (locked >= 0 && strings[locked]) showNote(noteLabel(strings[locked].note, prefs.notation));
  else showNote(null);
  setText('cents', els.cents, '');
  setText('hz', els.hz, '');
  setText('hint', els.hint, heardNoise ? 'Dejá sonar una sola cuerda' : idleHint());
  paintStrings();
}

function onDetection(result, now) {
  const reading = tracker.push(result.freq, result.clarity, now);
  if (!reading) {
    if (view.has) {
      tune.key = null;
      tune.inTune = false;
      tune.confirmed = false;
    }
    // Hay sonido pero no una nota clara (varias cuerdas, ruido de sala).
    if (result.rms > 0.02) {
      if (!noisySince) noisySince = now;
    } else {
      noisySince = 0;
    }
    renderIdle(noisySince > 0 && now - noisySince > 700);
    return;
  }
  noisySince = 0;

  let label;
  let cents;
  let key;
  let stringIndex = -1;
  if (strings.length) {
    const match = assignString(reading.freq, strings.map((s) => s.freq), {
      locked,
      current: view.has ? view.stringIndex : -1,
    });
    stringIndex = match.index;
    cents = match.cents;
    key = `s${stringIndex}`;
    label = noteLabel(strings[stringIndex].note, prefs.notation);
  } else {
    const near = nearestNote(reading.freq, prefs.a4);
    // Histéresis entre notas vecinas.
    cents = near.cents;
    key = `n${near.note.midi}`;
    label = noteLabel(near.note, prefs.notation);
  }

  // ¿Afinada?
  if (key !== tune.key) {
    tune.key = key;
    tune.inTune = false;
    tune.confirmed = false;
    tune.driftSince = 0;
  }
  const inTune = Math.abs(cents) <= (tune.inTune ? OUT_TUNE : IN_TUNE);
  if (inTune && !tune.inTune) tune.since = now;
  tune.inTune = inTune;
  if (!inTune) tune.confirmed = false;
  if (inTune && reading.live && !tune.confirmed && now - tune.since >= CONFIRM_MS) {
    tune.confirmed = true;
    onConfirmed(stringIndex, label);
  }

  // Una cuerda marcada que se corrió pierde la marca.
  if (stringIndex >= 0 && tuned.has(stringIndex) && reading.live && Math.abs(cents) > DRIFT_CENTS) {
    if (!tune.driftSince) tune.driftSince = now;
    else if (now - tune.driftSince > DRIFT_MS) {
      tuned.delete(stringIndex);
      tune.driftSince = 0;
    }
  } else {
    tune.driftSince = 0;
  }

  const changedString = view.stringIndex !== stringIndex || !view.has;
  view.has = true;
  view.key = key;
  view.stringIndex = stringIndex;
  view.cents = cents;
  needleTarget = cents;
  if (changedString) needle = cents; // nota nueva: la aguja arranca en su lugar, sin barrer

  setAttr('tune', inTune ? 'in' : cents < 0 ? 'flat' : 'sharp');
  setAttr('live', String(reading.live));
  showNote(label);
  setText('cents', els.cents, formatCents(cents));
  setText('hz', els.hz, `${numberFormat.format(reading.freq)} Hz`);
  setText('hint', els.hint, tuneHint(cents, inTune));
  paintStrings();
}

function onConfirmed(stringIndex, label) {
  if (stringIndex >= 0) tuned.add(stringIndex);
  if (prefs.vibrate && navigator.vibrate) {
    try {
      navigator.vibrate(strings.length && tuned.size === strings.length ? [45, 70, 45] : 45);
    } catch {
      /* sin vibración */
    }
  }
  app.classList.remove('confirmed');
  void app.offsetWidth; // reinicia la animación del destello
  app.classList.add('confirmed');
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => app.classList.remove('confirmed'), 700);
  els.announce.textContent =
    strings.length && tuned.size === strings.length ? `${label.text} afinada. Todo afinado.` : `${label.text} afinada`;
}

// ---------- Audio ----------

function ensureContext() {
  if (!audio.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audio.ctx = new Ctx({ latencyHint: 'interactive' });
  }
  if (audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {});
  return audio.ctx;
}

function configureDetector() {
  if (!audio.ctx || !audio.buffer) return;
  const instrument = INSTRUMENTS[prefs.instrument];
  const sampleRate = audio.ctx.sampleRate;
  detector = new PitchDetector(sampleRate, { minFreq: instrument.minFreq, maxFreq: instrument.maxFreq });
  windowSize = Math.min(audio.buffer.length, Math.round((instrument.windowMs * sampleRate) / 1000));
  detectInterval = prefs.instrument === 'chromatic' ? 50 : 40;
}

const MIC_ERRORS = {
  denied:
    'Falta el permiso del micrófono. Habilitalo para este sitio en los ajustes del navegador y volvé a intentar.',
  nomic: 'No encontré ningún micrófono en este dispositivo.',
  unsupported: 'Este navegador no deja usar el micrófono. Abrí el link en Chrome o Safari.',
  failed: 'No pude abrir el micrófono. Cerrá otras apps que lo estén usando y volvé a intentar.',
};

function showMicError(kind) {
  setAttr('state', 'error');
  els.startLabel.textContent = 'Reintentar';
  els.startNote.textContent = MIC_ERRORS[kind] || MIC_ERRORS.failed;
}

async function startAudio({ silent = false } = {}) {
  if (audio.running) return;
  if (!navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
    showMicError('unsupported');
    return;
  }
  setAttr('state', 'starting');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Sin procesamiento de llamadas: el filtro de ruido se come las notas sostenidas y los graves.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });
    // El contexto de audio se crea recién ahora: en algunos iPhone, uno creado
    // antes de tener el micrófono recibe silencio.
    stopTone();
    if (audio.ctx) {
      audio.ctx.close().catch(() => {});
      audio.ctx = null;
    }
    const ctx = ensureContext();
    if (ctx.state !== 'running') {
      await Promise.race([ctx.resume().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 1200))]);
    }

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = ctx.sampleRate > 60000 ? 16384 : ctx.sampleRate < 30000 ? 4096 : 8192;
    analyser.smoothingTimeConstant = 0;
    // Salida muda: algunos navegadores no procesan nodos que no llegan al destino.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(analyser);
    analyser.connect(sink);
    sink.connect(ctx.destination);

    Object.assign(audio, { stream, source, analyser, sink, running: true });
    audio.buffer = new Float32Array(analyser.fftSize);
    stream.getAudioTracks()[0]?.addEventListener('ended', () => stopAudio());

    configureDetector();
    resetReading();
    setAttr('state', 'listening');
    renderIdle();
    requestWakeLock();
  } catch (error) {
    audio.running = false;
    if (silent) {
      setAttr('state', 'idle');
      return;
    }
    const name = error?.name;
    showMicError(
      name === 'NotAllowedError' || name === 'SecurityError'
        ? 'denied'
        : name === 'NotFoundError' || name === 'OverconstrainedError'
          ? 'nomic'
          : 'failed',
    );
  }
}

function stopAudio() {
  if (!audio.running) return;
  audio.running = false;
  try {
    audio.stream?.getTracks().forEach((t) => t.stop());
    audio.source?.disconnect();
    audio.analyser?.disconnect();
    audio.sink?.disconnect();
  } catch {
    /* ya estaba desconectado */
  }
  audio.stream = audio.source = audio.analyser = audio.sink = null;
  releaseWakeLock();
  resetReading();
  els.startLabel.textContent = 'Activar micrófono';
  els.startNote.textContent = 'El audio se analiza en tu dispositivo. No se graba ni se envía.';
  setAttr('state', 'idle');
  setAttr('tune', 'none');
}

async function requestWakeLock() {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) || null;
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}

// ---------- Nota de referencia ----------

function playTone(freq, label) {
  stopTone();
  const ctx = ensureContext();
  const now = ctx.currentTime;
  const duration = 3.2;

  // Onda rica en armónicos: las notas graves se escuchan aunque el parlante
  // del celular no llegue a reproducir la fundamental.
  const count = 16;
  const real = new Float32Array(count + 1);
  const imag = new Float32Array(count + 1);
  const rolloff = freq < 90 ? 0.75 : 1.15;
  for (let k = 1; k <= count; k++) imag[k] = 1 / Math.pow(k, rolloff);
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(ctx.createPeriodicWave(real, imag));
  osc.frequency.value = freq;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(Math.min(9000, Math.max(1800, freq * 14)), now);
  filter.frequency.exponentialRampToValueAtTime(Math.max(700, freq * 4), now + duration);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.5, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.16, now + 0.5);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + duration + 0.05);

  const timer = setTimeout(stopTone, duration * 1000);
  tone = { osc, gain, timer };
  pausedUntil = performance.now() + duration * 1000 + 300; // no afinar contra el propio parlante
  btn.tone.setAttribute('aria-pressed', 'true');

  if (audio.running) {
    resetReading();
    setAttr('tune', 'none');
    setAttr('live', 'true');
    showNote(label);
    setText('cents', els.cents, '');
    setText('hz', els.hz, `${numberFormat.format(freq)} Hz`);
    setText('hint', els.hint, 'Sonando');
    paintStrings();
  }
}

function stopTone() {
  if (!tone) return;
  const { osc, gain, timer } = tone;
  tone = null;
  clearTimeout(timer);
  try {
    const now = audio.ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
    osc.stop(now + 0.08);
  } catch {
    /* ya terminó */
  }
  pausedUntil = performance.now() + 250;
  btn.tone.setAttribute('aria-pressed', 'false');
  if (audio.running) {
    resetReading();
    renderIdle();
  }
}

// ---------- Bucle ----------

function frame(now) {
  requestAnimationFrame(frame);
  if (audio.running && audio.analyser && now >= pausedUntil && now - lastDetect >= detectInterval) {
    lastDetect = now;
    audio.analyser.getFloatTimeDomainData(audio.buffer);
    const samples =
      windowSize < audio.buffer.length ? audio.buffer.subarray(audio.buffer.length - windowSize) : audio.buffer;
    onDetection(detector.detect(samples), now);
  }
  const dt = Math.min(80, now - lastFrame);
  lastFrame = now;
  needle += (needleTarget - needle) * (1 - Math.exp(-dt / 75));
  drawNeedle(needle);
}

// ---------- Hojas ----------

function openSheet(sheet) {
  if (typeof sheet.showModal === 'function') sheet.showModal();
  else sheet.setAttribute('open', '');
}

for (const sheet of Object.values(sheets)) {
  sheet.addEventListener('click', (event) => {
    if (event.target === sheet || event.target.closest('[data-close]')) sheet.close();
  });
}

// ---------- Compartir ----------

function shareUrl() {
  const url = new URL(location.href);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/index\.html$/, '');
  return url.href;
}

const shareData = () => ({
  title: 'Random Tune',
  text: 'Afinador de guitarra y bajo. Gratis y sin publicidad.',
  url: shareUrl(),
});

let qrLoading = null;
function loadQrLibrary() {
  if (window.qrcode) return Promise.resolve();
  qrLoading ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/qrcode.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
  return qrLoading;
}

async function renderQr() {
  const holder = $('qr');
  const url = shareUrl();
  if (holder.dataset.url === url) return;
  try {
    await loadQrLibrary();
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const size = qr.getModuleCount();
    let path = '';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (qr.isDark(y, x)) path += `M${x} ${y}h1v1h-1z`;
    }
    holder.innerHTML =
      `<svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" aria-hidden="true">` +
      `<path fill="#0b0b0d" d="${path}"/></svg>`;
    holder.dataset.url = url;
  } catch {
    holder.replaceChildren();
  }
}

btn.share.addEventListener('click', () => {
  $('shareUrl').textContent = shareUrl().replace(/^https?:\/\//, '').replace(/\/$/, '');
  $('btnShareNative').hidden = !navigator.share;
  $('btnCopy').classList.toggle('btn-primary', !navigator.share);
  openSheet(sheets.share);
  renderQr();
});

$('btnShareNative').addEventListener('click', async () => {
  try {
    await navigator.share(shareData());
  } catch {
    /* cancelado */
  }
});

$('btnCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareUrl());
    toast('Link copiado');
  } catch {
    toast('No pude copiar el link');
  }
});

// ---------- Eventos ----------

btn.start.addEventListener('click', () => startAudio());

for (const el of document.querySelectorAll('.mode')) {
  el.addEventListener('click', () => {
    if (prefs.instrument === el.dataset.instrument) return;
    prefs.instrument = el.dataset.instrument;
    savePrefs();
    applyInstrument();
  });
}

btn.tuning.addEventListener('click', () => {
  if (prefs.instrument === 'chromatic') {
    openSheet(sheets.settings);
    return;
  }
  renderTuningList();
  openSheet(sheets.tuning);
});

els.tuningList.addEventListener('click', (event) => {
  const item = event.target.closest('button[data-tuning]');
  if (!item) return;
  prefs.tuning[prefs.instrument] = item.dataset.tuning;
  savePrefs();
  applyInstrument();
  sheets.tuning.close();
});

els.strings.addEventListener('click', (event) => {
  const el = event.target.closest('.string');
  if (!el) return;
  const index = Number(el.dataset.index);
  locked = locked === index ? -1 : index;
  stopTone();
  resetReading();
  if (audio.running) renderIdle();
  else paintStrings();
});

btn.auto.addEventListener('click', () => {
  if (locked < 0) {
    toast('Auto detecta la cuerda sola. Tocá una cuerda en pantalla para fijarla.');
    return;
  }
  locked = -1;
  resetReading();
  if (audio.running) renderIdle();
  else paintStrings();
});

btn.tone.addEventListener('click', () => {
  if (tone) {
    stopTone();
    return;
  }
  if (prefs.instrument === 'chromatic') {
    playTone(prefs.a4, noteLabel(parseNote('A4'), prefs.notation));
    return;
  }
  if (locked < 0) {
    toast('Elegí una cuerda para escucharla.');
    return;
  }
  playTone(strings[locked].freq, noteLabel(strings[locked].note, prefs.notation));
});

btn.settings.addEventListener('click', () => openSheet(sheets.settings));

function setA4(value) {
  prefs.a4 = Math.min(A4_MAX, Math.max(A4_MIN, value));
  els.a4Value.textContent = `${prefs.a4} Hz`;
  savePrefs();
  applyInstrument();
}
$('a4Down').addEventListener('click', () => setA4(prefs.a4 - 1));
$('a4Up').addEventListener('click', () => setA4(prefs.a4 + 1));
els.a4Value.addEventListener('click', () => setA4(440));

for (const el of document.querySelectorAll('[data-notation]')) {
  el.addEventListener('click', () => {
    prefs.notation = el.dataset.notation;
    savePrefs();
    paintSettings();
    applyInstrument({ keepMarks: true });
  });
}

$('vibrate').addEventListener('click', () => {
  prefs.vibrate = !prefs.vibrate;
  savePrefs();
  paintSettings();
  if (prefs.vibrate) navigator.vibrate?.(45);
});

function paintSettings() {
  els.a4Value.textContent = `${prefs.a4} Hz`;
  for (const el of document.querySelectorAll('[data-notation]')) {
    el.setAttribute('aria-pressed', String(el.dataset.notation === prefs.notation));
  }
  $('vibrate').setAttribute('aria-checked', String(prefs.vibrate));
}

// Si el navegador dejó el audio en pausa, cualquier toque lo reanuda.
document.addEventListener(
  'pointerdown',
  () => {
    if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
  },
  { passive: true },
);

// Micrófono solo mientras la app está a la vista.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopTone();
    if (audio.running) {
      audio.resumeOnVisible = true;
      stopAudio();
    }
  } else if (audio.resumeOnVisible) {
    audio.resumeOnVisible = false;
    startAudio({ silent: true });
  }
});

// ---------- Instalación (PWA) ----------

const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installPrompt = null;

if (!standalone && isIos) {
  $('fieldInstall').hidden = false;
  $('installText').textContent = 'En Safari, tocá Compartir y elegí «Agregar a inicio». Queda como una app y funciona sin conexión.';
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  $('fieldInstall').hidden = false;
  $('btnInstall').hidden = false;
});

$('btnInstall').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  $('fieldInstall').hidden = true;
});

window.addEventListener('appinstalled', () => {
  $('fieldInstall').hidden = true;
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ---------- Arranque ----------

if (!navigator.vibrate) $('fieldVibrate').hidden = true;
paintSettings();
applyInstrument();
requestAnimationFrame(frame);
