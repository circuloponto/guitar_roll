import { useState, useCallback, useRef, useEffect } from 'react';
import Fretboard from './components/Fretboard';
import Timeline from './components/Timeline';
import { playNote, playNoteAtTime, playClickAtTime, getAudioContext, getMasterOut, getNoteName, INSTRUMENTS, getAllInstruments, setInstrument, getInstrument, saveCustomPreset } from './utils/audio';
import { NUM_BARS, SUBDIVISIONS, BPM as DEFAULT_BPM } from './utils/constants';
import { defaultBarSubdivisions, totalColumns, beatToBar, beatToTime, colDurationAtBeat, remapNotes, barStartBeats, applySwingBeat, amountToRatio, ratioToAmount } from './utils/barLayout';
import { loadAudioFile, computeWaveformPeaks } from './utils/audioFile';
import { ensureReady as ensureStretchReady, createStretchNode, setStretchTempo } from './utils/rubberbandStretch';
import { putAudioFile, getAudioFile, deleteAudioFile } from './utils/audioStore';
import { parseMidi, midiToGuitarNotes } from './utils/midiImport';
import { stateFromUrl, writeStateToUrl, saveChordLibrary, getSessionState, saveAutosave, loadAutosave, listColorSchemes, loadSessionSchemeState, saveSessionSchemeState } from './utils/storage';
import { loadHotkeys, matchesHotkey, formatHotkey, REFERENCE_ACTIONS } from './utils/hotkeys';
import { getMidiNote, closestComboForPitch, getComboForPosition } from './utils/pitchMap';
import { serializeNotes, parseNotes } from './utils/noteClipboard';
import { NUM_STRINGS, NUM_FRETS } from './utils/constants';
import SettingsModal from './components/SettingsModal';
import TrackStrip from './components/TrackStrip';
import SynthEditor from './components/SynthEditor';
import ChordPalette from './components/ChordPalette';
import VoiceLeadingModal from './components/VoiceLeadingModal';
import ConfirmDialog from './components/ConfirmDialog';
import NumberInput from './components/NumberInput';
import './App.css';

function createDefaultTrack(name = 'Track 1', instrument = 'clean-electric') {
  return { id: crypto.randomUUID(), name, instrument, type: 'notes', notes: [], volume: 1, muted: false, solo: false, visible: true, bgOpacity: 0.2, schemeName: null, activeInstanceScheme: null, audioFileName: null, audioDuration: 0, audioOffset: 0, waveformPeaks: null };
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
  const audioSourcesRef = useRef([]); // active AudioBufferSourceNodes during playback
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
    if (snap.activeTrackId) {
      activeTrackIdRef.current = snap.activeTrackId;
      setActiveTrackId(snap.activeTrackId);
    }
    if (snap.timeSignature) setTimeSignature(snap.timeSignature);
    if (snap.barSubdivisions) setBarSubdivisions(snap.barSubdivisions);
    if (snap.selectedBeat !== undefined && snap.autoForward) setSelectedBeat(snap.selectedBeat);
    if (snap.selectedNotes) setSelectedNotes(new Set(snap.selectedNotes));
  }, [setTracksTracked, setActiveNotes]);
  
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
    const track = tracksRef.current.find(t => t.id === trackId);
    if (track) {
      setInstrument(track.instrument);
      setInstrumentState(track.instrument);
    }
  }, []);
  const [projectName, setProjectName] = useState('Guitar Roll');
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
  const [bpm, setBpm] = useState(DEFAULT_BPM);
  const [swing, setSwing] = useState(50);
  const swingRef = useRef(swing);
  swingRef.current = swing;

  // Live tempo on bpm change: BufferSource.playbackRate does the time-stretch, rubberband
  // corrects the resulting pitch shift via pitch_scale. Update both so they track bpm.
  useEffect(() => {
    const entries = audioSourcesRef.current;
    if (entries.length === 0) return;
    entries.forEach((entry) => {
      const track = tracksRef.current.find((t) => t.id === entry.trackId);
      const originalBpm = (track?.originalBpm) || bpm;
      const tempoMultiplier = bpm / originalBpm;
      const pitchScale = 1 / tempoMultiplier;
      try { entry.source?.playbackRate.setValueAtTime(tempoMultiplier, entry.source.context.currentTime); } catch {}
      if (!entry.workletNode) {
        console.info(`[rubberband] bpm→${bpm}: worklet not ready yet for track=${entry.trackId.slice(0,6)} (pitch_scale will be applied at splice)`);
        return;
      }
      setStretchTempo(entry.workletNode, pitchScale);
      console.info(`[rubberband] bpm→${bpm}: playbackRate=${tempoMultiplier.toFixed(3)} pitchScale=${pitchScale.toFixed(3)} track=${entry.trackId.slice(0,6)}`);
    });
  }, [bpm]);

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
      const saved = JSON.parse(localStorage.getItem('guitar-roll-auto-scroll'));
      return { onHover: false, onInput: false, onPlayback: false, ...saved };
    } catch { return { onHover: false, onInput: false, onPlayback: false }; }
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
  const [showSynthEditor, setShowSynthEditor] = useState(false);
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

  // Apply partial state from settings/load/URL
  const applyState = useCallback((data) => {
    setPosition(0);  // reset position on any new session load or import
    if (data.tracks !== undefined) {
      setTracksTracked(data.tracks);
      const firstId = data.tracks[0]?.id;
      if (firstId) { setActiveTrackId(firstId); activeTrackIdRef.current = firstId; }
      // Rehydrate persisted audio files from IndexedDB
      data.tracks.forEach(async (t) => {
        if (t.type === 'audio' && t.audioFileName && !audioBuffersRef.current[t.id]) {
          try {
            const stored = await getAudioFile(t.id);
            if (!stored) return;
            const ctx = getAudioContext();
            ensureStretchReady(ctx).catch(() => {});
            const buffer = await ctx.decodeAudioData(stored.arrayBuffer.slice(0));
            audioBuffersRef.current[t.id] = buffer;
            // Back-fill originalBpm for legacy tracks that predate the tempo-stretch feature.
            setTracksTracked(prev => prev.map(tr => tr.id === t.id
              ? (tr.originalBpm ? { ...tr } : { ...tr, originalBpm: bpmRef.current })
              : tr));
          } catch (e) {
            console.warn('Could not restore audio for track', t.id, e);
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
  }, [setTracksTracked]);

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
      const auto = loadAutosave();
      if (auto) {
        const sessionSchemeState = loadSessionSchemeState();
        applyState({
          ...auto,
          sessionScheme: sessionSchemeState.sessionScheme || null,
          sessionSchemes: sessionSchemeState.sessionSchemes || {},
        });
      }
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
      }));
    }, 400);
    return () => clearTimeout(t);
  }, [tracks, bpm, swing, loop, loopStart, loopEnd, stringColors, synesthesia, sessionScheme, sessionSchemes, projectName, subdivisions, rhythmUnit, rhythmMult, metronome, barSubdivisions, timeSignature, markers]);

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
      });
      saveAutosave(state);
    }, 30000);
    return () => clearInterval(interval);
  }, [autoSave, bpm, swing, loop, loopStart, loopEnd, stringColors, synesthesia, sessionScheme, sessionSchemes, projectName, subdivisions, metronome, barSubdivisions, timeSignature, markers]);

  const totalBeats = totalColumns(barSubdivisions);
  const handlePlayRef = useRef(null);
  const handleSetSubdivisionsRef = useRef(null);
  const handleSetRhythmMultRef = useRef(null);
  const handleToggleSoloRef = useRef(null);
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

  const copySelectedNotes = useCallback(() => {
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
  }, [showToast]);

  // `text` is whatever is on the system clipboard (or null/'' to use the in-app one).
  const pasteNotes = useCallback((text) => {
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
  }, [defaultVelocity, showToast]);
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
            newSelected.add(newNotes.length - 2);
            newSelected.add(newNotes.length - 1);
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
                setPosition(pos);
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
            setPosition(pos);
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
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      if (positionTimeoutRef.current) clearTimeout(positionTimeoutRef.current);
      if (rhythmPendingRef.current) clearTimeout(rhythmPendingRef.current);
    };
  }, [totalBeats, undo, redo, setNotes]);

  const handleFretClick = useCallback((stringIndex, fret, stayInPlace = false) => {
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

  const handleDeleteNote = useCallback((noteIndex) => {
    setNotes(prev => prev.filter((_, i) => i !== noteIndex));
    setSelectedNotes(prev => {
      const next = new Set();
      for (const idx of prev) {
        if (idx < noteIndex) next.add(idx);
        else if (idx > noteIndex) next.add(idx - 1);
      }
      return next;
    });
  }, []);

  const stopPlayback = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    setCurrentBeat(null);
    playheadBeatRef.current = null;
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
    }
    // Stop audio file sources and tear down any rubberband worklet nodes.
    audioSourcesRef.current.forEach(({ source, gainNode, workletNode }) => {
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
      try { workletNode?.disconnect(); } catch {}
      try { gainNode?.disconnect(); } catch {}
    });
    audioSourcesRef.current = [];
  }, []);

  const scheduleAudioTracks = useCallback((playable, fromBeat, startTime, ctx, barSubs) => {
    audioSourcesRef.current.forEach(({ source, gainNode, workletNode }) => {
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
      try { workletNode?.disconnect(); } catch {}
      try { gainNode?.disconnect(); } catch {}
    });
    audioSourcesRef.current = [];

    const liveBpm = bpmRef.current;
    const denom = timeSigRef.current[1];

    playable.forEach(track => {
      if (track.type !== 'audio') return;
      const buffer = audioBuffersRef.current[track.id];
      if (!buffer) return;

      const originalBpm = track.originalBpm || liveBpm;
      const tempoMultiplier = liveBpm / originalBpm;
      // The BufferSource itself does the time-stretch by resampling; rubberband then
      // corrects the pitch shift. pitch_scale = 1/tempoMultiplier restores the original
      // pitch.
      const pitchScale = 1 / tempoMultiplier;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = tempoMultiplier;
      const gainNode = ctx.createGain();
      gainNode.gain.setValueAtTime(track.muted ? 0 : track.volume, startTime);

      // Build a per-track entry so the live-tempo effect can target it.
      const entry = { source, gainNode, workletNode: null, trackId: track.id };
      audioSourcesRef.current.push(entry);

      // Route source → rubberband worklet → gain → destination. The worklet is created
      // async, but the BufferSource can't wait for it (we need to schedule source.start
      // against startTime in the audio timeline). We pre-connect source→gain synchronously
      // so audio starts on time; once the worklet is ready, we splice it into the chain.
      source.connect(gainNode);
      gainNode.connect(ctx.destination);

      createStretchNode(ctx, { numChannels: buffer.numberOfChannels, initialRatio: pitchScale })
        .then(({ node, ready }) => {
          if (!audioSourcesRef.current.includes(entry)) {
            try { node.disconnect(); } catch {}
            return;
          }
          entry.workletNode = node;
          try { source.disconnect(); } catch {}
          source.connect(node);
          try { gainNode.disconnect(); } catch {}
          node.connect(gainNode);
          gainNode.connect(ctx.destination);
          // bpm may have changed during async init — re-apply tempoMultiplier and
          // pitch_scale so the splice lines up with the current bpm state.
          const nowTempoMult = bpmRef.current / originalBpm;
          const nowPitch = 1 / nowTempoMult;
          try { source.playbackRate.setValueAtTime(nowTempoMult, ctx.currentTime); } catch {}
          setStretchTempo(node, nowPitch);
          console.info(`[rubberband] spliced in for track=${track.id.slice(0,6)}, playbackRate=${nowTempoMult.toFixed(3)} pitch=${nowPitch.toFixed(3)}`);
          ready
            .then(({ startDelaySamples }) => {
              console.info(`[rubberband] ready track=${track.id.slice(0,6)} startDelay=${startDelaySamples} samples`);
            })
            .catch((err) => console.warn('[rubberband] init failed:', err));
        })
        .catch((err) => {
          console.warn('[rubberband] could not create worklet node, falling back to direct playback:', err);
        });

      // Loop + start offset are computed in file-time (original-bpm seconds) because the
      // BufferSource always plays at rate 1; rubberband does the tempo math downstream.
      const audioStartBeat = track.audioOffset || 0;
      const beatOffset = fromBeat - audioStartBeat;
      const timeOffsetInBuffer = beatToTime(Math.max(0, beatOffset), barSubs, originalBpm, denom);

      if (loopRef.current) {
        const lsBeats = loopStartRef.current - audioStartBeat;
        const leBeats = loopEndRef.current - audioStartBeat;
        const lsSec = beatToTime(Math.max(0, lsBeats), barSubs, originalBpm, denom);
        const leSec = beatToTime(Math.max(0, leBeats), barSubs, originalBpm, denom);
        const clampedEnd = Math.min(buffer.duration, leSec);
        if (clampedEnd > lsSec + 1e-4) {
          source.loop = true;
          source.loopStart = lsSec;
          source.loopEnd = clampedEnd;
        }
      }

      if (beatOffset >= 0) {
        if (timeOffsetInBuffer < buffer.duration) {
          source.start(startTime, timeOffsetInBuffer);
        }
      } else {
        // Negative offset = audio starts after playback begins. Wall-clock delay measured
        // against live tempo (not original) since it's a timeline-position gap.
        const delay = beatToTime(-beatOffset, barSubs, liveBpm, denom);
        source.start(startTime + delay, 0);
      }
    });
  }, []);

  const startPlayback = useCallback((fromBeat) => {
    const playable = getPlayableTracks(tracksRef.current);
    const hasContent = playable.some(t => t.notes.length > 0 || (t.type === 'audio' && audioBuffersRef.current[t.id]));
    if (!hasContent) return;

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
    const startTime = ctx.currentTime + 0.05;

    // Schedule audio file tracks
    scheduleAudioTracks(playable, fromBeat, startTime, ctx, barSubs);
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
      const rDuration = rEnd - rStart;

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
      }

      // Compute current column's duration for playhead interpolation
      const currentBeatAbs = rStart + (nextBeatIndex > 0 ? (nextBeatIndex - 1) % rDuration : 0);
      const currentColDur = colDurationAtBeat(Math.min(currentBeatAbs, tc - 1), bs, bpm, timeSigRef.current[1]);
      const beatsSinceLastScheduled = (now - (nextBeatTime - currentColDur)) / currentColDur;
      const playheadBeatIndex = nextBeatIndex - 1 + Math.min(1, Math.max(0, beatsSinceLastScheduled));
      const playheadBeat = rStart + (playheadBeatIndex % rDuration);

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
        const colDur = colDurationAtBeat(Math.min(beat, tc - 1), bs, bpm, timeSigRef.current[1]);

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
  }, [stopPlayback, scheduleAudioTracks]);

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

  const handleReorderTracks = useCallback((fromIndex, toIndex) => {
    setTracksTracked(prev => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, [setTracksTracked]);

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

  const handleLoadAudio = useCallback(async (trackId, file) => {
    try {
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
      setTracksTracked(prev => prev.map(t =>
        t.id === trackId ? {
          ...t,
          type: 'audio',
          audioFileName: file.name,
          audioDuration: buffer.duration,
          audioOffset: 0,
          originalBpm: bpmRef.current,
          notes: [],
          waveformPeaks: Array.from(peaks),
        } : t
      ));
    } catch (err) {
      alert('Failed to load audio file: ' + err.message);
    }
  }, [setTracksTracked]);

  const handleRemoveAudio = useCallback((trackId) => {
    delete audioBuffersRef.current[trackId];
    deleteAudioFile(trackId).catch(() => {});
    setTracksTracked(prev => prev.map(t =>
      t.id === trackId ? {
        ...t,
        type: 'notes',
        audioFileName: null,
        audioDuration: 0,
        audioOffset: 0,
        waveformPeaks: null,
      } : t
    ));
  }, [setTracksTracked]);

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
          className={`tool-btn ${metronome ? 'active' : ''}`}
          onClick={() => setMetronome(m => !m)}
          title="Metronome"
        >
          Metronome
        </button>
        <span className="toolbar-label">Inst:</span>
        <select
          className="duration-select"
          value={activeTrack?.instrument || instrument}
          title="Instrument"
          onChange={(e) => {
            const inst = e.target.value;
            setInstrument(inst);
            setInstrumentState(inst);
            setTracksTracked(prev => prev.map(t =>
              t.id === activeTrackId ? { ...t, instrument: inst } : t
            ));
          }}
        >
          {Object.entries(instrumentList).map(([id, inst]) => (
            <option key={id} value={id}>{inst.label}</option>
          ))}
        </select>
        <button
          className="tool-btn"
          onClick={() => setShowSynthEditor(true)}
          title="Edit synth parameters"
        >
          Synth
        </button>
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
          onClick={() => { setShowSettings(true);}}
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
        <span className="toolbar-label">Bars:</span>
        <NumberInput
          className="bpm-input"
          value={barSubdivisions.length}
          min={1}
          onChange={(newCount) => {
            setBarSubdivisions(prev => {
              if (newCount > prev.length) {
                return [...prev, ...Array(newCount - prev.length).fill(timeSignature[0])];
              } else if (newCount < prev.length) {
                const tc = totalColumns(prev.slice(0, newCount));
                setActiveNotes(notesRef.current.filter(n => n.beat < tc));
                return prev.slice(0, newCount);
              }
              return prev;
            });
          }}
        />
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
        onRenameTrack={handleRenameTrack}
        onLoadAudio={handleLoadAudio}
        onRemoveAudio={handleRemoveAudio}
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
      <div className="main-area">
        <Fretboard
          playing={playing}
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
          swungDisplay={swungDisplay}
          activeInstanceScheme={activeTrack?.activeInstanceScheme || null}
        />
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
          audioTracks={tracks.filter(t => t.type === 'audio' && t.waveformPeaks).map(t => ({
            trackId: t.id,
            audioOffset: t.audioOffset || 0,
            audioDuration: t.audioDuration,
            originalBpm: t.originalBpm,
            waveformPeaks: t.waveformPeaks,
            audioBuffer: audioBuffersRef.current[t.id],
            isActive: t.id === activeTrackId,
            bgOpacity: t.bgOpacity ?? 0.2,
            volume: t.volume,
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

      {showSynthEditor && (
        <SynthEditor
          currentInstrument={activeTrack?.instrument || instrument}
          onInstrumentChange={(id) => {
            setInstrument(id);
            setInstrumentState(id);
            setTracksTracked(prev => prev.map(t =>
              t.id === activeTrackId ? { ...t, instrument: id } : t
            ));
            setInstrumentList(getAllInstruments());
          }}
          onClose={() => { setShowSynthEditor(false); setInstrumentList(getAllInstruments()); }}
        />
      )}

      {showSettings && (
        <SettingsModal
          appState={{
            tracks, bpm, loop, loopStart, loopEnd,
            stringColors, synesthesia, sessionScheme, sessionSchemes,
            projectName, subdivisions, metronome, barSubdivisions, timeSignature, markers,
          }}
          onApplyState={applyState}
          onClose={() => setShowSettings(false)}
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
