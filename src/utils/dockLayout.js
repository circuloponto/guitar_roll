// Constrained dock layout. Fretboard and timeline always sit side by side (only their
// order can flip). The track strip sits above or below them. The menu is a top bar or a
// collapsible side bar on the left or right.
//
// The state is turned into a split tree ({ id } leaves, { dir, ratio, a, b } splits) so
// panels can be positioned flat (no remounting when they move).

export const PANEL_IDS = ['menu', 'tracks', 'fretboard', 'timeline'];
export const PANEL_TITLES = { menu: 'Menu', tracks: 'Tracks', fretboard: 'Fretboard', timeline: 'Timeline' };
const STORAGE_KEY = 'guitar-roll-layout-v2';
export const COLLAPSED_PX = 30;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function defaultState(w = 1400, h = 900) {
  return {
    menu: 'top',            // 'top' | 'left' | 'right'
    menuCollapsed: false,   // only applies to a side bar
    tracks: 'top',          // 'top' | 'bottom'
    fretFirst: true,        // fretboard left of the timeline
    sizes: {
      menuTop: clamp(140 / h, 0.05, 0.3),    // share of height
      menuSide: clamp(280 / w, 0.1, 0.45),   // share of width
      tracks: clamp(146 / (h - 140), 0.05, 0.35),
      fret: clamp(380 / w, 0.15, 0.6),
    },
  };
}

export function loadState(w, h) {
  const d = defaultState(w, h);
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s && ['top', 'left', 'right'].includes(s.menu) && ['top', 'bottom'].includes(s.tracks)
      && typeof s.fretFirst === 'boolean' && s.sizes) {
      const ok = (v) => Number.isFinite(v) && v > 0.02 && v < 0.9;
      return {
        menu: s.menu, menuCollapsed: !!s.menuCollapsed, tracks: s.tracks, fretFirst: s.fretFirst,
        sizes: {
          menuTop: ok(s.sizes.menuTop) ? s.sizes.menuTop : d.sizes.menuTop,
          menuSide: ok(s.sizes.menuSide) ? s.sizes.menuSide : d.sizes.menuSide,
          tracks: ok(s.sizes.tracks) ? s.sizes.tracks : d.sizes.tracks,
          fret: ok(s.sizes.fret) ? s.sizes.fret : d.sizes.fret,
        },
      };
    }
  } catch { /* ignore */ }
  return d;
}

export function saveState(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
export function clearSavedState() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

// Split nodes carry `key` (which size they edit) and `inv` (ratio is the share of the
// second child, so a pointer ratio must be flipped before storing).
export function buildTree(st, containerW = 1400) {
  const { sizes } = st;
  const f = sizes.fret;
  const main = {
    dir: 'row', key: 'fret', inv: !st.fretFirst,
    ratio: st.fretFirst ? f : 1 - f,
    a: { id: st.fretFirst ? 'fretboard' : 'timeline' },
    b: { id: st.fretFirst ? 'timeline' : 'fretboard' },
  };
  const t = sizes.tracks;
  const center = st.tracks === 'top'
    ? { dir: 'col', key: 'tracks', inv: false, ratio: t, a: { id: 'tracks' }, b: main }
    : { dir: 'col', key: 'tracks', inv: true, ratio: 1 - t, a: main, b: { id: 'tracks' } };
  if (st.menu === 'top') {
    return { dir: 'col', key: 'menuTop', inv: false, ratio: sizes.menuTop, a: { id: 'menu' }, b: center };
  }
  const fixed = st.menuCollapsed;
  const w = fixed ? clamp(COLLAPSED_PX / containerW, 0.01, 0.2) : sizes.menuSide;
  return st.menu === 'left'
    ? { dir: 'row', key: 'menuSide', inv: false, fixed, ratio: w, a: { id: 'menu' }, b: center }
    : { dir: 'row', key: 'menuSide', inv: true, fixed, ratio: 1 - w, a: center, b: { id: 'menu' } };
}

// Rects are fractions of the whole container.
export function computeRects(node, rect = { x: 0, y: 0, w: 1, h: 1 }, out = { panels: {}, gutters: [] }) {
  if (node.id) { out.panels[node.id] = rect; return out; }
  const { dir, ratio } = node;
  let ra, rb;
  if (dir === 'row') {
    ra = { x: rect.x, y: rect.y, w: rect.w * ratio, h: rect.h };
    rb = { x: rect.x + ra.w, y: rect.y, w: rect.w - ra.w, h: rect.h };
  } else {
    ra = { x: rect.x, y: rect.y, w: rect.w, h: rect.h * ratio };
    rb = { x: rect.x, y: rect.y + ra.h, w: rect.w, h: rect.h - ra.h };
  }
  if (!node.fixed) out.gutters.push({ key: node.key, inv: node.inv, dir, rect, ratio });
  computeRects(node.a, ra, out);
  computeRects(node.b, rb, out);
  return out;
}

// Where would dropping the dragged panel at pointer (fx, fy: container fractions) put it?
// Returns { apply(state) -> state, rect } or null.
export function dropTarget(dragId, st, panels, fx, fy) {
  if (dragId === 'menu') {
    if (fx < 0.18) return { rect: { x: 0, y: 0, w: 0.18, h: 1 }, apply: (s) => ({ ...s, menu: 'left' }) };
    if (fx > 0.82) return { rect: { x: 0.82, y: 0, w: 0.18, h: 1 }, apply: (s) => ({ ...s, menu: 'right' }) };
    if (fy < 0.15) return { rect: { x: 0, y: 0, w: 1, h: 0.15 }, apply: (s) => ({ ...s, menu: 'top' }) };
    return null;
  }
  const f = panels.fretboard, t = panels.timeline;
  const row = {
    x: Math.min(f.x, t.x), y: f.y,
    w: Math.max(f.x + f.w, t.x + t.w) - Math.min(f.x, t.x), h: f.h,
  };
  if (dragId === 'tracks') {
    const mid = row.y + row.h / 2;
    const inRow = fx >= row.x && fx <= row.x + row.w;
    if (!inRow) return null;
    return fy < mid
      ? { rect: { ...row, h: row.h / 2 }, apply: (s) => ({ ...s, tracks: 'top' }) }
      : { rect: { ...row, y: mid, h: row.h / 2 }, apply: (s) => ({ ...s, tracks: 'bottom' }) };
  }
  // fretboard / timeline: flip the order by dropping on the left or right half of the pair
  if (fx < row.x || fx > row.x + row.w || fy < row.y || fy > row.y + row.h) return null;
  const left = fx < row.x + row.w / 2;
  const fretLeft = dragId === 'fretboard' ? left : !left;
  return {
    rect: left ? { ...row, w: row.w / 2 } : { ...row, x: row.x + row.w / 2, w: row.w / 2 },
    apply: (s) => ({ ...s, fretFirst: fretLeft }),
  };
}

export function applyRatio(st, key, inv, ratio) {
  const v = inv ? 1 - ratio : ratio;
  return { ...st, sizes: { ...st.sizes, [key]: v } };
}
