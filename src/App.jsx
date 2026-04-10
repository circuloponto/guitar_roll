import { useState, useCallback, useRef, useEffect } from 'react';
import Fretboard from './components/Fretboard';
import Timeline from './components/Timeline';
import { playNote, playNoteAtTime, playClickAtTime, getAudioContext, getMasterOut, getNoteName, INSTRUMENTS, getAllInstruments, setInstrument, getInstrument, saveCustomPreset } from './utils/audio';
import { NUM_BARS, SUBDIVISIONS, BPM as DEFAULT_BPM } from './utils/constants';
import { defaultBarSubdivisions, totalColumns, beatToBar, beatToTime, timeToBeat, colDurationAtBeat, remapNotes, barStartBeats } from './utils/barLayout';
import { loadAudioFile } from './utils/audioFile';
import { parseMidi, midiToGuitarNotes } from './utils/midiImport';
import { stateFromUrl, saveColorScheme, saveChordLibrary, getSessionState, saveAutosave, loadAutosave, listColorSchemes } from './utils/storage';
import { loadHotkeys, matchesHotkey, formatHotkey } from './utils/hotkeys';
import { getMidiNote } from './utils/pitchMap';
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
  return { id: crypto.randomUUID(), name, instrument, type: 'notes', notes: [], volume: 1, muted: false, solo: false, visible: true, bgOpacity: 0.2, schemeName: null, audioFileName: null, audioDuration: 0, audioOffset: 0, waveformPeaks: null };
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
  const audioBuffersRef = useRef({}); // { [trackId]: AudioBuffer }
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

  // Snapshot helpers for undo/redo
  const takeSnapshot = useCallback(() => ({
    tracks: JSON.parse(JSON.stringify(tracksRef.current)),
    activeTrackId: activeTrackIdRef.current,
    timeSignature: timeSigRef.current,
    barSubdivisions: barSubsRef.current,
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
      return;
    }
    setTracksTracked(() => snap.tracks);
    if (snap.activeTrackId) {
      activeTrackIdRef.current = snap.activeTrackId;
      setActiveTrackId(snap.activeTrackId);
    }
    if (snap.timeSignature) setTimeSignature(snap.timeSignature);
    if (snap.barSubdivisions) setBarSubdivisions(snap.barSubdivisions);
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
  const [selectedBeat, setSelectedBeat] = useState(0);
  const [subdivisions, setSubdivisions] = useState(4); // how many subdivisions per beat
  const snapUnit = 1 / subdivisions; // smallest grid step
  const [noteDuration, setNoteDuration] = useState(snapUnit);
  const noteDurationRef = useRef(noteDuration);
  noteDurationRef.current = noteDuration;
  const snapUnitRef = useRef(snapUnit);
  snapUnitRef.current = snapUnit;
  const [selectedNotes, setSelectedNotes] = useState(new Set());
  const selectedNotesRef = useRef(selectedNotes);
  selectedNotesRef.current = selectedNotes;
  const [timeSignature, setTimeSignature] = useState([4, 4]); // [numerator, denominator]
  const [bpm, setBpm] = useState(DEFAULT_BPM);
  const [metronome, setMetronome] = useState(false);
  const clipboardRef = useRef([]);
  const [instrument, setInstrumentState] = useState(getInstrument());
  const [freeMode, setFreeMode] = useState(false);
  const [machineGunMode, setMachineGunMode] = useState(false);
  const [defaultVelocity, setDefaultVelocity] = useState(0.8);
  const [eraserMode, setEraserMode] = useState(false);
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
      return { visible: true, opacity: 0.35, ...saved };
    } catch { return { visible: true, opacity: 0.35 }; }
  });
  const [autoScroll, setAutoScroll] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('guitar-roll-auto-scroll'));
      return { onHover: true, onInput: true, onPlayback: true, ...saved };
    } catch { return { onHover: true, onInput: true, onPlayback: true }; }
  });
  const [hoverPill, setHoverPill] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('guitar-roll-hover-pill'));
      return { fretboard: true, pianoRoll: true, ...saved };
    } catch { return { fretboard: true, pianoRoll: true }; }
  });
  const [fingeringMode, setFingeringMode] = useState(false);
  const fingeringModeRef = useRef(false);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [fretboardZoom, setFretboardZoom] = useState(1);
  const [stringColors, setStringColors] = useState(['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff']);
  const [showSettings, setShowSettings] = useState(false);
  const [hotkeys, setHotkeys] = useState(loadHotkeys);
  const hotkeysRef = useRef(hotkeys);
  hotkeysRef.current = hotkeys;
  const [hoveredNote, setHoveredNote] = useState(null); // { stringIndex, fret }
  const [chordRoot, setChordRoot] = useState(null); // { stringIndex, fret } — locked by click on piano key
  const [showCheatSheet, setShowCheatSheet] = useState(false);
  const [showSubdivDial, setShowSubdivDial] = useState(false);
  const subdivDialRef = useRef(null);
  const [showSynthEditor, setShowSynthEditor] = useState(false);
  const [chordPreview, setChordPreview] = useState(null);
  const [chordPaletteOpen, setChordPaletteOpen] = useState(false);
  const [showVoiceLeading, setShowVoiceLeading] = useState(false);
  const [voicingPreview, setVoicingPreview] = useState(null); // [{ stringIndex, fret }] for fretboard highlight
  const [confirmClear, setConfirmClear] = useState(false);
  const [instrumentList, setInstrumentList] = useState(getAllInstruments);
  const [verticalScroll, setVerticalScroll] = useState(0);
  const [synesthesia, setSynesthesia] = useState([]); // [{ note: 'C', color: '#ff0000' }, ...]
  const [activeColorScheme, setActiveColorScheme] = useState(null); // { name, colors }
  const [barSubdivisions, setBarSubdivisions] = useState(defaultBarSubdivisions);
  const barSubsRef = useRef(barSubdivisions);
  barSubsRef.current = barSubdivisions;
  const [loop, setLoop] = useState(false);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(totalColumns(defaultBarSubdivisions()));
  const playingRef = useRef(false);
  const bpmRef = useRef(bpm);
  const metronomeRef = useRef(metronome);
  const loopRef = useRef(false);
  const loopStartRef = useRef(0);
  const loopEndRef = useRef(totalColumns(defaultBarSubdivisions()));
  const selectedBeatRef = useRef(selectedBeat);
  const animFrameRef = useRef(null);

  const timeSigRef = useRef(timeSignature);

  // Keep refs in sync
  bpmRef.current = bpm;
  metronomeRef.current = metronome;
  timeSigRef.current = timeSignature;
  selectedBeatRef.current = selectedBeat;
  loopRef.current = loop;
  loopStartRef.current = loopStart;
  loopEndRef.current = loopEnd;

  // Build synesthesia lookup: note letter (without octave) -> color
  const synesthesiaMap = {};
  synesthesia.forEach(s => { if (s.note) synesthesiaMap[s.note] = s.color; });

  // Track schemes are stored by name in localStorage; load active track's scheme map
  const activeTrackScheme = activeTrack?.schemeName
    ? (listColorSchemes()[activeTrack.schemeName] || null)
    : null;

  const getNoteColor = useCallback((stringIndex, fret) => {
    const name = getNoteName(stringIndex, fret);
    const letter = name.replace(/[0-9]/g, '');
    if (activeTrackScheme && activeTrackScheme[letter]) return activeTrackScheme[letter];
    if (synesthesiaMap[letter]) return synesthesiaMap[letter];
    return stringColors[stringIndex];
  }, [stringColors, synesthesia, activeTrackScheme]);

  // Apply partial state from settings/load/URL
  const applyState = useCallback((data) => {
    if (data.tracks !== undefined) {
      setTracksTracked(data.tracks);
      const firstId = data.tracks[0]?.id;
      if (firstId) { setActiveTrackId(firstId); activeTrackIdRef.current = firstId; }
    } else if (data.notes !== undefined) {
      // Legacy: wrap flat notes into a single track
      setTracksTracked(prev => {
        const track = prev[0] || createDefaultTrack();
        return [{ ...track, notes: data.notes }];
      });
    }
    if (data.bpm !== undefined) setBpm(data.bpm);
    if (data.loop !== undefined) setLoop(data.loop);
    if (data.loopStart !== undefined) setLoopStart(data.loopStart);
    if (data.loopEnd !== undefined) setLoopEnd(data.loopEnd);
    if (data.stringColors !== undefined) setStringColors(data.stringColors);
    if (data.synesthesia !== undefined) setSynesthesia(data.synesthesia);
    if (data.subdivisions !== undefined) setSubdivisions(data.subdivisions);
    if (data.markers !== undefined) setMarkers(data.markers);
    if (data.metronome !== undefined) setMetronome(data.metronome);
    if (data.activeColorScheme !== undefined) setActiveColorScheme(data.activeColorScheme);
    if (data.barSubdivisions !== undefined) setBarSubdivisions(data.barSubdivisions);
    if (data.timeSignature !== undefined) setTimeSignature(data.timeSignature);
    if (data.projectName !== undefined) setProjectName(data.projectName);
    if (data.colorSchemes) {
      Object.entries(data.colorSchemes).forEach(([name, scheme]) => {
        saveColorScheme(name, scheme);
      });
    }
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

  // Load from URL or autosave on mount
  useEffect(() => {
    const urlState = stateFromUrl();
    if (urlState) {
      applyState(urlState);
      window.history.replaceState(null, '', window.location.pathname);
    } else {
      const auto = loadAutosave();
      if (auto) applyState(auto);
    }
  }, []);

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
        bpm, loop, loopStart, loopEnd,
        stringColors, synesthesia, activeColorScheme,
        projectName, subdivisions, metronome, barSubdivisions, timeSignature, markers,
      });
      saveAutosave(state);
    }, 30000);
    return () => clearInterval(interval);
  }, [autoSave, bpm, loop, loopStart, loopEnd, stringColors, synesthesia, activeColorScheme, projectName, subdivisions, metronome, barSubdivisions, timeSignature, markers]);

  const totalBeats = totalColumns(barSubdivisions);
  const handlePlayRef = useRef(null);
  const handleSetSubdivisionsRef = useRef(null);
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT') return;
      const hk = hotkeysRef.current;

      // Number keys 1-9: set tuplet subdivision
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        handleSetSubdivisionsRef.current(Number(e.key));
        return;
      }

      // Ctrl+Left/Right: jump to previous/next note
      if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        e.stopPropagation();
        const currentNotes = notesRef.current;
        if (currentNotes.length === 0) return;
        const beats = [...new Set(currentNotes.map(n => n.beat))].sort((a, c) => a - c);
        if (e.key === 'ArrowLeft') {
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
        setSelectedBeat(b => Math.max(0, b - step));
      }
      if (matchesHotkey(e, hk.nextBeat)) {
        e.preventDefault();
        const step = noteDurationRef.current;
        setSelectedBeat(b => Math.min(totalBeats - 1, b + step));
      }
      if (matchesHotkey(e, hk.returnToStart)) {
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
      if (matchesHotkey(e, hk.zoomIn) || ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '='))) {
        e.preventDefault();
        setTimelineZoom(z => Math.min(40, z * 1.25));
      }
      if (matchesHotkey(e, hk.zoomOut) || ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === '_'))) {
        e.preventDefault();
        setTimelineZoom(z => Math.max(0.2, z / 1.25));
      }
      if (matchesHotkey(e, hk.freeMode)) {
        setFreeMode(m => !m);
      }
      if (matchesHotkey(e, hk.machineGunMode)) {
        setMachineGunMode(m => !m);
      }
      if (e.key === '?') {
        setShowCheatSheet(s => !s);
      }
      if (matchesHotkey(e, hk.fingeringMode)) {
        fingeringModeRef.current = !fingeringModeRef.current;
        setFingeringMode(fingeringModeRef.current);
      }
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
      if (matchesHotkey(e, hk.bendUp)) {
        if (selectedNotesRef.current.size > 0) {
          e.preventDefault();
          setNotes(prev => prev.map((n, i) =>
            selectedNotesRef.current.has(i) ? { ...n, bend: Math.min(3, (n.bend || 0) + 0.5) } : n
          ));
        }
      }
      if (matchesHotkey(e, hk.bendDown)) {
        if (selectedNotesRef.current.size > 0) {
          e.preventDefault();
          setNotes(prev => prev.map((n, i) =>
            selectedNotesRef.current.has(i) ? { ...n, bend: Math.max(0, (n.bend || 0) - 0.5) } : n
          ));
        }
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
      // Fingering: shift selected notes to adjacent string, same pitch (only in fingering mode)
      if (fingeringModeRef.current && (matchesHotkey(e, hk.fingerUp) || matchesHotkey(e, hk.fingerDown))) {
        if (selectedNotesRef.current.size > 0) {
          e.preventDefault();
          const dir = matchesHotkey(e, hk.fingerUp) ? -1 : 1;
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
        if (selectedNotesRef.current.size > 0) {
          const selected = notesRef.current.filter((_, i) => selectedNotesRef.current.has(i));
          const minBeat = Math.min(...selected.map(n => n.beat));
          clipboardRef.current = selected.map(n => ({ ...n, beat: n.beat - minBeat }));
        }
      }
      if (matchesHotkey(e, hk.paste)) {
        e.preventDefault();
        if (clipboardRef.current.length > 0) {
          const pasteAt = selectedBeatRef.current;
          const newNotes = clipboardRef.current.map(n => ({ ...n, beat: n.beat + pasteAt }));
          const baseIdx = notesRef.current.length;
          setNotes(prev => [...prev, ...newNotes]);
          setSelectedNotes(new Set(newNotes.map((_, i) => baseIdx + i)));
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [totalBeats, undo, redo, setNotes]);

  const handleFretClick = useCallback((stringIndex, fret) => {
    const beat = Math.round(selectedBeat * 10000) / 10000; // avoid float drift
    setNotes(prev => {
      const exactMatch = prev.findIndex(
        n => n.stringIndex === stringIndex && n.fret === fret && Math.abs(n.beat - beat) < 0.001
      );
      if (exactMatch >= 0) {
        return prev.filter((_, i) => i !== exactMatch);
      }
      const filtered = prev.filter(
        n => !(n.stringIndex === stringIndex && Math.abs(n.beat - beat) < 0.001)
      );
      return [...filtered, { stringIndex, fret, beat, duration: noteDuration, velocity: defaultVelocity }];
    });
  }, [selectedBeat, noteDuration, defaultVelocity]);

  const handleAdjacentClick = useCallback((stringIndex, fret) => {
    const beat = Math.round(selectedBeat * 10000) / 10000;
    setNotes(prev => {
      const exactMatch = prev.findIndex(
        n => n.stringIndex === stringIndex && n.fret === fret && Math.abs(n.beat - beat) < 0.001
      );
      if (exactMatch >= 0) {
        return prev.filter((_, i) => i !== exactMatch);
      }
      return [...prev, { stringIndex, fret, beat, duration: noteDuration, velocity: defaultVelocity }];
    });
  }, [selectedBeat, noteDuration]);

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
    setNoteDuration(1 / subs);
    if (selectedNotes.size > 0) {
      const dur = 1 / subs;
      setNotes(prev => prev.map((n, i) =>
        selectedNotes.has(i) ? { ...n, duration: dur } : n
      ));
    }
  }, [selectedNotes]);
  handleSetSubdivisionsRef.current = handleSetSubdivisions;


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
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
    }
    // Stop audio file sources
    audioSourcesRef.current.forEach(({ source }) => {
      try { source.stop(); } catch {}
    });
    audioSourcesRef.current = [];
  }, []);

  const scheduleAudioTracks = useCallback((playable, fromBeat, startTime, ctx, barSubs) => {
    // Stop any previous audio sources
    audioSourcesRef.current.forEach(({ source }) => {
      try { source.stop(); } catch {}
    });
    audioSourcesRef.current = [];

    const getMasterOut = () => {
      // Access master output from audio module
      getAudioContext();
      return ctx.destination; // fallback; will be routed through limiter below
    };

    playable.forEach(track => {
      if (track.type !== 'audio') return;
      const buffer = audioBuffersRef.current[track.id];
      if (!buffer) return;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gainNode = ctx.createGain();
      gainNode.gain.setValueAtTime(track.muted ? 0 : track.volume, startTime);
      source.connect(gainNode);
      gainNode.connect(getMasterOut());

      const audioStartBeat = track.audioOffset || 0;
      const beatOffset = fromBeat - audioStartBeat;
      const bpm = bpmRef.current;
      const denom = timeSigRef.current[1];
      const timeOffset = beatToTime(Math.max(0, beatOffset), barSubs, bpm, denom);

      if (beatOffset >= 0) {
        if (timeOffset < buffer.duration) {
          source.start(startTime, timeOffset);
        }
      } else {
        const delay = beatToTime(-beatOffset, barSubs, bpm, denom);
        source.start(startTime + delay, 0);
      }

      audioSourcesRef.current.push({ source, gainNode, trackId: track.id });
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

      // Check if first pass is done (reached end of region)
      if (firstPass && nextBeatIndex >= rDuration) {
        if (loopRef.current) {
          firstPass = false;
          nextBeatIndex = 0;
          // Switch to full loop region
          prevRStart = loopStartRef.current;
          prevRDuration = loopEndRef.current - loopStartRef.current;
          // Reschedule audio tracks for loop restart
          const loopPlayable = getPlayableTracks(tracksRef.current);
          scheduleAudioTracks(loopPlayable, loopStartRef.current, nextBeatTime, ctx, bs);
        }
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
          track.notes.forEach(note => {
            if (note.beat >= beat && note.beat < beat + 1) {
              const offset = (note.beat - beat) * colDur;
              const noteDur = (note.duration || 1) * colDur;
              playNoteAtTime(note.stringIndex, note.fret, nextBeatTime + offset, noteDur, note.velocity ?? 0.8, track.instrument, track.volume, note);
            }
          });
        });

        // Metronome on bar starts
        if (metronomeRef.current) {
          const bStarts = barStartBeats(bs);
          if (bStarts.includes(beat)) {
            const isDownbeat = beat === 0;
            playClickAtTime(nextBeatTime, isDownbeat);
          }
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
    startPlayback(Math.floor(selectedBeatRef.current));
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
      if (prev.length <= 1) return prev;
      const filtered = prev.filter(t => t.id !== trackId);
      if (activeTrackIdRef.current === trackId) {
        const newActive = filtered[0].id;
        activeTrackIdRef.current = newActive;
        setActiveTrackId(newActive);
        setSelectedNotes(new Set());
        setInstrument(filtered[0].instrument);
        setInstrumentState(filtered[0].instrument);
      }
      return filtered;
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
      const { buffer, peaks } = await loadAudioFile(file);
      audioBuffersRef.current[trackId] = buffer;
      setTracksTracked(prev => prev.map(t =>
        t.id === trackId ? {
          ...t,
          type: 'audio',
          audioFileName: file.name,
          audioDuration: buffer.duration,
          audioOffset: 0,
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
      const { tracks: midiTracks, detectedBpm } = midiToGuitarNotes(midi, subdivisions);

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
  }, [setTracksTracked, switchTrack, subdivisions]);

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
        color: '#3498db',
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
        <button
          className={`tool-btn ${eraserMode ? 'active' : ''}`}
          onClick={() => setEraserMode(m => !m)}
          title="Eraser: drag to select and delete notes"
        >
          Eraser
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
              bpm: 120, loop: false, loopStart: 0, loopEnd: totalColumns(defaultBarSubdivisions()),
              stringColors: ['#ffffff','#ffffff','#ffffff','#ffffff','#ffffff','#ffffff'],
              synesthesia: [], activeColorScheme: null,
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
          onClick={() => setShowSettings(true)}
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
          max={128}
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
        <button className="play-btn" onClick={() => {
          if (notes.length > 0) setConfirmClear(true);
          else handleClear();
        }}>
          Clear
        </button>
        <span className="toolbar-separator" />
        <div className="subdiv-picker" ref={subdivDialRef}>
          <button
            className={`subdiv-btn ${showSubdivDial ? 'open' : ''}`}
            onClick={() => setShowSubdivDial(o => !o)}
          >
            ÷{subdivisions}
          </button>
          {showSubdivDial && (
            <div className="subdiv-popup">
              <div className="subdiv-dial-large">
                <svg width={120} height={120} viewBox="0 0 120 120">
                  <circle cx={60} cy={60} r={48} fill="none" stroke="#333" strokeWidth={2} />
                  {Array.from({ length: 16 }, (_, i) => i + 1).map(val => {
                    const angle = ((val - 1) / 16) * 2 * Math.PI - Math.PI / 2;
                    const x = 60 + 48 * Math.cos(angle);
                    const y = 60 + 48 * Math.sin(angle);
                    const isActive = val === subdivisions;
                    return (
                      <g key={val} style={{ cursor: 'pointer' }} onClick={() => { handleSetSubdivisions(val); }}>
                        <circle cx={x} cy={y} r={isActive ? 10 : 7}
                          fill={isActive ? '#e67e22' : '#2a2a2a'}
                          stroke={isActive ? '#e67e22' : '#555'} strokeWidth={1}
                        />
                        <text x={x} y={y} textAnchor="middle" dominantBaseline="central"
                          fontSize={10} fontWeight="bold"
                          fill={isActive ? '#000' : '#999'}
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
                  max={64}
                  onChange={handleSetSubdivisions}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            </div>
          )}
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
      />
      <div className="status-bar">
        <span style={{ color: (freeMode || fingeringMode || machineGunMode) ? '#e67e22' : '#888' }}>
          {freeMode ? 'FREE ' : ''}{fingeringMode ? 'FINGERING ' : ''}{machineGunMode ? 'DRAW ' : ''}{notes.length} notes{selectedNotes.size > 0 ? ` (${selectedNotes.size} selected)` : ''} | Beat: {selectedBeat + 1} | Bar: {Math.floor(selectedBeat / SUBDIVISIONS) + 1}
        </span>
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
        <span style={{ fontSize: '11px', color: '#888', minWidth: 28 }}>{Math.round(defaultVelocity * 100)}%</span>
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
        <button onClick={() => {
          if (selectedNotes.size > 0) {
            const sel = notes.filter((_, i) => selectedNotes.has(i));
            const minBeat = Math.min(...sel.map(n => n.beat));
            clipboardRef.current = sel.map(n => ({ ...n, beat: n.beat - minBeat }));
          }
        }} title="Copy">Copy</button>
        <button onClick={() => {
          if (clipboardRef.current.length > 0) {
            const pasteAt = selectedBeat;
            const newNotes = clipboardRef.current.map(n => ({ ...n, beat: n.beat + pasteAt }));
            const baseIdx = notes.length;
            setNotes(prev => [...prev, ...newNotes]);
            setSelectedNotes(new Set(newNotes.map((_, i) => baseIdx + i)));
          }
        }} title="Paste">Paste</button>
        <span className="mobile-actions-sep" />
        <button className={freeMode ? 'active' : ''} onClick={() => setFreeMode(m => !m)}>Free</button>
        <button className={fingeringMode ? 'active' : ''} onClick={() => { fingeringModeRef.current = !fingeringModeRef.current; setFingeringMode(fingeringModeRef.current); }}>Finger</button>
      </div>
      <div className="main-area">
        <Fretboard
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
          barSubdivisions={barSubdivisions}
          setBarSubdivisions={setBarSubdivisions}
          setTimelineZoom={setTimelineZoom}
          currentBeat={currentBeat}
          selectedBeat={selectedBeat}
          setSelectedBeat={setSelectedBeat}
          playing={playing}
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
          eraserMode={eraserMode}
          machineGunMode={machineGunMode}
          defaultVelocity={defaultVelocity}
          noteDuration={noteDuration}
          setNoteDuration={setNoteDuration}
          onResizeDuration={setNoteDuration}
          snapUnit={snapUnit}
          subdivisions={subdivisions}
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
            waveformPeaks: t.waveformPeaks,
            isActive: t.id === activeTrackId,
            bgOpacity: t.bgOpacity ?? 0.2,
            volume: t.volume,
          }))}
          bpm={bpm}
          timeSignature={timeSignature}
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
              noteDuration={noteDuration}
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
              <div className="cheatsheet-row">
                <span className="cheatsheet-key">Alt + Drag</span>
                <span className="cheatsheet-desc">Duplicate notes</span>
              </div>
              {Object.entries(hotkeys).filter(([, h]) => h.wheel).map(([id, h]) => (
                <div key={id} className="cheatsheet-row">
                  <span className="cheatsheet-key">{formatHotkey(h)}</span>
                  <span className="cheatsheet-desc">{h.label}</span>
                </div>
              ))}
            </div>
            <div style={{ textAlign: 'center', marginTop: 12, color: '#666', fontSize: 11 }}>
              Press <b>?</b> or click outside to close
            </div>
          </div>
        </div>
      )}

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
            stringColors, synesthesia, activeColorScheme,
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
          onHotkeysChange={setHotkeys}
        />
      )}
    </div>
  );
}

export default App;
