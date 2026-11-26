// Saved window layouts: named presets that stay listed in the app, and one layout that becomes the
// default (used by "Reset layout" and for a fresh browser). A layout bundle holds the window arrangement
// (docked / floating / minimised / closed windows and their sizes), the toolbar setup and the
// Arrangement track height. Bundles are the same format as the exported layout files.
import { readSavedState, validateState, writeSavedState, loadState } from './dockLayout';
import { loadToolbar } from './toolbarConfig';

const PRESETS_KEY = 'guitar-roll-layout-presets';
const DEFAULT_KEY = 'guitar-roll-layout-default';
const ROW_KEY = 'guitar-roll-arrangement-row-height';

const read = (key, fallback) => { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; } };
const write = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } };
const changed = () => window.dispatchEvent(new Event('guitar-roll-presets-changed'));

export function currentLayoutBundle() {
  const dock = readSavedState() || loadState(window.innerWidth - 40, window.innerHeight - 100);
  let row = null;
  try { row = Number(localStorage.getItem(ROW_KEY)) || null; } catch { /* ignore */ }
  return { format: 'guitar-roll-layout', version: 1, dock, toolbar: loadToolbar(), arrangementRowHeight: row };
}

// returns { ok, text } and applies the layout when it is valid
export function checkBundle(obj) {
  if (!obj || obj.format !== 'guitar-roll-layout') return { ok: false, text: 'That is not a Guitar Roll layout.' };
  const dock = validateState(obj.dock);
  if (!dock) return { ok: false, text: 'The window layout in that file is not valid.' };
  return { ok: true, dock };
}
export function applyLayoutBundle(obj) {
  const c = checkBundle(obj);
  if (!c.ok) return c;
  writeSavedState(c.dock);
  window.dispatchEvent(new Event('guitar-roll-reload-layout'));
  if (obj.toolbar && Array.isArray(obj.toolbar.order)) window.dispatchEvent(new CustomEvent('guitar-roll-apply-toolbar', { detail: obj.toolbar }));
  if (obj.arrangementRowHeight) { try { localStorage.setItem(ROW_KEY, String(obj.arrangementRowHeight)); } catch { /* ignore */ } }
  return { ok: true, text: 'Layout applied.' };
}

export const listLayoutPresets = () => read(PRESETS_KEY, []).filter(p => p && p.id && p.bundle);
export function saveLayoutPreset(name, bundle = currentLayoutBundle()) {
  const list = listLayoutPresets();
  const clean = String(name || '').trim() || `Layout ${list.length + 1}`;
  const existing = list.find(p => p.name.toLowerCase() === clean.toLowerCase());
  const entry = { id: existing?.id || `lp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: clean, bundle };
  write(PRESETS_KEY, existing ? list.map(p => (p.id === entry.id ? entry : p)) : [...list, entry]);
  changed();
  return entry;
}
export function deleteLayoutPreset(id) { write(PRESETS_KEY, listLayoutPresets().filter(p => p.id !== id)); changed(); }

export const getDefaultLayout = () => { const b = read(DEFAULT_KEY, null); return b && b.format === 'guitar-roll-layout' ? b : null; };
export function setDefaultLayout(bundle = currentLayoutBundle()) { write(DEFAULT_KEY, bundle); changed(); }
export function clearDefaultLayout() { try { localStorage.removeItem(DEFAULT_KEY); } catch { /* ignore */ } changed(); }
