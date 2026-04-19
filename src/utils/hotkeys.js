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
  returnToStart: { label: 'Return to Start', description: 'Move playhead to beginning', key: 'Enter' },
  prevBeat: { label: 'Previous Beat', description: 'Move playhead left', key: 'ArrowLeft' },
  nextBeat: { label: 'Next Beat', description: 'Move playhead right', key: 'ArrowRight' },
  zoomIn: { label: 'Zoom In', description: 'Zoom into timeline', key: '=', modifiers: { ctrl: true } },
  zoomOut: { label: 'Zoom Out', description: 'Zoom out of timeline', key: '-', modifiers: { ctrl: true } },
  verticalZoomIn: { label: 'Vertical Zoom In', description: 'Increase timeline row height', key: '=', modifiers: { ctrl: true, shift: true } },
  verticalZoomOut: { label: 'Vertical Zoom Out', description: 'Decrease timeline row height', key: '-', modifiers: { ctrl: true, shift: true } },
  toggleGhost: { label: 'Ghost Notes', description: 'Toggle ghost (muted) on selected notes', key: 'x' },
  bendUp: { label: 'Bend Up', description: 'Increase bend on selected notes', key: 'ArrowUp', modifiers: { shift: true } },
  bendDown: { label: 'Bend Down', description: 'Decrease bend on selected notes', key: 'ArrowDown', modifiers: { shift: true } },
  toggleSlide: { label: 'Toggle Slide', description: 'Toggle slide to next note on selected', key: 's', modifiers: { shift: true } },
  prevMarker: { label: 'Previous Marker', description: 'Jump to previous marker', key: 'PageUp' },
  nextMarker: { label: 'Next Marker', description: 'Jump to next marker', key: 'PageDown' },
  voiceLeading: { label: 'Voice Leading', description: 'Open voice leading assistant for selected chords', key: 'v' },
  machineGunMode: { label: 'Machine Gun', description: 'Toggle draw mode: drag to paint notes', key: 'd' },
  fingeringMode: { label: 'Fingering Mode', description: 'Toggle fingering mode (arrow keys shift strings)', key: 'g' },
  fingerUp: { label: 'Finger Up', description: 'Move selected notes to higher string (same pitch)', key: 'ArrowUp' },
  fingerDown: { label: 'Finger Down', description: 'Move selected notes to lower string (same pitch)', key: 'ArrowDown' },
  zoomWheel: { label: 'Zoom (Scroll)', description: 'Scroll to zoom timeline', key: 'Wheel', modifiers: { ctrl: true }, wheel: true },
  verticalZoomWheel: { label: 'Vertical Zoom (Scroll)', description: 'Scroll to zoom timeline vertically', key: 'Wheel', modifiers: { ctrl: true, shift: true }, wheel: true },
  velocityWheel: { label: 'Velocity (Scroll)', description: 'Scroll to adjust note velocity', key: 'Wheel', modifiers: { shift: true }, wheel: true },
  cheatSheet: { label: 'Cheat Sheet', description: 'Show/hide keyboard shortcuts', key: '?' },
  escape: { label: 'Escape', description: 'Cancel current mode', key: 'Escape' },
  transposeSemiUp: { label: 'Transpose Up (Semitone)', description: 'Move selected notes up one semitone', key: 'u' },
  transposeSemiDown: { label: 'Transpose Down (Semitone)', description: 'Move selected notes down one semitone', key: 'd' },
  transposeOctaveUp: { label: 'Transpose Up (Octave)', description: 'Move selected notes up one octave', key: 'u', modifiers: { shift: true } },
  transposeOctaveDown: { label: 'Transpose Down (Octave)', description: 'Move selected notes down one octave', key: 'd', modifiers: { shift: true } },
  selectAtPlayhead: { label: 'Select Notes at Playhead', description: 'Select all notes at the current playhead position', key: 'Tab' },
  cursorMode: { label: 'Cursor Mode (Hold)', description: 'Hold to move the timeline cursor without placing a note', key: 'k' },
  jumpPrevNote: { label: 'Jump to Previous Note', description: 'Move playhead to the previous note position', key: 'ArrowLeft', modifiers: { ctrl: true } },
  jumpNextNote: { label: 'Jump to Next Note', description: 'Move playhead to the next note position', key: 'ArrowRight', modifiers: { ctrl: true } },
};

// Non-editable actions shown for reference in the hotkey manager.
export const REFERENCE_ACTIONS = [
  { label: 'Set Tuplet', description: 'Set subdivision count for the current bar', display: '1–9' },
  { label: 'Brush Erase', description: 'Right-click + drag across notes to delete them', display: 'Right Click + Drag' },
  { label: 'Marquee Erase', description: 'Marquee-select and delete notes', display: 'Shift + Right Click + Drag' },
  { label: 'Duplicate Notes', description: 'Alt-drag selected notes to duplicate instead of move', display: 'Alt + Drag' },
  { label: 'Shift-Drag Selection', description: 'Add to / remove from selection while dragging a marquee', display: 'Shift + Drag' },
];

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

// Check if a wheel event matches a wheel hotkey config
export function matchesWheelHotkey(e, hotkey) {
  if (!hotkey || !hotkey.wheel) return false;
  const ctrl = hotkey.modifiers?.ctrl || false;
  const shift = hotkey.modifiers?.shift || false;
  const alt = hotkey.modifiers?.alt || false;
  return (ctrl ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey)) &&
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
  'deleteNotes', 'toggleGhost', 'bendUp', 'bendDown', 'toggleSlide', 'voiceLeading',
  'prevMarker', 'nextMarker', 'playStop', 'returnToStart', 'prevBeat', 'nextBeat',
  'jumpPrevNote', 'jumpNextNote',
  'zoomIn', 'zoomOut', 'zoomWheel', 'verticalZoomIn', 'verticalZoomOut', 'verticalZoomWheel', 'velocityWheel',
  'machineGunMode', 'fingeringMode', 'fingerUp', 'fingerDown',
  'transposeSemiUp', 'transposeSemiDown', 'transposeOctaveUp', 'transposeOctaveDown', 'selectAtPlayhead',
  'cursorMode', 'cheatSheet', 'escape',
];
