// Prueba de punta a punta: Chromium real, con un archivo de audio como micrófono.
// Correr con:  npm run test:e2e   (necesita Playwright:  npm i -D playwright)
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = process.env.SHOTS_DIR || '';
const SAMPLE_RATE = 48000;

// ---------- Audio sintético ----------

/** Cuerda pulsada que se repite cada `period` segundos. */
function pluckWav(freq, { seconds = 6, period = 3, fundamentalGain = 1, noise = 0.004 } = {}) {
  const n = Math.round(seconds * SAMPLE_RATE);
  const data = new Float32Array(n);
  let seed = 12345;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    const t = (i / SAMPLE_RATE) % period;
    let v = 0;
    for (let k = 1; k <= 10; k++) {
      const f = k * freq;
      if (f > 9000) break;
      const amp = (k === 1 ? fundamentalGain : 1) / Math.pow(k, 1.1);
      v += amp * Math.exp(-(0.5 + 0.18 * k) * t) * Math.sin(2 * Math.PI * f * t + k);
    }
    const attack = Math.min(1, t / 0.004);
    data[i] = 0.22 * attack * v + noise * (rand() - 0.5);
  }
  return encodeWav(data);
}

function silenceWav(seconds = 3) {
  return encodeWav(new Float32Array(Math.round(seconds * SAMPLE_RATE)));
}

function encodeWav(samples) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buffer;
}

const cents = (c) => Math.pow(2, c / 1200);

// ---------- Servidor estático ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.join(root, pathname);
    if (!file.startsWith(root)) throw new Error('fuera de la raíz');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('no encontrado');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

// ---------- Escenarios ----------

const workdir = await mkdtemp(path.join(tmpdir(), 'random-tune-'));
if (shotsDir) await mkdir(shotsDir, { recursive: true });

async function scenario(name, wav, run, { viewport = { width: 390, height: 844 } } = {}) {
  const wavPath = path.join(workdir, `${name}.wav`);
  await writeFile(wavPath, wav);
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const shot = async (suffix = '') => {
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}${suffix}.png`) });
  };
  try {
    await page.goto(base);
    await run(page, shot);
    assert.deepEqual(errors, [], 'errores en la consola');
    console.log(`✔ ${name}`);
  } catch (error) {
    await shot('-FALLO');
    console.error(`✖ ${name}\n  ${error.message}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

const state = (page) =>
  page.evaluate(() => {
    const app = document.getElementById('app');
    const text = (id) => document.getElementById(id).textContent;
    return {
      state: app.dataset.state,
      tune: app.dataset.tune,
      note: text('noteBase') + text('noteAcc') + text('noteOct'),
      cents: text('cents'),
      hz: text('hz'),
      hint: text('hint'),
      active: [...document.querySelectorAll('.string.is-active .string-num')].map((e) => e.textContent),
      tuned: [...document.querySelectorAll('.string.is-tuned .string-num')].map((e) => e.textContent),
      locked: [...document.querySelectorAll('.string.is-locked .string-num')].map((e) => e.textContent),
    };
  });

const start = async (page) => {
  await page.click('#btnStart');
  await page.waitForFunction(() => document.getElementById('app').dataset.state === 'listening');
};

/** Espera a que haya una lectura estable. */
const reading = async (page) => {
  await page.waitForFunction(() => document.getElementById('app').dataset.tune !== 'none', null, { timeout: 8000 });
  await page.waitForTimeout(600);
  return state(page);
};

const centsValue = (s) => Number(s.cents.replace('−', '-').replace(/[^\d.+-]/g, ''));

await scenario('01-inicio', silenceWav(), async (page, shot) => {
  const s = await state(page);
  assert.equal(s.state, 'idle');
  await shot();
  await start(page);
  await page.waitForTimeout(400);
  const listening = await state(page);
  assert.equal(listening.tune, 'none');
  assert.equal(listening.hint, 'Tocá una cuerda');
  await shot('-escuchando');
});

await scenario('02-guitarra-sexta-baja', pluckWav(82.4069 * cents(-12)), async (page, shot) => {
  await start(page);
  const s = await reading(page);
  assert.equal(s.note, 'E2');
  assert.equal(s.tune, 'flat');
  assert.ok(Math.abs(centsValue(s) + 12) <= 1, `cents: ${s.cents}`);
  assert.equal(s.hint, '↑ Subí un poco');
  assert.deepEqual(s.active, ['6ª']);
  assert.deepEqual(s.tuned, []);
  await shot();
});

await scenario('03-guitarra-quinta-afinada', pluckWav(110 * cents(0.6)), async (page, shot) => {
  await start(page);
  const s = await reading(page);
  assert.equal(s.note, 'A2');
  assert.equal(s.tune, 'in');
  assert.equal(s.hint, 'Afinada');
  await page.waitForFunction(() => document.querySelector('.string.is-tuned'));
  assert.deepEqual((await state(page)).tuned, ['5ª']);
  await page.waitForTimeout(900); // que termine la animación del destello
  await shot();
});

await scenario('04-guitarra-muy-alta', pluckWav(196 * cents(64)), async (page, shot) => {
  await start(page);
  const s = await reading(page);
  assert.equal(s.note, 'G3');
  assert.equal(s.tune, 'sharp');
  assert.equal(s.hint, '↓ Muy alta');
  assert.ok(Math.abs(centsValue(s) - 64) <= 1, `cents: ${s.cents}`);
  await shot();
});

await scenario('05-bajo-5-si-grave', pluckWav(30.8677 * cents(7), { fundamentalGain: 0.15, period: 3.5 }), async (page, shot) => {
  await page.click('.mode[data-instrument="bass"]');
  await page.click('#btnTuning');
  await page.waitForSelector('#sheetTuning[open]');
  await shot('-afinaciones');
  await page.click('button[data-tuning="five"]');
  await start(page);
  const s = await reading(page);
  assert.equal(s.note, 'B0');
  assert.equal(s.tune, 'sharp');
  assert.ok(Math.abs(centsValue(s) - 7) <= 1.5, `cents: ${s.cents}`);
  assert.deepEqual(s.active, ['5ª']);
  await shot();
});

await scenario('06-cromatico', pluckWav(446), async (page, shot) => {
  await page.click('.mode[data-instrument="chromatic"]');
  await start(page);
  const s = await reading(page);
  assert.equal(s.note, 'A4');
  assert.ok(Math.abs(centsValue(s) - 23) <= 1, `cents: ${s.cents}`);
  await shot();
});

await scenario('07-cuerda-fijada-con-armonico', pluckWav(82.4069 * 2 * cents(4)), async (page, shot) => {
  await page.click('.string[data-index="0"]');
  assert.deepEqual((await state(page)).locked, ['6ª']);
  await start(page);
  assert.equal((await state(page)).hint, 'Tocá la 6ª cuerda');
  const s = await reading(page);
  assert.equal(s.note, 'E2');
  assert.ok(Math.abs(centsValue(s) - 4) <= 1, `cents: ${s.cents}`);
  await shot();
});

await scenario('08-ajustes-y-notacion', pluckWav(146.832 * cents(-30)), async (page, shot) => {
  await page.click('#btnSettings');
  await page.waitForSelector('#sheetSettings[open]');
  await page.waitForTimeout(350);
  await shot('-ajustes');
  await page.click('[data-notation="lat"]');
  await page.click('#a4Up');
  await page.click('#a4Up');
  assert.equal(await page.textContent('#a4Value'), '442 Hz');
  await page.click('#sheetSettings [data-close]');
  assert.match(await page.textContent('#tuningNotes'), /^Mi La Re Sol Si Mi · 442 Hz$/);
  await start(page);
  const s = await reading(page);
  assert.equal(s.note, 'Re3');
  // Con La = 442 Hz, la misma cuerda queda unos 8 cents más baja.
  assert.ok(Math.abs(centsValue(s) + 37.8) <= 1.5, `cents: ${s.cents}`);
  await shot();
  // Las preferencias quedan guardadas.
  await page.reload();
  assert.match(await page.textContent('#tuningNotes'), /442 Hz/);
});

await scenario('09-compartir', silenceWav(), async (page, shot) => {
  await page.click('#btnShare');
  await page.waitForSelector('#sheetShare[open]');
  await page.waitForSelector('#qr svg path');
  await page.waitForTimeout(350);
  const modules = await page.evaluate(() => document.querySelector('#qr svg').viewBox.baseVal.width);
  assert.ok(modules >= 21, 'el QR tiene módulos');
  await shot();
});

await scenario(
  '10-pantalla-chica',
  pluckWav(246.942 * cents(-22)),
  async (page, shot) => {
    await start(page);
    const s = await reading(page);
    assert.equal(s.note, 'B3');
    const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    assert.ok(overflow <= 0, `la pantalla desborda ${overflow}px`);
    await shot();
  },
  { viewport: { width: 375, height: 553 } },
);

server.close();
if (process.exitCode) console.error('\nHubo escenarios con fallas.');
else console.log('\nTodos los escenarios pasaron.');
