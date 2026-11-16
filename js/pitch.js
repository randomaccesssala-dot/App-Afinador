/**
 * Random Tune — detección de altura (pitch).
 *
 * YIN (de Cheveigné & Kawahara, 2002) en etapas:
 *   1. Pasa-bajos: saca el ruido agudo que no aporta a la afinación.
 *   2. Búsqueda gruesa del período sobre la señal decimada: barata y robusta.
 *   3. Verificación de octava y refinamiento a la frecuencia de muestreo
 *      completa, con interpolación parabólica: precisión de décimas de cent.
 *
 * Trabaja en el dominio del tiempo, así que encuentra la fundamental aunque el
 * micrófono del celular casi no la capte (caso típico: cuerdas graves de bajo),
 * porque los armónicos conservan la periodicidad.
 */

/** Pasa-bajos FIR (sinc con ventana de Hamming) para decimar por `factor`. */
function designLowpass(factor) {
  const taps = 8 * factor + 1;
  const cutoff = 0.45 / factor; // ciclos por muestra, algo por debajo del nuevo Nyquist
  const h = new Float32Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = sinc * win;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

export class PitchDetector {
  /**
   * @param {number} sampleRate
   * @param {{minFreq?: number, maxFreq?: number, minRms?: number, minClarity?: number}} [opts]
   */
  constructor(sampleRate, opts = {}) {
    this.sampleRate = sampleRate;
    this.minFreq = opts.minFreq ?? 26;
    this.maxFreq = opts.maxFreq ?? 1400;
    this.minRms = opts.minRms ?? 0.0012;
    this.minClarity = opts.minClarity ?? 0.5;
    // Decimación: la mayor posible que deje ~16 muestras por período en la nota más aguda.
    const byRange = Math.round(sampleRate / (16 * this.maxFreq));
    const byRate = Math.round(sampleRate / 12000);
    this.decim = Math.max(1, Math.min(byRange, byRate));
    this.fir = this.decim > 1 ? designLowpass(this.decim) : null;
    this._xf = new Float32Array(0);
    this._y = new Float32Array(0);
    this._d = new Float32Array(0);
  }

  /**
   * @param {Float32Array} x  Ventana de audio mono, a `sampleRate`.
   * @returns {{freq: number, clarity: number, rms: number}}  `freq` es 0 si no hay nota clara.
   */
  detect(x) {
    const N = x.length;
    let mean = 0;
    for (let i = 0; i < N; i++) mean += x[i];
    mean /= N;
    let energy = 0;
    for (let i = 0; i < N; i++) {
      const v = x[i] - mean;
      energy += v * v;
    }
    const rms = Math.sqrt(energy / N);
    const none = { freq: 0, clarity: 0, rms };
    if (!(rms >= this.minRms)) return none;

    // --- Etapa 1: pasa-bajos a frecuencia completa (xf) y decimación (y) ---
    const D = this.decim;
    let xf = x;
    let Nf = N;
    let y = x;
    let M = N;
    if (D > 1) {
      const h = this.fir;
      const taps = h.length;
      Nf = N - taps + 1;
      if (Nf < 64) return none;
      if (this._xf.length < Nf) this._xf = new Float32Array(Nf);
      xf = this._xf;
      for (let i = 0; i < Nf; i++) {
        let acc = 0;
        for (let k = 0; k < taps; k++) acc += h[k] * x[i + k];
        xf[i] = acc;
      }
      M = Math.floor((Nf - 1) / D) + 1;
      if (this._y.length < M) this._y = new Float32Array(M);
      y = this._y;
      for (let m = 0, i = 0; m < M; m++, i += D) y[m] = xf[i];
    }

    // --- Etapa 2: YIN sobre la señal decimada ---
    const srd = this.sampleRate / D;
    const tauMax = Math.min(Math.floor(srd / this.minFreq) + 2, M >> 1);
    const tauMin = Math.max(2, Math.floor(srd / this.maxFreq) - 1);
    if (tauMax - tauMin < 4) return none;
    const W = M - tauMax;
    if (this._d.length < tauMax + 1) this._d = new Float32Array(tauMax + 1);
    const d = this._d;

    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) {
        const diff = y[j] - y[j + tau];
        sum += diff * diff;
      }
      running += sum;
      // Diferencia normalizada por la media acumulada (CMNDF).
      d[tau] = running > 0 ? (sum * tau) / running : 1;
    }

    // Primer valle "tan bueno como el mejor": evita tanto el error de octava
    // hacia arriba (un armónico) como hacia abajo (un subarmónico).
    let globalMin = Infinity;
    for (let tau = tauMin; tau < tauMax; tau++) if (d[tau] < globalMin) globalMin = d[tau];
    const threshold = globalMin + 0.07;
    let tau = -1;
    for (let t = tauMin; t < tauMax; t++) {
      if (d[t] <= threshold) {
        while (t + 1 < tauMax && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau <= tauMin || tau >= tauMax - 1) return none; // en el borde: no es un valle real
    const clarity = 1 - d[tau];
    if (clarity < this.minClarity) return { freq: 0, clarity: Math.max(0, clarity), rms };

    let period = (tau + parabolicShift(d[tau - 1], d[tau], d[tau + 1])) * D;

    // --- Etapa 3: verificación de octava y refinamiento a frecuencia completa ---
    // Si la mitad (o el tercio) del período es igual de periódica, la nota real
    // es más aguda: pasa con notas agudas, donde la búsqueda gruesa tiene poca
    // resolución y puede caer en un múltiplo del período.
    const minLag = this.sampleRate / this.maxFreq;
    let improved = true;
    while (improved) {
      improved = false;
      const here = normalizedDiffNear(xf, Nf, period);
      for (const k of [2, 3]) {
        const candidate = period / k;
        if (candidate < minLag || candidate < 4) continue;
        if (normalizedDiffNear(xf, Nf, candidate) <= here + 0.05) {
          period = candidate;
          improved = true;
          break;
        }
      }
    }

    const center = Math.round(period);
    const half = D + 1;
    const lo = Math.max(1, center - half);
    const hi = center + half;
    const Wf = Nf - hi - 1;
    if (Wf > 32) {
      let best = -1;
      let bestVal = Infinity;
      const vals = new Float64Array(hi - lo + 1);
      for (let lag = lo; lag <= hi; lag++) {
        let sum = 0;
        for (let j = 0; j < Wf; j++) {
          const diff = xf[j] - xf[j + lag];
          sum += diff * diff;
        }
        vals[lag - lo] = sum;
        if (sum < bestVal) {
          bestVal = sum;
          best = lag;
        }
      }
      const i = best - lo;
      if (i > 0 && i < vals.length - 1) {
        period = best + parabolicShift(vals[i - 1], vals[i], vals[i + 1]);
      }
    }

    const freq = this.sampleRate / period;
    if (!(freq > 0) || !Number.isFinite(freq)) return none;
    return { freq, clarity, rms };
  }
}

/**
 * Diferencia normalizada (0 = periódica perfecta, ~1 = sin relación) en el
 * retardo entero más favorable alrededor de `lag`.
 */
function normalizedDiffNear(x, n, lag) {
  const center = Math.round(lag);
  let best = 2;
  for (let l = Math.max(1, center - 1); l <= center + 1; l++) {
    const w = n - l;
    if (w < 32) continue;
    let diff = 0;
    let power = 0;
    for (let j = 0; j < w; j++) {
      const a = x[j];
      const b = x[j + l];
      diff += (a - b) * (a - b);
      power += a * a + b * b;
    }
    const v = power > 0 ? (2 * diff) / power : 2;
    if (v < best) best = v;
  }
  return best;
}

/** Desplazamiento del mínimo de la parábola que pasa por tres puntos equiespaciados. */
function parabolicShift(a, b, c) {
  const denom = a - 2 * b + c;
  if (!(denom > 0)) return 0;
  const shift = (0.5 * (a - c)) / denom;
  return shift > 1 ? 1 : shift < -1 ? -1 : shift;
}
