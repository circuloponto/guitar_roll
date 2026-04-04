// Default hotkey configuration
// Each entry: { id, label, description, key, modifiers? }
// modifiers: { ctrl, shift, alt } — optional

const DEFAULT_HOTKEYS = {
  noteJump: { label: 'Note Jump', description: 'Toggle note-jump navigation', key: 'n' },
  freeMode: { label: 'Free Mode', description: 'Toggle free (unsnapped) mode', key: 'f' },
  durationMode: { label: 'Duration Mode', description: 'Toggle note duration editing on fretboard', key: 'l' },
  moveMode: { label: 'Move Mode', description: 'Toggle note beat-position editing on fretboard', key: 'm' },
  adjacentMode: { label: 'Adjacent Mode', description: 'Toggle multi-note placement on same string', key: 'a' },
  deleteNotes: { label: 'Delete Notes', description: 'Delete selected notes', key: 'Delete' },
  deleteNotesAlt: { label: 'Delete Notes (Alt)', description: 'Delete selected notes', key: 'Backspace' },
  undo: { label: 'Undo', description: 'Undo last action', key: 'z', modifiers: { ctrl: true } },
  redo: { label: 'Redo', description: 'Redo last undone action', key: 'y', modifiers: { ctrl: true } },
  redoAlt: { label: 'Redo (Alt)', description: 'Redo last undone action', key: 'z', modifiers: { ctrl: true, shift: true } },
  copy: { label: 'Copy', description: 'Copy selected notes', key: 'c', modifiers: { ctrl: true } },
  paste: { label: 'Paste', description: 'Paste notes at playhead', key: 'v', modifiers: { ctrl: true } },
  playStop: { label: 'Play / Stop', description: 'Toggle playback from playhead', key: ' ' },
  prevBeat: { label: 'Previous Beat', description: 'Move playhead left', key: 'ArrowLeft' },
  nextBeat: { label: 'Next Beat', description: 'Move playhead right', key: 'ArrowRight' },
  fingeringMode: { label: 'Fingering Mode', description: 'Toggle fingering mode (arrow keys shift strings)', key: 'g' },
  fingerUp: { label: 'Finger Up', description: 'Move selected notes to higher string (same pitch)', key: 'ArrowUp' },
  fingerDown: { label: 'Finger Down', description: 'Move selected notes to lower string (same pitch)', key: 'ArrowDown' },
  escape: { label: 'Escape', description: 'Cancel current mode', key: 'Escape' },
};

const STORAGE_KEY = 'guitar-roll-hotkeys';

export function getDefaultHotkeys() {
  return JSON.parse(JSON.stringify(DEFAULT_HOTKEYS));
}

export function loadHotkeys() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // Merge with defaults in case new hotkeys were added
      const defaults = getDefaultHotkeys();
      return { ...defaults, ...parsed };
    }
  } catch {}
  return getDefaultHotkeys();
}

export function saveHotkeys(hotkeys) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(hotkeys));
}

// Check if a key event matches a hotkey config
export function matchesHotkey(e, hotkey) {
  if (!hotkey) return false;
  const keyMatch = e.key.toLowerCase() === hotkey.key.toLowerCase() || e.key === hotkey.key;
  const ctrl = hotkey.modifiers?.ctrl || false;
  const shift = hotkey.modifiers?.shift || false;
  const alt = hotkey.modifiers?.alt || false;

  return keyMatch &&
    (ctrl ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey)) &&
    (shift ? e.shiftKey : !e.shiftKey) &&
    (alt ? e.altKey : !e.altKey);
}

// Find conflicts: returns array of { id1, id2 } pairs that share the same key+modifiers
export function findConflicts(hotkeys) {
  const entries = Object.entries(hotkeys);
  const conflicts = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [id1, h1] = entries[i];
      const [id2, h2] = entries[j];
      if (h1.key.toLowerCase() === h2.key.toLowerCase() &&
          !!(h1.modifiers?.ctrl) === !!(h2.modifiers?.ctrl) &&
          !!(h1.modifiers?.shift) === !!(h2.modifiers?.shift) &&
          !!(h1.modifiers?.alt) === !!(h2.modifiers?.alt)) {
        conflicts.push({ id1, id2, label1: h1.label, label2: h2.label });
      }
    }
  }
  return conflicts;
}

// Format a hotkey for display
export function formatHotkey(hotkey) {
  const parts = [];
  if (hotkey.modifiers?.ctrl) parts.push('Ctrl');
  if (hotkey.modifiers?.shift) parts.push('Shift');
  if (hotkey.modifiers?.alt) parts.push('Alt');

  let keyName = hotkey.key;
  if (keyName === ' ') keyName = 'Space';
  else if (keyName === 'ArrowLeft') keyName = 'Left';
  else if (keyName === 'ArrowRight') keyName = 'Right';
  else if (keyName === 'Escape') keyName = 'Esc';
  else if (keyName.length === 1) keyName = keyName.toUpperCase();

  parts.push(keyName);
  return parts.join(' + ');
}

// Editable hotkey IDs (ones users can change)
export const EDITABLE_HOTKEYS = [
  'noteJump', 'freeMode', 'durationMode', 'moveMode', 'adjacentMode',
  'deleteNotes', 'playStop', 'prevBeat', 'nextBeat', 'fingeringMode', 'fingerUp', 'fingerDown', 'escape',
];
