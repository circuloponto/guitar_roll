import { NUM_STRINGS, NUM_FRETS } from './constants';

// Open string MIDI values: E2=40, A2=45, D3=50, G3=55, B3=59, E4=64
const OPEN_STRING_MIDI = [40, 45, 50, 55, 59, 64];
const TOTAL_FRETS = NUM_FRETS + 1; // 0..25

const MAX_POSITION = Math.max(0, NUM_FRETS - 4);

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function getMidiNote(stringIndex, fret) {
  return OPEN_STRING_MIDI[stringIndex] + fret;
}

export function midiToNoteName(midi) {
  const note = NOTE_NAMES[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return note + octave;
}

// Build sorted list of all unique MIDI notes producible
const allMidi = new Set();
for (let s = 0; s < NUM_STRINGS; s++) {
  for (let f = 0; f < TOTAL_FRETS; f++) {
    allMidi.add(getMidiNote(s, f));
  }
}
export const PITCH_LIST = [...allMidi].sort((a, b) => a - b);
export const TOTAL_PITCH_ROWS = PITCH_LIST.length;

const midiToRowMap = new Map();
PITCH_LIST.forEach((midi, i) => midiToRowMap.set(midi, i));

export function midiToPitchRow(midi) {
  return midiToRowMap.get(midi) ?? -1;
}

export function pitchRowToMidi(row) {
  return PITCH_LIST[row];
}

export function noteToPitchRow(stringIndex, fret) {
  return midiToPitchRow(getMidiNote(stringIndex, fret));
}

// All string+fret combos that produce a given MIDI note
export function pitchRowCombos(pitchRow) {
  const midi = PITCH_LIST[pitchRow];
  const combos = [];
  for (let s = 0; s < NUM_STRINGS; s++) {
    const fret = midi - OPEN_STRING_MIDI[s];
    if (fret >= 0 && fret < TOTAL_FRETS) {
      combos.push({ stringIndex: s, fret });
    }
  }
  return combos;
}

// Best string+fret for a target MIDI, preferring the given string
export function closestComboForPitch(midi, preferredStringIndex) {
  // Try preferred string first
  const fretOnPreferred = midi - OPEN_STRING_MIDI[preferredStringIndex];
  if (fretOnPreferred >= 0 && fretOnPreferred < TOTAL_FRETS) {
    return { stringIndex: preferredStringIndex, fret: fretOnPreferred };
  }
  // Otherwise find the combo with lowest fret
  let best = null;
  for (let s = 0; s < NUM_STRINGS; s++) {
    const fret = midi - OPEN_STRING_MIDI[s];
    if (fret >= 0 && fret < TOTAL_FRETS) {
      if (!best || fret < best.fret) {
        best = { stringIndex: s, fret };
      }
    }
  }
  return best;
}

/**
 * Get the best string+fret placement for a MIDI note given a guitar position.
 * Position N = frets N through N+4 are considered "in position".
 *
 * Strategy:
 * 1. Find combos whose fret falls within [position, position+4].
 *    Among those, pick the one with the lowest fret.
 * 2. If no combo is in range, adjust position so the closest combo lands on
 *    the nearest boundary of the position window:
 *    - If the closest combo's fret is below position, set position = fret
 *    - If the closest combo's fret is above position+4, set position = fret-4
 *    Clamp position to [0, MAX_POSITION].
 *
 * Returns { stringIndex, fret, position: newPosition }
 */
export function getComboForPosition(midi, position = 0) {
  const pitchRow = midiToPitchRow(midi);
  if (pitchRow < 0) return null;
  const combos = pitchRowCombos(pitchRow);
  const validCombos = combos.filter(c => c.fret >= 0 && c.fret <= NUM_FRETS);
  if (validCombos.length === 0) return null;

  const posEnd = Math.min(position + 4, NUM_FRETS);
  const inPosition = validCombos.filter(c => c.fret >= position && c.fret <= posEnd);

  if (inPosition.length > 0) {
    inPosition.sort((a, b) => a.fret - b.fret || a.stringIndex - b.stringIndex);
    return { stringIndex: inPosition[0].stringIndex, fret: inPosition[0].fret, position };
  }

  let bestCombo = null;
  let bestDist = Infinity;
  let bestNewPos = position;

  for (const c of validCombos) {
    let dist;
    let newPos;
    if (c.fret < position) {
      dist = position - c.fret;
      newPos = c.fret;
    } else {
      dist = c.fret - posEnd;
      newPos = Math.max(0, c.fret - 4);
    }
    if (dist < bestDist) {
      bestDist = dist;
      bestCombo = c;
      bestNewPos = Math.max(0, Math.min(MAX_POSITION, newPos));
    }
  }

  if (bestCombo) {
    return { stringIndex: bestCombo.stringIndex, fret: bestCombo.fret, position: bestNewPos };
  }

  const fallback = validCombos[0];
  const clampedPos = Math.max(0, Math.min(MAX_POSITION, fallback.fret));
  return { stringIndex: fallback.stringIndex, fret: fallback.fret, position: clampedPos };
}
