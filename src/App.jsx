import { useState, useCallback, useRef, useEffect } from 'react';
import Fretboard from './components/Fretboard';
import Timeline from './components/Timeline';
import { playNote, playNoteAtTime, playClickAtTime, getAudioContext, getNoteName, INSTRUMENTS, getAllInstruments, setInstrument, getInstrument, saveCustomPreset } from './utils/audio';
import { NUM_BARS, SUBDIVISIONS, BPM as DEFAULT_BPM } from './utils/constants';
import { defaultBarSubdivisions, totalColumns, beatToBar, beatToTime, colDurationAtBeat, remapNotes, barStartBeats } from './utils/barLayout';
import { stateFromUrl, saveColorScheme, saveChordLibrary, getSessionState, saveAutosave, loadAutosave } from './utils/storage';
import { loadHotkeys, matchesHotkey, formatHotkey } from './utils/hotkeys';
import { getMidiNote } from './utils/pitchMap';
import { NUM_STRINGS, NUM_FRETS } from './utils/constants';
import SettingsModal from './components/SettingsModal';
import TrackStrip from './components/TrackStrip';
import SynthEditor from './components/SynthEditor';
import ChordPalette from './components/ChordPalette';
import './App.css';

function createDefaultTrack(name = 'Track 1', instrument = 'clean-electric') {
  return { id: crypto.randomUUID(), name, instrument, notes: [], volume: 1, muted: false, solo: false };
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
  const [noteMultiplier, setNoteMultiplier] = useState(1); // how many subdivisions per note
  const snapUnit = 1 / subdivisions; // smallest grid step
  const noteDuration = noteMultiplier / subdivisions; // actual note duration in beats
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
  const [fingeringMode, setFingeringMode] = useState(false);
  const fingeringModeRef = useRef(false);
  const [timelineZoom, setTimelineZoom] = useState(1);
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

  const getNoteColor = useCallback((stringIndex, fret) => {
    const name = getNoteName(stringIndex, fret);
    const letter = name.replace(/[0-9]/g, '');
    if (synesthesiaMap[letter]) return synesthesiaMap[letter];
    return stringColors[stringIndex];
  }, [stringColors, synesthesia]);

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
    if (data.noteMultiplier !== undefined) setNoteMultiplier(data.noteMultiplier);
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

  // Autosave every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      const state = getSessionState({
        tracks: tracksRef.current,
        bpm, loop, loopStart, loopEnd,
        stringColors, synesthesia, activeColorScheme,
        projectName, subdivisions, noteMultiplier, metronome, barSubdivisions, timeSignature,
      });
      saveAutosave(state);
    }, 30000);
    return () => clearInterval(interval);
  }, [bpm, loop, loopStart, loopEnd, stringColors, synesthesia, activeColorScheme, projectName, subdivisions, noteMultiplier, metronome, barSubdivisions, timeSignature]);

  const totalBeats = totalColumns(barSubdivisions);
  const handlePlayRef = useRef(null);
  const [noteJump, setNoteJump] = useState(false);
  const noteJumpRef = useRef(false);
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT') return;
      const hk = hotkeysRef.current;

      if (matchesHotkey(e, hk.noteJump)) {
        noteJumpRef.current = !noteJumpRef.current;
        setNoteJump(noteJumpRef.current);
        return;
      }
      if (matchesHotkey(e, hk.prevBeat)) {
        e.preventDefault();
        if (noteJumpRef.current) {
          const currentNotes = notesRef.current;
          setSelectedBeat(b => {
            const beats = [...new Set(currentNotes.map(n => Math.floor(n.beat)))].sort((a, c) => a - c);
            const prev = beats.filter(beat => beat < b);
            return prev.length > 0 ? prev[prev.length - 1] : b;
          });
        } else {
          const step = noteDurationRef.current;
          setSelectedBeat(b => Math.max(0, b - step));
        }
      }
      if (matchesHotkey(e, hk.nextBeat)) {
        e.preventDefault();
        if (noteJumpRef.current) {
          const currentNotes = notesRef.current;
          setSelectedBeat(b => {
            const beats = [...new Set(currentNotes.map(n => Math.floor(n.beat)))].sort((a, c) => a - c);
            const next = beats.filter(beat => beat > b);
            return next.length > 0 ? next[0] : b;
          });
        } else {
          const step = noteDurationRef.current;
          setSelectedBeat(b => Math.min(totalBeats - 1, b + step));
        }
      }
      if (matchesHotkey(e, hk.returnToStart)) {
        e.preventDefault();
        setSelectedBeat(0);
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
      if (matchesHotkey(e, hk.zoomIn)) {
        e.preventDefault();
        setTimelineZoom(z => Math.min(10, z * 1.25));
      }
      if (matchesHotkey(e, hk.zoomOut)) {
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
    setNotes(prev => {
      const exactMatch = prev.findIndex(
        n => n.stringIndex === stringIndex && n.fret === fret && n.beat === selectedBeat
      );
      if (exactMatch >= 0) {
        return prev.filter((_, i) => i !== exactMatch);
      }
      const filtered = prev.filter(
        n => !(n.stringIndex === stringIndex && n.beat === selectedBeat)
      );
      return [...filtered, { stringIndex, fret, beat: selectedBeat, duration: noteDuration, velocity: defaultVelocity }];
    });
  }, [selectedBeat, noteDuration, defaultVelocity]);

  const handleAdjacentClick = useCallback((stringIndex, fret) => {
    setNotes(prev => {
      const exactMatch = prev.findIndex(
        n => n.stringIndex === stringIndex && n.fret === fret && n.beat === selectedBeat
      );
      if (exactMatch >= 0) {
        return prev.filter((_, i) => i !== exactMatch);
      }
      // Don't remove existing notes on the same string — just add
      return [...prev, { stringIndex, fret, beat: selectedBeat, duration: noteDuration, velocity: defaultVelocity }];
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
    setNoteMultiplier(1);
  }, []);

  const handleSetMultiplier = useCallback((mult) => {
    setNoteMultiplier(mult);
    if (selectedNotes.size > 0) {
      const dur = mult / subdivisions;
      setNotes(prev => prev.map((n, i) =>
        selectedNotes.has(i) ? { ...n, duration: dur } : n
      ));
    }
  }, [selectedNotes, subdivisions]);


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
  }, []);

  const startPlayback = useCallback((fromBeat) => {
    const playable = getPlayableTracks(tracksRef.current);
    if (playable.every(t => t.notes.length === 0)) return;

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
          track.notes.forEach(note => {
            if (note.beat >= beat && note.beat < beat + 1) {
              const offset = (note.beat - beat) * colDur;
              const noteDur = (note.duration || 1) * colDur;
              playNoteAtTime(note.stringIndex, note.fret, nextBeatTime + offset, noteDur, note.velocity ?? 0.8, track.instrument, track.volume);
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
  }, [stopPlayback]);

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
        <input
          type="number"
          className="bpm-input"
          value={barSubdivisions.length}
          min={1}
          max={128}
          onChange={(e) => {
            const newCount = Math.max(1, Math.min(128, Number(e.target.value) || 1));
            setBarSubdivisions(prev => {
              if (newCount > prev.length) {
                // Add bars with current time signature
                return [...prev, ...Array(newCount - prev.length).fill(timeSignature[0])];
              } else if (newCount < prev.length) {
                // Remove bars from the end, delete notes in removed bars
                const tc = totalColumns(prev.slice(0, newCount));
                setActiveNotes(notesRef.current.filter(n => n.beat < tc));
                return prev.slice(0, newCount);
              }
              return prev;
            });
          }}
        />
        <span className="toolbar-label">BPM:</span>
        <input
          type="number"
          className="bpm-input"
          defaultValue={bpm}
          min={30}
          max={300}
          key={`bpm-${bpm}`}
          onBlur={(e) => setBpm(Math.max(30, Math.min(300, Number(e.target.value) || 120)))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.target.blur();
            }
          }}
        />
        <button className="play-btn" onClick={handleClear}>
          Clear
        </button>
        <span className="toolbar-separator" />
        <div className="subdiv-picker" ref={subdivDialRef}>
          <button
            className={`subdiv-btn ${showSubdivDial ? 'open' : ''}`}
            onClick={() => setShowSubdivDial(o => !o)}
          >
            ÷{subdivisions} x{noteMultiplier}
            {noteDuration !== 1 && <span className="subdiv-val"> ={noteDuration.toFixed(3)}</span>}
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
                <input
                  className="subdiv-center-input"
                  type="number"
                  value={subdivisions}
                  min={1}
                  max={64}
                  onChange={(e) => {
                    const v = Math.max(1, Math.min(64, Number(e.target.value) || 1));
                    handleSetSubdivisions(v);
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
              <div className="subdiv-mult-row">
                <span style={{ fontSize: 12, color: '#aaa' }}>Multiplier:</span>
                <input
                  type="number"
                  className="subdiv-mult-input"
                  value={noteMultiplier}
                  min={1}
                  max={subdivisions * 8}
                  onChange={(e) => handleSetMultiplier(Math.max(1, Number(e.target.value) || 1))}
                  onKeyDown={(e) => e.stopPropagation()}
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
        onRenameTrack={handleRenameTrack}
      />
      <div className="status-bar">
        <span style={{ color: (freeMode || noteJump || fingeringMode || machineGunMode) ? '#e67e22' : '#888' }}>
          {freeMode ? 'FREE ' : ''}{noteJump ? 'JUMP ' : ''}{fingeringMode ? 'FINGERING ' : ''}{machineGunMode ? 'DRAW ' : ''}{notes.length} notes{selectedNotes.size > 0 ? ` (${selectedNotes.size} selected)` : ''} | Beat: {selectedBeat + 1} | Bar: {Math.floor(selectedBeat / SUBDIVISIONS) + 1}
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
        <button className={noteJump ? 'active' : ''} onClick={() => { noteJumpRef.current = !noteJumpRef.current; setNoteJump(noteJumpRef.current); }}>Jump</button>
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
          playingNotes={playing && currentBeat !== null
            ? getPlayableTracks(tracks).flatMap(t => t.notes.filter(n => currentBeat >= n.beat && currentBeat < n.beat + (n.duration || 1)))
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
        />
        <Timeline
          notes={notes}
          backgroundNotes={tracks.filter(t => t.id !== activeTrackId && !t.muted).flatMap(t =>
            t.notes.map(n => ({ ...n, _trackColor: '#888' }))
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
          snapUnit={snapUnit}
          subdivisions={subdivisions}
          hotkeys={hotkeys}
          hoverPreviewPiano={hoverPreview.pianoRoll}
          hoverPreviewNotes={hoverPreview.timelineNotes}
          hoverVolume={hoverPreview.volume}
          onResizeDuration={(dur) => {
            // Convert resized duration to multiplier
            const mult = Math.max(1, Math.round(dur / snapUnit));
            setNoteMultiplier(mult);
          }}
          chordPreview={chordPreview}
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
            projectName, subdivisions, noteMultiplier, metronome, barSubdivisions, timeSignature,
          }}
          onApplyState={applyState}
          onClose={() => setShowSettings(false)}
          hoverPreview={hoverPreview}
          onHoverPreviewChange={(v) => { setHoverPreview(v); localStorage.setItem('guitar-roll-hover-preview', JSON.stringify(v)); }}
          onHotkeysChange={setHotkeys}
        />
      )}
    </div>
  );
}

export default App;
