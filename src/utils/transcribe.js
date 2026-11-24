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

async function resampleMono(buffer) {
  if (buffer.sampleRate === SR && buffer.numberOfChannels === 1) return buffer;
  const length = Math.max(1, Math.ceil(buffer.duration * SR));
  const ctx = new OfflineAudioContext(1, length, SR); // mixing down to mono happens here
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

export const hasAnalysis = (buffer) => !!buffer && cache.has(buffer);
export const getAnalysis = (buffer) => (buffer ? cache.get(buffer) || null : null);

// Run the model (once per recording; the result is cached). onProgress(0..1).
export async function analyzeAudio(buffer, onProgress = () => {}) {
  const hit = cache.get(buffer);
  if (hit) { onProgress(1); return hit; }
  const { BasicPitch } = await import('@spotify/basic-pitch');
  if (!modelPromise) modelPromise = Promise.resolve(new BasicPitch(MODEL_URL()));
  const bp = await modelPromise;
  const mono = await resampleMono(buffer);
  // The model reports its output in pieces (one per 2-second window): join them up.
  const result = { frames: [], onsets: [], contours: [] };
  await bp.evaluateModel(
    mono,
    (frames, onsets, contours) => {
      for (const row of frames) result.frames.push(row);
      for (const row of onsets) result.onsets.push(row);
      for (const row of contours) result.contours.push(row);
    },
    (p) => onProgress(Math.min(0.99, p)),
  );
  if (!result.frames.length) throw new Error('The pitch model returned nothing');
  result.seconds = buffer.duration;
  cache.set(buffer, result);
  onProgress(1);
  return result;
}

// Note events from the activations: [{ start, end, midi, amp }] in seconds of the audio file.
export async function extractNoteEvents(analysis, { sensitivity = 'balanced', minNoteMs = 60, harmonicFilter = true } = {}) {
  const { outputToNotesPoly, noteFramesToTime } = await import('@spotify/basic-pitch');
  const preset = SENSITIVITY[sensitivity] || SENSITIVITY.balanced;
  const minFrames = Math.max(2, Math.round((minNoteMs / 1000) * FPS));
  // guitar range: E2 (82 Hz) up to E6 (1318 Hz, fret 24 on the high string)
  const notes = outputToNotesPoly(
    analysis.frames, analysis.onsets, preset.onsetThresh, preset.frameThresh, minFrames,
    true, 1330, 80, true,
  );
  const timed = noteFramesToTime(notes);
  const events = timed
    .filter(n => n.pitchMidi >= 40 && n.pitchMidi <= 88)
    .map(n => ({
      start: n.startTimeSeconds,
      end: n.startTimeSeconds + n.durationSeconds,
      midi: n.pitchMidi,
      amp: n.amplitude,
    }))
    .sort((a, b) => a.start - b.start || a.midi - b.midi);
  return harmonicFilter ? suppressHarmonics(events) : events;
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
export function buildDraftNotes(events, { track, map, barSubs, chordMs = 45 }) {
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
