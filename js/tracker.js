/**
 * Random Tune — estabilización de lecturas.
 *
 * Convierte las detecciones cuadro a cuadro en una lectura estable:
 * mediana recortada sobre las últimas lecturas, rechazo de saltos aislados
 * (el ataque de la púa, un golpe en la caja) y retención breve de la última
 * nota cuando la cuerda se apaga, para que se pueda leer.
 */
export class NoteTracker {
  constructor(opts = {}) {
    this.size = opts.size ?? 5;
    this.minClarity = opts.minClarity ?? 0.82;
    this.jumpCents = opts.jumpCents ?? 70;
    this.holdMs = opts.holdMs ?? 1500;
    this.liveMs = opts.liveMs ?? 180;
    this.reset();
  }

  reset() {
    this.window = [];
    this.pending = [];
    this.lastValid = -Infinity;
  }

  /**
   * @param {number} freq     Frecuencia detectada (0 si no hubo).
   * @param {number} clarity  0..1
   * @param {number} now      Tiempo en ms.
   * @returns {{freq: number, live: boolean} | null}
   */
  push(freq, clarity, now) {
    if (freq > 0 && clarity >= this.minClarity) {
      const value = Math.log2(freq);
      if (this.window.length === 0) {
        this.window.push(value);
      } else {
        const diff = 1200 * Math.abs(value - median(this.window));
        if (diff > this.jumpCents) {
          // Nota nueva: hace falta que dos lecturas seguidas coincidan.
          const prev = this.pending[this.pending.length - 1];
          if (prev !== undefined && 1200 * Math.abs(value - prev) < 50) {
            this.window = [prev, value];
            this.pending = [];
          } else {
            this.pending = [value];
            return this._output(now);
          }
        } else {
          this.window.push(value);
          if (this.window.length > this.size) this.window.shift();
          this.pending = [];
        }
      }
      this.lastValid = now;
    }
    return this._output(now);
  }

  _output(now) {
    if (this.window.length === 0) return null;
    const age = now - this.lastValid;
    if (age > this.holdMs) {
      this.reset();
      return null;
    }
    return { freq: Math.pow(2, trimmedMean(this.window)), live: age <= this.liveMs };
  }
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Media sin el valor más alto ni el más bajo (cuando hay suficientes). */
function trimmedMean(values) {
  if (values.length < 4) return median(values);
  const s = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (let i = 1; i < s.length - 1; i++) sum += s[i];
  return sum / (s.length - 2);
}
