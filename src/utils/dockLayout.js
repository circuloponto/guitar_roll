// Window layout, FL Studio style: every panel can be resized against its neighbours (which adapt),
// minimised to a title strip, undocked into a floating window, and docked anywhere: drop a panel on
// the edge of another one to split it, on its middle to swap, or on the outer border of the dock.
//
// Docked panels form a split tree: { id } leaves and { dir: 'row'|'col', ratio, a, b } splits (ratio
// is the share of `a`). The tree holds exactly the docked panels; floating ones are kept apart.

export const PANEL_IDS = ['menu', 'tracks', 'fretboard', 'timeline', 'sync', 'arrangement', 'synth'];
const NEW_PANELS = ['sync', 'arrangement', 'synth']; // added later: layouts saved before them keep these closed
export const PANEL_TITLES = { menu: 'Menu', tracks: 'Tracks', fretboard: 'Fretboard', timeline: 'Timeline', sync: 'Sync editor', arrangement: 'Arrangement', synth: 'Synth' };
export const CLOSABLE = ['arrangement', 'fretboard', 'timeline', 'tracks', 'synth', 'sync']; // the menu holds the toolbar, so it stays
const STORAGE_KEY = 'guitar-roll-layout-v5';
const V4_KEY = 'guitar-roll-layout-v4';
const V3_KEY = 'guitar-roll-layout-v3';
const V2_KEY = 'guitar-roll-layout-v2';
export const STRIP_PX = 26;          // a minimised panel is just its title strip
export const FLOAT_MIN_W = 220;      // smallest floating window, in px
export const FLOAT_MIN_H = 110;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const leaf = (id) => ({ id });
// An empty slot is a leaf whose id starts with '_': the space left when a panel is narrowed. A panel
// can be dropped into it.
export const isEmptyId = (id) => typeof id === 'string' && id.startsWith('_');
let emptyCounter = 0;
const newEmpty = () => leaf(`_e${Date.now().toString(36)}${emptyCounter++}`);
const split = (dir, ratio, a, b) => ({ dir, ratio, a, b });

export function defaultState(w = 1400, h = 900) {
  // The board's layout: the Arrangement (track list + lanes) top left, fretboard and timeline below,
  // the menu as a narrow column on the right. The Tracks (tracks + Synth tabs) and Sync editor windows
  // start closed and open from the toolbar buttons.
  const menuW = clamp(300 / w, 0.14, 0.3);
  const arrH = clamp(250 / h, 0.2, 0.45);
  const fretW = clamp(420 / (w * (1 - menuW)), 0.2, 0.55);
  return {
    v: 5,
    tree: split('row', 1 - menuW,
      split('col', arrH, leaf('arrangement'), split('row', fretW, leaf('fretboard'), leaf('timeline'))),
      leaf('menu')),
    minimized: {},          // { [id]: true }
    closed: { tracks: true, synth: true, sync: true }, // closed panels are out of the layout; the toolbar buttons reopen them
    floating: {},           // { [id]: { x, y, w, h } } as fractions of the dock area
    order: [],              // floating windows, back to front
  };
}

const okRect = (r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0.05 && r.h > 0.03;
const okRatio = (v) => Number.isFinite(v) && v > 0.01 && v < 0.99;

function collectIds(n, out = []) {
  if (!n) return out;
  if (n.id) out.push(n.id); else { collectIds(n.a, out); collectIds(n.b, out); }
  return out;
}

// copy only the valid structure of a tree (null if malformed)
function cleanTree(n) {
  if (!n) return null;
  if (n.id) return PANEL_IDS.includes(n.id) || (isEmptyId(n.id) && /^_e[a-z0-9]+$/.test(n.id)) ? leaf(n.id) : null;
  if (!['row', 'col'].includes(n.dir) || !okRatio(n.ratio)) return null;
  const a = cleanTree(n.a), b = cleanTree(n.b);
  return a && b ? split(n.dir, n.ratio, a, b) : null;
}

function migrateV5(s, tree) {
  return { s, tree }; // saved layouts keep their windows as they were
}

function finish(s0, tree0) {
  const { s, tree } = migrateV5(s0, tree0);
  const minimized = {}, floating = {};
  PANEL_IDS.forEach((id) => {
    if (s.minimized?.[id]) minimized[id] = true;
    if (okRect(s.floating?.[id])) floating[id] = { ...s.floating[id] };
  });
  const closed = {};
  if (s.closed) PANEL_IDS.forEach((id) => { if (s.closed[id] && CLOSABLE.includes(id)) closed[id] = true; });
  const ids = collectIds(tree).filter(i => !isEmptyId(i));
  NEW_PANELS.forEach((id) => { if (!ids.includes(id) && !floating[id]) closed[id] = true; }); // saved before this panel existed
  const expected = PANEL_IDS.filter(id => !floating[id] && !closed[id]);
  const ok = ids.length === new Set(ids).size && ids.length === expected.length && expected.every(id => ids.includes(id));
  if (!ok) return null;
  return { v: 5, tree, minimized, closed, floating, order: (Array.isArray(s.order) ? s.order : []).filter(id => floating[id]) };
}

// the old fixed arrangement (v2/v3) as a tree
function legacyTree(s, d) {
  const fl = s.floating || {};
  const docked = (id) => !(s.floating?.[id] && okRect(fl[id]));
  const z = s.sizes || {};
  const frac = (v, dv) => (Number.isFinite(v) && v > 0.02 && v < 0.9 ? v : dv);
  const sz = { menuTop: frac(z.menuTop, 0.15), menuSide: frac(z.menuSide, 0.2), tracks: frac(z.tracks, 0.15), fret: frac(z.fret, 0.3) };
  void d;
  let main = null;
  const f = docked('fretboard'), t = docked('timeline');
  if (f && t) main = s.fretFirst ? split('row', sz.fret, leaf('fretboard'), leaf('timeline')) : split('row', 1 - sz.fret, leaf('timeline'), leaf('fretboard'));
  else if (f) main = leaf('fretboard'); else if (t) main = leaf('timeline');
  let center = main;
  if (docked('tracks')) {
    if (!main) center = leaf('tracks');
    else center = s.tracks === 'top' ? split('col', sz.tracks, leaf('tracks'), main) : split('col', 1 - sz.tracks, main, leaf('tracks'));
  }
  if (!docked('menu')) return center;
  if (!center) return leaf('menu');
  if (s.menu === 'top') return split('col', sz.menuTop, leaf('menu'), center);
  return s.menu === 'left' ? split('row', sz.menuSide, leaf('menu'), center) : split('row', 1 - sz.menuSide, center, leaf('menu'));
}

export function loadState(w, h) {
  const d = defaultState(w, h);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const r = s && finish(s, cleanTree(s.tree));
      if (r) return r;
    }
  } catch { /* ignore */ }
  try {
    const raw = localStorage.getItem(V4_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const r = s && finish({ ...s, v: undefined }, cleanTree(s.tree));
      if (r) return r;
    }
  } catch { /* ignore */ }
  for (const key of [V3_KEY, V2_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const s = JSON.parse(raw);
      if (!s || !['top', 'left', 'right'].includes(s.menu) || !['top', 'bottom'].includes(s.tracks) || typeof s.fretFirst !== 'boolean') continue;
      const mini = { ...(s.minimized || {}) };
      if (s.menuCollapsed && s.menu !== 'top') mini.menu = true;
      const r = finish({ ...s, minimized: mini }, legacyTree(s, d));
      if (r) return r;
    } catch { /* ignore */ }
  }
  // nothing saved yet: use the layout saved as the default, if there is one
  try {
    const b = JSON.parse(localStorage.getItem('guitar-roll-layout-default'));
    const r = b && b.format === 'guitar-roll-layout' ? finish(b.dock, cleanTree(b.dock?.tree)) : null;
    if (r) return r;
  } catch { /* ignore */ }
  return d;
}

export function saveState(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
export function clearSavedState() {
  try { [STORAGE_KEY, V4_KEY, V3_KEY, V2_KEY].forEach(k => localStorage.removeItem(k)); } catch { /* ignore */ }
}

export const isFloating = (st, id) => !!st.floating[id];

// ---- tree helpers ----
const allMinimized = (n, mini) => (n.id ? !!mini[n.id] : allMinimized(n.a, mini) && allMinimized(n.b, mini));

export function removeLeaf(n, id) {
  if (!n) return null;
  if (n.id) return n.id === id ? null : n;
  const a = removeLeaf(n.a, id), b = removeLeaf(n.b, id);
  if (!a) return b;
  if (!b) return a;
  return a === n.a && b === n.b ? n : { ...n, a, b };
}

// share of the slot the new panel gets: the menu is a slim bar, the rest start half and half
const newShare = (id) => (id === 'menu' ? 0.22 : 0.5);
function insertBeside(n, targetId, id, side) {
  if (n.id) {
    if (n.id !== targetId) return n;
    const dir = side === 'n' || side === 's' ? 'col' : 'row';
    const k = newShare(id);
    return side === 'n' || side === 'w' ? split(dir, k, leaf(id), n) : split(dir, 1 - k, n, leaf(id));
  }
  const a = insertBeside(n.a, targetId, id, side), b = insertBeside(n.b, targetId, id, side);
  return a === n.a && b === n.b ? n : { ...n, a, b };
}

function replaceLeaf(n, targetId, id) {
  if (!n) return n;
  if (n.id) return n.id === targetId ? leaf(id) : n;
  return { ...n, a: replaceLeaf(n.a, targetId, id), b: replaceLeaf(n.b, targetId, id) };
}

function swapLeaves(n, x, y) {
  if (n.id) return n.id === x ? leaf(y) : n.id === y ? leaf(x) : n;
  return { ...n, a: swapLeaves(n.a, x, y), b: swapLeaves(n.b, x, y) };
}

export function setRatioAt(st, path, ratio) {
  const go = (n, i) => {
    if (i === path.length) return { ...n, ratio };
    return path[i] === 'a' ? { ...n, a: go(n.a, i + 1) } : { ...n, b: go(n.b, i + 1) };
  };
  return st.tree ? { ...st, tree: go(st.tree, 0) } : st;
}

export function findPath(n, id, path = '') {
  if (!n) return null;
  if (n.id) return n.id === id ? path : null;
  const a = findPath(n.a, id, path + 'a');
  return a !== null ? a : findPath(n.b, id, path + 'b');
}

// Narrow a panel from one of its outer edges: its slot becomes [panel | empty slot]. Returns the new
// state and the path of the new split.
export function shrinkFromEdge(st, id, side) {
  const path = findPath(st.tree, id);
  if (path === null) return null;
  const dir = side === 'n' || side === 's' ? 'col' : 'row';
  const first = side === 'n' || side === 'w';
  const node = first ? split(dir, 0.97, newEmpty(), leaf(id)) : split(dir, 0.97, leaf(id), newEmpty());
  // for 'first' sides the empty slot is `a`, so a ratio near 0 is "all panel"
  if (first) node.ratio = 0.03;
  const go = (n, i) => {
    if (i === path.length) return node;
    return path[i] === 'a' ? { ...n, a: go(n.a, i + 1) } : { ...n, b: go(n.b, i + 1) };
  };
  return { st: { ...st, tree: go(st.tree, 0) }, path, dir };
}

// Remove empty slots that were dragged (almost) shut.
export function pruneEmpty(st) {
  const go = (n) => {
    if (n.id) return n;
    const a = go(n.a), b = go(n.b);
    if (a.id && isEmptyId(a.id) && n.ratio < 0.04) return b;
    if (b.id && isEmptyId(b.id) && n.ratio > 0.96) return a;
    return { ...n, a, b };
  };
  return st.tree ? { ...st, tree: go(st.tree) } : st;
}

export function findParent(n, id, path = '') {
  if (!n || n.id) return null;
  if (n.a.id === id) return { path, node: n, isA: true };
  if (n.b.id === id) return { path, node: n, isA: false };
  return findParent(n.a, id, path + 'a') || findParent(n.b, id, path + 'b');
}

// Rects are fractions of the whole dock area; `size` is its size in px (a minimised panel is a
// fixed-size strip, so the strip's share depends on it). Returns { panels, gutters }.
export function computeRects(node, size = { w: 1400, h: 900 }, mini = {}, rect = { x: 0, y: 0, w: 1, h: 1 }, path = '', out = { panels: {}, gutters: [] }) {
  if (!node) return out;
  if (node.id) { out.panels[node.id] = rect; return out; }
  const { dir } = node;
  const aMin = allMinimized(node.a, mini), bMin = allMinimized(node.b, mini);
  let ratio = node.ratio;
  let fixed = false;
  if (aMin || bMin) {
    const dim = dir === 'row' ? rect.w * size.w : rect.h * size.h;
    const strip = Math.min(0.5, STRIP_PX / Math.max(1, dim));
    if (aMin && bMin) ratio = strip;
    else ratio = aMin ? strip : 1 - strip;
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
  if (!fixed) out.gutters.push({ path, dir, rect, ratio });
  computeRects(node.a, size, mini, ra, path + 'a', out);
  computeRects(node.b, size, mini, rb, path + 'b', out);
  return out;
}

// Where would dropping the dragged panel at pointer (fx, fy: fractions of the dock area) put it?
// Returns { apply(state) -> state, rect } or null. Edge of another panel: split it; its middle:
// swap; the outer border of the dock: a new full-width/height panel on that side.
export function dropTarget(dragId, st, panels, fx, fy) {
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  const others = Object.keys(panels).filter(id => id !== dragId);
  const hasPanel = others.some(id => !isEmptyId(id));
  if (!hasPanel && !others.length) return null;
  const root = (side, rect) => ({
    rect,
    apply: (s) => {
      const t = removeLeaf(s.tree, dragId);
      const dir = side === 'n' || side === 's' ? 'col' : 'row';
      const tree = !t ? leaf(dragId)
        : side === 'n' || side === 'w' ? split(dir, 0.2, leaf(dragId), t) : split(dir, 0.8, t, leaf(dragId));
      return { ...s, tree };
    },
  });
  const B = 0.03;
  if (fx < B) return root('w', { x: 0, y: 0, w: 0.2, h: 1 });
  if (fx > 1 - B) return root('e', { x: 0.8, y: 0, w: 0.2, h: 1 });
  if (fy < B) return root('n', { x: 0, y: 0, w: 1, h: 0.2 });
  if (fy > 1 - B) return root('s', { x: 0, y: 0.8, w: 1, h: 0.2 });
  const target = others.find((id) => {
    const r = panels[id];
    return fx >= r.x && fx <= r.x + r.w && fy >= r.y && fy <= r.y + r.h;
  });
  if (!target) return null;
  const r = panels[target];
  if (isEmptyId(target)) return { rect: r, apply: (s) => ({ ...s, tree: replaceLeaf(removeLeaf(s.tree, dragId), target, dragId) }) };
  const u = (fx - r.x) / r.w, v = (fy - r.y) / r.h;
  const dists = { w: u, e: 1 - u, n: v, s: 1 - v };
  const side = Object.keys(dists).reduce((a, b) => (dists[a] <= dists[b] ? a : b));
  if (dists[side] > 0.3) {
    return { rect: r, swap: true, apply: (s) => ({ ...s, tree: swapLeaves(s.tree, dragId, target) }) };
  }
  const rect = side === 'w' ? { ...r, w: r.w / 2 } : side === 'e' ? { ...r, x: r.x + r.w / 2, w: r.w / 2 }
    : side === 'n' ? { ...r, h: r.h / 2 } : { ...r, y: r.y + r.h / 2, h: r.h / 2 };
  return { rect, apply: (s) => ({ ...s, tree: insertBeside(removeLeaf(s.tree, dragId), target, dragId, side) }) };
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
  return {
    ...st, tree: removeLeaf(st.tree, id), floating: { ...st.floating, [id]: rect }, minimized,
    order: [...st.order.filter(x => x !== id), id],
  };
}

// Dock back: split the biggest docked panel along its longer side (you can drag it from there).
export function dockBack(st, id, panels = {}, size = { w: 1400, h: 900 }) {
  const floating = { ...st.floating };
  delete floating[id];
  const minimized = { ...st.minimized };
  delete minimized[id];
  let tree;
  const all = collectIds(st.tree);
  const ids = all.filter(i => !isEmptyId(i));
  const emptySlot = all.find(isEmptyId);
  if (emptySlot) tree = replaceLeaf(st.tree, emptySlot, id);
  else if (!st.tree || !ids.length) tree = leaf(id);
  else {
    const area = (pid) => { const r = panels[pid]; return r ? r.w * size.w * r.h * size.h : 0; };
    const big = ids.filter(p => !st.minimized[p]).sort((a, b) => area(b) - area(a))[0] || ids[0];
    const r = panels[big];
    const wide = r ? r.w * size.w >= r.h * size.h : true;
    tree = insertBeside(st.tree, big, id, wide ? 'e' : 's');
  }
  return { ...st, tree, floating, minimized, order: st.order.filter(x => x !== id) };
}

export function raiseFloating(st, id) {
  if (!st.floating[id] || st.order[st.order.length - 1] === id) return st;
  return { ...st, order: [...st.order.filter(x => x !== id), id] };
}

export function setFloatRect(st, id, rect) {
  return { ...st, floating: { ...st.floating, [id]: rect } };
}

// Close a panel (it leaves the layout, floating or docked); openPanel brings it back.
export function closePanel(st, id) {
  if (!CLOSABLE.includes(id)) return st;
  const floating = { ...st.floating };
  delete floating[id];
  const minimized = { ...st.minimized };
  delete minimized[id];
  return {
    ...st, tree: removeLeaf(st.tree, id), floating, minimized, closed: { ...st.closed, [id]: true },
    order: st.order.filter(x => x !== id),
  };
}

export function openPanel(st, id, panels, size) {
  const closed = { ...st.closed };
  delete closed[id];
  return dockBack({ ...st, closed }, id, panels, size);
}

// ---- sharing layouts ----
// The saved layout as an object (or null), a checked copy of an imported one, and a way to store it.
export function readSavedState() {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function validateState(obj) {
  try { return obj && typeof obj === 'object' ? finish(obj, cleanTree(obj.tree)) : null; } catch { return null; }
}
export function writeSavedState(st) { saveState(st); }
