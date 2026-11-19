import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import { NUM_BARS, SUBDIVISIONS, BPM } from './constants';
import { loadCustomPresets } from './audio';

const STORAGE_KEY = 'guitar-roll-sessions';
const SCHEMES_KEY = 'guitar-roll-color-schemes';
const CHORDS_KEY = 'guitar-roll-chord-library';
const AUTOSAVE_KEY = 'guitar-roll-autosave';
const SESSION_SCHEME_STATE_KEY = 'guitar-roll-session-scheme-state';

// --- Chord library ---
export function loadChordLibrary() {
  try { return JSON.parse(localStorage.getItem(CHORDS_KEY)) || []; }
  catch { return []; }
}

export function saveChordLibrary(chords) {
  localStorage.setItem(CHORDS_KEY, JSON.stringify(chords));
}

// --- Autosave ---
export function loadAutosave() {
  try { return JSON.parse(localStorage.getItem(AUTOSAVE_KEY)); }
  catch { return null; }
}

export function saveAutosave(state) {
  localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(state));
}

// --- Current session scheme state ---
export function loadSessionSchemeState() {
  try { return JSON.parse(localStorage.getItem(SESSION_SCHEME_STATE_KEY)) || {}; }
  catch { return {}; }
}

export function saveSessionSchemeState(sessionScheme, sessionSchemes) {
  localStorage.setItem(SESSION_SCHEME_STATE_KEY, JSON.stringify({
    sessionScheme: sessionScheme || null,
    sessionSchemes: sessionSchemes || {},
  }));
}

// --- Session state shape ---
function defaultSession() {
  return {
    notes: [],
    bpm: BPM,
    swing: 50,
    loop: false,
    loopStart: 0,
    loopEnd: NUM_BARS * SUBDIVISIONS,
    stringColors: ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
    synesthesia: [],
    subdivisions: 4,
    rhythmUnit: 'beat',
    rhythmMult: 1,
    metronome: false,
    barSubdivisions: Array(NUM_BARS).fill(SUBDIVISIONS),
  };
}

export function getSessionState(appState) {
  return {
    projectName: appState.projectName,
    tracks: appState.tracks,
    bpm: appState.bpm,
    swing: appState.swing,
    loop: appState.loop,
    loopStart: appState.loopStart,
    loopEnd: appState.loopEnd,
    stringColors: appState.stringColors,
    synesthesia: appState.synesthesia,
    subdivisions: appState.subdivisions,
    rhythmUnit: appState.rhythmUnit,
    rhythmMult: appState.rhythmMult,
    markers: appState.markers,
    metronome: appState.metronome,
    barSubdivisions: appState.barSubdivisions,
    globalScheme: appState.sessionScheme || null,
    sessionSchemes: getSessionSchemes(appState),
    synthPresets: loadCustomPresets(),
    chordLibrary: loadChordLibrary(),
  };
}

// --- LocalStorage sessions ---
export function listSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function saveSession(name, state) {
  const sessions = listSessions();
  sessions[name] = { ...state, savedAt: Date.now() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

export function loadSession(name) {
  const sessions = listSessions();
  return sessions[name] || null;
}

export function deleteSession(name) {
  const sessions = listSessions();
  delete sessions[name];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

// --- Color schemes ---
export function listColorSchemes() {
  try {
    const raw = localStorage.getItem(SCHEMES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

// Build the session-local scheme map for export/import.
// This includes every scheme referenced by the current session, but importing
// these schemes will load them into session memory instead of saving them to
// the user's permanent color scheme library.
export function getSessionSchemes(appState) {
  const allSchemes = listColorSchemes();
  const sessionSchemes = {};

  const addScheme = (name, fallbackColors) => {
    if (!name || sessionSchemes[name]) return;

    if (appState.sessionSchemes?.[name]) {
      sessionSchemes[name] = appState.sessionSchemes[name];
    } else if (Object.prototype.hasOwnProperty.call(allSchemes, name)) {
      sessionSchemes[name] = allSchemes[name];
    } else if (fallbackColors) {
      sessionSchemes[name] = fallbackColors;
    }
  };

  if (appState.sessionScheme?.name) {
    addScheme(
      appState.sessionScheme.name,
      appState.sessionScheme.colors
    );
  }

  (appState.tracks || []).forEach(track => {
    addScheme(track.schemeName);
  });

  return sessionSchemes;
}

export function saveColorScheme(name, scheme) {
  const schemes = listColorSchemes();
  schemes[name] = scheme;
  localStorage.setItem(SCHEMES_KEY, JSON.stringify(schemes));
}

export function deleteColorScheme(name) {
  const schemes = listColorSchemes();
  delete schemes[name];
  localStorage.setItem(SCHEMES_KEY, JSON.stringify(schemes));
}

// --- File export/import ---
export async function exportToFile(state, suggestedFilename = 'guitar-roll-session.json') {
  // Try using File System Access API for save dialog
  if ('showSaveFilePicker' in window) {
    try {
      const fileHandle = await window.showSaveFilePicker({
        suggestedName: suggestedFilename,
        types: [{
          description: 'JSON Files',
          accept: { 'application/json': ['.json'] }
        }]
      });
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(state, null, 2));
      await writable.close();
      return;
    } catch (err) {
      // User cancelled the dialog
      if (err.name === 'AbortError') return;
    }
  }
  
  // Fallback to traditional download for browsers without File System Access API
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedFilename;
  a.click();
  URL.revokeObjectURL(url);
}
// Note: This function becomes async, so also needs the call in SettingsModal.jsx to be async

export function importFromFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) { reject('No file'); return; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          resolve(JSON.parse(ev.target.result));
        } catch { reject('Invalid JSON'); }
      };
      reader.readAsText(file);
    };
    input.click();
  });
}

// --- URL compression ---
export function stateToUrl(state) {
  const urlState = { ...state };
  delete urlState.colorSchemes;

  if (urlState.activeColorScheme) {
    urlState.globalScheme = urlState.activeColorScheme;
    delete urlState.activeColorScheme;
  }

  if (urlState.sessionScheme && !urlState.globalScheme) {
    urlState.globalScheme = urlState.sessionScheme;
  }
  delete urlState.sessionScheme;

  const json = JSON.stringify(urlState);
  const compressed = compressToEncodedURIComponent(json);
  return window.location.origin + window.location.pathname + '#s=' + compressed;
}

export function stateFromUrl() {
  const hash = window.location.hash;
  if (!hash.startsWith('#s=')) return null;
  try {
    const compressed = hash.slice(3);
    const json = decompressFromEncodedURIComponent(compressed);
    return JSON.parse(json);
  } catch { return null; }
}

export { defaultSession };
