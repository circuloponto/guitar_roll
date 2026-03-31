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

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
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

export function playNote(stringIndex, fret, duration = 0.5) {
  const ctx = getAudioContext();
  const freq = getNoteFrequency(stringIndex, fret);

  // Create a plucked string sound using oscillators
  const osc = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const gainNode = ctx.createGain();
  const filterNode = ctx.createBiquadFilter();

  // Main tone
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, ctx.currentTime);

  // Harmonic
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(freq * 2, ctx.currentTime);

  // Filter for guitar-like tone
  filterNode.type = 'lowpass';
  filterNode.frequency.setValueAtTime(2000 + freq, ctx.currentTime);
  filterNode.frequency.exponentialRampToValueAtTime(freq * 1.5, ctx.currentTime + duration * 0.5);

  // Smooth pluck envelope
  gainNode.gain.setValueAtTime(0.001, ctx.currentTime);
  gainNode.gain.linearRampToValueAtTime(0.25, ctx.currentTime + 0.005);
  gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

  osc.connect(filterNode);
  osc2.connect(filterNode);
  filterNode.connect(gainNode);
  gainNode.connect(ctx.destination);

  osc.start(ctx.currentTime);
  osc2.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
  osc2.stop(ctx.currentTime + duration);
}

export function playNoteAtTime(stringIndex, fret, startTime, duration = 0.3) {
  const ctx = getAudioContext();
  const freq = getNoteFrequency(stringIndex, fret);

  const osc = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const gainNode = ctx.createGain();
  const filterNode = ctx.createBiquadFilter();

  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, startTime);

  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(freq * 2, startTime);

  filterNode.type = 'lowpass';
  filterNode.frequency.setValueAtTime(2000 + freq, startTime);
  filterNode.frequency.exponentialRampToValueAtTime(Math.max(freq, 200), startTime + duration * 0.8);

  // Smooth attack, sustain, release — no clicks
  const attack = 0.005;
  const releaseTime = Math.max(0.05, duration * 0.15);
  gainNode.gain.setValueAtTime(0.001, startTime);
  gainNode.gain.linearRampToValueAtTime(0.25, startTime + attack);
  gainNode.gain.linearRampToValueAtTime(0.12, startTime + 0.04);
  gainNode.gain.setValueAtTime(0.12, startTime + duration - releaseTime);
  gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  osc.connect(filterNode);
  osc2.connect(filterNode);
  filterNode.connect(gainNode);
  gainNode.connect(ctx.destination);

  osc.start(startTime);
  osc2.start(startTime);
  osc.stop(startTime + duration + 0.01);
  osc2.stop(startTime + duration + 0.01);
}

export { getAudioContext };
