// Toolbar customisation (like FL Studio's): choose which controls show, in what order, and how big.
const KEY = 'guitar-roll-toolbar';

// Every control that can sit in the toolbar, in the default order. `off: true` = hidden by default.
export const TOOLBAR_ITEMS = [
  { id: 'name', label: 'Project name' },
  { id: 'play', label: 'Play / Stop' },
  { id: 'loop', label: 'Loop' },
  { id: 'octaveFit', label: 'Octave fit' },
  { id: 'metronome', label: 'Metronome' },
  { id: 'undo', label: 'Undo', off: true },
  { id: 'redo', label: 'Redo', off: true },
  { id: 'instrument', label: 'Instrument' },
  { id: 'new', label: 'New session' },
  { id: 'importMidi', label: 'Import MIDI' },
  { id: 'settings', label: 'Settings' },
  { id: 'panels', label: 'Panel buttons' },
  { id: 'sep1', label: 'Separator' },
  { id: 'timeSig', label: 'Time signature' },
  { id: 'bpm', label: 'BPM' },
  { id: 'swing', label: 'Swing' },
  { id: 'clear', label: 'Clear notes' },
  { id: 'sep2', label: 'Separator' },
  { id: 'rhythm', label: 'Beat / division' },
];

export const TOOLBAR_SIZES = { compact: 'Compact', normal: 'Normal', large: 'Large' };
const IDS = TOOLBAR_ITEMS.map(i => i.id);

export function defaultToolbar() {
  const hidden = {};
  TOOLBAR_ITEMS.forEach(i => { if (i.off) hidden[i.id] = true; });
  return { order: [...IDS], hidden, size: 'normal' };
}

// Saved config merged with the current item list (items added later show up at the end).
export function loadToolbar() {
  const d = defaultToolbar();
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (!s) return d;
    const order = (Array.isArray(s.order) ? s.order : []).filter(id => IDS.includes(id));
    IDS.forEach(id => { if (!order.includes(id)) order.push(id); });
    const hidden = {};
    IDS.forEach(id => { hidden[id] = id in (s.hidden || {}) ? !!s.hidden[id] : !!d.hidden[id]; });
    return { order, hidden, size: TOOLBAR_SIZES[s.size] ? s.size : 'normal' };
  } catch { return d; }
}

export function saveToolbar(cfg) {
  try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}
