// Automatic transcription (draft generator).
//
// 1. The recording is resampled to 22.05 kHz mono and run through Spotify's Basic Pitch model
//    (Apache 2.0, loaded on demand), which gives per-frame pitch activations and note onsets.
// 2. Those become note events (start / length in seconds, MIDI pitch, strength) limited to the
//    guitar's range.
// 3. buildDraftNotes() puts the events on the project grid with the tempo map, groups chord notes,
//    picks a straight or triplet subdivision per bar, and fingers the result on the fretboard.
import { clipTimeToBeat, getClips } from './audioClips';
import { assignFretboardPositions } from './midiImport';
import { onsetTimes } from './beatDetect';

const MODEL_URL = () => `${import.meta.env.BASE_URL}vendor/basic-pitch/model.json`;
const SR = 22050;
const HOP = 256;
const FPS = SR / HOP;
// Basic Pitch time base (see its inference code): time of a model frame, with the small offset the
// model accumulates per 2-second window.
const ANNOT_FRAMES = Math.floor(SR / HOP) * 2;
const WINDOW_OFFSET = (HOP / SR) * (ANNOT_FRAMES - (SR * 2 - HOP) / HOP) + 0.0018;
export const frameToTime = (frame) => (frame * HOP) / SR - WINDOW_OFFSET * Math.floor(frame / ANNOT_FRAMES);
export const MIDI_OFFSET = 21; // activation column 0 = MIDI 21 (A0)

const cache = new WeakMap(); // AudioBuffer -> { frames, onsets, contours, seconds }
let modelPromise = null;

// Settings presets: how eagerly the model's activations are turned into notes.
export const SENSITIVITY = {
  strict:    { onsetThresh: 0.6,  frameThresh: 0.4,  label: 'Strict (fewer, surer notes)' },
  balanced:  { onsetThresh: 0.5,  frameThresh: 0.3,  label: 'Balanced' },
  sensitive: { onsetThresh: 0.35, frameThresh: 0.22, label: 'Sensitive (more notes, more mistakes)' },
};

// Mono, 22.05 kHz copy of the recording. The browser's own offline renderer does this best; some
// browsers refuse the odd sample rate, so there is a plain JavaScript fallback (average + decimate).
async function resampleMono(buffer) {
  if (buffer.sampleRate === SR && buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  try {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const length = Math.max(1, Math.ceil(buffer.duration * SR));
    const ctx = new Offline(1, length, SR); // mixing down to mono happens here
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start();
    const out = await ctx.startRendering();
    return out.getChannelData(0);
  } catch (err) {
    console.warn('[transcribe] offline resample failed, using the JS fallback', err);
  }
  const ratio = buffer.sampleRate / SR;
  const n = Math.max(1, Math.floor(buffer.length / ratio));
  const out = new Float32Array(n);
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.min(buffer.length, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let k = a; k < b; k++) for (let c = 0; c < chans.length; c++) sum += chans[c][k];
    out[i] = sum / ((b - a) * chans.length);
    if (i % 200000 === 0) await new Promise(r => setTimeout(r, 0)); // keep the page responsive
  }
  return out;
}

export const hasAnalysis = (buffer) => !!buffer && cache.has(buffer);
export const getAnalysis = (buffer) => (buffer ? cache.get(buffer) || null : null);

// Run the model (once per recording; the result is cached).
//   onProgress(fraction 0..1, info) with info = { stage, backend }
//   signal: an AbortSignal; aborting stops the run at the next 2-second window
export async function analyzeAudio(buffer, onProgress = () => {}, signal = null) {
  const hit = cache.get(buffer);
  if (hit) { onProgress(1, { stage: 'done' }); return hit; }
  const stop = () => { if (signal?.aborted) throw new Error('Cancelled'); };
  onProgress(0, { stage: 'loading the pitch model' });
  const { BasicPitch } = await import('@spotify/basic-pitch');
  const tf = await import('@tensorflow/tfjs');
  await tf.ready();
  const backend = tf.getBackend();
  stop();
  if (!modelPromise) modelPromise = Promise.resolve(new BasicPitch(MODEL_URL()));
  let bp;
  try { bp = await modelPromise; await bp.model; } catch (err) { modelPromise = null; throw new Error('Could not load the pitch model (' + (err.message || err) + ')'); }
  stop();
  onProgress(0, { stage: 'preparing the audio', backend });
  const mono = await resampleMono(buffer);
  stop();
  // The model reports its output in pieces (one per 2-second window): join them up.
  const result = { frames: [], onsets: [], contours: [] };
  await bp.evaluateModel(
    mono,
    (frames, onsets, contours) => {
      for (const row of frames) result.frames.push(row);
      for (const row of onsets) result.onsets.push(row);
      for (const row of contours) result.contours.push(row);
    },
    (p) => { stop(); onProgress(Math.min(0.99, p), { stage: 'listening', backend }); },
  );
  if (!result.frames.length) throw new Error('The pitch model returned nothing');
  result.seconds = buffer.duration;
  // The moments a string is really plucked, found independently of the pitch model. Used to check
  // the model's notes against the audio (a note should start with an attack).
  onProgress(0.99, { stage: 'finding the attacks', backend });
  await new Promise(r => setTimeout(r, 30)); // let the message paint before the synchronous work
  result.attacks = onsetTimes(buffer);
  cache.set(buffer, result);
  onProgress(1, { stage: 'done', backend });
  return result;
}

// Turn the model's activations into notes. This follows Basic Pitch's own decoder (peaks in the
// onset curve start notes, a note lasts while its pitch stays active, then leftover energy is
// picked up as extra notes) but runs on flat typed arrays and picks leftovers from a sorted list.
// The library version rescans the whole recording once per leftover note, which takes minutes
// (and freezes the page) on a long, noisy recording.
export function decodeNotes(frames, onsets, { onsetThresh, frameThresh, minLen, minIdx = 0, maxIdx = 87, energyTol = 11 }) {
  const T = frames.length, C = 88;
  if (T < 3) return [];
  const F = new Float32Array(T * C);
  const O = new Float32Array(T * C);
  for (let t = 0; t < T; t++) {
    const fr = frames[t], on = onsets[t];
    for (let c = minIdx; c <= maxIdx; c++) { F[t * C + c] = fr[c]; O[t * C + c] = on[c]; }
  }
  // onsets inferred from sudden rises in the frame activations
  let maxO = 0, maxD = 0;
  for (let i = 0; i < O.length; i++) if (O[i] > maxO) maxO = O[i];
  const D = new Float32Array(T * C);
  for (let t = 2; t < T; t++) {
    for (let c = 0; c < C; c++) {
      const d = Math.max(0, Math.min(F[t * C + c] - F[(t - 1) * C + c], F[t * C + c] - F[(t - 2) * C + c]));
      D[t * C + c] = d;
      if (d > maxD) maxD = d;
    }
  }
  if (maxD > 0) for (let i = 0; i < O.length; i++) { const v = (maxO * D[i]) / maxD; if (v > O[i]) O[i] = v; }

  // onset peaks (strictly above both neighbours in time)
  const peaks = [];
  for (let t = 0; t < T; t++) {
    for (let c = 0; c < C; c++) {
      const v = O[t * C + c];
      if (v <= onsetThresh) continue;
      if (t > 0 && v <= O[(t - 1) * C + c]) continue;
      if (t < T - 1 && v <= O[(t + 1) * C + c]) continue;
      peaks.push([t, c]);
    }
  }
  peaks.sort((a, b) => b[0] - a[0] || b[1] - a[1]); // latest first, as the original does

  const R = F.slice(); // energy not yet used by a note
  const zero = (t, c) => {
    R[t * C + c] = 0;
    if (c < 87) R[t * C + c + 1] = 0;
    if (c > 0) R[t * C + c - 1] = 0;
  };
  const meanAmp = (a, b, c) => { let sum = 0; for (let t = a; t < b; t++) sum += F[t * C + c]; return sum / Math.max(1, b - a); };
  const notes = [];
  for (const [t0, c] of peaks) {
    if (t0 >= T - 1) continue;
    let i = t0 + 1, k = 0;
    while (i < T - 1 && k < energyTol) { if (R[i * C + c] < frameThresh) k++; else k = 0; i++; }
    i -= k;
    if (i - t0 <= minLen) continue;
    for (let j = t0; j < i; j++) zero(j, c);
    notes.push({ startFrame: t0, durationFrames: i - t0, pitchMidi: c + MIDI_OFFSET, amplitude: meanAmp(t0, i, c) });
  }

  // leftover energy: strongest cell first, grow forwards and backwards from it
  const cand = [];
  for (let i = 0; i < R.length; i++) if (R[i] > frameThresh) cand.push(i);
  cand.sort((a, b) => R[b] - R[a]);
  for (const idx of cand) {
    if (!(R[idx] > frameThresh)) continue; // used up meanwhile
    const iMid = Math.floor(idx / C), c = idx % C;
    R[idx] = 0;
    let i = iMid + 1, k = 0;
    while (i < T - 1 && k < energyTol) { if (R[i * C + c] < frameThresh) k++; else k = 0; zero(i, c); i++; }
    const iEnd = i - 1 - k;
    i = iMid - 1; k = 0;
    while (i > 0 && k < energyTol) { if (R[i * C + c] < frameThresh) k++; else k = 0; zero(i, c); i--; }
    const iStart = i + 1 + k;
    if (iEnd - iStart <= minLen) continue;
    notes.push({ startFrame: iStart, durationFrames: iEnd - iStart, pitchMidi: c + MIDI_OFFSET, amplitude: meanAmp(iStart, iEnd, c) });
  }
  return notes;
}

// Note events from the activations: [{ start, end, midi, amp }] in seconds of the audio file.
export async function extractNoteEvents(analysis, {
  sensitivity = 'balanced', minNoteMs = 60, harmonicFilter = true,
  lowestMidi = 40, octaveDownFilter = true, bassStrength = 0.4, attackGate = 'bass',
} = {}) {
  await new Promise(r => setTimeout(r, 0)); // let any progress message paint first
  const preset = SENSITIVITY[sensitivity] || SENSITIVITY.balanced;
  const minFrames = Math.max(2, Math.round((minNoteMs / 1000) * FPS));
  // guitar range: E2 (MIDI 40) up to E6 (MIDI 88, fret 24 on the high string)
  const notes = decodeNotes(analysis.frames, analysis.onsets, {
    onsetThresh: preset.onsetThresh, frameThresh: preset.frameThresh, minLen: minFrames,
    minIdx: Math.max(40, lowestMidi) - MIDI_OFFSET, maxIdx: 88 - MIDI_OFFSET,
  });
  const events = notes
    .map(n => ({
      start: frameToTime(n.startFrame),
      end: frameToTime(n.startFrame + n.durationFrames),
      midi: n.pitchMidi,
      amp: n.amplitude,
    }))
    .sort((a, b) => a.start - b.start || a.midi - b.midi);
  const stats = { modelNotes: events.length, overtones: 0, octaveGhosts: 0, weakBass: 0, noAttack: 0 };
  let out = events;
  const step = (fn, key) => { const before = out.length; out = fn(out); stats[key] = before - out.length; };
  if (harmonicFilter) step(suppressHarmonics, 'overtones');
  if (octaveDownFilter) step(suppressOctaveDown, 'octaveGhosts');
  if (bassStrength > 0) step((l) => suppressWeakBass(l, { ratio: bassStrength }), 'weakBass');
  if (attackGate !== 'off' && analysis.attacks) {
    step((l) => requireAttack(l, analysis.attacks, { belowMidi: attackGate === 'all' ? 200 : 52 }), 'noAttack');
  }
  stats.attacks = analysis.attacks ? analysis.attacks.length : null;
  stats.kept = out.length;
  out.stats = stats;
  return out;
}

// A real note starts with a pluck. Keep a note only if an attack is detected within `tolMs` of its
// start. By default only low notes are held to this (below E3, where the ghost notes are), because
// hammer-ons, pull-offs and slides in the melody legitimately start without a pluck.
export function requireAttack(events, attacks, { tolMs = 70, belowMidi = 52 } = {}) {
  if (!attacks || !attacks.length) return events;
  const tol = tolMs / 1000;
  const near = (t) => {
    let lo = 0, hi = attacks.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (attacks[mid] < t - tol) lo = mid + 1; else hi = mid; }
    return lo < attacks.length && attacks[lo] <= t + tol;
  };
  return events.filter(e => e.midi >= belowMidi || near(e.start));
}

// Events grouped by pitch, sorted by start, so "is there a note at pitch P around time T" is cheap.
function indexByPitch(events) {
  const by = new Map();
  for (const e of events) { if (!by.has(e.midi)) by.set(e.midi, []); by.get(e.midi).push(e); }
  for (const list of by.values()) list.sort((a, b) => a.start - b.start);
  return by;
}
function nearbyAt(by, midi, e, windowSec) {
  const list = by.get(midi);
  if (!list) return [];
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].start < e.start - windowSec) lo = mid + 1; else hi = mid; }
  const out = [];
  for (let i = lo; i < list.length && list[i].start <= e.start + windowSec; i++) out.push(list[i]);
  return out;
}

// "Octave-down ghosts": the model sometimes adds the pitch an octave (or two) BELOW a real note.
// Drop a low note when the same pitch class sounds higher at the same moment and clearly stronger.
// A deliberate octave pair has two notes of similar strength, so those stay.
export function suppressOctaveDown(events, { windowSec = 0.08, ratio = 0.75 } = {}) {
  const by = indexByPitch(events);
  return events.filter(e => {
    for (const up of [12, 24]) {
      for (const f of nearbyAt(by, e.midi + up, e, windowSec)) {
        if (f.end < e.start || f.start > e.end) continue;
        if (e.amp < f.amp * ratio) return false;
      }
    }
    return true;
  });
}

// Rumble, hum and ringing open strings are faint but low: below E3, a note must be at least
// `ratio` as strong as the typical note of the recording.
export function suppressWeakBass(events, { belowMidi = 52, ratio = 0.4 } = {}) {
  if (!events.length) return events;
  const amps = events.map(e => e.amp).sort((a, b) => a - b);
  const typical = amps[Math.floor(amps.length / 2)];
  return events.filter(e => e.midi >= belowMidi || e.amp >= typical * ratio);
}

// Overtones of a plucked string show up as weaker notes above the real one (octave, octave+fifth,
// two octaves ...). Drop a note when a much stronger note that many semitones below it starts at
// the same time. An octave needs a clearer gap, because octaves are played on purpose.
const HARMONIC_GAPS = [[12, 0.7], [19, 0.85], [24, 0.85], [28, 0.9], [31, 0.9]];
export function suppressHarmonics(events, windowSec = 0.08) {
  return events.filter(e => {
    for (const [semis, ratio] of HARMONIC_GAPS) {
      for (const f of events) {
        if (f === e || f.midi !== e.midi - semis) continue;
        if (Math.abs(f.start - e.start) > windowSec) continue;
        if (f.end < e.start || f.start > e.end) continue;
        if (e.amp < f.amp * ratio) return false;
      }
    }
    return true;
  });
}

// ---------------------------------------------------------------------------------------------

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// A strum spreads its notes over a few tens of ms: events that start within `chordMs` of each
// other (and are not the same pitch) are treated as one chord starting together.
export function groupChords(events, chordMs = 45) {
  const out = events.map(e => ({ ...e }));
  const tol = chordMs / 1000;
  let i = 0;
  while (i < out.length) {
    let j = i + 1;
    while (j < out.length && out[j].start - out[i].start <= tol) j++;
    if (j - i > 1) {
      const t = median(out.slice(i, j).map(e => e.start));
      for (let k = i; k < j; k++) {
        const len = out[k].end - out[k].start;
        out[k].start = t;
        out[k].end = Math.max(t + 0.03, t + len);
      }
    }
    i = j;
  }
  return out;
}

// Turn events into guitar-roll notes on the project grid.
//   tracks: the audio track to read the clips from; map: tempoMap.forTrack(track) (time <-> beat)
//   barSubs: columns per bar (the project's barSubdivisions)
export function buildDraftNotes(events, { track, map, barSubs, chordMs = 45, maxPerAttack = 6 }) {
  const clips = getClips(track);
  if (!clips.length) return [];
  const grouped = groupChords(events, chordMs);

  // 1. file time -> timeline beat, through the clip that contains the note
  const beats = [];
  for (const e of grouped) {
    const clip = clips.find(c => e.start >= c.srcStart - 1e-6 && e.start <= c.srcEnd + 1e-6);
    if (!clip) continue;
    const start = clipTimeToBeat(clip, e.start, map);
    const end = clipTimeToBeat(clip, Math.min(e.end, clip.srcEnd), map);
    if (!(end > start)) continue;
    beats.push({ midi: e.midi, amp: e.amp, start, end });
  }
  if (!beats.length) return [];

  // 2. per bar, pick the subdivision (8ths, triplets or 16ths per beat) that fits the onsets best
  const barStarts = [0];
  for (let i = 0; i < barSubs.length; i++) barStarts.push(barStarts[i] + barSubs[i]);
  const barOf = (b) => {
    let lo = 0, hi = barSubs.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (barStarts[mid] <= b + 1e-9) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const byBar = new Map();
  for (const n of beats) {
    const bar = barOf(n.start);
    if (!byBar.has(bar)) byBar.set(bar, []);
    byBar.get(bar).push(n);
  }
  const stepOfBar = new Map();
  for (const [bar, ns] of byBar) {
    let best = 2, bestCost = Infinity;
    for (const s of [2, 3, 4]) {
      let err = 0;
      for (const n of ns) { const r = n.start * s; err += Math.abs(r - Math.round(r)) / s; }
      const cost = err / ns.length + 0.02 * s; // a finer grid always fits better, so it pays a little
      if (cost < bestCost) { bestCost = cost; best = s; }
    }
    stepOfBar.set(bar, best);
  }

  // 3. snap starts and ends
  const snapped = beats.map(n => {
    const s = stepOfBar.get(barOf(n.start)) || 2;
    const start = Math.round(n.start * s) / s;
    let end = Math.round(n.end * s) / s;
    if (end <= start) end = start + 1 / s;
    return { ...n, start, end, step: s };
  });
  // a pitch can not start again before it ended
  snapped.sort((a, b) => a.start - b.start);
  const lastByMidi = new Map();
  for (const n of snapped) {
    const prev = lastByMidi.get(n.midi);
    if (prev && prev.end > n.start) prev.end = Math.max(prev.start + 1 / prev.step, n.start);
    lastByMidi.set(n.midi, n);
  }

  // 4. finger them: notes that start together are one chord for the voice-leading search
  const groups = [];
  for (const n of snapped) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[0].start - n.start) < 1e-6) g.push(n); else groups.push([n]);
  }
  // A guitar has six strings, and one pluck rarely carries more than a few notes: in a crowded
  // (noisy) group keep only the strongest `maxPerAttack`
  const cap = Math.max(1, Math.min(6, maxPerAttack));
  for (const g of groups) {
    if (g.length > cap) {
      g.sort((a, b) => b.amp - a.amp);
      g.length = cap;
    }
  }
  assignFretboardPositions(groups);

  const maxAmp = Math.max(0.0001, ...snapped.map(n => n.amp));
  return snapped
    .filter(n => n.stringIndex != null)
    .map(n => {
      const conf = Math.min(1, n.amp / maxAmp);
      return {
        stringIndex: n.stringIndex,
        fret: n.fret,
        beat: Math.round(n.start * 10000) / 10000,
        duration: Math.round((n.end - n.start) * 10000) / 10000,
        velocity: Math.round((0.4 + 0.6 * conf) * 100) / 100,
        conf: Math.round(conf * 100) / 100, // how sure the model was (dims weak notes on the roll)
      };
    });
}
