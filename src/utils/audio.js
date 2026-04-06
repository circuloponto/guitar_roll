// Guitar note frequencies for standard tuning (E2 A2 D3 G3 B3 E4)
const STRING_OPEN_NOTES = [
  { note: 'E2', freq: 82.41 },
  { note: 'A2', freq: 110.0 },
  { note: 'D3', freq: 146.83 },
  { note: 'G3', freq: 196.0 },
  { note: 'B3', freq: 246.94 },
  { note: 'E4', freq: 329.63 },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

let audioCtx = null;
let masterOut = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Master limiter chain to prevent clipping on chords
    const limiterGain = audioCtx.createGain();
    limiterGain.gain.setValueAtTime(0.6, audioCtx.currentTime);
    const comp = audioCtx.createDynamicsCompressor();
    comp.threshold.setValueAtTime(-18, audioCtx.currentTime);
    comp.knee.setValueAtTime(4, audioCtx.currentTime);
    comp.ratio.setValueAtTime(12, audioCtx.currentTime);
    comp.attack.setValueAtTime(0.001, audioCtx.currentTime);
    comp.release.setValueAtTime(0.05, audioCtx.currentTime);
    limiterGain.connect(comp);
    comp.connect(audioCtx.destination);
    masterOut = limiterGain;
  }
  return audioCtx;
}

function getMasterOut() {
  getAudioContext();
  return masterOut;
}

export function getNoteFrequency(stringIndex, fret) {
  const openFreq = STRING_OPEN_NOTES[stringIndex].freq;
  return openFreq * Math.pow(2, fret / 12);
}

export function getNoteName(stringIndex, fret) {
  const openNote = STRING_OPEN_NOTES[stringIndex].note;
  const noteName = openNote.slice(0, -1);
  const octave = parseInt(openNote.slice(-1));
  const noteIndex = NOTE_NAMES.indexOf(noteName);
  const newIndex = (noteIndex + fret) % 12;
  const newOctave = octave + Math.floor((noteIndex + fret) / 12);
  return NOTE_NAMES[newIndex] + newOctave;
}

// ===== Instrument definitions =====

let currentInstrument = 'clean-electric';

export const BUILTIN_INSTRUMENTS = {
  'clean-electric': { label: 'Clean Electric' },
  'acoustic': { label: 'Acoustic Guitar' },
  'piano': { label: 'Piano' },
  'bass': { label: 'Bass' },
  'synth-pad': { label: 'Synth Pad' },
  'organ': { label: 'Organ' },
  'pluck': { label: 'Pluck / Harp' },
  'drums': { label: 'Drums' },
};

const HIDDEN_PRESETS_KEY = 'guitar-roll-hidden-presets';

export function loadHiddenPresets() {
  try { return JSON.parse(localStorage.getItem(HIDDEN_PRESETS_KEY)) || []; }
  catch { return []; }
}

export function hidePreset(id) {
  const hidden = loadHiddenPresets();
  if (!hidden.includes(id)) {
    hidden.push(id);
    localStorage.setItem(HIDDEN_PRESETS_KEY, JSON.stringify(hidden));
  }
}

export function unhidePreset(id) {
  const hidden = loadHiddenPresets().filter(h => h !== id);
  localStorage.setItem(HIDDEN_PRESETS_KEY, JSON.stringify(hidden));
}

export function getAllInstruments() {
  const custom = loadCustomPresets();
  const hidden = loadHiddenPresets();
  const all = {};
  Object.entries(BUILTIN_INSTRUMENTS).forEach(([id, inst]) => {
    if (!hidden.includes(id)) all[id] = inst;
  });
  Object.entries(custom).forEach(([id, p]) => {
    all[id] = { label: p.name || id };
  });
  return all;
}

// Keep backward compat
export const INSTRUMENTS = BUILTIN_INSTRUMENTS;

export function setInstrument(id) {
  currentInstrument = id;
}

export function getInstrument() {
  return currentInstrument;
}

// Drum mapping: string → drum type
// String 0 (E2) = Kick, 1 (A2) = Snare, 2 (D3) = Closed HH,
// 3 (G3) = Open HH, 4 (B3) = Low Tom, 5 (E4) = Crash
const DRUM_NAMES = ['Kick', 'Snare', 'HH Closed', 'HH Open', 'Tom', 'Crash'];

export function getDrumName(stringIndex) {
  return DRUM_NAMES[stringIndex] || 'Perc';
}

// ===== Synth voices =====

function synthCleanElectric(ctx, freq, startTime, duration, gain) {
  const osc = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const gainNode = ctx.createGain();
  const filter = ctx.createBiquadFilter();

  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, startTime);
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(freq * 2, startTime);

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(2000 + freq, startTime);
  filter.frequency.exponentialRampToValueAtTime(Math.max(freq, 200), startTime + duration * 0.8);

  const attack = 0.005;
  const releaseTime = Math.max(0.05, duration * 0.15);
  gainNode.gain.setValueAtTime(0, startTime);
  gainNode.gain.linearRampToValueAtTime(gain, startTime + attack);
  gainNode.gain.linearRampToValueAtTime(gain * 0.48, startTime + 0.04);
  gainNode.gain.setValueAtTime(gain * 0.48, startTime + duration - releaseTime);
  gainNode.gain.linearRampToValueAtTime(0, startTime + duration);

  osc.connect(filter);
  osc2.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(getMasterOut());
  osc.start(startTime);
  osc2.start(startTime);
  osc.stop(startTime + duration + 0.01);
  osc2.stop(startTime + duration + 0.01);
}

function synthAcoustic(ctx, freq, startTime, duration, gain) {
  const nodes = [];
  const gainNode = ctx.createGain();
  const filter = ctx.createBiquadFilter();

  // Richer harmonics for acoustic body
  const partials = [1, 2, 3, 4.01, 5.02];
  const amps = [1, 0.5, 0.25, 0.12, 0.06];
  partials.forEach((p, i) => {
    const osc = ctx.createOscillator();
    osc.type = i === 0 ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(freq * p, startTime);
    const g = ctx.createGain();
    g.gain.setValueAtTime(amps[i], startTime);
    osc.connect(g);
    g.connect(filter);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.01);
    nodes.push(osc);
  });

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(3000 + freq, startTime);
  filter.frequency.exponentialRampToValueAtTime(Math.max(freq * 0.8, 200), startTime + duration * 0.5);
  filter.Q.setValueAtTime(1.5, startTime);

  // Quick attack, fast decay — plucked acoustic feel
  gainNode.gain.setValueAtTime(0, startTime);
  gainNode.gain.linearRampToValueAtTime(gain, startTime + 0.003);
  gainNode.gain.exponentialRampToValueAtTime(gain * 0.3, startTime + 0.08);
  gainNode.gain.linearRampToValueAtTime(0, startTime + duration);

  filter.connect(gainNode);
  gainNode.connect(getMasterOut());
}

function synthPiano(ctx, freq, startTime, duration, gain) {
  const gainNode = ctx.createGain();

  // Piano: detuned sine partials with long sustain
  const partials = [1, 2.0, 3.0, 4.0];
  const amps = [1, 0.6, 0.2, 0.08];
  partials.forEach((p, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    // Slight inharmonicity like real piano strings
    osc.frequency.setValueAtTime(freq * p * (1 + 0.0005 * p * p), startTime);
    const g = ctx.createGain();
    g.gain.setValueAtTime(amps[i], startTime);
    osc.connect(g);
    g.connect(gainNode);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
  });

  // Hammer attack + sustained decay
  gainNode.gain.setValueAtTime(0, startTime);
  gainNode.gain.linearRampToValueAtTime(gain, startTime + 0.005);
  gainNode.gain.linearRampToValueAtTime(gain * 0.7, startTime + 0.05);
  gainNode.gain.exponentialRampToValueAtTime(gain * 0.3, startTime + duration * 0.6);
  gainNode.gain.linearRampToValueAtTime(0, startTime + duration);

  gainNode.connect(getMasterOut());
}

function synthBass(ctx, freq, startTime, duration, gain) {
  const osc = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const gainNode = ctx.createGain();
  const filter = ctx.createBiquadFilter();

  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq, startTime);
  osc2.type = 'square';
  osc2.frequency.setValueAtTime(freq, startTime);

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(800, startTime);
  filter.frequency.exponentialRampToValueAtTime(Math.max(freq, 80), startTime + duration * 0.4);
  filter.Q.setValueAtTime(4, startTime);

  gainNode.gain.setValueAtTime(0, startTime);
  gainNode.gain.linearRampToValueAtTime(gain, startTime + 0.008);
  gainNode.gain.linearRampToValueAtTime(gain * 0.6, startTime + 0.06);
  gainNode.gain.linearRampToValueAtTime(0, startTime + duration);

  osc.connect(filter);
  osc2.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(getMasterOut());
  osc.start(startTime);
  osc2.start(startTime);
  osc.stop(startTime + duration + 0.01);
  osc2.stop(startTime + duration + 0.01);
}

function synthPad(ctx, freq, startTime, duration, gain) {
  const gainNode = ctx.createGain();
  const filter = ctx.createBiquadFilter();

  // Detuned sawtooths for lush pad
  [-6, -2, 0, 2, 7].forEach(detune => {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, startTime);
    osc.detune.setValueAtTime(detune, startTime);
    osc.connect(filter);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  });

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(1200, startTime);
  filter.Q.setValueAtTime(0.7, startTime);

  // Slow attack, sustained, slow release
  const attack = Math.min(0.2, duration * 0.3);
  const release = Math.min(0.15, duration * 0.2);
  gainNode.gain.setValueAtTime(0, startTime);
  gainNode.gain.linearRampToValueAtTime(gain * 0.15, startTime + attack);
  gainNode.gain.setValueAtTime(gain * 0.15, startTime + duration - release);
  gainNode.gain.linearRampToValueAtTime(0, startTime + duration);

  filter.connect(gainNode);
  gainNode.connect(getMasterOut());
}

function synthPluck(ctx, freq, startTime, duration, gain) {
  const osc = ctx.createOscillator();
  const gainNode = ctx.createGain();
  const filter = ctx.createBiquadFilter();

  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, startTime);

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(5000, startTime);
  filter.frequency.exponentialRampToValueAtTime(Math.max(freq, 200), startTime + 0.08);

  // Very short bright attack, quick decay
  const decayTime = Math.min(duration, 0.4);
  gainNode.gain.setValueAtTime(0, startTime);
  gainNode.gain.linearRampToValueAtTime(gain, startTime + 0.002);
  gainNode.gain.linearRampToValueAtTime(0, startTime + decayTime);

  osc.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(getMasterOut());
  osc.start(startTime);
  osc.stop(startTime + decayTime + 0.01);
}

// ===== Drum synth =====

function synthDrum(ctx, stringIndex, startTime, gain) {
  switch (stringIndex) {
    case 0: drumKick(ctx, startTime, gain); break;
    case 1: drumSnare(ctx, startTime, gain); break;
    case 2: drumHihatClosed(ctx, startTime, gain); break;
    case 3: drumHihatOpen(ctx, startTime, gain); break;
    case 4: drumTom(ctx, startTime, gain); break;
    case 5: drumCrash(ctx, startTime, gain); break;
    default: drumKick(ctx, startTime, gain);
  }
}

function drumKick(ctx, t, gain) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(40, t + 0.12);
  g.gain.setValueAtTime(gain, t);
  g.gain.linearRampToValueAtTime(0, t + 0.3);
  osc.connect(g);
  g.connect(getMasterOut());
  osc.start(t);
  osc.stop(t + 0.31);
}

function drumSnare(ctx, t, gain) {
  // Tonal body
  const osc = ctx.createOscillator();
  const og = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(200, t);
  og.gain.setValueAtTime(gain * 0.7, t);
  og.gain.linearRampToValueAtTime(0, t + 0.12);
  osc.connect(og);
  og.connect(getMasterOut());
  osc.start(t);
  osc.stop(t + 0.13);

  // Noise burst
  const bufferSize = ctx.sampleRate * 0.15;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const ng = ctx.createGain();
  const nf = ctx.createBiquadFilter();
  nf.type = 'highpass';
  nf.frequency.setValueAtTime(3000, t);
  ng.gain.setValueAtTime(gain * 0.6, t);
  ng.gain.linearRampToValueAtTime(0, t + 0.15);
  noise.connect(nf);
  nf.connect(ng);
  ng.connect(getMasterOut());
  noise.start(t);
  noise.stop(t + 0.16);
}

function drumHihatClosed(ctx, t, gain) {
  const bufferSize = ctx.sampleRate * 0.05;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const g = ctx.createGain();
  const f = ctx.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.setValueAtTime(8000, t);
  g.gain.setValueAtTime(gain * 0.4, t);
  g.gain.linearRampToValueAtTime(0, t + 0.05);
  noise.connect(f);
  f.connect(g);
  g.connect(getMasterOut());
  noise.start(t);
  noise.stop(t + 0.06);
}

function drumHihatOpen(ctx, t, gain) {
  const bufferSize = ctx.sampleRate * 0.25;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const g = ctx.createGain();
  const f = ctx.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.setValueAtTime(7000, t);
  g.gain.setValueAtTime(gain * 0.4, t);
  g.gain.linearRampToValueAtTime(0, t + 0.25);
  noise.connect(f);
  f.connect(g);
  g.connect(getMasterOut());
  noise.start(t);
  noise.stop(t + 0.26);
}

function drumTom(ctx, t, gain) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(120, t);
  osc.frequency.exponentialRampToValueAtTime(60, t + 0.2);
  g.gain.setValueAtTime(gain * 0.8, t);
  g.gain.linearRampToValueAtTime(0, t + 0.25);
  osc.connect(g);
  g.connect(getMasterOut());
  osc.start(t);
  osc.stop(t + 0.26);
}

function drumCrash(ctx, t, gain) {
  const bufferSize = ctx.sampleRate * 0.6;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const g = ctx.createGain();
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.setValueAtTime(5000, t);
  f.Q.setValueAtTime(0.5, t);
  g.gain.setValueAtTime(gain * 0.5, t);
  g.gain.linearRampToValueAtTime(0, t + 0.6);
  noise.connect(f);
  f.connect(g);
  g.connect(getMasterOut());
  noise.start(t);
  noise.stop(t + 0.61);
}

// ===== Parametric synth engine =====

export function defaultSynthParams() {
  return {
    name: 'Custom',
    oscillators: [
      { type: 'triangle', detune: 0, gain: 1.0 },
    ],
    filter: { type: 'lowpass', cutoff: 3000, resonance: 1, envAmount: 0.5 },
    envelope: { attack: 0.005, decay: 0.1, sustain: 0.5, release: 0.15 },
    tremolo: { rate: 0, depth: 0 },   // rate in Hz, depth 0-1
    vibrato: { rate: 0, depth: 0 },   // rate in Hz, depth in cents
  };
}

// Built-in preset configs (read-only, can be duplicated)
export const SYNTH_PRESETS = {
  'clean-electric': {
    name: 'Clean Electric', builtIn: true,
    oscillators: [
      { type: 'triangle', detune: 0, gain: 1.0 },
      { type: 'sine', detune: 1200, gain: 0.5 },
    ],
    filter: { type: 'lowpass', cutoff: 2000, resonance: 1, envAmount: 0.8 },
    envelope: { attack: 0.005, decay: 0.04, sustain: 0.48, release: 0.15 },
  },
  'acoustic': {
    name: 'Acoustic Guitar', builtIn: true,
    oscillators: [
      { type: 'triangle', detune: 0, gain: 1.0 },
      { type: 'sine', detune: 1200, gain: 0.5 },
      { type: 'sine', detune: 1902, gain: 0.25 },
      { type: 'sine', detune: 2400, gain: 0.12 },
      { type: 'sine', detune: 2786, gain: 0.06 },
    ],
    filter: { type: 'lowpass', cutoff: 3000, resonance: 1.5, envAmount: 0.5 },
    envelope: { attack: 0.003, decay: 0.08, sustain: 0.3, release: 0.2 },
  },
  'piano': {
    name: 'Piano', builtIn: true,
    oscillators: [
      { type: 'sine', detune: 0, gain: 1.0 },
      { type: 'sine', detune: 1200, gain: 0.6 },
      { type: 'sine', detune: 1902, gain: 0.2 },
      { type: 'sine', detune: 2400, gain: 0.08 },
    ],
    filter: { type: 'lowpass', cutoff: 5000, resonance: 0.5, envAmount: 0.2 },
    envelope: { attack: 0.005, decay: 0.05, sustain: 0.7, release: 0.2 },
  },
  'bass': {
    name: 'Bass', builtIn: true,
    oscillators: [
      { type: 'sawtooth', detune: 0, gain: 1.0 },
      { type: 'square', detune: 0, gain: 0.5 },
    ],
    filter: { type: 'lowpass', cutoff: 800, resonance: 4, envAmount: 0.4 },
    envelope: { attack: 0.008, decay: 0.06, sustain: 0.6, release: 0.15 },
  },
  'synth-pad': {
    name: 'Synth Pad', builtIn: true,
    oscillators: [
      { type: 'sawtooth', detune: -6, gain: 0.2 },
      { type: 'sawtooth', detune: -2, gain: 0.2 },
      { type: 'sawtooth', detune: 0, gain: 0.2 },
      { type: 'sawtooth', detune: 2, gain: 0.2 },
      { type: 'sawtooth', detune: 7, gain: 0.2 },
    ],
    filter: { type: 'lowpass', cutoff: 1200, resonance: 0.7, envAmount: 0.1 },
    envelope: { attack: 0.2, decay: 0.1, sustain: 0.8, release: 0.15 },
  },
  'organ': {
    name: 'Organ', builtIn: true,
    oscillators: [
      { type: 'sine', detune: -1200, gain: 0.5 },
      { type: 'sine', detune: 0, gain: 1.0 },
      { type: 'sine', detune: 1200, gain: 0.8 },
      { type: 'sine', detune: 1902, gain: 0.6 },
      { type: 'sine', detune: 2400, gain: 0.4 },
    ],
    filter: { type: 'lowpass', cutoff: 8000, resonance: 0.5, envAmount: 0 },
    envelope: { attack: 0.005, decay: 0.01, sustain: 1.0, release: 0.05 },
    tremolo: { rate: 5.5, depth: 0.3 },
    vibrato: { rate: 5.5, depth: 15 },
  },
  'pluck': {
    name: 'Pluck / Harp', builtIn: true,
    oscillators: [
      { type: 'triangle', detune: 0, gain: 1.0 },
    ],
    filter: { type: 'lowpass', cutoff: 5000, resonance: 1, envAmount: 0.9 },
    envelope: { attack: 0.002, decay: 0.3, sustain: 0.0, release: 0.1 },
  },
};

// Custom presets stored in localStorage
const CUSTOM_PRESETS_KEY = 'guitar-roll-synth-presets';

export function loadCustomPresets() {
  try {
    const raw = localStorage.getItem(CUSTOM_PRESETS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function saveCustomPreset(id, params) {
  const presets = loadCustomPresets();
  presets[id] = params;
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(presets));
}

export function deleteCustomPreset(id) {
  const presets = loadCustomPresets();
  delete presets[id];
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(presets));
}

export function getSynthParams(instrumentId) {
  if (SYNTH_PRESETS[instrumentId]) return SYNTH_PRESETS[instrumentId];
  const custom = loadCustomPresets();
  if (custom[instrumentId]) return custom[instrumentId];
  return null;
}

// Generic parametric synth — builds Web Audio graph from params
function synthParametric(ctx, freq, startTime, duration, gain, params, noteProps) {
  const env = params.envelope;
  const flt = params.filter;
  const trem = params.tremolo || { rate: 0, depth: 0 };
  const vib = params.vibrato || { rate: 0, depth: 0 };
  const gainNode = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const endTime = startTime + duration + 0.05;

  // Oscillators — normalize total gain so stacked oscs don't clip
  const totalOscGain = params.oscillators.reduce((s, o) => s + (o.gain || 1), 0) || 1;
  const normFactor = 1 / totalOscGain;
  const oscs = [];
  params.oscillators.forEach(oscDef => {
    const osc = ctx.createOscillator();
    osc.type = oscDef.type;
    osc.frequency.setValueAtTime(freq, startTime);
    osc.detune.setValueAtTime(oscDef.detune || 0, startTime);
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime((oscDef.gain || 1) * normFactor, startTime);
    osc.connect(oscGain);
    oscGain.connect(filter);
    osc.start(startTime);
    osc.stop(endTime);
    oscs.push(osc);
  });

  // Bend/slide pitch automation
  if (noteProps && (noteProps.bend || noteProps.slideTo != null)) {
    applyPitchEffects(oscs, freq, startTime, duration, noteProps);
  }

  // Vibrato LFO — modulates oscillator frequency via detune
  if (vib.rate > 0 && vib.depth > 0) {
    const vibratoLfo = ctx.createOscillator();
    const vibratoGain = ctx.createGain();
    vibratoLfo.type = 'sine';
    vibratoLfo.frequency.setValueAtTime(vib.rate, startTime);
    vibratoGain.gain.setValueAtTime(vib.depth, startTime); // depth in cents
    vibratoLfo.connect(vibratoGain);
    oscs.forEach(osc => vibratoGain.connect(osc.detune));
    vibratoLfo.start(startTime);
    vibratoLfo.stop(endTime);
  }

  // Filter
  filter.type = flt.type || 'lowpass';
  const cutoffStart = flt.cutoff + freq * (1 - flt.envAmount);
  const cutoffEnd = Math.max(freq * 0.5, flt.cutoff * (1 - flt.envAmount));
  filter.frequency.setValueAtTime(cutoffStart, startTime);
  filter.frequency.exponentialRampToValueAtTime(Math.max(cutoffEnd, 20), startTime + duration * 0.8);
  filter.Q.setValueAtTime(flt.resonance || 1, startTime);

  // ADSR envelope
  const attack = Math.min(env.attack, duration * 0.5);
  const decay = Math.min(env.decay, duration - attack);
  const sustainLevel = gain * env.sustain;
  const releaseStart = Math.max(startTime + attack + decay, startTime + duration - env.release);

  gainNode.gain.setValueAtTime(0, startTime);
  gainNode.gain.linearRampToValueAtTime(gain, startTime + attack);
  if (sustainLevel > 0.001) {
    gainNode.gain.exponentialRampToValueAtTime(Math.max(sustainLevel, 0.001), startTime + attack + decay);
  } else {
    gainNode.gain.linearRampToValueAtTime(0, startTime + attack + decay);
  }
  gainNode.gain.setValueAtTime(Math.max(sustainLevel, 0.001), releaseStart);
  gainNode.gain.linearRampToValueAtTime(0, startTime + duration);

  filter.connect(gainNode);

  // Tremolo LFO — modulates output gain
  if (trem.rate > 0 && trem.depth > 0) {
    const tremoloNode = ctx.createGain();
    tremoloNode.gain.setValueAtTime(1, startTime);
    const tremoloLfo = ctx.createOscillator();
    const tremoloDepth = ctx.createGain();
    tremoloLfo.type = 'sine';
    tremoloLfo.frequency.setValueAtTime(trem.rate, startTime);
    tremoloDepth.gain.setValueAtTime(trem.depth, startTime); // 0-1 range
    tremoloLfo.connect(tremoloDepth);
    tremoloDepth.connect(tremoloNode.gain);
    tremoloLfo.start(startTime);
    tremoloLfo.stop(endTime);
    gainNode.connect(tremoloNode);
    tremoloNode.connect(getMasterOut());
  } else {
    gainNode.connect(getMasterOut());
  }
}

// ===== Dispatch =====

const SYNTH_MAP = {
  'clean-electric': synthCleanElectric,
  'acoustic': synthAcoustic,
  'piano': synthPiano,
  'bass': synthBass,
  'synth-pad': synthPad,
  'pluck': synthPluck,
};

function playSynth(ctx, freq, startTime, duration, gain, instrument, noteProps) {
  const inst = instrument || currentInstrument;
  // Check for custom preset first
  const customPresets = loadCustomPresets();
  if (customPresets[inst]) {
    synthParametric(ctx, freq, startTime, duration, gain, customPresets[inst], noteProps);
    return;
  }
  // Legacy hardcoded synth
  const fn = SYNTH_MAP[inst];
  if (fn) { fn(ctx, freq, startTime, duration, gain); return; }
  // Built-in parametric preset (no legacy function)
  if (SYNTH_PRESETS[inst]) {
    synthParametric(ctx, freq, startTime, duration, gain, SYNTH_PRESETS[inst], noteProps);
    return;
  }
}

// Ghost note — muted percussive string click
function synthGhostNote(ctx, startTime, gain) {
  const bufferSize = ctx.sampleRate * 0.04;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const g = ctx.createGain();
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.setValueAtTime(1500, startTime);
  f.Q.setValueAtTime(2, startTime);
  g.gain.setValueAtTime(gain * 0.5, startTime);
  g.gain.linearRampToValueAtTime(0, startTime + 0.04);
  noise.connect(f);
  f.connect(g);
  g.connect(getMasterOut());
  noise.start(startTime);
  noise.stop(startTime + 0.05);
}

// Bend/slide pitch automation — returns a function to apply to oscillators
function applyPitchEffects(oscs, freq, startTime, duration, note) {
  if (note.bend && note.bend > 0) {
    // Bend: ramp up by bend semitones over first half, hold
    const bendFreq = freq * Math.pow(2, note.bend / 12);
    oscs.forEach(osc => {
      osc.frequency.setValueAtTime(freq, startTime);
      osc.frequency.linearRampToValueAtTime(bendFreq, startTime + duration * 0.4);
    });
  }
  if (note.slideTo != null) {
    // Slide: glide from current pitch to target fret pitch
    const targetFreq = getNoteFrequency(note.stringIndex, note.slideTo);
    oscs.forEach(osc => {
      osc.frequency.setValueAtTime(freq, startTime);
      osc.frequency.exponentialRampToValueAtTime(Math.max(targetFreq, 20), startTime + duration * 0.85);
    });
  }
}

export function playNote(stringIndex, fret, duration = 0.5, velocity = 0.8, instrument, volume = 1) {
  const ctx = getAudioContext();
  const inst = instrument || currentInstrument;
  const gain = 0.3 * velocity * volume;
  if (inst === 'drums') {
    synthDrum(ctx, stringIndex, ctx.currentTime, gain);
    return;
  }
  const freq = getNoteFrequency(stringIndex, fret);
  playSynth(ctx, freq, ctx.currentTime, duration, gain, inst);
}

export function playNoteAtTime(stringIndex, fret, startTime, duration = 0.3, velocity = 0.8, instrument, volume = 1, noteProps) {
  const ctx = getAudioContext();
  const inst = instrument || currentInstrument;
  const gain = 0.3 * velocity * volume;

  // Ghost note
  if (noteProps && noteProps.ghost) {
    synthGhostNote(ctx, startTime, gain);
    return;
  }

  if (inst === 'drums') {
    synthDrum(ctx, stringIndex, startTime, gain);
    return;
  }
  const freq = getNoteFrequency(stringIndex, fret);
  playSynth(ctx, freq, startTime, duration, gain, inst, noteProps);
}

export function playClickAtTime(time, accent = false) {
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const gainNode = ctx.createGain();

  osc.type = 'square';
  osc.frequency.setValueAtTime(accent ? 1500 : 1000, time);

  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(accent ? 3000 : 2000, time);

  const volume = accent ? 0.5 : 0.3;
  const dur = accent ? 0.06 : 0.04;
  gainNode.gain.setValueAtTime(0, time);
  gainNode.gain.linearRampToValueAtTime(volume, time + 0.001);
  gainNode.gain.linearRampToValueAtTime(0, time + dur);

  osc.connect(gainNode);
  osc2.connect(gainNode);
  gainNode.connect(getMasterOut());
  osc.start(time);
  osc2.start(time);
  osc.stop(time + dur + 0.01);
  osc2.stop(time + dur + 0.01);
}

export { getAudioContext };
