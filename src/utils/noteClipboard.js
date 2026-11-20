// System-clipboard interchange format for notes (guitar-roll <-> 43_scales).
//
// Time is expressed in QUARTER NOTES so it does not depend on either app's grid:
//   guitar-roll: one column = one beat of the time-signature denominator
//                quarters = columns * 4 / den
//   43_scales:   one cell = a 16th note        quarters = cells / 4
//
// Payload (JSON, text/plain):
//   { format: 'tonomancy-notes', version: 1, source: 'guitar-roll', position?: 0-20,
//     notes: [{ start, length, midi, velocity?, hint?: {s, f}, bend?, slideTo?, ghost? }] }
//   start is relative to the earliest copied note. Receivers ignore keys they
//   do not know; `hint` (string/fret) is only used if it still matches `midi`.
//   `position` is the fretboard window (lower fret of the 5-fret span [p, p+4]),
//   shared by both apps; the receiver adopts it so fingering lines up.
import { NUM_STRINGS, NUM_FRETS } from './constants';
import { getMidiNote, getComboForPosition } from './pitchMap';

export const CLIPBOARD_FORMAT = 'tonomancy-notes';
export const CLIPBOARD_VERSION = 1;

const round = (v) => Math.round(v * 1e6) / 1e6;
const denOf = (timeSignature) => (timeSignature && timeSignature[1]) || 4;

export function serializeNotes(notes, timeSignature = [4, 4], position) {
  if (!notes.length) return null;
  const q = 4 / denOf(timeSignature);
  const minBeat = Math.min(...notes.map(n => n.beat));
  const items = notes.map((n) => {
    const item = {
      start: round((n.beat - minBeat) * q),
      length: round((n.duration || 1) * q),
      midi: getMidiNote(n.stringIndex, n.fret),
      velocity: n.velocity ?? 0.8,
      hint: { s: n.stringIndex, f: n.fret },
    };
    if (n.bend) item.bend = n.bend;
    if (n.slideTo !== undefined && n.slideTo !== null) item.slideTo = n.slideTo;
    if (n.ghost) item.ghost = true;
    return item;
  });
  const payload = {
    format: CLIPBOARD_FORMAT,
    version: CLIPBOARD_VERSION,
    source: 'guitar-roll',
  };
  if (Number.isInteger(position) && position >= 0) payload.position = position;
  payload.notes = items;
  return JSON.stringify(payload);
}

// Returns { notes, skipped, position } (notes have beat relative to 0; position is
// the sender's fretboard window or undefined), or null if `text`
// is not our format. `skipped` counts pitches the guitar cannot play.
export function parseNotes(text, { timeSignature = [4, 4], position = 0, defaultVelocity = 0.8 } = {}) {
  if (typeof text !== 'string' || text.length === 0 || text[0] !== '{') return null;
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!data || data.format !== CLIPBOARD_FORMAT || !Array.isArray(data.notes)) return null;

  const perQuarter = denOf(timeSignature) / 4; // columns per quarter note
  const notes = [];
  let skipped = 0;
  const maxPos = Math.max(0, NUM_FRETS - 4);
  const sentPosition = Number.isInteger(data.position) && data.position >= 0 && data.position <= maxPos
    ? data.position : undefined;
  let pos = sentPosition ?? position;

  for (const item of data.notes) {
    const start = Number(item?.start);
    const length = Number(item?.length);
    const midi = Number(item?.midi);
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(length) || length <= 0 || !Number.isInteger(midi)) {
      skipped++;
      continue;
    }

    let stringIndex;
    let fret;
    const h = item.hint;
    if (h && Number.isInteger(h.s) && Number.isInteger(h.f)
        && h.s >= 0 && h.s < NUM_STRINGS && h.f >= 0 && h.f <= NUM_FRETS
        && getMidiNote(h.s, h.f) === midi) {
      stringIndex = h.s; fret = h.f;
    } else {
      const combo = getComboForPosition(midi, pos);
      if (!combo) { skipped++; continue; }
      stringIndex = combo.stringIndex; fret = combo.fret;
      pos = combo.position ?? pos;
    }

    const note = {
      stringIndex,
      fret,
      beat: round(start * perQuarter),
      duration: round(length * perQuarter),
      velocity: Number.isFinite(item.velocity) ? Math.min(1, Math.max(0, item.velocity)) : defaultVelocity,
    };
    if (Number.isFinite(item.bend) && item.bend > 0) note.bend = item.bend;
    if (Number.isFinite(item.slideTo)) note.slideTo = item.slideTo;
    if (item.ghost === true) note.ghost = true;
    notes.push(note);
  }
  return { notes, skipped, position: sentPosition };
}
