import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import { NUM_BARS, SUBDIVISIONS, BPM } from './constants';

const STORAGE_KEY = 'guitar-roll-sessions';
const SCHEMES_KEY = 'guitar-roll-color-schemes';

// --- Session state shape ---
function defaultSession() {
  return {
    notes: [],
    bpm: BPM,
    loop: false,
    loopStart: 0,
    loopEnd: NUM_BARS * SUBDIVISIONS,
    stringColors: ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
    synesthesia: [],
    noteDuration: 1,
    metronome: false,
    barSubdivisions: Array(NUM_BARS).fill(SUBDIVISIONS),
  };
}

export function getSessionState(appState) {
  return {
    notes: appState.notes,
    bpm: appState.bpm,
    loop: appState.loop,
    loopStart: appState.loopStart,
    loopEnd: appState.loopEnd,
    stringColors: appState.stringColors,
    synesthesia: appState.synesthesia,
    noteDuration: appState.noteDuration,
    metronome: appState.metronome,
    barSubdivisions: appState.barSubdivisions,
    activeColorScheme: appState.activeColorScheme || null,
    colorSchemes: listColorSchemes(),
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
export function exportToFile(state, filename = 'guitar-roll-session.json') {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

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
  const { colorSchemes, ...urlState } = state;
  // Only include the active color scheme, not all saved schemes
  if (urlState.activeColorScheme) {
    urlState.colorSchemes = { [urlState.activeColorScheme.name]: urlState.activeColorScheme.colors };
  }
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
