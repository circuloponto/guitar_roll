// Playback note visuals: each note flashes at its onset and fades out, so repeating the same pitch
// reads as separate hits instead of one held note. How long the fade takes follows the note's real
// length in seconds (so it follows tempo): short notes pulse quickly, long notes linger, and a long
// held note keeps a dim glow until it ends.
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const NOTE_FADE_PRESETS = { off: 0, short: 0.5, normal: 1, long: 2 };

// tSec: seconds since the note started; durSec: the note's length in seconds; factor: fade length
// multiplier (0 = no fade, hold for the whole note). Returns brightness 0..1.
export function noteEnvelope(tSec, durSec, factor = 1) {
  if (tSec < 0) return 0;
  if (!(factor > 0)) return tSec <= durSec ? 1 : 0;
  const attack = Math.min(1, tSec / 0.015);                       // no click at the very first instant
  const fade = clamp(durSec * 0.9, 0.18, 2) * factor;             // how long the flash takes to die away
  const tau = fade / 3;
  const floor = durSec > 0.6 ? 0.3 : 0;                           // held notes keep a dim glow
  const release = clamp(durSec * 0.25, 0.08, 0.5) * factor;       // fade after the note ends
  if (tSec <= durSec) return attack * Math.max(Math.exp(-tSec / tau), floor);
  const atEnd = Math.max(Math.exp(-durSec / tau), floor);
  const r = (tSec - durSec) / release;
  return r >= 1 ? 0 : atEnd * (1 - r);
}
