// UI accent colour: stored in localStorage and applied as CSS variables on :root.
export const DEFAULT_ACCENT = '#9c36b5';
const KEY = 'guitar-roll-accent';

export function loadAccent() {
  try {
    const v = localStorage.getItem(KEY);
    if (v && /^#[0-9a-f]{6}$/i.test(v)) return v;
  } catch { /* ignore */ }
  return DEFAULT_ACCENT;
}

export function applyAccent(hex) {
  const root = document.documentElement;
  root.style.setProperty('--accent', hex);
  // The brighter companion used for hovers and highlights.
  root.style.setProperty('--accent-hi', `color-mix(in srgb, ${hex} 78%, white)`);
}

export function saveAccent(hex) {
  try {
    if (hex === DEFAULT_ACCENT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, hex);
  } catch { /* ignore */ }
}
