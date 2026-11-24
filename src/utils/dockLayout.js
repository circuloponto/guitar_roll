// Window layout, FL Studio style: every panel can be resized (the neighbours adapt), minimised to a
// title strip (the others grow into the space), and undocked into a floating window that can be
// moved and resized freely, then docked back into its slot.
//
// Docked panels follow a constrained arrangement: fretboard and timeline sit side by side (only
// their order can flip), the track strip goes above or below them, and the menu is a top bar or a
// side bar. The arrangement is turned into a split tree ({ id } leaves, { dir, ratio, a, b }
// splits) from whichever panels are docked, so panels can be positioned flat (no remounting).

export const PANEL_IDS = ['menu', 'tracks', 'fretboard', 'timeline'];
export const PANEL_TITLES = { menu: 'Menu', tracks: 'Tracks', fretboard: 'Fretboard', timeline: 'Timeline' };
const STORAGE_KEY = 'guitar-roll-layout-v3';
const OLD_STORAGE_KEY = 'guitar-roll-layout-v2';
export const STRIP_PX = 26;          // a minimised panel is just its title strip
export const FLOAT_MIN_W = 220;      // smallest floating window, in px
export const FLOAT_MIN_H = 110;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function defaultState(w = 1400, h = 900) {
  return {
    menu: 'top',            // 'top' | 'left' | 'right'
    tracks: 'top',          // 'top' | 'bottom'
    fretFirst: true,        // fretboard left of the timeline
    sizes: {
      menuTop: clamp(140 / h, 0.05, 0.3),    // share of height
      menuSide: clamp(280 / w, 0.1, 0.45),   // share of width
      tracks: clamp(146 / (h - 140), 0.05, 0.35),
      fret: clamp(380 / w, 0.15, 0.6),
    },
    minimized: {},          // { [id]: true }
    floating: {},           // { [id]: { x, y, w, h } } as fractions of the dock area
    order: [],              // floating windows, back to front
  };
}

const okFrac = (v) => Number.isFinite(v) && v > 0.02 && v < 0.9;
const okRect = (r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0.05 && r.h > 0.03;

function readState(raw, d) {
  const s = JSON.parse(raw);
  if (!s || !['top', 'left', 'right'].includes(s.menu) || !['top', 'bottom'].includes(s.tracks)
    || typeof s.fretFirst !== 'boolean' || !s.sizes) return null;
  const minimized = {};
  const floating = {};
  PANEL_IDS.forEach((id) => {
    if (s.minimized?.[id]) minimized[id] = true;
    if (okRect(s.floating?.[id])) floating[id] = { ...s.floating[id] };
  });
  if (s.menuCollapsed && s.menu !== 'top') minimized.menu = true; // the old "collapse the side bar"
  return {
    menu: s.menu, tracks: s.tracks, fretFirst: s.fretFirst,
    sizes: {
      menuTop: okFrac(s.sizes.menuTop) ? s.sizes.menuTop : d.sizes.menuTop,
      menuSide: okFrac(s.sizes.menuSide) ? s.sizes.menuSide : d.sizes.menuSide,
      tracks: okFrac(s.sizes.tracks) ? s.sizes.tracks : d.sizes.tracks,
      fret: okFrac(s.sizes.fret) ? s.sizes.fret : d.sizes.fret,
    },
    minimized, floating,
    order: (Array.isArray(s.order) ? s.order : []).filter(id => floating[id]),
  };
}

export function loadState(w, h) {
  const d = defaultState(w, h);
  for (const key of [STORAGE_KEY, OLD_STORAGE_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const s = readState(raw, d);
      if (s) return s;
    } catch { /* ignore */ }
  }
  return d;
}

export function saveState(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
export function clearSavedState() {
  try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(OLD_STORAGE_KEY); } catch { /* ignore */ }
}

export const isFloating = (st, id) => !!st.floating[id];

// Tree of the DOCKED panels (floating ones leave the tree and the others take their space).
// Split nodes carry `key` (which size they edit) and `inv` (ratio is the share of the second
// child, so a pointer ratio must be flipped before storing). Returns null if nothing is docked.
export function buildTree(st) {
  const docked = (id) => !st.floating[id];
  const leaf = (id) => ({ id, min: !!st.minimized[id] });
  const { sizes } = st;

  let main = null;
  const f = docked('fretboard'), t = docked('timeline');
  if (f && t) {
    main = {
      dir: 'row', key: 'fret', inv: !st.fretFirst,
      ratio: st.fretFirst ? sizes.fret : 1 - sizes.fret,
      a: leaf(st.fretFirst ? 'fretboard' : 'timeline'),
      b: leaf(st.fretFirst ? 'timeline' : 'fretboard'),
    };
  } else if (f) main = leaf('fretboard');
  else if (t) main = leaf('timeline');

  let center = main;
  if (docked('tracks')) {
    const tr = leaf('tracks');
    if (!main) center = tr;
    else if (st.tracks === 'top') center = { dir: 'col', key: 'tracks', inv: false, ratio: sizes.tracks, a: tr, b: main };
    else center = { dir: 'col', key: 'tracks', inv: true, ratio: 1 - sizes.tracks, a: main, b: tr };
  }

  if (!docked('menu')) return center;
  const me = leaf('menu');
  if (!center) return me;
  if (st.menu === 'top') return { dir: 'col', key: 'menuTop', inv: false, ratio: sizes.menuTop, a: me, b: center };
  return st.menu === 'left'
    ? { dir: 'row', key: 'menuSide', inv: false, ratio: sizes.menuSide, a: me, b: center }
    : { dir: 'row', key: 'menuSide', inv: true, ratio: 1 - sizes.menuSide, a: center, b: me };
}

const allMinimized = (n) => (n.id ? !!n.min : allMinimized(n.a) && allMinimized(n.b));

// Rects are fractions of the whole dock area; `size` is its size in px (a minimised panel is a
// fixed-size strip, so the strip's share depends on it). Returns { panels, gutters }.
export function computeRects(node, size = { w: 1400, h: 900 }, rect = { x: 0, y: 0, w: 1, h: 1 }, out = { panels: {}, gutters: [] }) {
  if (!node) return out;
  if (node.id) { out.panels[node.id] = rect; return out; }
  const { dir } = node;
  const aMin = allMinimized(node.a), bMin = allMinimized(node.b);
  let ratio = node.ratio;
  let fixed = false;
  if (aMin !== bMin) {
    // one side is only a title strip: it keeps its strip size and the other side gets the rest
    const dim = dir === 'row' ? rect.w * size.w : rect.h * size.h;
    const strip = Math.min(0.5, STRIP_PX / Math.max(1, dim));
    ratio = aMin ? strip : 1 - strip;
    fixed = true;
  } else if (aMin && bMin) {
    const dim = dir === 'row' ? rect.w * size.w : rect.h * size.h;
    ratio = Math.min(0.5, STRIP_PX / Math.max(1, dim));
    fixed = true;
  }
  let ra, rb;
  if (dir === 'row') {
    ra = { x: rect.x, y: rect.y, w: rect.w * ratio, h: rect.h };
    rb = { x: rect.x + ra.w, y: rect.y, w: rect.w - ra.w, h: rect.h };
  } else {
    ra = { x: rect.x, y: rect.y, w: rect.w, h: rect.h * ratio };
    rb = { x: rect.x, y: rect.y + ra.h, w: rect.w, h: rect.h - ra.h };
  }
  if (!fixed) out.gutters.push({ key: node.key, inv: node.inv, dir, rect, ratio });
  computeRects(node.a, size, ra, out);
  computeRects(node.b, size, rb, out);
  return out;
}

// Where would dropping the dragged panel at pointer (fx, fy: fractions of the dock area) put it?
// Returns { apply(state) -> state, rect } or null. Only docked panels are drop targets.
export function dropTarget(dragId, st, panels, fx, fy) {
  if (dragId === 'menu') {
    if (fx < 0.18) return { rect: { x: 0, y: 0, w: 0.18, h: 1 }, apply: (s) => ({ ...s, menu: 'left' }) };
    if (fx > 0.82) return { rect: { x: 0.82, y: 0, w: 0.18, h: 1 }, apply: (s) => ({ ...s, menu: 'right' }) };
    if (fy < 0.15) return { rect: { x: 0, y: 0, w: 1, h: 0.15 }, apply: (s) => ({ ...s, menu: 'top' }) };
    return null;
  }
  const f = panels.fretboard, t = panels.timeline;
  if (dragId === 'tracks') {
    const rows = [f, t].filter(Boolean);
    if (!rows.length) return null;
    const row = {
      x: Math.min(...rows.map(r => r.x)), y: rows[0].y,
      w: Math.max(...rows.map(r => r.x + r.w)) - Math.min(...rows.map(r => r.x)), h: rows[0].h,
    };
    if (fx < row.x || fx > row.x + row.w) return null;
    const mid = row.y + row.h / 2;
    return fy < mid
      ? { rect: { ...row, h: row.h / 2 }, apply: (s) => ({ ...s, tracks: 'top' }) }
      : { rect: { ...row, y: mid, h: row.h / 2 }, apply: (s) => ({ ...s, tracks: 'bottom' }) };
  }
  // fretboard / timeline: flip the order by dropping on the left or right half of the pair
  if (!f || !t) return null;
  const row = {
    x: Math.min(f.x, t.x), y: f.y,
    w: Math.max(f.x + f.w, t.x + t.w) - Math.min(f.x, t.x), h: f.h,
  };
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

// ---- window actions (each returns a new state) ----

export function toggleMinimized(st, id) {
  const minimized = { ...st.minimized };
  if (minimized[id]) delete minimized[id]; else minimized[id] = true;
  return { ...st, minimized };
}

// Undock into a floating window where the panel currently sits (`from`: its docked rect, fractions).
export function undock(st, id, from) {
  const base = from || { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
  const rect = {
    x: clamp(base.x + 0.03, 0, 0.7), y: clamp(base.y + 0.04, 0, 0.7),
    w: clamp(base.w, 0.2, 0.9), h: clamp(base.h, 0.2, 0.9),
  };
  const minimized = { ...st.minimized };
  delete minimized[id]; // a floating window opens at full size
  return { ...st, floating: { ...st.floating, [id]: rect }, minimized, order: [...st.order.filter(x => x !== id), id] };
}

export function dockBack(st, id) {
  const floating = { ...st.floating };
  delete floating[id];
  const minimized = { ...st.minimized };
  delete minimized[id];
  return { ...st, floating, minimized, order: st.order.filter(x => x !== id) };
}

export function raiseFloating(st, id) {
  if (!st.floating[id] || st.order[st.order.length - 1] === id) return st;
  return { ...st, order: [...st.order.filter(x => x !== id), id] };
}

export function setFloatRect(st, id, rect) {
  return { ...st, floating: { ...st.floating, [id]: rect } };
}
