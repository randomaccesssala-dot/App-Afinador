// Pruebas del motor de afinación con señales sintéticas.
// Correr con:  npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { PitchDetector } from '../js/pitch.js';
import { INSTRUMENTS, parseNote, midiToFreq, centsBetween, assignString, nearestNote, noteLabel } from '../js/music.js';
import { NoteTracker } from '../js/tracker.js';

// Generador pseudoaleatorio determinístico (para que las pruebas sean repetibles).
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cuerda pulsada sintética: armónicos que decaen, con inarmonicidad opcional,
 * fundamental atenuada (micrófono de celular) y ruido de sala.
 */
function pluck(f0, sr, n, opts = {}) {
  const {
    harmonics = 10,
    fundamentalGain = 1,
    evenOnly = false,
    inharmonicity = 0,
    decay = 1.5, // 1/s
    noise = 0, // amplitud RMS relativa a la señal
    amplitude = 0.2,
    seed = 1,
    offset = 0.35, // segundos desde el ataque
  } = opts;
  const rand = rng(seed);
  const x = new Float32Array(n);
  const partials = [];
  for (let k = 1; k <= harmonics; k++) {
    const f = k * f0 * Math.sqrt(1 + inharmonicity * k * k);
    if (f > sr / 2.2) break;
    let a = 1 / Math.pow(k, 1.1);
    if (k === 1) a *= fundamentalGain;
    if (evenOnly && k % 2 === 1 && k > 1) a *= 0.12;
    partials.push({ f, a, phase: rand() * 2 * Math.PI, decay: decay * (1 + 0.25 * k) });
  }
  let power = 0;
  for (let i = 0; i < n; i++) {
    const t = offset + i / sr;
    let v = 0;
    for (const p of partials) v += p.a * Math.exp(-p.decay * t) * Math.sin(2 * Math.PI * p.f * t + p.phase);
    x[i] = v;
    power += v * v;
  }
  const rms = Math.sqrt(power / n) || 1;
  const gain = amplitude / rms;
  for (let i = 0; i < n; i++) {
    // Ruido aproximadamente gaussiano.
    const g = (rand() + rand() + rand() + rand() - 2) * Math.sqrt(3);
    x[i] = x[i] * gain + noise * amplitude * g;
  }
  return x;
}

function windowSize(instrument, sr) {
  return Math.min(8192, Math.round((INSTRUMENTS[instrument].windowMs * sr) / 1000));
}

function detectorFor(instrument, sr) {
  const { minFreq, maxFreq } = INSTRUMENTS[instrument];
  return new PitchDetector(sr, { minFreq, maxFreq });
}

const SAMPLE_RATES = [44100, 48000];
const allNotes = (instrument) => [...new Set(INSTRUMENTS[instrument].tunings.flatMap((t) => t.notes))];

test('cuerdas al aire de guitarra: error menor a 0,5 cents', () => {
  for (const sr of SAMPLE_RATES) {
    const det = detectorFor('guitar', sr);
    const n = windowSize('guitar', sr);
    for (const name of allNotes('guitar')) {
      const f0 = midiToFreq(parseNote(name).midi);
      for (const detune of [-18, -3, 0, 4, 27]) {
        const f = f0 * Math.pow(2, detune / 1200);
        const r = det.detect(pluck(f, sr, n, { seed: detune + 100 }));
        assert.ok(r.freq > 0, `${name} ${detune}c @${sr}: sin detección`);
        const err = centsBetween(r.freq, f);
        assert.ok(Math.abs(err) < 0.5, `${name} ${detune}c @${sr}: error ${err.toFixed(2)} cents`);
      }
    }
  }
});

test('cuerdas al aire de bajo (hasta el Si grave): error menor a 0,5 cents', () => {
  for (const sr of SAMPLE_RATES) {
    const det = detectorFor('bass', sr);
    const n = windowSize('bass', sr);
    for (const name of allNotes('bass')) {
      const f0 = midiToFreq(parseNote(name).midi);
      for (const detune of [-22, 0, 6]) {
        const f = f0 * Math.pow(2, detune / 1200);
        const r = det.detect(pluck(f, sr, n, { seed: detune + 7 }));
        assert.ok(r.freq > 0, `${name} ${detune}c @${sr}: sin detección`);
        const err = centsBetween(r.freq, f);
        assert.ok(Math.abs(err) < 0.5, `${name} ${detune}c @${sr}: error ${err.toFixed(2)} cents`);
      }
    }
  }
});

test('bajo con la fundamental casi ausente (micrófono de celular)', () => {
  for (const sr of SAMPLE_RATES) {
    const det = detectorFor('bass', sr);
    const n = windowSize('bass', sr);
    for (const name of ['B0', 'E1', 'A1', 'D2']) {
      const f = midiToFreq(parseNote(name).midi);
      for (const fundamentalGain of [0.05, 0]) {
        const r = det.detect(pluck(f, sr, n, { fundamentalGain, seed: 3 }));
        const err = centsBetween(r.freq, f);
        assert.ok(Math.abs(err) < 1, `${name} gain ${fundamentalGain} @${sr}: ${r.freq.toFixed(2)} Hz (error ${err.toFixed(1)} cents)`);
      }
    }
  }
});

test('armónicos impares débiles: no salta una octava arriba', () => {
  const sr = 48000;
  for (const instrument of ['guitar', 'bass']) {
    const det = detectorFor(instrument, sr);
    const n = windowSize(instrument, sr);
    for (const name of INSTRUMENTS[instrument].tunings[0].notes) {
      const f = midiToFreq(parseNote(name).midi);
      const r = det.detect(pluck(f, sr, n, { evenOnly: true, seed: 11 }));
      const err = centsBetween(r.freq, f);
      assert.ok(Math.abs(err) < 2, `${name}: ${r.freq.toFixed(2)} Hz (error ${err.toFixed(1)} cents)`);
    }
  }
});

test('con ruido de sala: cada lectura dentro de ±2,5 cents (SNR 20 dB) y el promedio dentro de ±1,5 (SNR 14 dB)', () => {
  const sr = 48000;
  for (const instrument of ['guitar', 'bass']) {
    const det = detectorFor(instrument, sr);
    const n = windowSize(instrument, sr);
    for (const name of INSTRUMENTS[instrument].tunings[0].notes) {
      const f = midiToFreq(parseNote(name).midi);
      let worst = 0;
      let sum = 0;
      const frames = 12;
      for (let seed = 0; seed < frames; seed++) {
        const quiet = det.detect(pluck(f, sr, n, { noise: 0.1, seed: 500 + seed }));
        assert.ok(quiet.freq > 0, `${name} seed ${seed}: sin detección`);
        worst = Math.max(worst, Math.abs(centsBetween(quiet.freq, f)));
        const loud = det.detect(pluck(f, sr, n, { noise: 0.2, seed: 900 + seed }));
        assert.ok(loud.freq > 0, `${name} seed ${seed}: sin detección con ruido fuerte`);
        sum += centsBetween(loud.freq, f);
      }
      assert.ok(worst < 2.5, `${name}: peor error ${worst.toFixed(2)} cents`);
      assert.ok(Math.abs(sum / frames) < 1.5, `${name}: error medio ${(sum / frames).toFixed(2)} cents`);
    }
  }
});

test('cuerda real con inarmonicidad: la lectura queda cerca de la fundamental', () => {
  const sr = 48000;
  const det = detectorFor('guitar', sr);
  const n = windowSize('guitar', sr);
  for (const [name, B] of [['E2', 0.00006], ['A2', 0.00005], ['G3', 0.0001], ['E4', 0.00008]]) {
    const f = midiToFreq(parseNote(name).midi);
    const r = det.detect(pluck(f, sr, n, { inharmonicity: B, seed: 21 }));
    const err = centsBetween(r.freq, f);
    assert.ok(err > -1 && err < 6, `${name}: error ${err.toFixed(2)} cents`);
  }
});

test('silencio y ruido puro no producen notas', () => {
  const sr = 48000;
  const det = detectorFor('guitar', sr);
  const n = windowSize('guitar', sr);
  assert.equal(det.detect(new Float32Array(n)).freq, 0);
  const rand = rng(99);
  let confident = 0;
  for (let trial = 0; trial < 40; trial++) {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = (rand() - 0.5) * 0.2;
    const r = det.detect(x);
    if (r.freq > 0 && r.clarity >= 0.82) confident++;
  }
  assert.equal(confident, 0);
});

test('rango cromático: de 33 Hz a 1,3 kHz', () => {
  for (const sr of SAMPLE_RATES) {
    const det = detectorFor('chromatic', sr);
    const n = windowSize('chromatic', sr);
    for (let midi = 24; midi <= 89; midi += 3) {
      const f = midiToFreq(midi) * 1.004;
      const r = det.detect(pluck(f, sr, n, { harmonics: 6, seed: midi }));
      const err = centsBetween(r.freq, f);
      assert.ok(Math.abs(err) < 0.6, `midi ${midi} @${sr}: ${r.freq.toFixed(2)} vs ${f.toFixed(2)} (error ${err.toFixed(2)})`);
    }
  }
});

test('otras frecuencias de muestreo (16 kHz bluetooth, 96 kHz)', () => {
  for (const sr of [16000, 22050, 32000, 96000]) {
    const det = detectorFor('bass', sr);
    const n = windowSize('bass', sr);
    for (const name of ['E1', 'G2']) {
      const f = midiToFreq(parseNote(name).midi);
      const r = det.detect(pluck(f, sr, n, { seed: 5 }));
      const err = centsBetween(r.freq, f);
      assert.ok(Math.abs(err) < 1, `${name} @${sr}: error ${err.toFixed(2)} cents`);
    }
  }
});

test('notas: nombres, MIDI y frecuencias', () => {
  assert.equal(parseNote('A4').midi, 69);
  assert.equal(parseNote('E2').midi, 40);
  assert.equal(parseNote('Eb2').midi, 39);
  assert.equal(parseNote('B0').midi, 23);
  assert.ok(Math.abs(midiToFreq(40) - 82.4069) < 0.001);
  assert.ok(Math.abs(midiToFreq(69, 442) - 442) < 1e-9);
  assert.deepEqual(noteLabel(parseNote('F#3'), 'lat'), { base: 'Fa', acc: '♯', octave: 3, text: 'Fa♯' });
  assert.equal(noteLabel(parseNote('Bb3'), 'en').text, 'B♭');
  const n = nearestNote(446, 440);
  assert.equal(n.note.letter, 'A');
  assert.ok(Math.abs(n.cents - 23.45) < 0.1);
});

test('asignación de cuerdas', () => {
  const freqs = INSTRUMENTS.guitar.tunings[0].notes.map((s) => midiToFreq(parseNote(s).midi));
  // Automático: cuerda más cercana.
  assert.equal(assignString(110.5, freqs).index, 1);
  assert.ok(Math.abs(assignString(110.5, freqs).cents - 7.85) < 0.1);
  // Armónico del traste 12 de la sexta: sigue siendo la sexta.
  const harm = assignString(freqs[0] * 2.006, freqs);
  assert.equal(harm.index, 0);
  assert.ok(harm.folded && Math.abs(harm.cents - 5.2) < 0.2);
  // Cuerda fijada: mide contra esa cuerda aunque otra esté más cerca.
  const locked = assignString(100, freqs, { locked: 0 });
  assert.equal(locked.index, 0);
  assert.ok(locked.cents > 300);
  // Histéresis: no cambia de cuerda por poca diferencia.
  const mid = Math.sqrt(freqs[0] * freqs[1]) * 1.01;
  assert.equal(assignString(mid, freqs, { current: 0 }).index, 0);
  assert.equal(assignString(mid, freqs).index, 1);
  // Bajo de 5: si el micrófono devuelve la octava del Si grave, se pliega.
  const bass = INSTRUMENTS.bass.tunings[1].notes.map((s) => midiToFreq(parseNote(s).midi));
  const low = assignString(bass[0] * 2 * 0.996, bass);
  assert.equal(low.index, 0);
  assert.ok(Math.abs(low.cents + 6.9) < 0.2);
});

test('estabilizador: ignora saltos aislados y retiene la última nota', () => {
  const tr = new NoteTracker();
  let t = 0;
  let out = null;
  for (let i = 0; i < 6; i++) out = tr.push(110 + (i % 2) * 0.02, 0.95, (t += 40));
  assert.ok(Math.abs(out.freq - 110.01) < 0.02 && out.live);
  out = tr.push(220, 0.95, (t += 40)); // salto aislado
  assert.ok(Math.abs(out.freq - 110.01) < 0.02);
  out = tr.push(110, 0.95, (t += 40));
  assert.ok(Math.abs(out.freq - 110.01) < 0.02);
  // Nota nueva confirmada por dos lecturas seguidas.
  tr.push(146.8, 0.95, (t += 40));
  out = tr.push(146.9, 0.95, (t += 40));
  assert.ok(Math.abs(out.freq - 146.85) < 0.1);
  // Sin señal: retiene y después suelta.
  out = tr.push(0, 0, (t += 600));
  assert.ok(out && !out.live);
  out = tr.push(0, 0, (t += 1200));
  assert.equal(out, null);
  // Lecturas poco claras no cuentan.
  assert.equal(tr.push(200, 0.4, (t += 40)), null);
});
