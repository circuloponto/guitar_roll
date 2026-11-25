// Width of the piano key column beside the Timeline: normal, small, or hidden.
const KEY = 'guitar-roll-piano-size';
export const PIANO_SIZES = { normal: 'Normal', small: 'Small', hidden: 'Hidden' };
const WIDTHS = { normal: 64, small: 38, hidden: 0 };

export function loadPianoSize() {
  try { const v = localStorage.getItem(KEY); return PIANO_SIZES[v] ? v : 'normal'; } catch { return 'normal'; }
}
export function applyPianoSize(size) {
  const w = WIDTHS[size] ?? 64;
  const root = document.documentElement;
  root.style.setProperty('--piano-w', `${w}px`);
  root.dataset.pianoSize = size;
}
export function setPianoSize(size) {
  try { localStorage.setItem(KEY, size); } catch { /* ignore */ }
  applyPianoSize(size);
}
