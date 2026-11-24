import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import Fretboard from './components/Fretboard';
import Timeline from './components/Timeline';
import { playNote, playNoteAtTime, playClickAtTime, getAudioContext, getMasterOut, getNoteName, INSTRUMENTS, getAllInstruments, setInstrument, getInstrument, saveCustomPreset, loadUltrabox } from './utils/audio';
import { isUltrabox, ultraboxReady, prewarmNotes } from './utils/ultrabox';
import { groupTracks as groupTracksFn, ungroupTracks as ungroupTracksFn, normalizeGroups, tidyTrackGroups } from './utils/trackGroups';
import { NUM_BARS, SUBDIVISIONS, BPM as DEFAULT_BPM, CELL_WIDTH } from './utils/constants';
import { NOTE_FADE_PRESETS } from './utils/noteFade';
import { xToBeat, defaultBarSubdivisions, totalColumns, beatToBar, beatToTime, colDurationAtBeat, remapNotes, barStartBeats, applySwingBeat, amountToRatio, ratioToAmount } from './utils/barLayout';
import { loadAudioFile, computeWaveformPeaks } from './utils/audioFile';
import { ensureReady as ensureStretchReady, createStretchNode, setStretchTempo, scheduleStretchTempo, resetStretch } from './utils/rubberbandStretch';
import { putAudioFile, getAudioFile, deleteAudioFile } from './utils/audioStore';
import { parseMidi, midiToGuitarNotes } from './utils/midiImport';
import { stateFromUrl, writeStateToUrl, saveChordLibrary, getSessionState, saveAutosave, loadAutosave, listColorSchemes, loadSessionSchemeState, saveSessionSchemeState } from './utils/storage';
import { loadHotkeys, matchesHotkey, formatHotkey, REFERENCE_ACTIONS } from './utils/hotkeys';
import { refingerNotes, refingerNotesOctave, countInPosition, bestPosition } from './utils/position';
import { detectBeats, fitTempo } from './utils/beatDetect';
import { makeTempoMap } from './utils/tempoMap';
import { getClips, getSyncPoints, makeWarp, clipEndBeat, clipBeatToTime, clipLenBeats, secPerBeat, splitClips, pasteClips, newClip, MIN_CLIP_SEC } from './utils/audioClips';
import { getMidiNote, closestComboForPitch, getComboForPosition } from './utils/pitchMap';
import { serializeNotes, parseNotes } from './utils/noteClipboard';
import { NUM_STRINGS, NUM_FRETS } from './utils/constants';
import SettingsModal from './components/SettingsModal';
import TrackStrip from './components/TrackStrip';
import SynthEditor from './components/SynthEditor';
import ChordPalette from './components/ChordPalette';
import Dock from './components/Dock';
import CycleIcon from './components/CycleIcon';
import { Metronome } from 'lucide-react';
import SongTabs from './components/SongTabs';
import { loadAccent, applyAccent, saveAccent } from './utils/accent';
import { makeSongId, makeGroupId, nextTabName, GROUP_COLOURS, moveSong as moveSongList, moveGroup as moveGroupList, assignSongToGroup as assignSongList } from './utils/songs';
import VoiceLeadingModal from './components/VoiceLeadingModal';
import ConfirmDialog from './components/ConfirmDialog';
import NumberInput from './components/NumberInput';
import './App.css';

function createDefaultTrack(name = 'Track 1', instrument = 'clean-electric') {
  return { id: crypto.randomUUID(), name, instrument, type: 'notes', notes: [], volume: 1, muted: false, solo: false, visible: true, bgOpacity: 0.2, schemeName: null, activeInstanceScheme: null, audioFileName: null, audioDuration: 0, audioOffset: 0, waveformPeaks: null };
}

// Pitch scale applied by rubberband on top of the BufferSource's tempo resampling.
// Tempo is done by playbackRate (which also moves pitch by tempoMult); with "keep pitch"
// (default) we cancel that, and optional semitones shift the result.
function audioPitchScale(track, rate) {
  const semis = Math.pow(2, (track.pitchSemitones || 0) / 12);
  return semis * (track.keepPitch === false ? 1 : 1 / rate);
}

function getPlayableTracks(tracks) {
  const anySolo = tracks.some(t => t.solo);
  return tracks.filter(t => {
    if (t.muted) return false;
    if (anySolo && !t.solo) return false;
    return true;
  });
}

function App() {
  // === Track state ===
  const [tracks, setTracksRaw] = useState(() => [createDefaultTrack()]);
  const tracksRef = useRef(tracks);
  const audioBuffersRef = useRef({}); // { [trackId]: AudioBuffer } — original decoded
  // Audio tracks whose file isn't in this browser (e.g. a session opened from JSON): offer to relink.
  const [missingAudioIds, setMissingAudioIds] = useState(() => new Set());
  const markAudioMissing = useCallback((id, missing) => setMissingAudioIds(prev => {
    if (prev.has(id) === missing) return prev;
    const next = new Set(prev);
    if (missing) next.add(id); else next.delete(id);
    return next;
  }), []);
  const audioSourcesRef = useRef([]); // active AudioBufferSourceNodes during playback
  const [trackGroups, setTrackGroupsRaw] = useState([]);   // [{ id, name, colour, collapsed }]
  const trackGroupsRef = useRef(trackGroups);
  const setTrackGroups = useCallback((updater) => {
    setTrackGroupsRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      trackGroupsRef.current = next;
      return next;
    });
  }, []);
  const [selectedTrackIds, setSelectedTrackIds] = useState(() => new Set());
  const [activeTrackId, setActiveTrackId] = useState(() => tracks[0]?.id);
  const activeTrackIdRef = useRef(activeTrackId);
  activeTrackIdRef.current = activeTrackId;

  const setTracksTracked = useCallback((updater) => {
    setTracksRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      tracksRef.current = next;
      return next;
    });
  }, []);

  // Derived: active track's notes
  const activeTrack = tracks.find(t => t.id === activeTrackId) || tracks[0];
  const notes = activeTrack ? activeTrack.notes : [];
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const activeScheme = activeTrack?.activeInstanceScheme ?? null;

  // Helper: update only the active track's notes
  const setActiveNotes = useCallback((updater) => {
    setTracksTracked(prev => prev.map(t => {
      if (t.id !== activeTrackIdRef.current) return t;
      const newNotes = typeof updater === 'function' ? updater(t.notes) : updater;
      return { ...t, notes: newNotes };
    }));
  }, [setTracksTracked]);

  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const autoForwardLastActionRef = useRef(false);

  // Snapshot helpers for undo/redo
  const takeSnapshot = useCallback(() => ({
    tracks: JSON.parse(JSON.stringify(tracksRef.current)),
    trackGroups: JSON.parse(JSON.stringify(trackGroupsRef.current)),
    activeTrackId: activeTrackIdRef.current,
    timeSignature: timeSigRef.current,
    barSubdivisions: barSubsRef.current,
    selectedBeat: selectedBeatRef.current,
    selectedNotes: [...selectedNotesRef.current],    
    autoForward: autoForwardLastActionRef.current,
  }), []);

  const restoreSnapshot = useCallback((snap) => {
    // Legacy: plain array means notes-only snapshot
    if (Array.isArray(snap)) {
      setActiveNotes(() => snap);
      return;
    }
    // Legacy: snapshot with .notes but no .tracks
    if (snap.notes && !snap.tracks) {
      setActiveNotes(() => snap.notes);
      if (snap.timeSignature) setTimeSignature(snap.timeSignature);
      if (snap.barSubdivisions) setBarSubdivisions(snap.barSubdivisions);
      if (snap.selectedBeat !== undefined && snap.autoForward) setSelectedBeat(snap.selectedBeat);
      if (snap.selectedNotes) setSelectedNotes(new Set(snap.selectedNotes));
      return;
    }
    setTracksTracked(() => snap.tracks);
    if (snap.trackGroups) setTrackGroups(snap.trackGroups);
    if (snap.activeTrackId) {
      activeTrackIdRef.current = snap.activeTrackId;
      setActiveTrackId(snap.activeTrackId);
    }
    if (snap.timeSignature) setTimeSignature(snap.timeSignature);
    if (snap.barSubdivisions) setBarSubdivisions(snap.barSubdivisions);
    if (snap.selectedBeat !== undefined && snap.autoForward) setSelectedBeat(snap.selectedBeat);
    if (snap.selectedNotes) setSelectedNotes(new Set(snap.selectedNotes));
  }, [setTracksTracked, setActiveNotes, setTrackGroups]);
  
  // setNotes: pushes undo, for one-shot operations
  const setNotes = useCallback((updater) => {
    undoStackRef.current.push(takeSnapshot());
    if (undoStackRef.current.length > 200) undoStackRef.current.shift();
    redoStackRef.current = [];
    setActiveNotes(updater);
  }, [setActiveNotes, takeSnapshot]);

  // setNotesDrag: no undo push, for continuous drag updates
  const setNotesDrag = useCallback((updater) => {
    setActiveNotes(updater);
  }, [setActiveNotes]);

  // saveSnapshot: push undo once before a drag starts
  const saveSnapshot = useCallback(() => {
    undoStackRef.current.push(takeSnapshot());
    if (undoStackRef.current.length > 200) undoStackRef.current.shift();
    redoStackRef.current = [];
  }, [takeSnapshot]);

  // commitDrag: no-op
  const commitDrag = useCallback(() => {}, []);

  const undo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;
    redoStackRef.current.push(takeSnapshot());
    const prev = undoStackRef.current.pop();
    restoreSnapshot(prev);
  }, [takeSnapshot, restoreSnapshot]);

  const redo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    undoStackRef.current.push(takeSnapshot());
    const next = redoStackRef.current.pop();
    restoreSnapshot(next);
  }, [takeSnapshot, restoreSnapshot]);

  // Switch active track
  const switchTrack = useCallback((trackId) => {
    setActiveTrackId(trackId);
    activeTrackIdRef.current = trackId;
    setSelectedNotes(new Set());
    setSelectedClips(new Set());
    const track = tracksRef.current.find(t => t.id === trackId);
    if (track) {
      setInstrument(track.instrument);
      setInstrumentState(track.instrument);
    }
  }, []);
  const [projectName, setProjectName] = useState('Guitar Roll');
  // Browser tab title: "<session name> - Fretroll"
  useEffect(() => {
    const name = (projectName || '').trim();
    document.title = name ? `${name} - Fretroll` : 'Fretroll';
  }, [projectName]);
  const [playing, setPlaying] = useState(false);
  const [currentBeat, setCurrentBeat] = useState(null);
  // Imperative playhead ref — updated every audio frame, consumed by Timeline
  // without going through React state so smooth motion survives slow renders.
  const playheadBeatRef = useRef(null);
  // Shared ref to the Timeline's scroll body so Fretboard drags can trigger its auto-pan.
  const timelineBodyRef = useRef(null);
  const lastMousePosRef = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const handler = (e) => { lastMousePosRef.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('mousemove', handler);
    return () => window.removeEventListener('mousemove', handler);
  }, []);
  const [selectedBeat, setSelectedBeat] = useState(0);
  const [subdivisions, setSubdivisions] = useState(4); // how many subdivisions per beat
  const [rhythmUnit, setRhythmUnit] = useState('beat'); // 'beat' | 'bar'
  const [rhythmMult, setRhythmMult] = useState(1); // 1-32
  const [xHeld, setXHeld] = useState(false);
  const xHeldRef = useRef(false); // ref for synchronous X key access
  // Position-system-style rhythm entry: buffer accumulates digits on keydown,
  // commits on keyup (all keys released). Second digit allowed only if
  // firstDigit * 10 <= max (e.g. subdiv max 32 → first digit 1-3 can extend;
  // mult max 32 → first digit 1-3 can extend).
  const rhythmBufRef = useRef({ kind: null, str: '' });
  const rhythmKeysDownRef = useRef(new Set());
  const rhythmPendingRef = useRef(null);
  const [rhythmLiveValue, setRhythmLiveValue] = useState(null);
  const [rhythmLiveKind, setRhythmLiveKind] = useState(null);
  const RHYTHM_MAX_DIV = 32;
  const RHYTHM_MAX_MULT = 32;
  const RHYTHM_PENDING_WINDOW = 200;
  // Whether changing the subdivision (÷) resets the multiplier (×) to 1.
  const [resetMultOnSubdiv, setResetMultOnSubdiv] = useState(() => {
    try {
      const saved = localStorage.getItem('guitar-roll-reset-mult-on-subdiv');
      return saved === null ? true : saved === 'true';
    } catch { return true; }
  });
  const resetMultOnSubdivRef = useRef(resetMultOnSubdiv);
  resetMultOnSubdivRef.current = resetMultOnSubdiv;
  useEffect(() => {
    try { localStorage.setItem('guitar-roll-reset-mult-on-subdiv', String(resetMultOnSubdiv)); } catch {}
  }, [resetMultOnSubdiv]);
  // Whether changing ÷ or × updates the duration of selected notes.
  const [rhythmAltersSelected, setRhythmAltersSelected] = useState(() => {
    try {
      const saved = localStorage.getItem('guitar-roll-rhythm-alters-selected');
      return saved === null ? true : saved === 'true';
    } catch { return true; }
  });
  const rhythmAltersSelectedRef = useRef(rhythmAltersSelected);
  rhythmAltersSelectedRef.current = rhythmAltersSelected;
  useEffect(() => {
    try { localStorage.setItem('guitar-roll-rhythm-alters-selected', String(rhythmAltersSelected)); } catch {}
  }, [rhythmAltersSelected]);
  const [selectingSchemeClosesMenu, setSelectingSchemeClosesMenu] = useState(() => {
    try {
      const saved = localStorage.getItem('guitar-roll-selecting-scheme-closes-menu');
      return saved === null ? true : saved === 'true';
    } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('guitar-roll-selecting-scheme-closes-menu', String(selectingSchemeClosesMenu)); } catch {}
  }, [selectingSchemeClosesMenu]);
  const [timeSignature, setTimeSignature] = useState([4, 4]); // [numerator, denominator]
  const unitBeats = rhythmUnit === 'bar' ? (timeSignature[0] || 4) : 1;
  const baseSubdivBeats = unitBeats / subdivisions;
  const effectiveNoteLength = baseSubdivBeats * rhythmMult;
  const snapUnit = baseSubdivBeats; // grid snaps to base subdivision (not multiplied length)
  const [noteDuration, setNoteDuration] = useState(effectiveNoteLength);
  const noteDurationRef = useRef(effectiveNoteLength);
  const snapUnitRef = useRef(snapUnit);
  
  // Keep refs in sync with derived values
  useEffect(() => { noteDurationRef.current = effectiveNoteLength; }, [effectiveNoteLength]);
  useEffect(() => { snapUnitRef.current = snapUnit; }, [snapUnit]);
  
  // Sync noteDuration state when effectiveNoteLength changes (e.g. rhythmUnit, rhythmMult, timeSignature)
  // Use epsilon to avoid unnecessary updates that could cause render loops
  useEffect(() => {
    setNoteDuration(prev => Math.abs(prev - effectiveNoteLength) > 1e-6 ? effectiveNoteLength : prev);
  }, [effectiveNoteLength]);
  const [selectedNotes, setSelectedNotes] = useState(new Set());
  const selectedNotesRef = useRef(selectedNotes);
  selectedNotesRef.current = selectedNotes;
  // Audio clips (DAW regions) selected on the active audio track
  const [selectedClips, setSelectedClips] = useState(new Set());
  const selectedClipsRef = useRef(selectedClips);
  selectedClipsRef.current = selectedClips;
  const clipClipboardRef = useRef([]);
  const [bpm, setBpm] = useState(DEFAULT_BPM);
  const [swing, setSwing] = useState(50);
  const swingRef = useRef(swing);
  swingRef.current = swing;

  // Live tempo / pitch updates: BufferSource.playbackRate does the time-stretch, rubberband
  // applies the pitch correction (or the user's semitone shift). Re-apply whenever bpm or
  // any track's audio settings change.
  // The recording is the master clock when it has sync points: this map turns beats into time.
  const tempoMap = useMemo(() => makeTempoMap(tracks, bpm, timeSignature[1]), [tracks, bpm, timeSignature]);
  const tempoMapRef = useRef(tempoMap);
  tempoMapRef.current = tempoMap;
  // Playback speed of a track's audio relative to the file: the BPM control, taken against the
  // tempo of the recording that drives the grid (or the track's own import tempo without a map).
  const audioRateOf = (track) => (tempoMapRef.current.active
    ? tempoMapRef.current.mult
    : bpmRef.current / (track.originalBpm || bpmRef.current));
  // The timeline always reaches the end of the audio clips (import, move, tempo changes).
  useEffect(() => {
    let end = 0;
    tracks.forEach(t => {
      if (t.type !== 'audio') return;
      const m = tempoMap.forTrack(t);
      getClips(t).forEach(c => { end = Math.max(end, clipEndBeat(c, m)); });
    });
    if (!(end > 0)) return;
    setBarSubdivisions(prev => {
      let next = prev;
      while (totalColumns(next) < end - 1e-6 && next.length < 999) next = [...next, timeSignature[0] || 4];
      return next;
    });
  }, [tracks, tempoMap, timeSignature]);
  // After an audio import, zoom the timeline out so the whole song is visible.
  const fitZoomPendingRef = useRef(false);
  useEffect(() => {
    if (!fitZoomPendingRef.current) return;
    let end = 0;
    tracks.forEach(t => {
      if (t.type !== 'audio') return;
      const m = tempoMap.forTrack(t);
      getClips(t).forEach(c => { end = Math.max(end, clipEndBeat(c, m)); });
    });
    if (!(end > 0)) return;
    fitZoomPendingRef.current = false;
    const body = timelineBodyRef.current;
    if (!body || !body.clientWidth) return;
    const fit = (body.clientWidth * 0.98) / (end * CELL_WIDTH);
    // Only ever zoom out; a short clip keeps the current zoom.
    setTimelineZoom(z => Math.max(0.02, Math.min(z, fit)));
    requestAnimationFrame(() => { if (timelineBodyRef.current) timelineBodyRef.current.scrollLeft = 0; });
  }, [tracks, tempoMap]);
  // UltraBox instruments: load the engine when a track uses one and render its notes ahead of time.
  const [ultraboxLoaded, setUltraboxLoaded] = useState(ultraboxReady());
  useEffect(() => {
    if (!tracks.some(t => isUltrabox(t.instrument))) return;
    if (!ultraboxLoaded) { loadUltrabox().then(() => setUltraboxLoaded(true)).catch(() => {}); return; }
    const timer = setTimeout(() => {
      const ctx = getAudioContext();
      tracks.forEach(t => {
        if (!isUltrabox(t.instrument) || t.type === 'audio') return;
        const spb = tempoMapRef.current.liveSpb || 0.5;
        prewarmNotes(ctx, t.instrument, t.notes.map(n => ({
          midi: getMidiNote(n.stringIndex, n.fret),
          duration: Math.max(0.05, (n.duration || 1) * spb),
        })));
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [tracks, ultraboxLoaded]);
  const applyChainParamsRef = useRef(() => {});
  useEffect(() => { applyChainParamsRef.current(); }, [bpm, tracks]);

  const [metronome, setMetronome] = useState(false);
  const clipboardRef = useRef([]);
  const [instrument, setInstrumentState] = useState(getInstrument());
  const [freeMode, setFreeMode] = useState(false);
  const [machineGunMode, setMachineGunMode] = useState(false);
  const [defaultVelocity, setDefaultVelocity] = useState(0.8);
  const [hoverPreview, setHoverPreview] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('guitar-roll-hover-preview'));
      return { fretboard: false, pianoRoll: false, timelineNotes: false, volume: 0.3, ...saved };
    } catch { return { fretboard: false, pianoRoll: false, timelineNotes: false, volume: 0.3 }; }
  });
  const [markers, setMarkers] = useState([]); // [{ id, name, beat, color }]
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const [tupletLines, setTupletLines] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('guitar-roll-tuplet-lines'));
      return { visible: false, opacity: 0.35, ...saved };
    } catch { return { visible: false, opacity: 0.35 }; }
  });
  const [autoScroll, setAutoScroll] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('guitar-roll-auto-scroll')) || {};
      // Following the playhead is now on by default; reset an old stored "off" once.
      if (!localStorage.getItem('guitar-roll-auto-scroll-playback-default')) {
        saved.onPlayback = true;
        localStorage.setItem('guitar-roll-auto-scroll', JSON.stringify({ onHover: false, onInput: false, ...saved }));
        localStorage.setItem('guitar-roll-auto-scroll-playback-default', '1');
      }
      return { onHover: false, onInput: false, onPlayback: true, ...saved };
    } catch { return { onHover: false, onInput: false, onPlayback: true }; }
  });
  const [hoverPill, setHoverPill] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('guitar-roll-hover-pill'));
      return { fretboard: true, pianoRoll: false, ...saved };
    } catch { return { fretboard: true, pianoRoll: false }; }
  });
  const [swungDisplay, setSwungDisplay] = useState(() => {
    try {
      const saved = localStorage.getItem('guitar-roll-swung-display');
      return saved === null ? false : saved === 'true';
    } catch { return false; }
  });
  const [fretboardAutoForward, setFretboardAutoForward] = useState(() => {
    try {
      const saved = localStorage.getItem('guitar-roll-fretboard-auto-forward');
      return saved === null ? false : saved === 'true';
    } catch { return false; }
  });
  const [fretboardAutoForwardExcludeAdjacent, setFretboardAutoForwardExcludeAdjacent] = useState(() => {
    try {
      const saved = localStorage.getItem('guitar-roll-fretboard-auto-forward-exclude-adjacent');
      return saved === null ? true : saved === 'true';
    } catch { return true; }
  });
  // Selected notes (from the timeline) also show on the fretboard, wherever the playhead is.
  const [showSelectedOnFretboard, setShowSelectedOnFretboard] = useState(() => {
    try { return localStorage.getItem('guitar-roll-show-selected-fretboard') !== 'false'; } catch { return true; }
  });
  const [showFretNumbers, setShowFretNumbers] = useState(() => {
    try { return localStorage.getItem('guitar-roll-show-fret-numbers') !== 'false'; } catch { return true; }
  });
  const [openDots, setOpenDots] = useState(() => {
    try { return localStorage.getItem('guitar-roll-open-dots') !== 'false'; } catch { return true; }
  });
  const [openScroll, setOpenScroll] = useState(() => {
    try { return localStorage.getItem('guitar-roll-open-scroll') !== 'false'; } catch { return true; }
  });
  // Playback visuals: how long notes take to fade out on the fretboard (off | short | normal | long)
  const [noteFade, setNoteFade] = useState(() => {
    try { const v = localStorage.getItem('guitar-roll-note-fade'); return v in NOTE_FADE_PRESETS ? v : 'normal'; } catch { return 'normal'; }
  });
  const [fingeringMode, setFingeringMode] = useState(false);
  const fingeringModeRef = useRef(false);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [timelineVerticalZoom, setTimelineVerticalZoom] = useState(() => {
    try {
      const saved = parseFloat(localStorage.getItem('guitar-roll-timeline-vertical-zoom'));
      return Number.isFinite(saved) && saved > 0 ? saved : 1;
    } catch { return 1; }
  });
  const [showTimelineVerticalZoomButtons, setShowTimelineVerticalZoomButtons] = useState(() => {
    try {
      const saved = localStorage.getItem('guitar-roll-timeline-vzoom-buttons');
      return saved === null ? true : saved === 'true';
    } catch { return true; }
  });
  const [fretboardZoom, setFretboardZoom] = useState(1);
  const [stringColors, setStringColors] = useState(['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff']);
  const [showSettings, setShowSettings] = useState(false);
  const showSettingsRef = useRef(showSettings);
  showSettingsRef.current = showSettings;
  const [hotkeys, setHotkeys] = useState(loadHotkeys);
  const hotkeysRef = useRef(hotkeys);
  hotkeysRef.current = hotkeys;
  const [hoveredNote, setHoveredNote] = useState(null); // { stringIndex, fret }
  const [chordRoot, setChordRoot] = useState(null); // { stringIndex, fret } — locked by click on piano key
  const [showCheatSheet, setShowCheatSheet] = useState(false);
  const [showSubdivDial, setShowSubdivDial] = useState(false);
  const subdivDialRef = useRef(null);
  const [showInstanceColorMenu, setShowInstanceColorMenu] = useState(false);
  const instanceColorMenuRef = useRef(showInstanceColorMenu);
  instanceColorMenuRef.current = showInstanceColorMenu;
  const [instanceColorMenuPos, setInstanceColorMenuPos] = useState({ left: window.innerWidth / 2, top: window.innerHeight / 2, right: null });
  const [showMultDial, setShowMultDial] = useState(false);
  const multDialRef = useRef(null);
  const [settingsTab, setSettingsTab] = useState(null); // opens Settings on a given tab
  const [chordPreview, setChordPreview] = useState(null);
  const [chordPaletteOpen, setChordPaletteOpen] = useState(false);
  const [showVoiceLeading, setShowVoiceLeading] = useState(false);
  const [voicingPreview, setVoicingPreview] = useState(null); // [{ stringIndex, fret }] for fretboard highlight
  const [confirmClear, setConfirmClear] = useState(false);
  const [instrumentList, setInstrumentList] = useState(getAllInstruments);
  const [verticalScroll, setVerticalScroll] = useState(0);
  const [synesthesia, setSynesthesia] = useState([]); // [{ note: 'C', color: '#ff0000' }, ...]
  const [sessionScheme, setSessionScheme] = useState(() => loadSessionSchemeState().sessionScheme || null);
  const [sessionSchemes, setSessionSchemes] = useState(() => loadSessionSchemeState().sessionSchemes || {});
  const [barSubdivisions, setBarSubdivisions] = useState(defaultBarSubdivisions);
  const barSubsRef = useRef(barSubdivisions);
  barSubsRef.current = barSubdivisions;
  const [loop, setLoop] = useState(false);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(totalColumns(defaultBarSubdivisions()));
  const playingRef = useRef(false);

  useEffect(() => {
    saveSessionSchemeState(sessionScheme, sessionSchemes);
  }, [sessionScheme, sessionSchemes]);

  useEffect(() => {
    if (showInstanceColorMenu) {
      setShowInstanceColorMenu(false);
    }
  }, [selectedNotes.size]);

  const bpmRef = useRef(bpm);
  const metronomeRef = useRef(metronome);
  const loopRef = useRef(false);
  const loopStartRef = useRef(0);
  const loopEndRef = useRef(totalColumns(defaultBarSubdivisions()));
  const selectedBeatRef = useRef(selectedBeat);
  const animFrameRef = useRef(null);

  const [position, setPosition] = useState(() => 0);
  const positionRef = useRef(position);
  positionRef.current = position;
  const [playheadPreview, setPlayheadPreview] = useState(false);
  // Octave fit: choosing a position may move the selected notes by whole octaves to fit it.
  const [octaveFit, setOctaveFit] = useState(() => {
    try { return localStorage.getItem('guitar-roll-octave-fit') === '1'; } catch { return false; }
  });
  const octaveFitRef = useRef(octaveFit);
  octaveFitRef.current = octaveFit;
  const [positionMode, setPositionMode] = useState(false);
  const positionModeRef = useRef(false);
  positionModeRef.current = positionMode;
  const [positionModeValue, setPositionModeValue] = useState(null);
  const positionBufferRef = useRef([]);
  const numberKeysDownRef = useRef(new Set());
  const positionTimeoutRef = useRef(null);

  const timeSigRef = useRef(timeSignature);

  // Keep refs in sync
  bpmRef.current = bpm;
  metronomeRef.current = metronome;
  timeSigRef.current = timeSignature;
  selectedBeatRef.current = selectedBeat;
  loopRef.current = loop;
  loopStartRef.current = loopStart;
  loopEndRef.current = loopEnd;

  /*
  // Auto-select notes at the playhead whenever it moves (not during playback).
  useEffect(() => {
    if (playing) return;
    const beat = selectedBeat;
    const atBeat = new Set();
    const currentNotes = tracksRef.current.find(t => t.id === activeTrackIdRef.current)?.notes || [];
    currentNotes.forEach((n, i) => {
      if (beat >= n.beat && beat < n.beat + (n.duration || 1)) atBeat.add(i);
    });
    setSelectedNotes(atBeat);
  }, [selectedBeat, playing]);
  */

  // Build synesthesia lookup: note letter (without octave) -> color
  const synesthesiaMap = {};
  synesthesia.forEach(s => { if (s.note) synesthesiaMap[s.note] = s.color; });

  // Track schemes are resolved from session-local schemes first, then saved schemes.
  const activeTrackScheme = activeTrack?.schemeName
    ? (sessionSchemes?.[activeTrack.schemeName] || listColorSchemes()[activeTrack.schemeName] || null)
    : null;

  const getNoteColor = useCallback((stringIndexOrNote, fretOrMaybe, noteIndexOrMaybe) => {
    let stringIndex, fret, note;
    if (typeof stringIndexOrNote === 'object' && stringIndexOrNote !== null) {
      stringIndex = stringIndexOrNote.stringIndex;
      fret = stringIndexOrNote.fret;
      note = stringIndexOrNote;
    } else {
      stringIndex = stringIndexOrNote;
      fret = fretOrMaybe;
      if (typeof noteIndexOrMaybe === 'number') {
        note = notesRef.current[noteIndexOrMaybe];
      }
    }
    const name = getNoteName(stringIndex, fret);
    const letter = name.replace(/[0-9]/g, '');
    if (note?.instanceSchemeName) {
      const scheme = (sessionSchemes?.[note.instanceSchemeName] || listColorSchemes()[note.instanceSchemeName]) || null;
      if (scheme && scheme[letter]) return scheme[letter];
    }
    if (activeTrackScheme && activeTrackScheme[letter]) return activeTrackScheme[letter];
    if (sessionScheme?.name) {
      const gscheme = (sessionSchemes?.[sessionScheme.name] || listColorSchemes()[sessionScheme.name] || sessionScheme.colors || null);
      if (gscheme && gscheme[letter]) return gscheme[letter];
    } else if (sessionScheme?.colors && sessionScheme.colors[letter]) {
      return sessionScheme.colors[letter];
    }
    if (synesthesiaMap[letter]) return synesthesiaMap[letter];
    return stringColors[stringIndex];
  }, [stringColors, synesthesia, activeTrackScheme, sessionSchemes, sessionScheme]);

  const [accent, setAccent] = useState(loadAccent);
  const handleAccentChange = useCallback((hex) => { setAccent(hex); applyAccent(hex); saveAccent(hex); }, []);

  // === Song tabs: each song is a whole workspace. Live state below is the active song's;
  // other songs keep a snapshot in `songs`. ===
  const [songs, setSongs] = useState(() => [{ id: makeSongId(), name: 'Tab 1', groupId: null, snapshot: null }]);
  const [songGroups, setSongGroups] = useState([]);
  const [activeSongId, setActiveSongId] = useState(() => songs[0].id);
  const songsRef = useRef(songs);
  songsRef.current = songs;
  const activeSongIdRef = useRef(activeSongId);
  activeSongIdRef.current = activeSongId;
  const songHistoryRef = useRef({}); // { [songId]: { undo, redo } } — in memory only
  const liveRef = useRef({});
  liveRef.current = { bpm, swing, loop, loopStart, loopEnd, subdivisions, rhythmUnit, rhythmMult, markers, barSubdivisions, timeSignature, timelineZoom, trackGroups };
  const captureSong = useCallback(() => ({
    ...liveRef.current,
    tracks: tracksRef.current,
    activeTrackId: activeTrackIdRef.current,
    selectedBeat: selectedBeatRef.current,
  }), []);
  // Songs with the active one's snapshot refreshed from live state (for saving).
  const songsWithLive = () => songs.map(s => s.id === activeSongId ? { ...s, snapshot: captureSong() } : s);

  // Apply partial state from settings/load/URL
  const applyState = useCallback((data) => {
    setPosition(0);  // reset position on any new session load or import
    if (!data.__songSwitch && (data.tracks !== undefined || data.notes !== undefined)) {
      // A whole session: restore its songs, or start over with a single tab.
      if (Array.isArray(data.songs) && data.songs.length) {
        const sid = data.songs.some(sg => sg.id === data.activeSongId) ? data.activeSongId : data.songs[0].id;
        setSongs(data.songs);
        setSongGroups(Array.isArray(data.songGroups) ? data.songGroups : []);
        setActiveSongId(sid);
        activeSongIdRef.current = sid;
      } else {
        const id = makeSongId();
        setSongs([{ id, name: 'Tab 1', groupId: null, snapshot: null }]);
        setSongGroups([]);
        setActiveSongId(id);
        activeSongIdRef.current = id;
      }
      songHistoryRef.current = {};
    }
    if (data.tracks !== undefined) {
      setTracksTracked(data.tracks);
      const firstId = data.tracks[0]?.id;
      if (firstId) { setActiveTrackId(firstId); activeTrackIdRef.current = firstId; }
      // Rehydrate persisted audio files from IndexedDB
      data.tracks.forEach(async (t) => {
        if (t.type === 'audio' && t.audioFileName && !audioBuffersRef.current[t.id]) {
          try {
            const stored = await getAudioFile(t.id);
            if (!stored) { markAudioMissing(t.id, true); return; }
            const ctx = getAudioContext();
            ensureStretchReady(ctx).catch(() => {});
            const buffer = await ctx.decodeAudioData(stored.arrayBuffer.slice(0));
            audioBuffersRef.current[t.id] = buffer;
            markAudioMissing(t.id, false);
            // Back-fill originalBpm for legacy tracks that predate the tempo-stretch feature.
            setTracksTracked(prev => prev.map(tr => tr.id === t.id
              ? (tr.originalBpm ? { ...tr } : { ...tr, originalBpm: bpmRef.current })
              : tr));
          } catch (e) {
            console.warn('Could not restore audio for track', t.id, e);
            markAudioMissing(t.id, true);
          }
        }
      });
    } else if (data.notes !== undefined) {
      // Legacy: wrap flat notes into a single track
      setTracksTracked(prev => {
        const track = prev[0] || createDefaultTrack();
        return [{ ...track, notes: data.notes }];
      });
    }
    if (data.trackGroups !== undefined) setTrackGroups(Array.isArray(data.trackGroups) ? data.trackGroups : []);
    else if (data.tracks !== undefined) setTrackGroups([]);
    if (data.tracks !== undefined) setSelectedTrackIds(new Set());
    if (data.bpm !== undefined) setBpm(data.bpm);
    if (data.swing !== undefined) setSwing(data.swing);
    if (data.loop !== undefined) setLoop(data.loop);
    if (data.loopStart !== undefined) setLoopStart(data.loopStart);
    if (data.loopEnd !== undefined) setLoopEnd(data.loopEnd);
    if (data.stringColors !== undefined) setStringColors(data.stringColors);
    if (data.synesthesia !== undefined) setSynesthesia(data.synesthesia);
    if (data.subdivisions !== undefined) {
      setSubdivisions(data.subdivisions);
      setRhythmMult(1);
      // noteDuration is now derived from effectiveNoteLength
    }
    if (data.rhythmUnit !== undefined) setRhythmUnit(data.rhythmUnit);
    if (data.rhythmMult !== undefined) setRhythmMult(data.rhythmMult);
    if (data.markers !== undefined) setMarkers(data.markers);
    if (data.metronome !== undefined) setMetronome(data.metronome);
    if (data.sessionSchemes !== undefined) {
      setSessionSchemes(data.sessionSchemes || {});
    } else if (data.colorSchemes !== undefined) {
      setSessionSchemes(data.colorSchemes || {});
    }
    const globalScheme = data.globalScheme !== undefined
      ? data.globalScheme
      : data.sessionScheme !== undefined
        ? data.sessionScheme
        : data.activeColorScheme;

    if (globalScheme !== undefined) {
      setSessionScheme(globalScheme);
      if (globalScheme?.name && globalScheme?.colors) {
        setSessionSchemes(prev => ({ ...prev, [globalScheme.name]: globalScheme.colors }));
      }
    }
    if (data.barSubdivisions !== undefined) setBarSubdivisions(data.barSubdivisions);
    if (data.timeSignature !== undefined) setTimeSignature(data.timeSignature);
    if (data.projectName !== undefined) setProjectName(data.projectName);
    if (data.synthPresets) {
      Object.entries(data.synthPresets).forEach(([id, preset]) => {
        saveCustomPreset(id, preset);
      });
      setInstrumentList(getAllInstruments());
    }
    if (data.chordLibrary) {
      saveChordLibrary(data.chordLibrary);
    }
  }, [setTracksTracked, markAudioMissing, setTrackGroups]);

  // Close subdiv dial on outside click
  useEffect(() => {
    if (!showSubdivDial) return;
    const handleClick = (e) => {
      if (subdivDialRef.current && !subdivDialRef.current.contains(e.target)) {
        setShowSubdivDial(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSubdivDial]);

  // Close mult dial on outside click
  useEffect(() => {
    if (!showMultDial) return;
    const handleClick = (e) => {
      if (multDialRef.current && !multDialRef.current.contains(e.target)) {
        setShowMultDial(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showMultDial]);

  // Load from URL or autosave on mount
  useEffect(() => {
    const urlState = stateFromUrl();
    if (urlState) {
      // Keep the hash: the URL *is* this tab's session (see live sync below)
      applyState(urlState);
    } else {
      // No session in the URL: start blank. The autosave is not loaded automatically (it
      // used to override a fresh visit); restore it from Settings > Autosave instead.
    }
  }, []);

  // Handle share link opened in an already-running tab (only hash changes, no reload)
  useEffect(() => {
    const onHashChange = () => {
      const urlState = stateFromUrl();
      if (urlState) applyState(urlState);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [applyState]);

  // Live URL sync: the address bar always holds this tab's session, so a tab can
  // be reloaded, duplicated or shared by copying its URL. Debounced; replaceState
  // means no history entries and no hashchange events.
  useEffect(() => {
    const t = setTimeout(() => {
      writeStateToUrl(getSessionState({
        tracks, bpm, swing, loop, loopStart, loopEnd,
        stringColors, synesthesia, sessionScheme, sessionSchemes,
        projectName, subdivisions, rhythmUnit, rhythmMult, metronome, barSubdivisions, timeSignature, markers,
        songs: songsWithLive(), songGroups, activeSongId, trackGroups,
      }));
    }, 400);
    return () => clearTimeout(t);
  }, [tracks, bpm, swing, loop, loopStart, loopEnd, stringColors, synesthesia, sessionScheme, sessionSchemes, projectName, subdivisions, rhythmUnit, rhythmMult, metronome, barSubdivisions, timeSignature, markers, songs, songGroups, activeSongId, trackGroups]);

  // Autosave toggle
  const [autoSave, setAutoSave] = useState(() => {
    try {
      const saved = localStorage.getItem('guitar-roll-auto-save');
      return saved !== null ? JSON.parse(saved) : true;
    } catch { return true; }
  });

  // Autosave every 30 seconds
  useEffect(() => {
    if (!autoSave) return;
    const interval = setInterval(() => {
      const state = getSessionState({
        tracks: tracksRef.current,
        bpm, swing, loop, loopStart, loopEnd,
        stringColors, synesthesia, sessionScheme, sessionSchemes,
        projectName, subdivisions, metronome, barSubdivisions, timeSignature, markers,
        songs: songsWithLive(), songGroups, activeSongId, trackGroups,
      });
      const blank = tracksRef.current.every(t => t.type !== 'audio' && !(t.notes && t.notes.length))
        && songsRef.current.length <= 1;
      if (!blank) saveAutosave(state);
    }, 30000);
    return () => clearInterval(interval);
  }, [autoSave, bpm, swing, loop, loopStart, loopEnd, stringColors, synesthesia, sessionScheme, sessionSchemes, projectName, subdivisions, metronome, barSubdivisions, timeSignature, markers, songs, songGroups, activeSongId, trackGroups]);

  const totalBeats = totalColumns(barSubdivisions);
  const handlePlayRef = useRef(null);
  const handleSetSubdivisionsRef = useRef(null);
  const handleSetRhythmMultRef = useRef(null);
  const handleToggleSoloRef = useRef(null);
  const handleToggleMuteRef = useRef(null);
  // Commit the rhythm entry buffer to the appropriate state value.
  const commitRhythmEntry = useCallback(() => {
    const buf = rhythmBufRef.current;
    if (!buf.kind || buf.str === '') return;
    const max = buf.kind === 'mult' ? RHYTHM_MAX_MULT : RHYTHM_MAX_DIV;
    let num = parseInt(buf.str, 10);
    if (!Number.isFinite(num) || num < 1) num = 1;
    if (num > max) num = max;
    if (buf.kind === 'mult') {
      handleSetRhythmMultRef.current?.(num);
    } else {
      handleSetSubdivisionsRef.current?.(num);
    }
    rhythmBufRef.current = { kind: null, str: '' };
    rhythmKeysDownRef.current.clear();
    setRhythmLiveValue(null);
    setRhythmLiveKind(null);
  }, []);
  // --- Copy / paste -------------------------------------------------------
  // In-app clipboard (clipboardRef) keeps full note clones; the system clipboard
  // additionally carries the interchange format from utils/noteClipboard.js so
  // notes can travel to/from other apps (e.g. 43_scales).
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);
  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 1600);
  }, []);

  // Choose a fretboard position; selected notes are re-fingered into the window
  // [pos, pos+4] when their pitch can be played there (others keep their fingering).
  const applyPosition = (pos) => {
    setPosition(pos);
    const sel = selectedNotesRef.current;
    if (!sel.size) return;
    const before = notesRef.current;
    const fit = countInPosition(before, sel, pos);
    if (octaveFitRef.current && fit < sel.size) {
      // Octave fit: shift the selection by whole octaves so it can sit in the window.
      const res = refingerNotesOctave(before, sel, pos);
      setNotes(() => res.notes);
      if (res.shift !== 0) {
        const n = Math.abs(res.shift);
        showToast(`Moved the selection ${n} octave${n > 1 ? 's' : ''} ${res.shift < 0 ? 'down' : 'up'} to fit frets ${pos}–${pos + 4} (${res.count}/${sel.size} fit)`);
      } else if (res.count < sel.size) {
        showToast(`Only ${res.count} of ${sel.size} notes fit frets ${pos}–${pos + 4}, even with octave shifts`);
      }
      return;
    }
    setNotes(prev => refingerNotes(prev, sel, pos));
    // Pitch is kept, so notes whose pitch simply does not exist in the window stay outside it: say so.
    if (fit < sel.size) {
      const best = bestPosition(before, sel);
      showToast(`${sel.size - fit} of ${sel.size} notes can't be played in frets ${pos}–${pos + 4} at their pitch.` +
        (best.count > fit ? ` Best position: ${best.position} (${best.count}/${sel.size} fit), or turn on Octave fit.` : ' Turn on Octave fit to shift them by octaves.'));
    }
  };

  // ---- Audio clip editing (active audio track) ----
  const activeAudioTrack = () => {
    const t = tracksRef.current.find(x => x.id === activeTrackIdRef.current);
    return t && t.type === 'audio' ? t : null;
  };
  // fn(clips, track) -> clips. Pass undo=false for continuous drags (snapshot taken once by the caller).
  const updateClips = useCallback((trackId, fn, undo = true) => {
    if (undo) saveSnapshot();
    setTracksTracked(prev => prev.map(t => t.id === trackId ? { ...t, clips: fn(getClips(t), t) } : t));
  }, [saveSnapshot, setTracksTracked]);

  // fn(points, track) -> points. Sync points warp the file's time so it lines up with the grid.
  const updateSyncPoints = useCallback((trackId, fn, undo = true) => {
    if (undo) saveSnapshot();
    setTracksTracked(prev => prev.map(t => t.id === trackId ? { ...t, syncPoints: fn(getSyncPoints(t), t) } : t));
  }, [saveSnapshot, setTracksTracked]);

  // The first sync point turns the recording into the master clock, which re-times the notes.
  const confirmTempoMapChange = () => {
    const tm = tempoMapRef.current;
    if (tm.active) return true;
    const hasNotes = tracksRef.current.some(t => t.type !== 'audio' && t.notes.length > 0);
    if (!hasNotes) return true;
    return confirm('Sync points make the grid follow this recording. Your notes keep their beats but will play at the recording\'s timing (they shift in time). Undo with Ctrl+Z. Continue?');
  };
  const syncBlockedByOtherTrack = (trackId) => {
    const tm = tempoMapRef.current;
    if (tm.active && tm.refId !== trackId) {
      const ref = tracksRef.current.find(x => x.id === tm.refId);
      showToast(`The tempo map comes from "${ref?.name || 'another audio track'}". Clear its sync points first.`);
      return true;
    }
    return false;
  };

  // Add a sync point where the sound is at timeline `beat` of `clip` (the map itself does not change).
  const addSyncPointAtBeat = useCallback((trackId, clip, beat) => {
    const t = tracksRef.current.find(x => x.id === trackId);
    if (!t || syncBlockedByOtherTrack(trackId)) return;
    const tm = tempoMapRef.current;
    const m = tm.forTrack(t);
    if (!confirmTempoMapChange()) return;
    const time = clipBeatToTime(clip, beat, m);
    const spb = secPerBeat(t, bpmRef.current, timeSigRef.current[1]);
    const fileBeat = makeWarp(t, spb).toBeat(time);
    const c0 = getClips(t).reduce((a, c) => (c.start < a.start ? c : a));
    const anchor = (getSyncPoints(t).length && Number.isFinite(t.syncAnchor)) ? t.syncAnchor : c0.start - c0.srcStart / spb;
    saveSnapshot();
    setTracksTracked(prev => prev.map(x => x.id === trackId
      ? { ...x, syncAnchor: anchor, syncPoints: [...getSyncPoints(x), { id: crypto.randomUUID(), time, beat: fileBeat }] }
      : x));
  }, [showToast, saveSnapshot, setTracksTracked]);

  const addSyncPointAtPlayhead = useCallback((trackId) => {
    const t = tracksRef.current.find(x => x.id === trackId);
    if (!t) return;
    const beat = playingRef.current && playheadBeatRef.current != null ? playheadBeatRef.current : selectedBeatRef.current;
    const m = tempoMapRef.current.forTrack(t);
    const clip = getClips(t).find(c => beat >= c.start && beat <= clipEndBeat(c, m));
    if (!clip) { showToast('Put the playhead over the audio clip first'); return; }
    addSyncPointAtBeat(trackId, clip, beat);
  }, [showToast, addSyncPointAtBeat]);

  // Auto sync: detect the beats of the recording, take its steady tempo as the project tempo and
  // pin only the leftover drift, so the grid (and your notes) follow the audio. Undoable.
  const autoSyncPoints = useCallback((trackId) => {
    const t = tracksRef.current.find(x => x.id === trackId);
    const buffer = audioBuffersRef.current[trackId];
    if (!t || !buffer || syncBlockedByOtherTrack(trackId)) return;
    showToast('Detecting beats…');
    setTimeout(() => {
      const spb = secPerBeat(t, bpmRef.current, timeSigRef.current[1]);
      let beats = [];
      try { beats = detectBeats(buffer, spb); } catch (err) { console.warn('beat detection failed', err); }
      const fit = beats.length >= 4 ? fitTempo(beats) : null;
      if (!fit) { showToast('Could not find a steady beat in this audio'); return; }
      if (!confirmTempoMapChange()) return;
      // the audio keeps its own tempo; the project tempo becomes the same so it plays 1:1
      const detectedBpm = Math.round(60 / fit.period * (4 / timeSigRef.current[1]) * 10) / 10;
      // label the first beat with the grid beat it already sits closest to
      const b0 = Math.max(1, Math.round(fit.t0 / fit.period));
      const bars = new Set(barStartBeats(barSubsRef.current));
      const step = timeSigRef.current[0] || 4;
      const maxDrift = Math.max(...fit.residual.map(Math.abs));
      const offset = b0 * fit.period - fit.t0; // where the first beat sits vs. the grid beat it was given
      const pins = [];
      if (maxDrift > 0.025 || Math.abs(offset) > 0.025) { // otherwise the steady tempo is already tight enough
        beats.forEach((_, k) => {
          const beat = b0 + k;
          if (bars.has(beat) || (bars.size < 2 && beat % step === 0)) {
            pins.push({ id: crypto.randomUUID(), time: fit.t0 + fit.period * k + fit.residual[k], beat });
          }
        });
        // tempo is steady: one pin is enough to put the beat on the grid (the rest plays 1:1)
        if (maxDrift <= 0.025) pins.splice(1);
      }
      // keep the file's origin where the audio already sits on the grid
      const c0 = getClips(t).reduce((a, c) => (c.start < a.start ? c : a), { start: 0, srcStart: 0 });
      const syncAnchor = c0.start - c0.srcStart / spb;
      saveSnapshot();
      setTracksTracked(prev => prev.map(x => x.id === trackId
        ? { ...x, originalBpm: detectedBpm, syncPoints: pins, syncAnchor }
        : (x.type === 'audio' ? { ...x, syncPoints: [] } : x)));
      setBpm(detectedBpm);
      showToast(`Detected ${detectedBpm} BPM · ${maxDrift > 0.025 ? `${pins.length} sync points follow the tempo drift` : 'steady tempo, no drift to follow'}`);
    }, 30);
  }, [showToast, saveSnapshot, setTracksTracked]);
  const clearSyncPoints = useCallback((trackId) => updateSyncPoints(trackId, () => []), [updateSyncPoints]);

  // Ctrl+E: split selected clips (or whatever is under the playhead) at the playhead.
  const splitClipsAtPlayhead = useCallback(() => {
    const t = activeAudioTrack();
    if (!t) return false;
    const beat = playingRef.current && playheadBeatRef.current != null ? playheadBeatRef.current : selectedBeatRef.current;
    const spb = tempoMapRef.current.forTrack(t);
    const clips = getClips(t);
    let ids = selectedClipsRef.current;
    if (ids.size === 0) ids = new Set(clips.filter(c => beat > c.start && beat < clipEndBeat(c, spb)).map(c => c.id));
    const res = splitClips(clips, ids, beat, spb);
    if (res.created.length === 0) { showToast('Nothing to split at the playhead'); return true; }
    updateClips(t.id, () => res.clips);
    setSelectedClips(new Set(res.created));
    return true;
  }, [showToast, updateClips]);

  const deleteSelectedClips = useCallback(() => {
    const t = activeAudioTrack();
    if (!t || selectedClipsRef.current.size === 0) return false;
    const ids = selectedClipsRef.current;
    updateClips(t.id, clips => clips.filter(c => !ids.has(c.id)));
    setSelectedClips(new Set());
    return true;
  }, [updateClips]);

  const copyClips = useCallback(() => {
    const t = activeAudioTrack();
    if (!t) return false;
    const picked = getClips(t).filter(c => selectedClipsRef.current.has(c.id));
    if (picked.length === 0) { showToast('Select a clip first'); return true; }
    clipClipboardRef.current = picked.map(c => ({ ...c }));
    showToast(`Copied ${picked.length} clip${picked.length === 1 ? '' : 's'}`);
    return true;
  }, [showToast]);

  const pasteClipsAtPlayhead = useCallback(() => {
    const t = activeAudioTrack();
    if (!t) return false;
    if (clipClipboardRef.current.length === 0) { showToast('No clips to paste'); return true; }
    const at = selectedBeatRef.current || 0;
    const res = pasteClips(getClips(t), clipClipboardRef.current, at);
    updateClips(t.id, () => res.clips);
    setSelectedClips(new Set(res.created));
    // make sure the timeline is long enough for the pasted clips
    const spb = tempoMapRef.current.forTrack(t);
    const end = Math.max(...res.clips.map(c => clipEndBeat(c, spb)));
    setBarSubdivisions(prev => {
      let next = prev;
      while (totalColumns(next) < end && next.length < 999) next = [...next, timeSigRef.current[0] || 4];
      return next;
    });
    return true;
  }, [showToast, updateClips]);

  const copySelectedNotes = useCallback(() => {
    if (copyClips()) return;
    // Selection first; with nothing selected, copy what the fretboard is showing
    // (the notes sounding at the cursor beat) so Ctrl+C is never a silent no-op.
    let selected = notesRef.current.filter((_, i) => selectedNotesRef.current.has(i));
    if (selected.length === 0) {
      const b = selectedBeatRef.current;
      selected = notesRef.current.filter(n => b >= n.beat && b < n.beat + (n.duration || 1));
    }
    if (selected.length === 0) { showToast('Nothing to copy — select notes first'); return; }
    const minBeat = Math.min(...selected.map(n => n.beat));
    clipboardRef.current = selected.map(n => ({ ...n, beat: n.beat - minBeat }));
    const text = serializeNotes(selected, timeSigRef.current, positionRef.current);
    try {
      const p = navigator.clipboard?.writeText(text);
      if (p?.then) p.then(() => showToast(`Copied ${selected.length} note${selected.length === 1 ? '' : 's'}`))
                    .catch(() => showToast('Copied in-app only (browser blocked the clipboard)'));
      else showToast('Copied in-app only (clipboard unavailable)');
    } catch { showToast('Copied in-app only (clipboard unavailable)'); }
  }, [showToast, copyClips]);

  // `text` is whatever is on the system clipboard (or null/'' to use the in-app one).
  const pasteNotes = useCallback((text) => {
    if (pasteClipsAtPlayhead()) return;
    const parsed = parseNotes(text, {
      timeSignature: timeSigRef.current,
      position: positionRef.current,
      defaultVelocity,
    });
    const source = parsed ? parsed.notes : clipboardRef.current;
    if (!source.length) {
      showToast(parsed && parsed.skipped ? `Nothing pasted — ${parsed.skipped} note${parsed.skipped === 1 ? '' : 's'} outside the guitar's range` : 'Nothing to paste');
      return;
    }
    showToast(`Pasted ${source.length} note${source.length === 1 ? '' : 's'}${parsed?.skipped ? ` (${parsed.skipped} outside the guitar's range skipped)` : ''}`);
    if (parsed?.position !== undefined) setPosition(parsed.position); // adopt the sender's fretboard window
    const pasteAt = selectedBeatRef.current;
    const newNotes = source.map(n => ({ ...n, beat: n.beat + pasteAt }));
    const baseIdx = notesRef.current.length;
    // Grow the timeline if the pasted notes run past the last bar
    const endBeat = Math.max(...newNotes.map(n => n.beat + (n.duration || 1)));
    setBarSubdivisions(prev => {
      let next = prev;
      while (totalColumns(next) < endBeat && next.length < 999) {
        next = [...next, timeSigRef.current[0] || 4];
      }
      return next;
    });
    setNotes(prev => [...prev, ...newNotes]);
    setSelectedNotes(new Set(newNotes.map((_, i) => baseIdx + i)));
  }, [defaultVelocity, showToast, pasteClipsAtPlayhead]);
  const pasteNotesRef = useRef(pasteNotes);
  pasteNotesRef.current = pasteNotes;

  // Native paste event: no permission prompt, works across tabs and origins.
  useEffect(() => {
    const onPaste = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      pasteNotesRef.current(e.clipboardData?.getData('text/plain') || '');
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT') return;
      const hk = hotkeysRef.current;

      // Position selection mode: number keys accumulate position value
      if (positionModeRef.current) {
        if (e.key >= '0' && e.key <= '9') {
          e.preventDefault();
          if (positionTimeoutRef.current) {
            clearTimeout(positionTimeoutRef.current);
            positionTimeoutRef.current = null;
          }
          if (!numberKeysDownRef.current.has(e.key)) {
            const canAdd =
              positionBufferRef.current.length === 0 ||
              (positionBufferRef.current.length === 1 &&
              (positionBufferRef.current[0] === '1' || positionBufferRef.current[0] === '2'));
            if (canAdd) {
              numberKeysDownRef.current.add(e.key);
              positionBufferRef.current.push(e.key);
              setPositionModeValue(parseInt(positionBufferRef.current.join(''), 10));
            }
          }
          return;
        }
        if (e.key === 'Backspace') {
          e.preventDefault();
          if (positionTimeoutRef.current) {
            clearTimeout(positionTimeoutRef.current);
            positionTimeoutRef.current = null;
          }
          positionBufferRef.current.pop();
          setPositionModeValue(positionBufferRef.current.length > 0 ? parseInt(positionBufferRef.current.join(''), 10) : null);
          return;
        }
        // This chunk makes it so that position mode can be canceled...
        if (e.key === 'Escape' || matchesHotkey(e, hk.positionMode)) {
          e.preventDefault();
          if (positionTimeoutRef.current) {
            clearTimeout(positionTimeoutRef.current);
            positionTimeoutRef.current = null;
          }
          setPositionMode(false);
          positionModeRef.current = false;
          positionBufferRef.current = [];
setPositionModeValue(null);
        numberKeysDownRef.current.clear();
        return;
      }       
      // ...with Esc or the Position mode Hot key 
      return;
    }

    // X key held as modifier for multiplier input
    if (e.code === 'KeyX' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (!xHeldRef.current) {
        xHeldRef.current = true;
        setXHeld(true);
      }
      return;
    }

    // Enter position mode on P
    if (matchesHotkey(e, hk.positionMode)) {
      e.preventDefault();
      setPositionMode(true);
      positionModeRef.current = true;
      positionBufferRef.current = [];
      setPositionModeValue(null);
      numberKeysDownRef.current.clear();
      return;
    }

    // Number keys 1-9: set subdivision (default) or multiplier (when X held)
    // Position-system-style: buffer accumulates on keydown, commits on keyup.
    // A second digit is allowed only when firstDigit * 10 <= max.
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key >= '1' && e.key <= '9') {
      if (positionModeRef.current) {
        // Position mode handles its own number keys
      } else {
        e.preventDefault();
        if (e.repeat) return;
        // Clear any pending single-digit commit — a new keydown extends/cancels it
        if (rhythmPendingRef.current) {
          clearTimeout(rhythmPendingRef.current);
          rhythmPendingRef.current = null;
        }
        const digit = Number(e.key);
        const buf = rhythmBufRef.current;
        // Kind is fixed by the first digit of the buffer; X only sets it when
        // the buffer is empty.
        const kind = buf.kind || (xHeldRef.current ? 'mult' : 'div');
        const max = kind === 'mult' ? RHYTHM_MAX_MULT : RHYTHM_MAX_DIV;
        const bufEmpty = buf.str === '';
        const firstDigit = bufEmpty ? digit : Number(buf.str[0]);
        // Allow: empty buffer, or single digit that can still be extended
        const canAdd = bufEmpty || (buf.str.length === 1 && firstDigit * 10 <= max);
        if (canAdd) {
          rhythmKeysDownRef.current.add(e.key);
          const newStr = bufEmpty ? String(digit) : buf.str + String(digit);
          rhythmBufRef.current = { kind, str: newStr };
          setRhythmLiveKind(kind);
          setRhythmLiveValue(parseInt(newStr, 10));
        }
      }
      return;
    }

      // Jump to previous/next note (configurable hotkey)
      if (matchesHotkey(e, hk.jumpPrevNote) || matchesHotkey(e, hk.jumpNextNote)) {
        e.preventDefault();
        e.stopPropagation();
        const currentNotes = notesRef.current;
        if (currentNotes.length === 0) return;
        const beats = [...new Set(currentNotes.map(n => n.beat))].sort((a, c) => a - c);
        if (matchesHotkey(e, hk.jumpPrevNote)) {
          setSelectedBeat(b => {
            const prev = beats.filter(beat => beat < b - 0.001);
            return prev.length > 0 ? prev[prev.length - 1] : b;
          });
        } else {
          setSelectedBeat(b => {
            const next = beats.filter(beat => beat > b + 0.001);
            return next.length > 0 ? next[0] : b;
          });
        }
        return;
      }
      if (matchesHotkey(e, hk.prevBeat)) {
        e.preventDefault();
        const step = noteDurationRef.current;
        const snap = snapUnitRef.current;
        setSelectedBeat(b => {
          const next = Math.max(0, b - step);
          return next <= 0 ? 0 : Math.round(next / snap) * snap;
        });
      }
      if (matchesHotkey(e, hk.nextBeat)) {
        e.preventDefault();
        const step = noteDurationRef.current;
        const snap = snapUnitRef.current;
        setSelectedBeat(b => {
          const next = Math.min(totalBeats - 1, b + step);
          return next >= totalBeats - 1 ? totalBeats - 1 : Math.round(next / snap) * snap;
        });
      }
      if (matchesHotkey(e, hk.returnToStart) && !instanceColorMenuRef.current) {
        e.preventDefault();
        setSelectedBeat(0);
      }
      if (matchesHotkey(e, hk.prevMarker)) {
        e.preventDefault();
        setSelectedBeat(b => {
          const sorted = [...markersRef.current].sort((a, c) => a.beat - c.beat);
          const prev = sorted.filter(m => m.beat < b);
          return prev.length > 0 ? prev[prev.length - 1].beat : b;
        });
      }
      if (matchesHotkey(e, hk.nextMarker)) {
        e.preventDefault();
        setSelectedBeat(b => {
          const sorted = [...markersRef.current].sort((a, c) => a.beat - c.beat);
          const next = sorted.filter(m => m.beat > b);
          return next.length > 0 ? next[0].beat : b;
        });
      }
      if (e.code === 'Space' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (!e.repeat) playFromPointerRef.current?.();
        return;
      }
      if (matchesHotkey(e, hk.playStop)) {
        e.preventDefault();
        handlePlayRef.current();
      }
      if (matchesHotkey(e, hk.undo)) {
        e.preventDefault();
        undo();
      }
      if (matchesHotkey(e, hk.redo) || matchesHotkey(e, hk.redoAlt)) {
        e.preventDefault();
        redo();
      }
      // Keyboard zoom: anchored at the playhead by the Timeline component (which captures
      // the anchor before the state update commits). Shift modifier switches to vertical.
      if (matchesHotkey(e, hk.verticalZoomIn) || ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === '+' || e.key === '='))) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('timeline-vertical-zoom', { detail: { dir: 1 } }));
      } else if (matchesHotkey(e, hk.verticalZoomOut) || ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === '-' || e.key === '_'))) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('timeline-vertical-zoom', { detail: { dir: -1 } }));
      } else if (matchesHotkey(e, hk.zoomIn) || ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === '+' || e.key === '='))) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('timeline-zoom', { detail: { dir: 1 } }));
      } else if (matchesHotkey(e, hk.zoomOut) || ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === '-' || e.key === '_'))) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('timeline-zoom', { detail: { dir: -1 } }));
      }
      if (matchesHotkey(e, hk.freeMode)) {
        setFreeMode(m => !m);
      }
      if (matchesHotkey(e, hk.machineGunMode) && selectedNotesRef.current.size === 0) {
        setMachineGunMode(m => !m);
      }
      // Match by key character so shifted symbols like '?' work regardless of modifiers
      if (e.key === hk.cheatSheet.key) {
        setShowCheatSheet(s => !s);
      }
      if (matchesHotkey(e, hk.fingeringMode)) {
        fingeringModeRef.current = !fingeringModeRef.current;
        setFingeringMode(fingeringModeRef.current);
      }
      if (matchesHotkey(e, hk.rhythmUnit)) {
        e.preventDefault();
        setRhythmUnit(u => u === 'beat' ? 'bar' : 'beat');
      }
      if (matchesHotkey(e, hk.instanceColor)) {
        e.preventDefault();
        if (showSettingsRef.current) return;
        const next = !instanceColorMenuRef.current;
        setShowInstanceColorMenu(next);
        if (next) {
          const body = timelineBodyRef.current;
          const pos = lastMousePosRef.current;
          let x = window.innerWidth / 2;
          let y = window.innerHeight / 2;
          if (body) {
            const rect = body.getBoundingClientRect();
            if (pos.x >= rect.left && pos.x <= rect.right && pos.y >= rect.top && pos.y <= rect.bottom) {
              const midX = rect.left + rect.width / 2;
              if (pos.x < midX) {
                setInstanceColorMenuPos({ left: pos.x + 12, top: pos.y + 12, right: null });
                return;
              } else {
                setInstanceColorMenuPos({ left: null, top: pos.y + 12, right: window.innerWidth - pos.x + 12 });
                return;
              }
            }
          }
          setInstanceColorMenuPos({ left: x, top: y, right: null });
        } else if (selectedNotesRef.current.size === 0) {
          setTracksTracked(prev => prev.map(t => t.id === activeTrackId ? { ...t, activeInstanceScheme: null } : t));
        }
      }
      if (matchesHotkey(e, hk.selectAtPlayhead)) {
        e.preventDefault();
        const beat = selectedBeatRef.current;
        const atBeat = new Set();
        notesRef.current.forEach((n, i) => {
          if (beat >= n.beat && beat < n.beat + (n.duration || 1)) atBeat.add(i);
        });
        setSelectedNotes(atBeat);
      }
      
      //Added event listener for the clear selections hotkey, which sets the selected note state to empty.
      if (matchesHotkey(e, hk.clearSelection)) {
        e.preventDefault();
        setSelectedNotes(new Set());
      }

      // Audio track: clip editing hotkeys take over (split / delete / select all)
      if (activeAudioTrack()) {
        if (matchesHotkey(e, hk.splitNote)) { e.preventDefault(); splitClipsAtPlayhead(); return; }
        if (matchesHotkey(e, hk.deleteNotes) || matchesHotkey(e, hk.deleteNotesAlt)) {
          if (deleteSelectedClips()) e.preventDefault();
          return;
        }
        if (matchesHotkey(e, hk.selectAll)) {
          e.preventDefault();
          setSelectedClips(new Set(getClips(activeAudioTrack()).map(c => c.id)));
          return;
        }
      }

      //Event listener for Select-All hotkey
      if (matchesHotkey(e, hk.selectAll)) {
        e.preventDefault();
        const all = new Set(notesRef.current.map((_, i) => i));
        setSelectedNotes(all);
      }

      //Split-note handler...
      if (matchesHotkey(e, hk.splitNote)) {
        e.preventDefault();
        const beat = selectedBeatRef.current;
        const currentNotes = notesRef.current;
        const selected = selectedNotesRef.current;
        const targets = selected.size > 0
          ? [...selected].filter(i => i < currentNotes.length)
          : currentNotes.map((_, i) => i);

        const newNotes = [];
        const newSelected = new Set();

        currentNotes.forEach((note, i) => {
          if (!targets.includes(i)) {
            newNotes.push(note);
            return;
          }

          const start = note.beat;
          const end = note.beat + (note.duration || 1);
          if (beat > start + 0.001 && beat < end - 0.001) {
            const leftDur = beat - start;
            const rightDur = end - beat;
            const leftNote = { ...note, duration: leftDur };
            const rightNote = { ...note, beat: beat, duration: rightDur };
            newNotes.push(leftNote, rightNote);
            // Select only the shorter piece (the right one when they are equal)
            newSelected.add(leftDur < rightDur - 1e-9 ? newNotes.length - 2 : newNotes.length - 1);
          } else {
            newNotes.push(note);
          }
        });

        if (newNotes.length !== currentNotes.length) {
          setNotes(newNotes);
          setSelectedNotes(newSelected);
        }
      }    // ...end of split-note handler
      
      if (matchesHotkey(e, hk.deleteNotes) || matchesHotkey(e, hk.deleteNotesAlt)) {
        if (selectedNotesRef.current.size > 0) {
          e.preventDefault();
          setNotes(prev => prev.filter((_, i) => !selectedNotesRef.current.has(i)));
          setSelectedNotes(new Set());
        }
      }
      if (matchesHotkey(e, hk.toggleGhost)) {
        if (selectedNotesRef.current.size > 0) {
          e.preventDefault();
          setNotes(prev => prev.map((n, i) =>
            selectedNotesRef.current.has(i) ? { ...n, ghost: !n.ghost } : n
          ));
        }
      }
      
      // Transpose selected notes via configurable hotkeys.
      let transposeHandled = false;
      const isSemiUp = matchesHotkey(e, hk.transposeSemiUp);
      const isSemiDown = matchesHotkey(e, hk.transposeSemiDown);
      const isOctUp = matchesHotkey(e, hk.transposeOctaveUp);
      const isOctDown = matchesHotkey(e, hk.transposeOctaveDown);
      if ((isSemiUp || isSemiDown || isOctUp || isOctDown) && selectedNotesRef.current.size > 0) {
        e.preventDefault();
        transposeHandled = true;
        const step = (isOctUp || isOctDown) ? 12 : 1;
        const delta = (isSemiUp || isOctUp) ? step : -step;
        setNotes(prev => prev.map((n, i) => {
          if (!selectedNotesRef.current.has(i)) return n;
          const newMidi = getMidiNote(n.stringIndex, n.fret) + delta;
          const combo = closestComboForPitch(newMidi, n.stringIndex);
          if (!combo) return n;
          return { ...n, stringIndex: combo.stringIndex, fret: combo.fret };
        }));
      }
      // Nudge selected notes with the arrows: left/right by one grid step, up/down by a semitone.
      if (selectedNotesRef.current.size > 0) {
        const nl = matchesHotkey(e, hk.nudgeLeft), nr = matchesHotkey(e, hk.nudgeRight);
        const nu = matchesHotkey(e, hk.nudgeUp), nd = matchesHotkey(e, hk.nudgeDown);
        if (nl || nr || nu || nd) {
          e.preventDefault();
          transposeHandled = true;
          if (nl || nr) {
            const step = snapUnitRef.current || 1;
            const maxBeat = totalColumns(barSubsRef.current);
            const sel = [...selectedNotesRef.current].map(i => notesRef.current[i]).filter(Boolean);
            // One shared shift, clamped so the whole selection stays inside the timeline.
            const minBeat = Math.min(...sel.map(n => n.beat));
            const maxEnd = Math.max(...sel.map(n => n.beat + (n.duration || 1)));
            let d = nr ? step : -step;
            d = Math.max(-minBeat, Math.min(d, maxBeat - maxEnd));
            if (Math.abs(d) > 1e-9) {
              setNotes(prev => prev.map((n, i) => selectedNotesRef.current.has(i)
                ? { ...n, beat: Math.round((n.beat + d) * 10000) / 10000 } : n));
            }
          } else {
            const delta = nu ? 1 : -1;
            setNotes(prev => prev.map((n, i) => {
              if (!selectedNotesRef.current.has(i)) return n;
              const combo = closestComboForPitch(getMidiNote(n.stringIndex, n.fret) + delta, n.stringIndex);
              return combo ? { ...n, stringIndex: combo.stringIndex, fret: combo.fret } : n;
            }));
          }
        }
      }
      // Stretch / compress the selection: the shortest note changes by one rhythm step and every
      // note start (from the earliest) and length scales by the same factor, so the rhythm keeps its shape.
      // Keyboard layouts differ in what e.key says when Alt/AltGr is held, so also accept the
      // physical keys: the bracket keys themselves, or Alt+8 / Alt+9 (where [ and ] live on e.g.
      // a Portuguese layout), as long as the hotkey is still at its default [ ].
      const bracketDefault = hk.stretchNotes?.key === ']' && hk.compressNotes?.key === '[';
      const codeStretch = bracketDefault && !e.shiftKey && !e.metaKey
        && (e.code === 'BracketRight' || (e.altKey && e.code === 'Digit9'));
      const codeCompress = bracketDefault && !e.shiftKey && !e.metaKey
        && (e.code === 'BracketLeft' || (e.altKey && e.code === 'Digit8'));
      const isStretch = matchesHotkey(e, hk.stretchNotes) || codeStretch;
      const isCompress = matchesHotkey(e, hk.compressNotes) || codeCompress;
      if (selectedNotesRef.current.size > 0 && (isStretch || isCompress)) {
        e.preventDefault();
        const dir = isStretch ? 1 : -1;
        const FLOOR = 1 / 32;
        const step = noteDurationRef.current > 0 ? noteDurationRef.current : 1;
        const round = (x) => Math.round(x * 1e6) / 1e6;
        const sel = [...selectedNotesRef.current].map(i => notesRef.current[i]).filter(Boolean);
        const anchor = Math.min(...sel.map(n => n.beat));
        const minLen = Math.min(...sel.map(n => n.duration || 1));
        const factor = Math.max(FLOOR, minLen + dir * step) / minLen;
        if (Math.abs(factor - 1) > 1e-9) {
          const total = totalColumns(barSubsRef.current);
          const maxEnd = Math.max(...sel.map(n => anchor + (n.beat - anchor) * factor + Math.max(FLOOR, (n.duration || 1) * factor)));
          setNotes(prev => prev.map((n, i) => selectedNotesRef.current.has(i)
            ? { ...n, beat: round(anchor + (n.beat - anchor) * factor), duration: Math.max(FLOOR, round((n.duration || 1) * factor)) }
            : n));
          if (maxEnd > total + 1e-6) {
            // Grow the timeline so the stretched phrase fits.
            setBarSubdivisions(prev => {
              let next = prev;
              while (totalColumns(next) < maxEnd - 1e-6 && next.length < 999) next = [...next, timeSigRef.current[0] || 4];
              return next;
            });
          }
        }
      }
      if (!transposeHandled && matchesHotkey(e, hk.bendUp)) {
        if (selectedNotesRef.current.size > 0) {
          e.preventDefault();
          setNotes(prev => prev.map((n, i) =>
            selectedNotesRef.current.has(i) ? { ...n, bend: Math.min(3, (n.bend || 0) + 0.5) } : n
          ));
        }
      }
      if (!transposeHandled && matchesHotkey(e, hk.bendDown)) {
        if (selectedNotesRef.current.size > 0) {
          e.preventDefault();
          setNotes(prev => prev.map((n, i) =>
            selectedNotesRef.current.has(i) ? { ...n, bend: Math.max(0, (n.bend || 0) - 0.5) } : n
          ));
        }
      }
      /* Solo: hotkey solos only current track. If there's only 1
      soloed track, using the hotkey on it un-solos that track */
      if (matchesHotkey(e, hk.soloTrack)) {
        e.preventDefault();
        if (handleToggleSoloRef.current) handleToggleSoloRef.current();
      }
      if (matchesHotkey(e, hk.soloGroup)) {
        e.preventDefault();
        handleGroupHotkeyRef.current?.('solo');
      }
      if (matchesHotkey(e, hk.muteGroup)) {
        e.preventDefault();
        handleGroupHotkeyRef.current?.('muted');
      }
      if (matchesHotkey(e, hk.groupTracks)) {
        e.preventDefault();
        handleGroupTracksRef.current?.();
      }
      if (matchesHotkey(e, hk.ungroupTracks)) {
        e.preventDefault();
        handleUngroupTracksRef.current?.();
      }
      if (matchesHotkey(e, hk.muteTrack)) {
        e.preventDefault();
        if (handleToggleMuteRef.current) handleToggleMuteRef.current(activeTrackIdRef.current);
      }
      if (matchesHotkey(e, hk.toggleSlide)) {
        if (selectedNotesRef.current.size > 0) {
          e.preventDefault();
          setNotes(prev => prev.map((n, i) => {
            if (!selectedNotesRef.current.has(i)) return n;
            if (n.slideTo != null) return { ...n, slideTo: undefined };
            // Find the next note on the same string after this one
            const nextOnString = prev.filter(other =>
              other.stringIndex === n.stringIndex && other.beat > n.beat
            ).sort((a, b) => a.beat - b.beat)[0];
            return { ...n, slideTo: nextOnString ? nextOnString.fret : Math.min(NUM_FRETS, n.fret + 2) };
          }));
        }
      }
      if (matchesHotkey(e, hk.voiceLeading)) {
        e.preventDefault();
        setShowVoiceLeading(true);
      }
      // Fingering: shift selected notes to an adjacent string, same pitch (only in fingering mode)
      if (fingeringModeRef.current && (matchesHotkey(e, hk.stringUp) || matchesHotkey(e, hk.stringDown))) {
        if (selectedNotesRef.current.size > 0) {
          e.preventDefault();
          const dir = matchesHotkey(e, hk.stringUp) ? 1 : -1;
          const MAX_FRET_SPAN = 4;
          setNotes(prev => {
            // Collect selected notes with their indices
            const selected = [];
            prev.forEach((n, i) => {
              if (selectedNotesRef.current.has(i)) selected.push({ note: n, idx: i });
            });
            // Sort by string in movement direction so we assign strings without conflicts
            selected.sort((a, b) => dir * (a.note.stringIndex - b.note.stringIndex));

            const usedStrings = new Set();
            const placements = []; // { idx, stringIndex, fret }

            for (const { note, idx } of selected) {
              const midi = getMidiNote(note.stringIndex, note.fret);
              let placed = false;
              for (let step = 1; step < NUM_STRINGS; step++) {
                const s = ((note.stringIndex + dir * step) % NUM_STRINGS + NUM_STRINGS) % NUM_STRINGS;
                if (usedStrings.has(s)) continue;
                const fret = midi - getMidiNote(s, 0);
                if (fret < 0 || fret > NUM_FRETS) continue;
                // Check fret span with already placed notes
                const allFrets = placements.map(p => p.fret).concat(fret);
                if (Math.max(...allFrets) - Math.min(...allFrets) > MAX_FRET_SPAN) continue;
                placements.push({ idx, stringIndex: s, fret });
                usedStrings.add(s);
                placed = true;
                break;
              }
              if (!placed) return prev; // abort entire move if any note can't be placed
            }

            const placementMap = new Map(placements.map(p => [p.idx, p]));
            return prev.map((n, i) => {
              const p = placementMap.get(i);
              return p ? { ...n, stringIndex: p.stringIndex, fret: p.fret } : n;
            });
          });
        }
      }
      if (matchesHotkey(e, hk.copy)) {
        e.preventDefault();
        copySelectedNotes();
      }
      // Paste is handled by the native `paste` event listener above.
    };
    window.addEventListener('keydown', handleKeyDown);
    const handleKeyUp = (e) => {
      // Shift + Space plays only while the keys are down
      if ((e.code === 'Space' || e.key === 'Shift') && shiftPlayOriginRef.current != null) {
        stopShiftPlayRef.current?.();
      }
      if (e.code === 'KeyX') {
        xHeldRef.current = false;
        setXHeld(false);
        return;
      }
      if (positionModeRef.current) {
        if (e.key >= '0' && e.key <= '9') {
          numberKeysDownRef.current.delete(e.key);
          // Only arm timeout if all number keys are released AND buffer has exactly one digit of '1' or '2'
          if (numberKeysDownRef.current.size === 0 && positionBufferRef.current.length === 1) {
            const buffered = positionBufferRef.current[0];
            if (buffered === '1' || buffered === '2') {
              positionTimeoutRef.current = setTimeout(() => {
                numberKeysDownRef.current.clear();
                const pos = Math.min(NUM_FRETS, Math.max(0, parseInt(positionBufferRef.current.join(''), 10)));
                applyPosition(pos);
                positionBufferRef.current = [];
                setPositionModeValue(null);
                setPositionMode(false);
                positionModeRef.current = false;
                positionTimeoutRef.current = null;
              }, 1000); // 1 second grace window
              return;
            }
          }
          // Normal commit: all keys up and buffer has a complete number (or no timeout window applies)
          if (numberKeysDownRef.current.size === 0 && positionTimeoutRef.current === null && positionBufferRef.current.length > 0) {
            const pos = Math.min(NUM_FRETS, Math.max(0, parseInt(positionBufferRef.current.join(''), 10)));
            applyPosition(pos);
            positionBufferRef.current = [];
            setPositionModeValue(null);
            setPositionMode(false);
            positionModeRef.current = false;
          }
        }
        return;
      }
      // Rhythm entry: commit on keyup when all rhythm keys are released
      if (e.key >= '1' && e.key <= '9' && rhythmKeysDownRef.current.has(e.key)) {
        rhythmKeysDownRef.current.delete(e.key);
        if (rhythmKeysDownRef.current.size === 0 && rhythmBufRef.current.str !== '') {
          const buf = rhythmBufRef.current;
          const max = buf.kind === 'mult' ? RHYTHM_MAX_MULT : RHYTHM_MAX_DIV;
          const firstDigit = Number(buf.str[0]);
          // Single digit that can still be extended → arm a grace window in case
          // a second digit arrives. Otherwise commit immediately.
          if (buf.str.length === 1 && firstDigit * 10 <= max) {
            rhythmPendingRef.current = setTimeout(() => {
              commitRhythmEntry();
              rhythmPendingRef.current = null;
            }, RHYTHM_PENDING_WINDOW);
          } else {
            commitRhythmEntry();
          }
        }
      }
    };
    window.addEventListener('keyup', handleKeyUp);
    const onBlur = () => stopShiftPlayRef.current?.();
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      if (positionTimeoutRef.current) clearTimeout(positionTimeoutRef.current);
      if (rhythmPendingRef.current) clearTimeout(rhythmPendingRef.current);
    };
  }, [totalBeats, undo, redo, setNotes]);

  const handleFretClick = useCallback((stringIndex, fret, stayInPlace = false) => {
    setSelectedNotes(new Set()); // note entry cancels selection
    const beat = Math.round(selectedBeat / snapUnit) * snapUnit;
    const exactMatch = notes.findIndex(
      n => n.stringIndex === stringIndex && n.fret === fret && Math.abs(n.beat - beat) < 0.001
    );
    const willAutoForward = exactMatch < 0 && fretboardAutoForward !== stayInPlace;
      if (willAutoForward) {
        autoForwardLastActionRef.current = true;
      }
    setNotes(prev => {
      if (exactMatch >= 0) {
        return prev.filter((_, i) => i !== exactMatch);
      }
      const filtered = prev.filter(
        n => !(n.stringIndex === stringIndex && Math.abs(n.beat - beat) < 0.001)
      );
      return [...filtered, { stringIndex, fret, beat, duration: effectiveNoteLength, velocity: defaultVelocity, instanceSchemeName: activeTrack?.activeInstanceScheme ?? null }];
    });
    // Only advance playhead when adding a note, not when erasing
    if (willAutoForward) {
      setSelectedBeat(b => {
        const next = Math.min(totalBeats - 1, b + effectiveNoteLength);
        return next >= totalBeats - 1 ? totalBeats - 1 : Math.round(next / snapUnit) * snapUnit;
      });
      autoForwardLastActionRef.current = false;
    }
  }, [selectedBeat, effectiveNoteLength, snapUnit, totalBeats, defaultVelocity, fretboardAutoForward, notes, activeScheme]);
  const handleAdjacentClick = useCallback((stringIndex, fret, stayInPlace = false) => {
    setSelectedNotes(new Set()); // note entry cancels selection
    const beat = Math.round(selectedBeat / snapUnit) * snapUnit;
    const exactMatch = notes.findIndex(
      n => n.stringIndex === stringIndex && n.fret === fret && Math.abs(n.beat - beat) < 0.001
    );
    const willAutoForward = fretboardAutoForward && stayInPlace === fretboardAutoForwardExcludeAdjacent && exactMatch < 0;
    if (willAutoForward) {
      autoForwardLastActionRef.current = true;
    }
    setNotes(prev => {
      const idx = prev.findIndex(
        n => n.stringIndex === stringIndex && n.fret === fret && Math.abs(n.beat - beat) < 0.001
      );
      if (idx >= 0) {
        return prev.filter((_, i) => i !== idx);
      }
      return [...prev, { stringIndex, fret, beat, duration: effectiveNoteLength, velocity: defaultVelocity, instanceSchemeName: activeScheme }];
    });
    if (willAutoForward) {
      setSelectedBeat(b => {
        const next = Math.min(totalBeats - 1, b + effectiveNoteLength);
        return next >= totalBeats - 1 ? totalBeats - 1 : Math.round(next / snapUnit) * snapUnit;
      });
      autoForwardLastActionRef.current = false;
    }
  }, [selectedBeat, effectiveNoteLength, snapUnit, totalBeats, defaultVelocity, fretboardAutoForward, fretboardAutoForwardExcludeAdjacent, notes, activeScheme]);

  const handleMoveNote = useCallback((fromString, fromFret, toString, toFret) => {
    setNotes(prev => {
      const idx = prev.findIndex(
        n => n.stringIndex === fromString && n.fret === fromFret && n.beat === selectedBeat
      );
      if (idx < 0) return prev;
      // Remove any existing note at the destination on the same beat
      const filtered = prev.filter(
        (n, i) => i === idx || !(n.stringIndex === toString && n.beat === selectedBeat)
      );
      return filtered.map((n, i) =>
        n === prev[idx] ? { ...n, stringIndex: toString, fret: toFret } : n
      );
    });
  }, [selectedBeat]);

  const handleSetSubdivisions = useCallback((subs) => {
    setSubdivisions(subs);
    const newMult = resetMultOnSubdivRef.current ? 1 : rhythmMult;
    if (resetMultOnSubdivRef.current) setRhythmMult(1);
    // noteDuration is now derived from effectiveNoteLength
    if (rhythmAltersSelectedRef.current && selectedNotes.size > 0) {
      const dur = (unitBeats / subs) * newMult;
      setNotes(prev => prev.map((n, i) =>
        selectedNotes.has(i) ? { ...n, duration: dur } : n
      ));
    }
  }, [selectedNotes, rhythmMult, unitBeats]);
  handleSetSubdivisionsRef.current = handleSetSubdivisions;

  const handleSetRhythmMult = useCallback((mult) => {
    setRhythmMult(mult);
    if (rhythmAltersSelectedRef.current && selectedNotes.size > 0) {
      const dur = baseSubdivBeats * mult;
      setNotes(prev => prev.map((n, i) =>
        selectedNotes.has(i) ? { ...n, duration: dur } : n
      ));
    }
  }, [selectedNotes, baseSubdivBeats]);
  handleSetRhythmMultRef.current = handleSetRhythmMult;


  const handleNoteDurationChange = useCallback((stringIndex, fret, newDuration) => {
    setNotesDrag(prev => prev.map(n =>
      n.stringIndex === stringIndex && n.fret === fret && n.beat === selectedBeat
        ? { ...n, duration: newDuration }
        : n
    ));
  }, [selectedBeat, setNotesDrag]);

  const handleBeatChange = useCallback((stringIndex, fret, fromBeat, toBeat) => {
    setNotesDrag(prev => prev.map(n =>
      n.stringIndex === stringIndex && n.fret === fret && n.beat === fromBeat
        ? { ...n, beat: toBeat }
        : n
    ));
    setSelectedBeat(toBeat);
  }, []);

  const handleDeleteNotes = useCallback((indices) => {
    const drop = new Set(indices);
    setNotes(prev => prev.filter((_, i) => !drop.has(i)));
    setSelectedNotes(new Set());
  }, []);

  const handleDeleteNote = useCallback((noteIndex) => {
    setNotes(prev => prev.filter((_, i) => i !== noteIndex));
    setSelectedNotes(new Set());
  }, []);

  const teardownChain = (c) => {
    c.sources.forEach(src => {
      try { src.stop(); } catch {}
      try { src.disconnect(); } catch {}
    });
    c.sources.length = 0;
    try { c.workletNode?.disconnect(); } catch {}
    try { c.gainNode?.disconnect(); } catch {}
  };

  const dropAudioChain = useCallback((trackId) => {
    const i = audioSourcesRef.current.findIndex(c => c.trackId === trackId);
    if (i < 0) return;
    teardownChain(audioSourcesRef.current[i]);
    audioSourcesRef.current.splice(i, 1);
  }, []);

  // One persistent gain + rubberband chain per audio track, created ahead of time so
  // playback never starts through an uncorrected (pitch-shifted) path.
  const ensureAudioChain = useCallback((track, buffer) => {
    let chain = audioSourcesRef.current.find(c => c.trackId === track.id);
    if (chain && chain.buffer === buffer) return chain;
    if (chain) dropAudioChain(track.id);
    const ctx = getAudioContext();
    const gainNode = ctx.createGain();
    gainNode.gain.value = track.muted ? 0 : (track.volume ?? 1);
    gainNode.connect(ctx.destination);
    chain = { trackId: track.id, buffer, gainNode, workletNode: null, sources: [], latencySamples: 0, failed: false, settled: false };
    audioSourcesRef.current.push(chain);
    const c = chain;
    c.ready = createStretchNode(ctx, { numChannels: buffer.numberOfChannels, initialRatio: audioPitchScale(track, audioRateOf(track)) })
      .then(({ node, ready }) => {
        if (!audioSourcesRef.current.includes(c)) { try { node.disconnect(); } catch {} return null; }
        node.connect(c.gainNode);
        return ready.then(({ latencySamples }) => {
          c.latencySamples = latencySamples || 0;
          c.workletNode = node;
        }).catch((err) => {
          console.warn('[rubberband] init failed, audio will not keep pitch:', err);
          c.failed = true;
          try { node.disconnect(); } catch {}
        });
      })
      .catch((err) => {
        console.warn('[rubberband] could not create worklet node:', err);
        c.failed = true;
      })
      .finally(() => { c.settled = true; });
    return chain;
  }, [dropAudioChain]);

  // Resolves once every playable audio track's chain is ready (null when nothing to wait for).
  const prepareAudioChains = useCallback((playable) => {
    const waits = [];
    playable.forEach(t => {
      if (t.type !== 'audio') return;
      const buffer = audioBuffersRef.current[t.id];
      if (!buffer) return;
      const chain = ensureAudioChain(t, buffer);
      if (!chain.settled) waits.push(chain.ready);
    });
    if (waits.length === 0) return null;
    return Promise.race([Promise.all(waits), new Promise(r => setTimeout(r, 3000))]);
  }, [ensureAudioChain]);

  // Stop all clip sources and flush the worklets; chains stay alive for the next play.
  const stopAudioChains = useCallback(() => {
    audioSourcesRef.current.forEach((c) => {
      c.sources.forEach(src => {
        try { src.stop(); } catch {}
        try { src.disconnect(); } catch {}
      });
      c.sources.length = 0;
      if (c.workletNode) resetStretch(c.workletNode);
    });
  }, []);

  // Push current bpm / volume / pitch settings into the live chains.
  applyChainParamsRef.current = () => {
    audioSourcesRef.current.forEach((c) => {
      const track = tracksRef.current.find(t => t.id === c.trackId);
      if (!track) return;
      const mult = audioRateOf(track);
      const now = c.gainNode.context.currentTime;
      try { c.gainNode.gain.setTargetAtTime(track.muted ? 0 : (track.volume ?? 1), now, 0.01); } catch {}
      c.sources.forEach(src => { try { src.playbackRate.setValueAtTime(mult, now); } catch {} });
      if (c.workletNode) setStretchTempo(c.workletNode, audioPitchScale(track, mult));
    });
  };

  const stopPlayback = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    setCurrentBeat(null);
    playheadBeatRef.current = null;
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
    }
    // Stop audio file sources and tear down any rubberband worklet nodes.
    stopAudioChains();
  }, [stopAudioChains]);

  // Schedule the audio clips of every playable audio track for the beat range
  // [fromBeat, endBeat), with fromBeat sounding at `startTime`. Clips are BufferSources
  // feeding the track's chain, so a loop can append another pass at the boundary.
  const scheduleAudioPass = useCallback((playable, fromBeat, startTime, ctx, endBeat) => {
    const tm = tempoMapRef.current;
    const fromSec = tm.liveSec(fromBeat);

    playable.forEach(track => {
      if (track.type !== 'audio') return;
      const buffer = audioBuffersRef.current[track.id];
      if (!buffer) return;

      // The audio plays 1:1 (times the BPM control). With a tempo map the grid bends to the
      // recording; without one a clip is attached to the grid at the tempo it was imported at.
      const m = tm.forTrack(track);
      const rate = audioRateOf(track);
      const chain = ensureAudioChain(track, buffer);
      // rubberband delays its output; start sources early by that much so audio stays on the grid
      const latencySec = (chain.latencySamples || 0) / ctx.sampleRate;
      const dest = chain.workletNode || chain.gainNode;

      getClips(track).forEach(clip => {
        const clipEnd = clipEndBeat(clip, m);
        const a = Math.max(clip.start, fromBeat);
        const b = Math.min(clipEnd, endBeat);
        if (b - a <= 1e-6) return;
        let when = startTime + (tm.liveSec(a) - fromSec) - latencySec;
        let offset = clipBeatToTime(clip, a, m);
        let dur = clipBeatToTime(clip, b, m) - offset;
        const lag = ctx.currentTime - when;
        if (lag > 0) { // too late to start early: skip the part that already passed
          offset += lag * rate;
          dur -= lag * rate;
          when = ctx.currentTime;
          if (dur <= 0.001) return;
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = rate;
        source.connect(dest);
        const sources = chain.sources;
        source.onended = () => {
          const i = sources.indexOf(source);
          if (i >= 0) sources.splice(i, 1);
        };
        sources.push(source);
        source.start(when, offset, dur); // offset/duration are in file time
      });
      if (chain.workletNode) setStretchTempo(chain.workletNode, audioPitchScale(track, rate));
    });
  }, [ensureAudioChain]);

  const startPlaybackRef = useRef(null);
  const startPlayback = useCallback((fromBeat, chainsReady = false) => {
    const playable = getPlayableTracks(tracksRef.current);
    const hasContent = playable.some(t => t.notes.length > 0 || (t.type === 'audio' && audioBuffersRef.current[t.id]));
    if (!hasContent) return;
    if (!chainsReady) {
      const pending = prepareAudioChains(playable);
      if (pending) { pending.then(() => startPlaybackRef.current(fromBeat, true)); return; }
    }

    const ctx = getAudioContext();
    const isLoop = loopRef.current;
    const barSubs = barSubsRef.current;
    const totalCols = totalColumns(barSubs);
    const regionStart = fromBeat;
    const regionEnd = isLoop ? loopEndRef.current : totalCols;
    const regionDuration = regionEnd - regionStart;

    if (regionDuration <= 0) return;

    playingRef.current = true;
    setPlaying(true);

    const initialStart = regionStart;
    // Everything (notes + audio) starts a little later by the largest audio chain latency
    const maxLatency = audioSourcesRef.current.reduce((m, c) => Math.max(m, (c.latencySamples || 0) / ctx.sampleRate), 0);
    const startTime = ctx.currentTime + 0.05 + maxLatency;

    // Schedule audio file tracks
    scheduleAudioPass(playable, fromBeat, startTime, ctx, regionEnd);
    const lookahead = 0.1;
    let nextBeatIndex = 0;
    let nextBeatTime = startTime;
    let prevRStart = initialStart;
    let prevRDuration = regionDuration;
    let firstPass = true; // use initialStart for the first pass, loop boundaries after

    const animate = () => {
      if (!playingRef.current) return;

      const now = ctx.currentTime;
      const bs = barSubsRef.current;
      const bpm = bpmRef.current;
      const tc = totalColumns(bs);

      // Read live loop region — use initialStart on first pass
      let rStart, rEnd;
      if (firstPass) {
        rStart = initialStart;
        rEnd = loopRef.current ? loopEndRef.current : tc;
      } else {
        rStart = loopRef.current ? loopStartRef.current : initialStart;
        rEnd = loopRef.current ? loopEndRef.current : tc;
      }
      let rDuration = rEnd - rStart;

      if (rDuration <= 0) { stopPlayback(); return; }

      // If loop region changed, adjust nextBeatIndex to stay in range
      if (rStart !== prevRStart || rDuration !== prevRDuration) {
        if (!firstPass) nextBeatIndex = nextBeatIndex % rDuration;
        prevRStart = rStart;
        prevRDuration = rDuration;
      }

      // Loop boundary: reached end of current region. Reset indexing so note scheduling
      // continues from loopStart. Audio loops natively via source.loop, so no rescheduling.
      if (loopRef.current && nextBeatIndex >= rDuration) {
        firstPass = false;
        nextBeatIndex -= rDuration;
        prevRStart = loopStartRef.current;
        prevRDuration = loopEndRef.current - loopStartRef.current;
        // From here on (including the rest of this frame) the region is the loop itself, not the
        // part of it we started in the middle of.
        rStart = loopStartRef.current;
        rDuration = prevRDuration;
        // Audio clips do not loop natively: queue the next pass at the boundary.
        scheduleAudioPass(getPlayableTracks(tracksRef.current), loopStartRef.current, nextBeatTime, ctx, loopEndRef.current);
      }

      // Compute current column's duration for playhead interpolation
      const currentBeatAbs = rStart + (nextBeatIndex > 0 ? (nextBeatIndex - 1) % rDuration : (firstPass ? 0 : rDuration - 1));
      const currentColDur = tempoMapRef.current.colDur(Math.min(currentBeatAbs, tc - 1));
      const beatsSinceLastScheduled = (now - (nextBeatTime - currentColDur)) / currentColDur;
      const playheadBeatIndex = nextBeatIndex - 1 + Math.min(1, Math.max(0, beatsSinceLastScheduled));
      // Just after a loop wrap the index is still in the last column of the previous pass (< 0):
      // wrap it to the end of the loop instead of letting it fall before the loop start.
      const playheadBeat = rStart + (((playheadBeatIndex % rDuration) + rDuration) % rDuration);

      if (!loopRef.current && playheadBeatIndex >= rDuration) {
        stopPlayback();
        return;
      }

      playheadBeatRef.current = playheadBeat;
      setCurrentBeat(playheadBeat);

      // Schedule upcoming beats
      const scheduleEnd = now + lookahead;
      const currentPlayable = getPlayableTracks(tracksRef.current);

      while (nextBeatTime <= scheduleEnd) {
        if (!loopRef.current && nextBeatIndex >= rDuration) break;

        const beatInRegion = nextBeatIndex % rDuration;
        const beat = rStart + beatInRegion;
        const colDur = tempoMapRef.current.colDur(Math.min(beat, tc - 1));

        currentPlayable.forEach(track => {
          if (track.type === 'audio') return;
          const swing = swingRef.current;
          const swungBeat = applySwingBeat(beat, swing, 0.5);
          track.notes.forEach(note => {
            if (note.beat >= beat && note.beat < beat + 1) {
              const swungNoteStart = applySwingBeat(note.beat, swing, 0.5);
              const swungNoteEnd = applySwingBeat(note.beat + (note.duration || 1), swing, 0.5);
              const offset = (swungNoteStart - swungBeat) * colDur;
              const noteDur = Math.max(0.06, (swungNoteEnd - swungNoteStart) * colDur);
              playNoteAtTime(note.stringIndex, note.fret, nextBeatTime + offset, noteDur, note.velocity ?? 0.8, track.instrument, track.volume, note);
            }
          });
        });

        // Metronome clicks every subdivision; downbeat on bar starts
        if (metronomeRef.current) {
          const bStarts = barStartBeats(bs);
          const isDownbeat = bStarts.includes(beat);
          playClickAtTime(nextBeatTime, isDownbeat);
        }

        nextBeatIndex++;
        nextBeatTime += colDur;
      }

      animFrameRef.current = requestAnimationFrame(animate);
    };

    animFrameRef.current = requestAnimationFrame(animate);
  }, [stopPlayback, scheduleAudioPass, prepareAudioChains]);
  startPlaybackRef.current = startPlayback;

  // Editing audio clips (crop / move / split / delete / mute / solo) while playing: re-queue the
  // audio from the playhead so the change is heard immediately instead of after the next play.
  const audioEditSig = useMemo(() => tracks
    .filter(t => t.type === 'audio')
    .map(t => `${t.id}:${t.muted ? 1 : 0}${t.solo ? 1 : 0}:${JSON.stringify(t.clips || null)}:${JSON.stringify(t.syncPoints || null)}${t.syncPoints?.length ? `:${bpm}:${t.pitchSemitones || 0}:${t.keepPitch}` : ''}`)
    .join('|') + `|solo:${tracks.some(t => t.solo) ? 1 : 0}`, [tracks, bpm]);
  useEffect(() => {
    if (!playingRef.current) return;
    const id = setTimeout(() => {
      if (!playingRef.current || playheadBeatRef.current == null) return;
      const ctx = getAudioContext();
      const playable = getPlayableTracks(tracksRef.current);
      const tm = tempoMapRef.current;
      const maxLatency = audioSourcesRef.current.reduce((m, c) => Math.max(m, (c.latencySamples || 0) / ctx.sampleRate), 0);
      const startTime = ctx.currentTime + 0.03 + maxLatency;
      const fromBeat = tm.liveBeat(tm.liveSec(playheadBeatRef.current) + (startTime - ctx.currentTime));
      const endBeat = loopRef.current ? loopEndRef.current : totalColumns(barSubsRef.current);
      stopAudioChains();
      scheduleAudioPass(playable, fromBeat, startTime, ctx, endBeat);
    }, 40);
    return () => clearTimeout(id);
  }, [audioEditSig, stopAudioChains, scheduleAudioPass]);

  // Loop button: the loop region only exists (and is only editable) while on.
  // Turning it on with no meaningful region starts from the bar at the playhead.
  const toggleLoop = useCallback(() => {
    if (loopRef.current) { setLoop(false); return; }
    const bs = barSubsRef.current;
    const total = totalColumns(bs);
    const s = loopStartRef.current, e = loopEndRef.current;
    if (e <= s || e > total || (s <= 0 && e >= total)) {
      const starts = barStartBeats(bs);
      const beat = selectedBeatRef.current || 0;
      let bar = 0;
      for (let i = 0; i < starts.length; i++) if (starts[i] <= beat) bar = i;
      setLoopStart(starts[bar]);
      setLoopEnd(starts[bar] + bs[bar]);
    }
    setLoop(true);
  }, []);

  // Play button: from start of loop or start of timeline
  const handlePlay = useCallback(() => {
    if (playing) {
      stopPlayback();
      return;
    }
    const isLoop = loopRef.current;
    startPlayback(isLoop ? loopStartRef.current : 0);
  }, [playing, stopPlayback, startPlayback]);

  // Spacebar: from playhead position
  const handlePlayFromHead = useCallback(() => {
    if (playing) {
      stopPlayback();
      return;
    }
    startPlayback(selectedBeatRef.current);
  }, [playing, stopPlayback, startPlayback]);

  handlePlayRef.current = handlePlayFromHead;

  // Shift + Space: play from the pointer. The start jumps to the nearest subdivision mark before
  // the pointer, wherever the playhead was. (Pointer off the timeline: from the playhead.)
  const shiftPlayOriginRef = useRef(null);
  const playFromPointerRef = useRef(null);
  playFromPointerRef.current = () => {
    const body = timelineBodyRef.current;
    const m = lastMousePosRef.current;
    let beat = selectedBeatRef.current;
    const box = body?.closest('.timeline-container')?.getBoundingClientRect();
    if (body && box && m.x >= box.left && m.x <= box.right && m.y >= box.top && m.y <= box.bottom) {
      const r = body.getBoundingClientRect();
      const raw = xToBeat(m.x - r.left + body.scrollLeft, barSubsRef.current, CELL_WIDTH * liveRef.current.timelineZoom, false);
      const snap = snapUnitRef.current || 1;
      beat = Math.max(0, Math.min(totalColumns(barSubsRef.current) - 1, Math.floor(raw / snap + 1e-9) * snap));
    }
    // Shift + Space is momentary: remember the playhead so it can go back when the keys are released
    if (shiftPlayOriginRef.current == null) shiftPlayOriginRef.current = selectedBeatRef.current;
    if (playingRef.current) stopPlayback();
    startPlayback(beat);
  };
  const stopShiftPlay = () => {
    const origin = shiftPlayOriginRef.current;
    if (origin == null) return;
    shiftPlayOriginRef.current = null;
    if (playingRef.current) stopPlayback();
    setSelectedBeat(origin);
    selectedBeatRef.current = origin;
  };
  const stopShiftPlayRef = useRef(null);
  stopShiftPlayRef.current = stopShiftPlay;

  // Alt + Space: play the notes that sit at this beat once (the audio part is the scrub voice)
  const auditionNotesAt = useCallback((beat) => {
    getPlayableTracks(tracksRef.current).forEach(t => {
      if (t.type === 'audio') return;
      t.notes.forEach(n => {
        if (n.ghost) return;
        if (beat >= n.beat - 1e-6 && beat < n.beat + (n.duration || 1) - 1e-6) {
          playNote(n.stringIndex, n.fret, Math.min(1.2, Math.max(0.25, (n.duration || 1) * (tempoMapRef.current.liveSpb || 0.5))), n.velocity ?? 0.8, t.instrument, t.volume);
        }
      });
    });
  }, []);

  const handleClear = useCallback(() => {
    setNotes([]);
    setSelectedNotes(new Set());
  }, []);

  const handleStampChord = useCallback((chordNotes) => {
    const beat = selectedBeat;
    const newNotes = chordNotes.map(cn => ({
      stringIndex: cn.stringIndex,
      fret: cn.fret,
      beat: beat + (cn.beatOffset || 0),
      duration: cn.duration || noteDuration,
      velocity: cn.velocity ?? defaultVelocity,
    }));
    setNotes(prev => {
      // Remove existing notes at same string+beat positions
      const removeKeys = new Set(newNotes.map(n => `${n.stringIndex}_${n.beat}`));
      const filtered = prev.filter(n => !removeKeys.has(`${n.stringIndex}_${n.beat}`));
      return [...filtered, ...newNotes];
    });
  }, [selectedBeat, noteDuration, defaultVelocity]);

  // Track management
  const handleAddTrack = useCallback(() => {
    const num = tracksRef.current.length + 1;
    const newTrack = createDefaultTrack(`Track ${num}`);
    setTracksTracked(prev => [...prev, newTrack]);
    switchTrack(newTrack.id);
  }, [setTracksTracked, switchTrack]);

  const handleDuplicateTrack = useCallback((trackId) => {
    const source = tracksRef.current.find(t => t.id === trackId);
    if (!source) return;
    const newTrack = {
      ...source,
      id: crypto.randomUUID(),
      name: source.name + ' (copy)',
      notes: source.notes.map(n => ({ ...n })),
    };
    setTracksTracked(prev => {
      const idx = prev.findIndex(t => t.id === trackId);
      const next = [...prev];
      next.splice(idx + 1, 0, newTrack);
      return next;
    });
    switchTrack(newTrack.id);
  }, [setTracksTracked, switchTrack]);

  // ---- Song tabs ----
  const applySongSnapshot = useCallback((snap) => {
    applyState({
      __songSwitch: true,
      tracks: snap.tracks, bpm: snap.bpm, swing: snap.swing, loop: snap.loop,
      loopStart: snap.loopStart, loopEnd: snap.loopEnd, subdivisions: snap.subdivisions,
      rhythmUnit: snap.rhythmUnit, rhythmMult: snap.rhythmMult, markers: snap.markers,
      barSubdivisions: snap.barSubdivisions, timeSignature: snap.timeSignature,
      trackGroups: snap.trackGroups || [],
    });
    const active = snap.tracks.find(t => t.id === snap.activeTrackId) || snap.tracks[0];
    if (active) {
      setActiveTrackId(active.id);
      activeTrackIdRef.current = active.id;
      setInstrument(active.instrument);
      setInstrumentState(active.instrument);
    }
    setSelectedBeat(snap.selectedBeat || 0);
    setSelectedNotes(new Set());
    setSelectedClips(new Set());
    // Each tab remembers its own timeline zoom; one with audio but no saved zoom fits the song.
    if (Number.isFinite(snap.timelineZoom)) setTimelineZoom(snap.timelineZoom);
    else if (snap.tracks.some(t => t.type === 'audio')) fitZoomPendingRef.current = true;
    else setTimelineZoom(1);
    requestAnimationFrame(() => { if (timelineBodyRef.current) timelineBodyRef.current.scrollLeft = 0; });
  }, [applyState]);

  const switchSong = useCallback((id) => {
    if (id === activeSongIdRef.current) return;
    const target = songsRef.current.find(sg => sg.id === id);
    if (!target) return;
    stopPlayback();
    const cur = activeSongIdRef.current;
    // Park the current song: snapshot + its undo history.
    songHistoryRef.current[cur] = { undo: undoStackRef.current, redo: redoStackRef.current };
    const snapNow = captureSong();
    setSongs(prev => prev.map(sg => sg.id === cur ? { ...sg, snapshot: snapNow } : sg));
    const hist = songHistoryRef.current[id];
    undoStackRef.current = hist?.undo || [];
    redoStackRef.current = hist?.redo || [];
    activeSongIdRef.current = id;
    setActiveSongId(id);
    if (target.snapshot) applySongSnapshot(target.snapshot);
  }, [stopPlayback, captureSong, applySongSnapshot]);

  const handleAddSong = useCallback(() => {
    const id = makeSongId();
    const lv = liveRef.current;
    const track = createDefaultTrack();
    // A new tab starts blank but keeps the current tempo, swing, meter and subdivision.
    const snapshot = {
      tracks: [track], activeTrackId: track.id, selectedBeat: 0,
      bpm: lv.bpm, swing: lv.swing, timeSignature: lv.timeSignature, subdivisions: lv.subdivisions,
      rhythmUnit: 'beat', rhythmMult: 1, loop: false, loopStart: 0,
      loopEnd: totalColumns(defaultBarSubdivisions()), markers: [], barSubdivisions: defaultBarSubdivisions(),
    };
    const name = nextTabName(songsRef.current);
    const cur = activeSongIdRef.current;
    const after = songsRef.current.find(sg => sg.id === cur);
    // Join the active tab's group so "+" next to a group's tabs keeps them together.
    const rec = { id, name, groupId: after?.groupId ?? null, snapshot };
    songsRef.current = songsRef.current.map(sg => sg.id === cur ? { ...sg, snapshot: captureSong() } : sg);
    songsRef.current = [...songsRef.current, rec];
    setSongs(songsRef.current);
    // Park current history, then switch.
    stopPlayback();
    songHistoryRef.current[cur] = { undo: undoStackRef.current, redo: redoStackRef.current };
    undoStackRef.current = [];
    redoStackRef.current = [];
    activeSongIdRef.current = id;
    setActiveSongId(id);
    applySongSnapshot(snapshot);
  }, [captureSong, stopPlayback, applySongSnapshot]);

  const handleDuplicateSong = useCallback((id) => {
    const src = songsRef.current.find(sg => sg.id === id);
    if (!src) return;
    const snap = id === activeSongIdRef.current ? captureSong() : src.snapshot;
    if (!snap) return;
    const copy = JSON.parse(JSON.stringify(snap));
    const idMap = {};
    copy.tracks = copy.tracks.map(t => {
      const nid = crypto.randomUUID();
      idMap[t.id] = nid;
      // Audio is keyed by track id: share the decoded buffer and copy the stored file.
      if (t.type === 'audio') {
        const buf = audioBuffersRef.current[t.id];
        if (buf) audioBuffersRef.current[nid] = buf;
        getAudioFile(t.id).then(f => { if (f) putAudioFile(nid, f.arrayBuffer.slice(0), f.fileName, f.mimeType); }).catch(() => {});
      }
      return { ...t, id: nid };
    });
    copy.activeTrackId = idMap[copy.activeTrackId] || copy.tracks[0]?.id;
    const nid = makeSongId();
    const rec = { id: nid, name: `${src.name} (copy)`, groupId: src.groupId ?? null, snapshot: copy };
    const list = [...songsRef.current];
    list.splice(list.findIndex(sg => sg.id === id) + 1, 0, rec);
    songsRef.current = list;   // switchSong reads the ref, so update it before switching
    setSongs(list);
    switchSongRef.current?.(nid);
  }, [captureSong]);

  const handleRemoveSong = useCallback((id) => {
    if (songsRef.current.length <= 1) return;
    const target = songsRef.current.find(sg => sg.id === id);
    if (!target) return;
    const snap = id === activeSongIdRef.current ? captureSong() : target.snapshot;
    const tks = snap?.tracks || [];
    if (tks.some(t => (t.notes && t.notes.length) || t.type === 'audio')
      && !window.confirm(`Close "${target.name}"? Its tracks will be lost.`)) return;
    const remaining = songsRef.current.filter(sg => sg.id !== id);
    if (id === activeSongIdRef.current) {
      // Move to the neighbour tab, then drop this one.
      const idx = songsRef.current.findIndex(sg => sg.id === id);
      const next = remaining[Math.min(idx, remaining.length - 1)];
      stopPlayback();
      songHistoryRef.current[id] = undefined;
      const h = songHistoryRef.current[next.id];
      undoStackRef.current = h?.undo || [];
      redoStackRef.current = h?.redo || [];
      activeSongIdRef.current = next.id;
      setActiveSongId(next.id);
      if (next.snapshot) applySongSnapshot(next.snapshot);
    }
    delete songHistoryRef.current[id];
    tks.filter(t => t.type === 'audio').forEach(t => { delete audioBuffersRef.current[t.id]; deleteAudioFile(t.id).catch(() => {}); });
    songsRef.current = remaining;
    setSongs(remaining);
  }, [captureSong, stopPlayback, applySongSnapshot]);

  const handleRenameSong = useCallback((id, name) => {
    setSongs(prev => prev.map(sg => sg.id === id ? { ...sg, name } : sg));
  }, []);

  const handleAddGroup = useCallback(() => {
    const id = makeGroupId();
    setSongGroups(prev => [...prev, { id, name: `Group ${prev.length + 1}`, colour: GROUP_COLOURS[prev.length % GROUP_COLOURS.length], collapsed: false }]);
    return id;
  }, []);

  const handleToggleGroupCollapsed = useCallback((gid) => {
    const group = songGroups.find(g => g.id === gid);
    if (!group) return;
    if (!group.collapsed) {
      // Collapsing hides its tabs: move off the active tab if it is inside.
      const act = songsRef.current.find(sg => sg.id === activeSongIdRef.current);
      if (act?.groupId === gid) {
        const outside = songsRef.current.find(sg => sg.groupId !== gid);
        if (!outside) return;
        switchSong(outside.id);
      }
    }
    setSongGroups(prev => prev.map(g => g.id === gid ? { ...g, collapsed: !g.collapsed } : g));
  }, [songGroups, switchSong]);

  const handleRemoveGroup = useCallback((gid) => {
    setSongGroups(prev => prev.filter(g => g.id !== gid));
    setSongs(prev => prev.map(sg => sg.groupId === gid ? { ...sg, groupId: null } : sg));
  }, []);

  const handleRenameGroup = useCallback((gid, name) => {
    setSongGroups(prev => prev.map(g => g.id === gid ? { ...g, name } : g));
  }, []);

  const handleSetGroupColour = useCallback((gid, colour) => {
    setSongGroups(prev => prev.map(g => g.id === gid ? { ...g, colour } : g));
  }, []);

  const handleMoveSong = useCallback((id, beforeId, groupId) => setSongs(prev => moveSongList(prev, id, beforeId, groupId)), []);
  const handleMoveGroup = useCallback((gid, beforeId) => setSongs(prev => moveGroupList(prev, gid, beforeId)), []);
  const handleAssignSongToGroup = useCallback((id, gid) => setSongs(prev => assignSongList(prev, id, gid)), []);
  const switchSongRef = useRef(null);
  switchSongRef.current = switchSong;

  const handleReorderTracks = useCallback((fromIndex, toIndex) => {
    setTracksTracked(prev => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return normalizeGroups(next);
    });
  }, [setTracksTracked]);

  // ---- Track selection and track groups ----
  // Plain click = just this track; Ctrl/Cmd = add or remove; Shift = everything from the active track.
  const handleSelectTrack = useCallback((trackId, mode = 'single') => {
    if (mode === 'toggle') {
      setSelectedTrackIds(prev => {
        const next = new Set(prev.size ? prev : [activeTrackIdRef.current]);
        if (next.has(trackId)) next.delete(trackId); else next.add(trackId);
        return next;
      });
    } else if (mode === 'range') {
      const list = tracksRef.current;
      const a = list.findIndex(t => t.id === activeTrackIdRef.current);
      const b = list.findIndex(t => t.id === trackId);
      if (a < 0 || b < 0) return;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelectedTrackIds(new Set(list.slice(lo, hi + 1).map(t => t.id)));
    } else {
      switchTrack(trackId);
      setSelectedTrackIds(new Set([trackId]));
    }
  }, [switchTrack]);

  const applyGroupResult = useCallback((r) => {
    saveSnapshot();
    setTracksTracked(r.tracks);
    setTrackGroups(r.groups);
  }, [saveSnapshot, setTracksTracked, setTrackGroups]);

  const handleGroupTracks = useCallback((intoGroupId = null) => {
    const ids = [...selectedTrackIds];
    if (ids.length < 2 && !intoGroupId) { showToast('Select two or more tracks first (Ctrl/Cmd or Shift + click), then group them.'); return; }
    applyGroupResult(groupTracksFn(tracksRef.current, trackGroupsRef.current, ids, intoGroupId));
  }, [selectedTrackIds, applyGroupResult, showToast]);

  const handleUngroupTracks = useCallback(() => {
    const ids = selectedTrackIds.size ? [...selectedTrackIds] : [activeTrackIdRef.current];
    if (!tracksRef.current.some(t => ids.includes(t.id) && t.groupId)) return;
    applyGroupResult(ungroupTracksFn(tracksRef.current, trackGroupsRef.current, ids));
  }, [selectedTrackIds, applyGroupResult]);

  const handleRemoveTrackGroup = useCallback((gid) => {
    const ids = tracksRef.current.filter(t => t.groupId === gid).map(t => t.id);
    applyGroupResult(ungroupTracksFn(tracksRef.current, trackGroupsRef.current, ids, true));
  }, [applyGroupResult]);

  const handleToggleTrackGroup = useCallback((gid) => {
    setTrackGroups(prev => prev.map(g => (g.id === gid ? { ...g, collapsed: !g.collapsed } : g)));
  }, [setTrackGroups]);
  const handleRenameTrackGroup = useCallback((gid, name) => {
    setTrackGroups(prev => prev.map(g => (g.id === gid ? { ...g, name } : g)));
  }, [setTrackGroups]);
  const handleSetTrackGroupColour = useCallback((gid, colour) => {
    setTrackGroups(prev => prev.map(g => (g.id === gid ? { ...g, colour } : g)));
  }, [setTrackGroups]);
  // Group mute / solo act on every member (like pressing M / S on each).
  const handleTrackGroupFlag = useCallback((gid, flag) => {
    setTracksTracked(prev => {
      const members = prev.filter(t => t.groupId === gid);
      const all = members.length > 0 && members.every(t => t[flag]);
      return prev.map(t => (t.groupId === gid ? { ...t, [flag]: !all } : t));
    });
  }, [setTracksTracked]);
  // Hotkeys: act on the group the active track belongs to.
  const handleGroupHotkey = useCallback((flag) => {
    const active = tracksRef.current.find(t => t.id === activeTrackIdRef.current);
    if (!active?.groupId) { showToast('The active track is not in a group.'); return; }
    const gid = active.groupId;
    if (flag === 'muted') { handleTrackGroupFlag(gid, 'muted'); return; }
    // Solo: like the solo-track key, solo only this group (again = back to normal)
    setTracksTracked(prev => {
      const onlyThisGroup = prev.every(t => (t.groupId === gid ? t.solo : !t.solo));
      return prev.map(t => ({ ...t, solo: onlyThisGroup ? false : t.groupId === gid }));
    });
  }, [handleTrackGroupFlag, setTracksTracked, showToast]);
  const handleGroupHotkeyRef = useRef(null);
  handleGroupHotkeyRef.current = handleGroupHotkey;
  const handleGroupTracksRef = useRef(null);
  handleGroupTracksRef.current = handleGroupTracks;
  const handleUngroupTracksRef = useRef(null);
  handleUngroupTracksRef.current = handleUngroupTracks;

  // Groups with no tracks left (deleted, replaced by an import) disappear.
  useEffect(() => {
    const alive = new Set(tracks.map(t => t.groupId).filter(Boolean));
    if (trackGroups.some(g => !alive.has(g.id))) setTrackGroups(prev => prev.filter(g => alive.has(g.id)));
  }, [tracks, trackGroups, setTrackGroups]);

  const handleDeleteTrack = useCallback((trackId) => {
    setTracksTracked(prev => {
      const filtered = prev.filter(t => t.id !== trackId);
      // If deleting the last track, create a fresh empty one
      const result = filtered.length > 0 ? filtered : [createDefaultTrack()];
      if (activeTrackIdRef.current === trackId) {
        const newActive = result[0].id;
        activeTrackIdRef.current = newActive;
        setActiveTrackId(newActive);
        setSelectedNotes(new Set());
        setInstrument(result[0].instrument);
        setInstrumentState(result[0].instrument);
      }
      return result;
    });
  }, [setTracksTracked]);

  const handleToggleMute = useCallback((trackId) => {
    setTracksTracked(prev => prev.map(t =>
      t.id === trackId ? { ...t, muted: !t.muted } : t
    ));
  }, [setTracksTracked]);

  const handleToggleSolo = useCallback((trackId) => {
    setTracksTracked(prev => prev.map(t =>
      t.id === trackId ? { ...t, solo: !t.solo } : t
    ));
  }, [setTracksTracked]);

  const handleToggleSoloActiveTrack = useCallback(() => {
    setTracksTracked(prev => {
      const target = prev.find(t => t.id === activeTrackIdRef.current);
      if (!target) return prev;
      // Unsolo when this track is already the only soloed track.
      if (target.solo && prev.every(t => !t.solo || t.id === target.id)) {
        return prev.map(t => (t.solo ? { ...t, solo: false } : t));
      }
      // Otherwise solo exclusively this track.
      return prev.map(t => (t.id === target.id ? { ...t, solo: true } : (t.solo ? { ...t, solo: false } : t)));
    });
  }, [setTracksTracked]);

  handleToggleSoloRef.current = handleToggleSoloActiveTrack;
  handleToggleMuteRef.current = handleToggleMute;

  const handleSetTrackVolume = useCallback((trackId, volume) => {
    setTracksTracked(prev => prev.map(t =>
      t.id === trackId ? { ...t, volume } : t
    ));
  }, [setTracksTracked]);

  const handleRenameTrack = useCallback((trackId, name) => {
    setTracksTracked(prev => prev.map(t =>
      t.id === trackId ? { ...t, name } : t
    ));
  }, [setTracksTracked]);

  // Audio always gets its own dedicated track: loading onto a notes track must never
  // turn that track into audio (which would hide its notes).
  const handleLoadAudio = useCallback(async (sourceTrackId, file) => {
    try {
      const src = tracksRef.current.find(t => t.id === sourceTrackId);
      // Relink: an audio track from a saved session whose file isn't here keeps its clips and sync points.
      const relink = !!(src && src.type === 'audio' && src.audioFileName && !audioBuffersRef.current[src.id]);
      const reuse = (src && src.type === 'audio' && !src.audioFileName) || relink;
      const trackId = reuse ? sourceTrackId : crypto.randomUUID();
      const arrayBuffer = await file.arrayBuffer();
      // Persist raw bytes so audio survives reload
      try {
        await putAudioFile(trackId, arrayBuffer.slice(0), file.name, file.type);
      } catch (e) {
        console.warn('Could not persist audio file:', e);
      }
      const ctx = getAudioContext();
      ensureStretchReady(ctx).catch(() => {});
      const buffer = await ctx.decodeAudioData(arrayBuffer);
      const peaks = computeWaveformPeaks(buffer, 2000);
      audioBuffersRef.current[trackId] = buffer;
      ensureAudioChain({ id: trackId, muted: false, volume: 1, originalBpm: relink ? (src.originalBpm || bpmRef.current) : bpmRef.current }, buffer);
      if (relink) markAudioMissing(trackId, false);
      const audioProps = relink ? {
        audioFileName: file.name,
        audioDuration: buffer.duration,
        waveformPeaks: Array.from(peaks),
      } : {
        type: 'audio',
        audioFileName: file.name,
        audioDuration: buffer.duration,
        audioOffset: 0,
        clips: [newClip(0, 0, buffer.duration)],
        originalBpm: bpmRef.current,
        notes: [],
        waveformPeaks: Array.from(peaks),
      };
      fitZoomPendingRef.current = true;
      if (reuse) {
        setTracksTracked(prev => prev.map(t => t.id === trackId ? { ...t, ...audioProps } : t));
      } else {
        const name = file.name.replace(/\.[^.]+$/, '') || 'Audio';
        const newTrack = { ...createDefaultTrack(name), id: trackId, ...audioProps };
        setTracksTracked(prev => {
          const i = prev.findIndex(t => t.id === sourceTrackId);
          const next = prev.slice();
          next.splice(i >= 0 ? i + 1 : next.length, 0, newTrack);
          return next;
        });
        switchTrack(trackId);
      }
    } catch (err) {
      alert('Failed to load audio file: ' + err.message);
    }
  }, [setTracksTracked, switchTrack, ensureAudioChain, markAudioMissing]);

  const handleRemoveAudio = useCallback((trackId) => {
    dropAudioChain(trackId);
    delete audioBuffersRef.current[trackId];
    deleteAudioFile(trackId).catch(() => {});
    setTracksTracked(prev => prev.map(t =>
      t.id === trackId ? {
        ...t,
        type: 'notes',
        audioFileName: null,
        audioDuration: 0,
        audioOffset: 0,
        clips: [],
        waveformPeaks: null,
      } : t
    ));
  }, [setTracksTracked, dropAudioChain]);

  const handleImportMidi = useCallback(async (file) => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const midi = parseMidi(arrayBuffer);
      const { tracks: midiTracks, detectedBpm } = midiToGuitarNotes(midi, timeSignature[1]);

      if (midiTracks.length === 0) {
        alert('No playable guitar notes found in this MIDI file.\nNotes must be in the range E2–E6 (MIDI 40–88).');
        return;
      }

      // Set detected BPM
      if (detectedBpm > 0) setBpm(detectedBpm);

      // Create tracks for each MIDI track
      const newTracks = midiTracks.map(mt =>
        ({ ...createDefaultTrack(mt.name), notes: mt.notes })
      );

      // Grow the timeline so every imported note fits
      const endBeat = Math.max(0, ...newTracks.flatMap(t => t.notes.map(n => n.beat + (n.duration || 1))));
      setBarSubdivisions(prev => {
        let next = prev;
        while (totalColumns(next) < endBeat && next.length < 999) {
          next = [...next, timeSignature[0] || 4];
        }
        return next;
      });

      setTracksTracked(prev => [...prev, ...newTracks]);
      switchTrack(newTracks[0].id);
      setSelectedNotes(new Set());
    } catch (err) {
      alert('Failed to import MIDI file: ' + err.message);
    }
  }, [setTracksTracked, switchTrack, timeSignature]);

  const handleToggleVisible = useCallback((trackId) => {
    setTracksTracked(prev => prev.map(t =>
      t.id === trackId ? { ...t, visible: t.visible === false ? true : false } : t
    ));
  }, [setTracksTracked]);

  const handleSetBgOpacity = useCallback((trackId, opacity) => {
    setTracksTracked(prev => prev.map(t =>
      t.id === trackId ? { ...t, bgOpacity: opacity } : t
    ));
  }, [setTracksTracked]);

  const handleSetTrackScheme = useCallback((trackId, schemeName) => {
    setTracksTracked(prev => prev.map(t =>
      t.id === trackId ? { ...t, schemeName } : t
    ));
  }, [setTracksTracked]);

  // Marker management
  const handleAddMarker = useCallback((beat) => {
    setMarkers(prev => {
      const newMarker = {
        id: crypto.randomUUID(),
        name: 'Marker',
        beat,
        color: '#b24fcc',
      };
      return [...prev, newMarker].sort((a, b) => a.beat - b.beat);
    });
  }, []);

  const handleUpdateMarker = useCallback((id, updates) => {
    setMarkers(prev => prev.map(m => m.id === id ? { ...m, ...updates } : m).sort((a, b) => a.beat - b.beat));
  }, []);

  const handleDeleteMarker = useCallback((id) => {
    setMarkers(prev => prev.filter(m => m.id !== id));
  }, []);

  return (
    <div className="app">
      <Dock
      menu={(
      <div className="toolbar">
        <input
          className="project-name"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          spellCheck={false}
        />
        <button
          className={`play-btn ${playing ? 'playing' : ''}`}
          onClick={handlePlay}
        >
          {playing ? '⏹ Stop' : '▶ Play'}
        </button>
        <button
          className={`tool-btn ${loop ? 'active' : ''}`}
          onClick={toggleLoop}
          title="Loop region: when on, drag the time strip to set, resize or move the loop"
          aria-label="Loop"
        >
          <CycleIcon size={18} />
        </button>
        <button
          className={`tool-btn ${octaveFit ? 'active' : ''}`}
          onClick={() => setOctaveFit(v => { const n = !v; try { localStorage.setItem('guitar-roll-octave-fit', n ? '1' : '0'); } catch {} return n; })}
          title="Octave fit: when you choose a position (P) with notes selected, shift them up or down by whole octaves so they fit it. Changes pitch."
        >
          Octave fit
        </button>
        <button
          className={`tool-btn ${metronome ? 'active' : ''}`}
          onClick={() => setMetronome(m => !m)}
          title="Metronome"
          aria-label="Metronome"
        >
          <Metronome size={18} />
        </button>
        <span className="toolbar-label">Inst:</span>
        <select
          className="duration-select"
          value={activeTrack?.instrument || instrument}
          title="Instrument"
          onChange={(e) => {
            const inst = e.target.value;
            if (isUltrabox(inst)) loadUltrabox().then(() => playNote(1, 3, 0.6, 0.8, inst)).catch(() => {});
            setInstrument(inst);
            setInstrumentState(inst);
            setTracksTracked(prev => prev.map(t =>
              t.id === activeTrackId ? { ...t, instrument: inst } : t
            ));
          }}
        >
          {Object.entries(instrumentList).filter(([, inst]) => !inst.group).map(([id, inst]) => (
            <option key={id} value={id}>{inst.label}</option>
          ))}
          {[...new Set(Object.values(instrumentList).map(i => i.group).filter(Boolean))].map(group => (
            <optgroup key={group} label={group}>
              {Object.entries(instrumentList).filter(([, inst]) => inst.group === group).map(([id, inst]) => (
                <option key={id} value={id}>{inst.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          className="tool-btn"
          onClick={() => {
            if (!confirm('Start a new session? Unsaved changes will be lost.')) return;
            const track = createDefaultTrack();
            applyState({
              tracks: [track],
              bpm: 120, swing: 50, loop: false, loopStart: 0, loopEnd: totalColumns(defaultBarSubdivisions()),
              stringColors: ['#ffffff','#ffffff','#ffffff','#ffffff','#ffffff','#ffffff'],
              synesthesia: [], sessionScheme: null, sessionSchemes: {},
              subdivisions: 4, markers: [], metronome: false,
              barSubdivisions: defaultBarSubdivisions(),
              timeSignature: [4, 4], projectName: 'Untitled',
            });
            setSelectedBeat(0);
            setSelectedNotes(new Set());
            setNoteDuration(0.25);
          }}
          title="New Session"
        >
          New
        </button>
        <button
          className="tool-btn"
          onClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.mid,.midi';
            input.onchange = () => {
              if (input.files[0]) handleImportMidi(input.files[0]);
            };
            input.click();
          }}
          title="Import MIDI file"
        >
          Import MIDI
        </button>
        <button
          className="tool-btn"
          onClick={() => { setSettingsTab(null); setShowSettings(true); }}
          title="Settings"
        >
          Settings
        </button>
        <span className="toolbar-separator" />
        <span className="toolbar-label">Time:</span>
        <select
          className="duration-select"
          value={`${timeSignature[0]}/${timeSignature[1]}`}
          onChange={(e) => {
            const [num, den] = e.target.value.split('/').map(Number);
            // Push undo snapshot before changing time signature
            undoStackRef.current.push(takeSnapshot());
            if (undoStackRef.current.length > 200) undoStackRef.current.shift();
            redoStackRef.current = [];
            setTimeSignature([num, den]);
            setBarSubdivisions(prev => {
              const newSubs = Array(prev.length).fill(num);
              // Remap notes for all bars that changed
              let remapped = notesRef.current;
              const oldStarts = barStartBeats(prev);
              for (let i = 0; i < prev.length; i++) {
                if (prev[i] !== num) {
                  remapped = remapNotes(remapped, prev, newSubs, i);
                  // After remapping bar i, update prev for subsequent bars
                  prev = [...prev];
                  prev[i] = num;
                }
              }
              setActiveNotes(remapped);
              return newSubs;
            });
          }}
        >
          <option value="2/4">2/4</option>
          <option value="3/4">3/4</option>
          <option value="4/4">4/4</option>
          <option value="5/4">5/4</option>
          <option value="6/4">6/4</option>
          <option value="7/4">7/4</option>
          <option value="3/8">3/8</option>
          <option value="6/8">6/8</option>
          <option value="7/8">7/8</option>
          <option value="9/8">9/8</option>
          <option value="12/8">12/8</option>
        </select>
        <span className="toolbar-label">BPM:</span>
        <NumberInput
          className="bpm-input"
          value={bpm}
          min={30}
          max={300}
          onChange={setBpm}
        />
        <span className="toolbar-label">Swing %:</span>
        <NumberInput
          className="bpm-input"
          value={Math.round(ratioToAmount(swing / 100) * 100)}
          min={-100}
          max={100}
          step={1}
          onChange={(amt) => setSwing(amountToRatio(amt / 100) * 100)}
        />
        <button className="tool-btn" onClick={() => {
          if (notes.length > 0) setConfirmClear(true);
          else handleClear();
        }}>
          Clear
        </button>
        <span className="toolbar-separator" />
        <div className="rhythm-cluster">
          <button
            type="button"
            className="rhythm-unit-btn"
            onClick={() => setRhythmUnit(u => u === 'beat' ? 'bar' : 'beat')}
            title="Toggle whether the division refers to a beat or a bar"
          >
            {rhythmUnit === 'bar' ? 'BAR' : 'BEAT'}
          </button>
          <div className="subdiv-picker" ref={subdivDialRef}>
            <button
              className={`subdiv-btn ${showSubdivDial ? 'open' : ''} ${rhythmLiveKind === 'div' ? 'live' : ''}`}
              onClick={() => setShowSubdivDial(o => !o)}
            >
              ÷{rhythmLiveKind === 'div' && rhythmLiveValue != null ? rhythmLiveValue : subdivisions}
            </button>
            {showSubdivDial && (
              <div className="subdiv-popup">
                <div className="subdiv-dial-large">
                  <svg width={120} height={120} viewBox="0 0 120 120">
                    <circle cx={60} cy={60} r={48} fill="none" stroke="#26262a" strokeWidth={2} />
                    {Array.from({ length: 16 }, (_, i) => i + 1).map(val => {
                      const angle = ((val - 1) / 16) * 2 * Math.PI - Math.PI / 2;
                      const x = 60 + 48 * Math.cos(angle);
                      const y = 60 + 48 * Math.sin(angle);
                      const isActive = val === subdivisions;
                      return (
                        <g key={val} style={{ cursor: 'pointer' }} onClick={() => { handleSetSubdivisions(val); }}>
                          <circle cx={x} cy={y} r={isActive ? 10 : 7}
                            fill={isActive ? '#e6a15b' : '#1c1c1f'}
                            stroke={isActive ? '#e6a15b' : '#2c2c31'} strokeWidth={1}
                          />
                          <text x={x} y={y} textAnchor="middle" dominantBaseline="central"
                            fontSize={10} fontWeight="bold"
                            fill={isActive ? '#0b0b0c' : '#a3a2a0'}
                            style={{ pointerEvents: 'none' }}
                          >{val}</text>
                        </g>
                      );
                    })}
                  </svg>
                  <NumberInput
                    className="subdiv-center-input"
                    value={subdivisions}
                    min={1}
                    max={32}
                    onChange={handleSetSubdivisions}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
              </div>
            )}
          </div>
          <div className="subdiv-picker" ref={multDialRef}>
            <button
              className={`subdiv-btn ${showMultDial ? 'open' : ''} ${rhythmLiveKind === 'mult' || xHeld ? 'live' : ''}`}
              onClick={() => setShowMultDial(o => !o)}
            >
              ×{rhythmLiveKind === 'mult' && rhythmLiveValue != null ? rhythmLiveValue : rhythmMult}
            </button>
            {showMultDial && (
              <div className="subdiv-popup">
                <div className="subdiv-dial-large">
                  <svg width={120} height={120} viewBox="0 0 120 120">
                    <circle cx={60} cy={60} r={48} fill="none" stroke="#26262a" strokeWidth={2} />
                    {Array.from({ length: 8 }, (_, i) => i + 1).map(val => {
                      const angle = ((val - 1) / 8) * 2 * Math.PI - Math.PI / 2;
                      const x = 60 + 48 * Math.cos(angle);
                      const y = 60 + 48 * Math.sin(angle);
                      const isActive = val === rhythmMult;
                      return (
                          <g key={val} style={{ cursor: 'pointer' }} onClick={() => { handleSetRhythmMult(val); }}>
                           <circle cx={x} cy={y} r={isActive ? 10 : 7}
                             fill={isActive ? '#e6a15b' : '#1c1c1f'}
                             stroke={isActive ? '#e6a15b' : '#2c2c31'} strokeWidth={1}
                           />
                           <text x={x} y={y} textAnchor="middle" dominantBaseline="central"
                             fontSize={10} fontWeight="bold"
                             fill={isActive ? '#0b0b0c' : '#a3a2a0'}
                             style={{ pointerEvents: 'none' }}
                           >{val}</text>
                         </g>
                      );
                    })}
                  </svg>
                  <NumberInput
                    className="subdiv-center-input"
                    value={rhythmMult}
                    min={1}
                    max={32}
                    onChange={handleSetRhythmMult}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      )}
      tracks={(
      <>
      <SongTabs
        songs={songs}
        groups={songGroups}
        activeSongId={activeSongId}
        onSelect={switchSong}
        onAdd={handleAddSong}
        onRemove={handleRemoveSong}
        onRename={handleRenameSong}
        onDuplicate={handleDuplicateSong}
        onAddGroup={handleAddGroup}
        onToggleGroupCollapsed={handleToggleGroupCollapsed}
        onRemoveGroup={handleRemoveGroup}
        onRenameGroup={handleRenameGroup}
        onSetGroupColour={handleSetGroupColour}
        onMoveSong={handleMoveSong}
        onMoveGroup={handleMoveGroup}
        onAssignSongToGroup={handleAssignSongToGroup}
      />
      <TrackStrip
        tracks={tracks}
        activeTrackId={activeTrackId}
        onSwitchTrack={switchTrack}
        onToggleMute={handleToggleMute}
        onToggleSolo={handleToggleSolo}
        onSetVolume={handleSetTrackVolume}
        onAddTrack={handleAddTrack}
        onDeleteTrack={handleDeleteTrack}
        onDuplicateTrack={handleDuplicateTrack}
        onReorderTracks={handleReorderTracks}
        trackGroups={trackGroups}
        selectedTrackIds={selectedTrackIds}
        onSelectTrack={handleSelectTrack}
        onGroupTracks={handleGroupTracks}
        onUngroupTracks={handleUngroupTracks}
        onRemoveTrackGroup={handleRemoveTrackGroup}
        onToggleTrackGroup={handleToggleTrackGroup}
        onRenameTrackGroup={handleRenameTrackGroup}
        onSetTrackGroupColour={handleSetTrackGroupColour}
        onTrackGroupFlag={handleTrackGroupFlag}
        onRenameTrack={handleRenameTrack}
        onLoadAudio={handleLoadAudio}
        missingAudioIds={missingAudioIds}
        onRemoveAudio={handleRemoveAudio}
        onAddSyncPoint={addSyncPointAtPlayhead}
        onAutoSync={autoSyncPoints}
        onClearSyncPoints={clearSyncPoints}
        onSetAudioOptions={(trackId, patch) => setTracksTracked(prev => prev.map(t => t.id === trackId ? { ...t, ...patch } : t))}
        onToggleVisible={handleToggleVisible}
        onSetBgOpacity={handleSetBgOpacity}
        onSetTrackScheme={handleSetTrackScheme}
        sessionSchemes={sessionSchemes}
      />
      <div className="status-bar">
        <span style={{ color: (freeMode || fingeringMode || machineGunMode) ? '#e67e22' : '#888' }}>
          {freeMode ? 'FREE ' : ''}{fingeringMode ? 'FINGERING ' : ''}{machineGunMode ? 'DRAW ' : ''}{notes.length} notes{selectedNotes.size > 0 ? ` (${selectedNotes.size} selected)` : ''} | Beat: {selectedBeat + 1} | Bar: {Math.floor(selectedBeat / SUBDIVISIONS) + 1}
        </span>
        {positionMode ? <span style={{ color: 'var(--accent-hi)', marginLeft: 8 }}>Select Position {positionModeValue != null ? `(${positionModeValue})` : ''}</span> : null}
        {!positionMode && (() => {
          const romanNumerals = ['O','I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII','XIII','XIV','XV','XVI','XVII','XVIII','XIX','XX','XXI','XXII','XXIII','XXIV'];
          return <span style={{ color: 'var(--soft)', marginLeft: 8 }}>Pos: {romanNumerals[Math.min(position, romanNumerals.length - 1)]}</span>;
        })()}
        <span className="status-separator" />
        <span className="toolbar-label">Vel:</span>
        <input
          type="range"
          className="velocity-slider"
          min={0}
          max={100}
          value={Math.round(defaultVelocity * 100)}
          onChange={(e) => setDefaultVelocity(Number(e.target.value) / 100)}
        />
        <span style={{ fontSize: '11px', color: 'var(--mute)', minWidth: 28 }}>{Math.round(defaultVelocity * 100)}%</span>
      </div>
      {/* Mobile action bar */}
      <div className="mobile-actions">
        <button onClick={undo} title="Undo">↩</button>
        <button onClick={redo} title="Redo">↪</button>
        <button onClick={() => {
          if (selectedNotes.size > 0) {
            setNotes(prev => prev.filter((_, i) => !selectedNotes.has(i)));
            setSelectedNotes(new Set());
          }
        }} title="Delete">🗑</button>
        <span className="mobile-actions-sep" />
        <button onClick={() => setSelectedBeat(b => Math.max(0, b - 1))} title="Prev beat">◀</button>
        <button onClick={() => setSelectedBeat(b => Math.min(totalBeats - 1, b + 1))} title="Next beat">▶</button>
        <span className="mobile-actions-sep" />
        <button onClick={copySelectedNotes} title="Copy">Copy</button>
        <button onClick={async () => {
          let text = '';
          try { text = (await navigator.clipboard?.readText()) || ''; } catch { /* fall back to in-app clipboard */ }
          pasteNotes(text);
        }} title="Paste">Paste</button>
        <span className="mobile-actions-sep" />
        <button className={freeMode ? 'active' : ''} onClick={() => setFreeMode(m => !m)}>Free</button>
        <button className={fingeringMode ? 'active' : ''} onClick={() => { fingeringModeRef.current = !fingeringModeRef.current; setFingeringMode(fingeringModeRef.current); }}>Finger</button>
      </div>
      </>
      )}
      fretboard={(
        <Fretboard
          playing={playing}
            positionMode={positionMode}
          onNoteClick={handleFretClick}
          onAdjacentClick={handleAdjacentClick}
          onMoveNote={handleMoveNote}
          onDurationChange={handleNoteDurationChange}
          onBeatChange={handleBeatChange}
          saveSnapshot={saveSnapshot}
          commitDrag={commitDrag}
          freeMode={freeMode}
          totalBeats={totalBeats}
          activeNotes={playing ? [] : notes.filter(n => selectedBeat >= n.beat && selectedBeat < n.beat + (n.duration || 1))}
          backgroundActiveNotes={(() => {
            const beat = playing && currentBeat !== null ? currentBeat : selectedBeat;
            if (playing && currentBeat === null) return [];
            return tracks
              .filter(t => t.id !== activeTrackId && t.visible !== false)
              .flatMap(t => t.notes
                .filter(n => beat >= n.beat && beat < n.beat + (n.duration || 1))
                .map(n => ({ ...n, _trackOpacity: t.bgOpacity ?? 0.2 }))
              );
          })()}
          playingNotes={playing && currentBeat !== null
            ? notes.filter(n => currentBeat >= n.beat && currentBeat < n.beat + (n.duration || 1))
            : []}
          stringColors={stringColors}
          getNoteColor={getNoteColor}
          hoveredNote={hoveredNote}
          setHoveredNote={setHoveredNote}
          fingeringMode={fingeringMode}
          onExitFingeringMode={() => { fingeringModeRef.current = false; setFingeringMode(false); }}
          onDeleteNote={handleDeleteNote}
          onDeleteNotes={handleDeleteNotes}
          notes={notes}
          selectedBeat={selectedBeat}
          selectedNotes={selectedNotes}
          setSelectedNotes={setSelectedNotes}
          verticalScroll={verticalScroll}
          setVerticalScroll={setVerticalScroll}
          hotkeys={hotkeys}
          hoverPreview={hoverPreview.fretboard}
          hoverVolume={hoverPreview.volume}
          snapUnit={snapUnit}
          fretboardZoom={fretboardZoom}
          setFretboardZoom={setFretboardZoom}
          voicingPreview={voicingPreview}
          autoScroll={autoScroll}
          hoverPill={hoverPill}
          timelineBodyRef={timelineBodyRef}
          timelineZoom={timelineZoom}
          barSubdivisions={barSubdivisions}
          position={position}
          setPosition={setPosition}
          playheadPreview={playheadPreview}
          setPlayheadPreview={setPlayheadPreview}
          setSelectedBeat={setSelectedBeat}
          fretboardAutoForward={fretboardAutoForward}
          swing={swing}
          playheadBeatRef={playheadBeatRef}
          tempoMap={tempoMap}
          noteFadeFactor={NOTE_FADE_PRESETS[noteFade]}
          showFretNumbers={showFretNumbers}
          openDots={openDots}
          openScroll={openScroll}
          selectedExtraNotes={showSelectedOnFretboard && selectedNotes.size > 0 && !playing
            ? [...selectedNotes].map(idx => notes[idx]).filter(n => n && !(selectedBeat >= n.beat && selectedBeat < n.beat + (n.duration || 1)))
            : []}
          swungDisplay={swungDisplay}
          activeInstanceScheme={activeTrack?.activeInstanceScheme || null}
        />
      )}
      timeline={(
      <div className="dock-timeline-row">
        <Timeline
          notes={notes}
          backgroundNotes={tracks.filter(t => t.id !== activeTrackId && t.visible !== false).flatMap(t =>
            t.notes.map(n => ({ ...n, _trackColor: '#888', _trackOpacity: t.bgOpacity ?? 0.2 }))
          )}
          setNotes={setNotes}
          saveSnapshot={saveSnapshot}
          setNotesDrag={setNotesDrag}
          commitDrag={commitDrag}
          freeMode={freeMode}
          timelineZoom={timelineZoom}
          timelineVerticalZoom={timelineVerticalZoom}
          setTimelineVerticalZoom={(updater) => {
            setTimelineVerticalZoom(prev => {
              const next = typeof updater === 'function' ? updater(prev) : updater;
              try { localStorage.setItem('guitar-roll-timeline-vertical-zoom', String(next)); } catch {}
              return next;
            });
          }}
          showVerticalZoomButtons={showTimelineVerticalZoomButtons}
          barSubdivisions={barSubdivisions}
          setBarSubdivisions={setBarSubdivisions}
          onGrowBars={(n) => setBarSubdivisions(prev => prev.length >= 999 ? prev : [...prev, ...Array(n).fill(timeSignature[0])])}
          setTimelineZoom={setTimelineZoom}
          position={position}
          currentBeat={currentBeat}
          playheadBeatRef={playheadBeatRef}
          selectedBeat={selectedBeat}
          setSelectedBeat={setSelectedBeat}
          playing={playing}
          playheadPreview={playheadPreview}
          setPlayheadPreview={setPlayheadPreview}
          onDeleteNote={handleDeleteNote}
          loopStart={loopStart}
          loopEnd={loopEnd}
          setLoopStart={setLoopStart}
          setLoopEnd={setLoopEnd}
          loop={loop}
          setLoop={setLoop}
          selectedNotes={selectedNotes}
          setSelectedNotes={setSelectedNotes}
          stringColors={stringColors}
          getNoteColor={getNoteColor}
          hoveredNote={hoveredNote}
          setHoveredNote={setHoveredNote}
          chordRoot={chordRoot}
          setChordRoot={setChordRoot}
          verticalScroll={verticalScroll}
          setVerticalScroll={setVerticalScroll}
          machineGunMode={machineGunMode}
          defaultVelocity={defaultVelocity}
          noteDuration={effectiveNoteLength}
          setNoteDuration={setNoteDuration}
          onResizeDuration={setNoteDuration}
          snapUnit={snapUnit}
          subdivisions={subdivisions}
          rhythmMult={rhythmMult}
          rhythmUnit={rhythmUnit}
          hotkeys={hotkeys}
          hoverPreviewPiano={hoverPreview.pianoRoll}
          hoverPreviewNotes={hoverPreview.timelineNotes}
          hoverVolume={hoverPreview.volume}
          tupletLines={tupletLines}
          chordPreview={chordPreview}
          onTimelineHover={(pos) => setHoveredNote(pos)}
          autoScroll={autoScroll}
          markers={markers}
          onAddMarker={handleAddMarker}
          onUpdateMarker={handleUpdateMarker}
          onDeleteMarker={handleDeleteMarker}
          selectedClips={selectedClips}
          setSelectedClips={setSelectedClips}
          onUpdateClips={updateClips}
          onUpdateSyncPoints={updateSyncPoints}
          tempoMap={tempoMap}
          onAddSyncPointAt={addSyncPointAtBeat}
          onAuditionNotes={auditionNotesAt}
          audioTracks={tracks.filter(t => t.type === 'audio' && t.waveformPeaks).map(t => ({
            trackId: t.id,
            name: t.name,
            clips: getClips(t),
            syncPoints: getSyncPoints(t),
            audioOffset: t.audioOffset || 0,
            audioDuration: t.audioDuration,
            originalBpm: t.originalBpm,
            waveformPeaks: t.waveformPeaks,
            audioBuffer: audioBuffersRef.current[t.id],
            isActive: t.id === activeTrackId,
            bgOpacity: t.bgOpacity ?? 0.2,
            volume: t.volume,
            muted: !!t.muted,
          }))}
          bpm={bpm}
          timeSignature={timeSignature}
          bodyRefExternal={timelineBodyRef}
          position={position}
          setPosition={setPosition}
          swing={swing}
          swungDisplay={swungDisplay}
          activeInstanceScheme={activeTrack?.activeInstanceScheme || null}
        />
        <div className={`chord-sidebar ${chordPaletteOpen ? 'open' : ''}`}>
          <button className="chord-sidebar-toggle" onClick={() => setChordPaletteOpen(o => !o)}>
            {chordPaletteOpen ? '>' : '<'}
          </button>
          {chordPaletteOpen && (
            <ChordPalette
              notes={notes}
              selectedNotes={selectedNotes}
              selectedBeat={selectedBeat}
              chordRoot={chordRoot}
              noteDuration={effectiveNoteLength}
              onStampChord={handleStampChord}
              onPreviewChange={setChordPreview}
            />
          )}
        </div>
      </div>
      )}
      />

      {/* Cheat Sheet Overlay */}
      {showCheatSheet && (
        <div className="cheatsheet-overlay" onClick={() => setShowCheatSheet(false)}>
          <div className="cheatsheet" onClick={(e) => e.stopPropagation()}>
            <h2 className="cheatsheet-title">Keyboard Shortcuts</h2>
            <div className="cheatsheet-grid">
              {Object.entries(hotkeys).filter(([, h]) => !h.wheel).map(([id, h]) => (
                <div key={id} className="cheatsheet-row">
                  <span className="cheatsheet-key">{formatHotkey(h)}</span>
                  <span className="cheatsheet-desc">{h.label}</span>
                </div>
              ))}
              <div className="cheatsheet-row">
                <span className="cheatsheet-key">Shift + Click</span>
                <span className="cheatsheet-desc">Multi-select notes</span>
              </div>
              <div className="cheatsheet-row">
                <span className="cheatsheet-key">Right Click</span>
                <span className="cheatsheet-desc">Delete note</span>
              </div>
              {REFERENCE_ACTIONS.map((a, i) => (
                <div key={`ref-${i}`} className="cheatsheet-row">
                  <span className="cheatsheet-key">{a.display}</span>
                  <span className="cheatsheet-desc">{a.label}</span>
                </div>
              ))}
              {Object.entries(hotkeys).filter(([, h]) => h.wheel).map(([id, h]) => (
                <div key={id} className="cheatsheet-row">
                  <span className="cheatsheet-key">{formatHotkey(h)}</span>
                  <span className="cheatsheet-desc">{h.label}</span>
                </div>
              ))}
            </div>
            <div style={{ textAlign: 'center', marginTop: 12, color: 'var(--mute)', fontSize: 11 }}>
              Press <b>?</b> or click outside to close
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}

      {/* Settings Modal */}
      {confirmClear && (
        <ConfirmDialog
          message={`Clear all ${notes.length} notes from this track?`}
          onConfirm={() => { handleClear(); setConfirmClear(false); }}
          onCancel={() => setConfirmClear(false)}
        />
      )}

      {showVoiceLeading && (
        <VoiceLeadingModal
          notes={notes}
          selectedNotes={selectedNotes}
          onPreview={setVoicingPreview}
          onApply={(replacements) => {
            setNotes(prev => prev.map((n, i) => {
              const rep = replacements.find(r => r.index === i);
              if (!rep) return n;
              return { ...n, stringIndex: rep.stringIndex, fret: rep.fret };
            }));
            setShowVoiceLeading(false);
            setVoicingPreview(null);
          }}
          onClose={() => { setShowVoiceLeading(false); setVoicingPreview(null); }}
        />
      )}

      {showSettings && (
        <SettingsModal
          appState={{
            tracks, bpm, loop, loopStart, loopEnd,
            stringColors, synesthesia, sessionScheme, sessionSchemes,
            projectName, subdivisions, metronome, barSubdivisions, timeSignature, markers,
            songs: songsWithLive(), songGroups, activeSongId, trackGroups,
          }}
          onApplyState={applyState}
          accent={accent}
          onRestoreAutosave={() => {
            const auto = loadAutosave();
            if (!auto) return false;
            const ss = loadSessionSchemeState();
            applyState({ ...auto, sessionScheme: ss.sessionScheme || null, sessionSchemes: ss.sessionSchemes || {} });
            return true;
          }}
          onAccentChange={handleAccentChange}
          onClose={() => { setShowSettings(false); setSettingsTab(null); setInstrumentList(getAllInstruments()); }}
          initialTab={settingsTab}
          synthInstrument={activeTrack?.instrument || instrument}
          onSynthInstrumentChange={(id) => {
            setInstrument(id);
            setInstrumentState(id);
            setTracksTracked(prev => prev.map(t =>
              t.id === activeTrackId ? { ...t, instrument: id } : t
            ));
            setInstrumentList(getAllInstruments());
          }}
          hoverPreview={hoverPreview}
          onHoverPreviewChange={(v) => { setHoverPreview(v); localStorage.setItem('guitar-roll-hover-preview', JSON.stringify(v)); }}
          tupletLines={tupletLines}
          onTupletLinesChange={(v) => { setTupletLines(v); localStorage.setItem('guitar-roll-tuplet-lines', JSON.stringify(v)); }}
          autoScroll={autoScroll}
          onAutoScrollChange={(v) => { setAutoScroll(v); localStorage.setItem('guitar-roll-auto-scroll', JSON.stringify(v)); }}
          hoverPill={hoverPill}
          onHoverPillChange={(v) => { setHoverPill(v); localStorage.setItem('guitar-roll-hover-pill', JSON.stringify(v)); }}
          autoSave={autoSave}
          onAutoSaveChange={(v) => { setAutoSave(v); localStorage.setItem('guitar-roll-auto-save', JSON.stringify(v)); }}
          fretboardAutoForward={fretboardAutoForward}
          onFretboardAutoForwardChange={(v) => { setFretboardAutoForward(v); localStorage.setItem('guitar-roll-fretboard-auto-forward', String(v)); }}
          fretboardAutoForwardExcludeAdjacent={fretboardAutoForwardExcludeAdjacent}
          showSelectedOnFretboard={showSelectedOnFretboard}
          noteFade={noteFade}
          openDots={openDots}
          onOpenDotsChange={(v) => { setOpenDots(v); try { localStorage.setItem('guitar-roll-open-dots', String(v)); } catch { /* ignore */ } }}
          openScroll={openScroll}
          onOpenScrollChange={(v) => { setOpenScroll(v); try { localStorage.setItem('guitar-roll-open-scroll', String(v)); } catch { /* ignore */ } }}
          showFretNumbers={showFretNumbers}
          onShowFretNumbersChange={(v) => { setShowFretNumbers(v); try { localStorage.setItem('guitar-roll-show-fret-numbers', String(v)); } catch { /* ignore */ } }}
          onNoteFadeChange={(v) => { setNoteFade(v); try { localStorage.setItem('guitar-roll-note-fade', v); } catch { /* ignore */ } }}
          onShowSelectedOnFretboardChange={(v) => { setShowSelectedOnFretboard(v); try { localStorage.setItem('guitar-roll-show-selected-fretboard', String(v)); } catch { /* ignore */ } }}
          onFretboardAutoForwardExcludeAdjacentChange={(v) => { setFretboardAutoForwardExcludeAdjacent(v); localStorage.setItem('guitar-roll-fretboard-auto-forward-exclude-adjacent', String(v)); }}
          showTimelineVerticalZoomButtons={showTimelineVerticalZoomButtons}
          onShowTimelineVerticalZoomButtonsChange={(v) => {
            setShowTimelineVerticalZoomButtons(v);
            try { localStorage.setItem('guitar-roll-timeline-vzoom-buttons', String(v)); } catch {}
          }}
          swungDisplay={swungDisplay}
          onSwungDisplayChange={(v) => { setSwungDisplay(v); try { localStorage.setItem('guitar-roll-swung-display', String(v)); } catch {} }}
          resetMultOnSubdiv={resetMultOnSubdiv}
          onResetMultOnSubdivChange={(v) => { setResetMultOnSubdiv(v); try { localStorage.setItem('guitar-roll-reset-mult-on-subdiv', String(v)); } catch {} }}
          rhythmAltersSelected={rhythmAltersSelected}
          onRhythmAltersSelectedChange={(v) => { setRhythmAltersSelected(v); try { localStorage.setItem('guitar-roll-rhythm-alters-selected', String(v)); } catch {} }}
          selectingSchemeClosesMenu={selectingSchemeClosesMenu}
          onSelectingSchemeClosesMenuChange={(v) => { setSelectingSchemeClosesMenu(v); try { localStorage.setItem('guitar-roll-selecting-scheme-closes-menu', String(v)); } catch {} }}
          onHotkeysChange={setHotkeys}
        />
      )}
      {showInstanceColorMenu && (
        <InstanceColorMenu
          position={instanceColorMenuPos}
          sessionSchemes={sessionSchemes}
          selectedNotes={selectedNotes}
          highlightScheme={
            (() => {
              if (selectedNotes.size > 0) {
                const schemes = new Set();
                selectedNotes.forEach(i => schemes.add(notes[i]?.instanceSchemeName));
                return schemes.size === 1 ? [...schemes][0] : null;
              }
              return activeTrack?.activeInstanceScheme ?? null;
            })()
          }
          onClose={() => setShowInstanceColorMenu(false)}
          onApply={(schemeName) => {
            if (selectedNotes.size > 0) {
              setNotes(prev => prev.map((n, i) => selectedNotes.has(i) ? { ...n, instanceSchemeName: schemeName } : n));
            } else {
              setTracksTracked(prev => prev.map(t => t.id === activeTrackId ? { ...t, activeInstanceScheme: schemeName } : t));
            }
            if (selectingSchemeClosesMenu) {
              setShowInstanceColorMenu(false);
            }
          }}
        />
      )}
    </div>
  );
}

const INSTANCE_MENU_HEIGHT_KEY = 'guitar-roll-instance-color-menu-height';
const MIN_INSTANCE_MENU_HEIGHT = 100;
const DEFAULT_INSTANCE_MENU_HEIGHT = 260;

function readStoredInstanceMenuHeight() {
  try {
    const v = parseInt(localStorage.getItem(INSTANCE_MENU_HEIGHT_KEY) || '', 10);
    if (Number.isFinite(v) && v >= MIN_INSTANCE_MENU_HEIGHT) {
      return Math.min(v, Math.max(MIN_INSTANCE_MENU_HEIGHT, window.innerHeight - 40));
    }
  } catch {}
  return null;
}

function InstanceColorMenu({ position, sessionSchemes, selectedNotes, highlightScheme, onClose, onApply }) {
  const schemes = { ...sessionSchemes };
  try {
    const saved = JSON.parse(localStorage.getItem('guitar-roll-color-schemes') || '{}');
    Object.assign(schemes, saved);
  } catch {}
  const schemeNames = Object.keys(schemes);
  const containerRef = useRef(null);
  const contentRef = useRef(null);
  const focusedIndexRef = useRef(0);
  const suppressOverlayClickRef = useRef(false);
  const [menuHeight, setMenuHeight] = useState(readStoredInstanceMenuHeight);
  const [menuTop, setMenuTop] = useState(() => {
    const stored = readStoredInstanceMenuHeight();
    const effective = stored ?? DEFAULT_INSTANCE_MENU_HEIGHT;
    const base = Math.min(position.top, window.innerHeight - effective - 12);
    return Math.max(0, base);
  });
  const [resizing, setResizing] = useState(null);
  const dragHeightRef = useRef(null);
  const dragChangedRef = useRef(false);
  const [focusedIndex, setFocusedIndex] = useState(() => {
    if (highlightScheme === null) return 0;
    const idx = schemeNames.indexOf(highlightScheme);
    return idx >= 0 ? idx + 1 : 0;
  });
  focusedIndexRef.current = focusedIndex;
  const scrollFocusedIntoView = (selector) => {
    const content = contentRef.current;
    const btn = content?.querySelector(selector);
    if (!content || !btn) return;
    const contentRect = content.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    if (btnRect.top < contentRect.top) {
      content.scrollTop -= (contentRect.top - btnRect.top) + 4;
    } else if (btnRect.bottom > contentRect.bottom) {
      content.scrollTop += (btnRect.bottom - contentRect.bottom) + 4;
    }
  };
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    const nav = (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        const total = 1 + schemeNames.length;
        const delta = e.key === 'ArrowUp' ? -1 : 1;
        const next = (focusedIndexRef.current + delta + total) % total;
        focusedIndexRef.current = next;
        setFocusedIndex(next);
        setTimeout(() => {
          const btn = containerRef.current?.querySelector('.instance-color-button-navigate-style');
          btn?.scrollIntoView({ block: 'nearest' });
        }, 0);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const scheme = focusedIndexRef.current === 0 ? null : schemeNames[focusedIndexRef.current - 1];
        onApply(scheme);
      }
    };
    document.addEventListener('keydown', esc);
    document.addEventListener('keydown', nav);
    return () => {
      document.removeEventListener('keydown', esc);
      document.removeEventListener('keydown', nav);
    };
  }, [onClose, schemeNames.length, onApply]);
  useEffect(() => {
     const btn = containerRef.current?.querySelector('.selected-instance-color-button');
     btn?.scrollIntoView({ block: 'nearest' });
  }, [highlightScheme]);
  useEffect(() => {
    if (!resizing) return;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const onMove = (e) => {
      const dy = e.clientY - resizing.startY;
       if (resizing.mode === 'bottom') {
         const maxH = Math.min(window.innerHeight - resizing.startTop - 12, resizing.maxContentHeight);
         const h = Math.max(MIN_INSTANCE_MENU_HEIGHT, Math.min(maxH, resizing.startHeight + dy));
        dragHeightRef.current = h;
        dragChangedRef.current = true;
        setMenuHeight(h);
      } else {
        const bottom = resizing.startTop + resizing.startHeight;
         let h = resizing.startHeight - dy;
         let top = resizing.startTop + dy;
         const maxH = resizing.maxContentHeight;
         if (h > maxH) {
           h = maxH;
           top = resizing.startTop + resizing.startHeight - maxH;
         }
         if (h < MIN_INSTANCE_MENU_HEIGHT) {
          h = MIN_INSTANCE_MENU_HEIGHT;
          top = bottom - h;
        }
        if (top < 0) {
          top = 0;
          h = bottom;
        }
        dragHeightRef.current = h;
        dragChangedRef.current = true;
        setMenuHeight(h);
        setMenuTop(top);
      }
    };
    const onUp = () => {
      if (dragChangedRef.current && dragHeightRef.current) {
        try { localStorage.setItem(INSTANCE_MENU_HEIGHT_KEY, String(Math.round(dragHeightRef.current))); } catch {}
      }
      dragHeightRef.current = null;
      dragChangedRef.current = false;
      setResizing(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = prevUserSelect;
    };
  }, [resizing]);
  const getPreviewColors = (name) => {
    const sc = schemes[name];
    if (!sc) return [];
    const notes = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return notes.map(n => sc[n]).filter(Boolean).slice(0, 12);
  };
  const startResize = (mode) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    suppressOverlayClickRef.current = false;
     const el = containerRef.current;
     if (!el) return;
     const rect = el.getBoundingClientRect();
     const content = contentRef.current;
     const maxContentHeight = (content?.scrollHeight ?? 0) + (rect.height - (content?.clientHeight ?? 0));
     setResizing({ mode, startY: e.clientY, startTop: rect.top, startHeight: rect.height, maxContentHeight });
  };
  const left = position.left !== null && position.left !== undefined ? Math.min(position.left, window.innerWidth - 260) : 'auto';
  const right = position.right !== null && position.right !== undefined ? position.right : 'auto';
  const top = menuTop;
  const menuStyle = menuHeight
    ? { position: 'absolute', left, top, right, height: menuHeight, maxHeight: 'none' }
    : { position: 'absolute', left, top, right };
  return (
      <div className="instance-color-menu-overlay" onClick={(e) => { if (e.target.classList.contains('instance-color-menu-overlay')) onClose(); }}>
      <div ref={containerRef} className="instance-color-menu" style={menuStyle}>
        <div className="instance-color-menu-resize-handle instance-color-menu-resize-handle-top" onMouseDown={startResize('top')} title="Drag to resize" />
        <div className="instance-color-menu-title">
          {selectedNotes.size > 0 ? 'Instance color for selection' : 'Instance color for new notes'}
        </div>
        <div className="instance-color-menu-content" ref={contentRef}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button className={`settings-btn-sm ${focusedIndex === 0 ? 'instance-color-button-navigate-style' : ''} ${highlightScheme === null ? 'selected-instance-color-button' : ''}`} onClick={() => onApply(null)} style={{ textAlign: 'left' }}>None</button>
            {schemeNames.map((name, i) => (
              <button key={name} className={`settings-btn-sm ${focusedIndex === i + 1 ? 'instance-color-button-navigate-style' : ''} ${highlightScheme === name ? 'selected-instance-color-button' : ''}`} onClick={() => onApply(name)} style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, maxWidth: '100%' }}>
                <div className="scheme-colors-preview" style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                  {getPreviewColors(name).map((c, ci) => (
                    <div key={ci} className="scheme-color-dot" style={{ width: 10, height: 10, background: c, border: '1px solid var(--line)' }} />
                  ))}
                </div>
                <span style={{ fontSize: 11, color: 'var(--fg)', wordBreak: 'break-word', maxWidth: '100%' }}>{name}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="instance-color-menu-resize-handle instance-color-menu-resize-handle-bottom" onMouseDown={startResize('bottom')} title="Drag to resize" />
      </div>
    </div>
  );
}

export default App;
