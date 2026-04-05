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
    // Master compressor to prevent clipping when multiple notes play simultaneously
    const comp = audioCtx.createDynamicsCompressor();
    comp.threshold.setValueAtTime(-12, audioCtx.currentTime);
    comp.knee.setValueAtTime(6, audioCtx.currentTime);
    comp.ratio.setValueAtTime(8, audioCtx.currentTime);
    comp.attack.setValueAtTime(0.003, audioCtx.currentTime);
    comp.release.setValueAtTime(0.1, audioCtx.currentTime);
    comp.connect(audioCtx.destination);
    masterOut = comp;
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

export const INSTRUMENTS = {
  'clean-electric': { label: 'Clean Electric' },
  'acoustic': { label: 'Acoustic Guitar' },
  'piano': { label: 'Piano' },
  'bass': { label: 'Bass' },
  'synth-pad': { label: 'Synth Pad' },
  'pluck': { label: 'Pluck / Harp' },
  'drums': { label: 'Drums' },
};

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

// ===== Dispatch =====

const SYNTH_MAP = {
  'clean-electric': synthCleanElectric,
  'acoustic': synthAcoustic,
  'piano': synthPiano,
  'bass': synthBass,
  'synth-pad': synthPad,
  'pluck': synthPluck,
};

function playSynth(ctx, freq, startTime, duration, gain) {
  const fn = SYNTH_MAP[currentInstrument];
  if (fn) fn(ctx, freq, startTime, duration, gain);
}

export function playNote(stringIndex, fret, duration = 0.5, velocity = 0.8) {
  const ctx = getAudioContext();
  const gain = 0.3 * velocity;
  if (currentInstrument === 'drums') {
    synthDrum(ctx, stringIndex, ctx.currentTime, gain);
    return;
  }
  const freq = getNoteFrequency(stringIndex, fret);
  playSynth(ctx, freq, ctx.currentTime, duration, gain);
}

export function playNoteAtTime(stringIndex, fret, startTime, duration = 0.3, velocity = 0.8) {
  const ctx = getAudioContext();
  const gain = 0.3 * velocity;
  if (currentInstrument === 'drums') {
    synthDrum(ctx, stringIndex, startTime, gain);
    return;
  }
  const freq = getNoteFrequency(stringIndex, fret);
  playSynth(ctx, freq, startTime, duration, gain);
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
