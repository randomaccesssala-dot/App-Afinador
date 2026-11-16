/**
 * Random Tune — notas, afinaciones y asignación de cuerdas.
 */

const SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LATIN = { C: 'Do', D: 'Re', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };

/** 'Eb2' | 'F#3' | 'A4' → { letter, acc, octave, midi } */
export function parseNote(str) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(str);
  if (!m) throw new Error(`Nota inválida: ${str}`);
  const [, letter, acc, oct] = m;
  const octave = Number(oct);
  const midi = 12 * (octave + 1) + SEMITONE[letter] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0);
  return { letter, acc, octave, midi };
}

/** Número MIDI → { letter, acc, octave, midi } (con sostenidos). */
export function describeMidi(midi) {
  const name = SHARP_NAMES[((midi % 12) + 12) % 12];
  return { letter: name[0], acc: name[1] || '', octave: Math.floor(midi / 12) - 1, midi };
}

export function midiToFreq(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export function freqToMidi(freq, a4 = 440) {
  return 69 + 12 * Math.log2(freq / a4);
}

export function centsBetween(freq, ref) {
  return 1200 * Math.log2(freq / ref);
}

/** Partes para mostrar una nota: nombre base y alteración, según la notación elegida. */
export function noteLabel(note, notation = 'en') {
  const base = notation === 'lat' ? LATIN[note.letter] : note.letter;
  const acc = note.acc === '#' ? '♯' : note.acc === 'b' ? '♭' : '';
  return { base, acc, octave: note.octave, text: base + acc };
}

export const INSTRUMENTS = {
  guitar: {
    label: 'Guitarra',
    minFreq: 50,
    maxFreq: 1100,
    windowMs: 120,
    tunings: [
      { id: 'standard', name: 'Estándar', notes: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
      { id: 'drop-d', name: 'Drop D', notes: ['D2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
      { id: 'half-down', name: 'Medio tono abajo', notes: ['Eb2', 'Ab2', 'Db3', 'Gb3', 'Bb3', 'Eb4'] },
      { id: 'whole-down', name: 'Un tono abajo', notes: ['D2', 'G2', 'C3', 'F3', 'A3', 'D4'] },
      { id: 'drop-c', name: 'Drop C', notes: ['C2', 'G2', 'C3', 'F3', 'A3', 'D4'] },
      { id: 'dadgad', name: 'DADGAD', notes: ['D2', 'A2', 'D3', 'G3', 'A3', 'D4'] },
      { id: 'open-g', name: 'Sol abierto', notes: ['D2', 'G2', 'D3', 'G3', 'B3', 'D4'] },
      { id: 'open-d', name: 'Re abierto', notes: ['D2', 'A2', 'D3', 'F#3', 'A3', 'D4'] },
      { id: 'open-e', name: 'Mi abierto', notes: ['E2', 'B2', 'E3', 'G#3', 'B3', 'E4'] },
      { id: 'seven', name: '7 cuerdas', notes: ['B1', 'E2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
    ],
  },
  bass: {
    label: 'Bajo',
    minFreq: 26,
    maxFreq: 520,
    windowMs: 175,
    tunings: [
      { id: 'standard', name: '4 cuerdas', notes: ['E1', 'A1', 'D2', 'G2'] },
      { id: 'five', name: '5 cuerdas', notes: ['B0', 'E1', 'A1', 'D2', 'G2'] },
      { id: 'drop-d', name: 'Drop D', notes: ['D1', 'A1', 'D2', 'G2'] },
      { id: 'half-down', name: 'Medio tono abajo', notes: ['Eb1', 'Ab1', 'Db2', 'Gb2'] },
      { id: 'whole-down', name: 'Un tono abajo', notes: ['D1', 'G1', 'C2', 'F2'] },
      { id: 'drop-c', name: 'Drop C', notes: ['C1', 'G1', 'C2', 'F2'] },
      { id: 'five-high-c', name: '5 cuerdas con Do agudo', notes: ['E1', 'A1', 'D2', 'G2', 'C3'] },
      { id: 'six', name: '6 cuerdas', notes: ['B0', 'E1', 'A1', 'D2', 'G2', 'C3'] },
    ],
  },
  chromatic: {
    label: 'Cromático',
    minFreq: 26,
    maxFreq: 1500,
    windowMs: 175,
    tunings: [],
  },
};

/**
 * Decide a qué cuerda corresponde una frecuencia y cuántos cents se desvía.
 *
 * - Con una cuerda fijada (`locked`), todo se mide contra esa cuerda. Si lo que
 *   suena está a una o dos octavas (un armónico natural, o un error de octava
 *   del micrófono en cuerdas muy graves) se pliega a la octava de la cuerda.
 * - En automático gana la cuerda más cercana, con algo de histéresis para que
 *   no salte entre dos cuerdas vecinas.
 *
 * @param {number} freq
 * @param {number[]} stringFreqs  Frecuencias objetivo, de la cuerda más grave a la más aguda.
 * @param {{locked?: number, current?: number}} [opts]
 * @returns {{index: number, cents: number, folded: boolean}}
 */
export function assignString(freq, stringFreqs, opts = {}) {
  const locked = opts.locked ?? -1;
  const current = opts.current ?? -1;

  if (locked >= 0 && locked < stringFreqs.length) {
    const raw = centsBetween(freq, stringFreqs[locked]);
    let cents = raw;
    let folded = false;
    for (const k of [1, 2, -1]) {
      const c = raw - 1200 * k;
      if (Math.abs(c) < 60 && Math.abs(c) < Math.abs(cents)) {
        cents = c;
        folded = true;
      }
    }
    return { index: locked, cents, folded };
  }

  let index = 0;
  let cents = Infinity;
  for (let i = 0; i < stringFreqs.length; i++) {
    const c = centsBetween(freq, stringFreqs[i]);
    if (Math.abs(c) < Math.abs(cents)) {
      cents = c;
      index = i;
    }
  }

  if (Math.abs(cents) > 100) {
    // Lejos de todas las cuerdas: ¿es el armónico de alguna?
    let best = null;
    for (const k of [1, 2]) {
      for (let i = 0; i < stringFreqs.length; i++) {
        const c = centsBetween(freq, stringFreqs[i]) - 1200 * k;
        if (Math.abs(c) <= 50 && (!best || Math.abs(c) < Math.abs(best.cents) - 1)) {
          best = { index: i, cents: c, folded: true };
        }
      }
      if (best) return best;
    }
  }

  if (current >= 0 && current < stringFreqs.length && current !== index) {
    const cur = centsBetween(freq, stringFreqs[current]);
    if (Math.abs(cur) <= Math.abs(cents) + 40) return { index: current, cents: cur, folded: false };
  }
  return { index, cents, folded: false };
}

/** Nota cromática más cercana: { note, cents, freq }. */
export function nearestNote(freq, a4 = 440) {
  const midi = Math.round(freqToMidi(freq, a4));
  const ref = midiToFreq(midi, a4);
  return { note: describeMidi(midi), cents: centsBetween(freq, ref), freq: ref };
}
