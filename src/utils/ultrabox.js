// UltraBox instruments. The engine (public/vendor/ultrabox_synth.js, MIT, see ULTRABOX_LICENSE.md)
// renders each note offline into an AudioBuffer, which the normal scheduler then plays like any
// other buffer. Presets (public/vendor/ultrabox_presets.json) are the parameter sets UltraBox
// ships with; the engine is what turns them into sound.
import index from './ultraboxIndex.json';

export const UB_PREFIX = 'ub:';
export const isUltrabox = (id) => typeof id === 'string' && id.startsWith(UB_PREFIX);
export const ULTRABOX_INSTRUMENTS = index; // [{ id, cat, name }]

const BASE = import.meta.env.BASE_URL + 'vendor/';
const SR = 44100;
const OUTPUT_GAIN = 0.25; // the engine renders loud (peaks up to ~2)
const TAIL_SEC = 1.4;     // release / reverb tail rendered after the note ends
const MAX_CACHE = 800;

// ---- instruments you edited or saved yourself (kept in this browser) ----
const CUSTOM_KEY = 'guitar-roll-ub-custom';
export const CUSTOM_PREFIX = UB_PREFIX + 'Custom/';
export function loadCustomUltrabox() {
  try { const l = JSON.parse(localStorage.getItem(CUSTOM_KEY)); return Array.isArray(l) ? l : []; } catch { return []; }
}
function writeCustom(list) { try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); } catch { /* ignore */ } }
export const isCustomUltrabox = (id) => typeof id === 'string' && id.startsWith(CUSTOM_PREFIX);
export function saveCustomUltrabox(id, name, settings) {
  const list = loadCustomUltrabox().filter(c => c.id !== id);
  list.push({ id, name, settings });
  writeCustom(list);
  invalidateUltrabox(id);
}
export function deleteCustomUltrabox(id) {
  writeCustom(loadCustomUltrabox().filter(c => c.id !== id));
  invalidateUltrabox(id);
}
export function uniqueCustomId(name) {
  const taken = new Set(loadCustomUltrabox().map(c => c.id));
  let id = CUSTOM_PREFIX + name, n = 2;
  while (taken.has(id) || ULTRABOX_INSTRUMENTS.some(u => u.id === id)) id = `${CUSTOM_PREFIX}${name} ${n++}`;
  return id;
}
// The parameter set of any UltraBox instrument (built-in preset or your own), or null.
export function getUltraboxSettings(id) {
  const c = loadCustomUltrabox().find(x => x.id === id);
  if (c) return c.settings;
  return presets?.get(id)?.settings || null;
}
export const ultraboxName = (id) => loadCustomUltrabox().find(c => c.id === id)?.name
  || ULTRABOX_INSTRUMENTS.find(u => u.id === id)?.name || id;

let engine = null;
let presets = null;
let loading = null;

export const ultraboxReady = () => !!(engine && presets);

export function loadUltrabox() {
  if (loading) return loading;
  loading = (async () => {
    if (!window.beepbox) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = BASE + 'ultrabox_synth.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Could not load the UltraBox engine'));
        document.head.appendChild(s);
      });
    }
    const res = await fetch(BASE + 'ultrabox_presets.json');
    if (!res.ok) throw new Error('Could not load the UltraBox presets');
    const list = await res.json();
    presets = new Map(list.map(p => [p.id, p]));
    engine = window.beepbox;
  })().catch((err) => { loading = null; console.warn('[ultrabox]', err); throw err; });
  return loading;
}

// Render lengths are bucketed (and rounded down) so equal pitch/length notes share one render.
function durationBucket(d) {
  const x = Math.min(6, Math.max(0.05, d));
  return x < 1 ? Math.max(0.05, Math.floor(x * 20) / 20) : Math.floor(x * 4) / 4;
}

function renderRaw(preset, midi, dur) {
  const bpm = 120, tpb = 4;
  const secPerTick = 60 / bpm / tpb;
  const ticks = Math.max(1, Math.round(dur / secPerTick));
  const beatsPerBar = Math.max(8, Math.ceil(ticks / tpb) + 4);
  const inst = JSON.parse(JSON.stringify(preset.settings));
  const drums = inst.type === 'drumset'; // drum sounds live on a noise channel, one pitch per drum
  const song = {
    format: 'UltraBox', version: 5, scale: 'Free', key: 'C', keyOctave: 0, introBars: 0, loopBars: 1,
    beatsPerBar, ticksPerBeat: tpb, beatsPerMinute: bpm, reverb: 0, masterGain: 100,
    layeredInstruments: false, patternInstruments: false,
    channels: [{
      type: drums ? 'noise' : 'pitch', name: '', octaveScrollBar: 0, sequence: [1],
      instruments: [Object.assign({ volume: 0 }, inst)],
      patterns: [{ notes: [{
        pitches: [drums ? midi % 12 : midi - 12], // the engine's pitch 0 is MIDI 12
        points: [{ tick: 0, pitchBend: 0, volume: 100, forMod: false }, { tick: ticks, pitchBend: 0, volume: 100, forMod: false }],
        continuesLastPattern: false,
      }] }],
    }],
  };
  const so = new engine.Song();
  so.fromJsonObject(song);
  const synth = new engine.Synth(so);
  synth.loopRepeatCount = -1;
  const n = Math.round((ticks * secPerTick + TAIL_SEC) * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  synth.isPlayingSong = true;
  synth.synthesize(L, R, n, true);
  return { L, R, n };
}

const cache = new Map(); // key -> AudioBuffer (insertion order = age)
function invalidateUltrabox(id) {
  for (const k of [...cache.keys()]) if (k.startsWith(id + '|')) cache.delete(k);
}

function keyOf(id, midi, bucket) { return `${id}|${midi}|${bucket}`; }

// Returns the buffer for a note (rendering it now if needed), or null when the engine isn't
// loaded yet or the preset is unknown / silent.
export function getNoteBuffer(ctx, id, midi, duration) {
  if (!ultraboxReady()) return null;
  const settings = getUltraboxSettings(id);
  if (!settings) return null;
  const preset = { settings };
  const bucket = durationBucket(duration);
  const key = keyOf(id, midi, bucket);
  let buf = cache.get(key);
  if (buf) { cache.delete(key); cache.set(key, buf); return buf; }
  let r;
  try { r = renderRaw(preset, midi, bucket); } catch (e) { console.warn('[ultrabox] render failed', id, e); return null; }
  buf = ctx.createBuffer(2, r.n, SR);
  buf.getChannelData(0).set(r.L);
  buf.getChannelData(1).set(r.R);
  cache.set(key, buf);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  return buf;
}

// Play one note: pitched, with the usual guitar-roll bend / slide done as a detune ramp.
export function playUltraboxNote(ctx, out, id, midi, startTime, duration, gain, noteProps, slideSemis) {
  const buf = getNoteBuffer(ctx, id, midi, duration);
  if (!buf) { loadUltrabox().catch(() => {}); return false; }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain * OUTPUT_GAIN / 0.3, startTime);
  src.connect(g);
  g.connect(out);
  if (noteProps && noteProps.bend > 0) {
    src.detune.setValueAtTime(0, startTime);
    src.detune.linearRampToValueAtTime(noteProps.bend * 100, startTime + duration * 0.4);
  }
  if (slideSemis) {
    src.detune.setValueAtTime(0, startTime);
    src.detune.linearRampToValueAtTime(slideSemis * 100, startTime + duration * 0.85);
  }
  src.start(startTime);
  return true;
}

// Render a track's notes ahead of time in small slices so playback finds them in the cache.
let warmQueue = [];
let warming = false;
export function prewarmNotes(ctx, id, items) { // items: [{ midi, duration }]
  if (!ultraboxReady()) return;
  const seen = new Set();
  for (const it of items) {
    const key = keyOf(id, it.midi, durationBucket(it.duration));
    if (seen.has(key) || cache.has(key)) continue;
    seen.add(key);
    warmQueue.push({ id, midi: it.midi, duration: it.duration });
  }
  if (warming || !warmQueue.length) return;
  warming = true;
  const step = () => {
    const t0 = performance.now();
    while (warmQueue.length && performance.now() - t0 < 12) {
      const w = warmQueue.shift();
      getNoteBuffer(ctx, w.id, w.midi, w.duration);
    }
    if (warmQueue.length) setTimeout(step, 0); else warming = false;
  };
  setTimeout(step, 0);
}
