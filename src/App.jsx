import { useState, useCallback, useRef, useEffect } from 'react';
import Fretboard from './components/Fretboard';
import Timeline from './components/Timeline';
import { playNote, playNoteAtTime, playClickAtTime, getAudioContext, getNoteName } from './utils/audio';
import { NUM_BARS, SUBDIVISIONS, BPM as DEFAULT_BPM } from './utils/constants';
import { stateFromUrl, saveColorScheme } from './utils/storage';
import SettingsModal from './components/SettingsModal';
import './App.css';

function App() {
  const [notes, setNotesRaw] = useState([]);
  const notesRef = useRef(notes);
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);

  // Wrap setNotesRaw to keep notesRef always current
  const setNotesTracked = useCallback((updater) => {
    setNotesRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      notesRef.current = next;
      return next;
    });
  }, []);

  // setNotes: pushes undo, for one-shot operations (click to add/remove, etc.)
  const setNotes = useCallback((updater) => {
    undoStackRef.current.push(notesRef.current);
    if (undoStackRef.current.length > 200) undoStackRef.current.shift();
    redoStackRef.current = [];
    setNotesTracked(updater);
  }, [setNotesTracked]);

  // setNotesDrag: no undo push, for continuous drag updates
  const setNotesDrag = useCallback((updater) => {
    setNotesTracked(updater);
  }, [setNotesTracked]);

  // saveSnapshot: push undo once before a drag starts
  const saveSnapshot = useCallback(() => {
    undoStackRef.current.push(notesRef.current);
    if (undoStackRef.current.length > 200) undoStackRef.current.shift();
    redoStackRef.current = [];
  }, []);

  // commitDrag: no-op
  const commitDrag = useCallback(() => {}, []);

  const undo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;
    redoStackRef.current.push(notesRef.current);
    const prev = undoStackRef.current.pop();
    setNotesTracked(() => prev);
  }, [setNotesTracked]);

  const redo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    undoStackRef.current.push(notesRef.current);
    const next = redoStackRef.current.pop();
    setNotesTracked(() => next);
  }, [setNotesTracked]);
  const [playing, setPlaying] = useState(false);
  const [currentBeat, setCurrentBeat] = useState(null);
  const [selectedBeat, setSelectedBeat] = useState(0);
  const [noteDuration, setNoteDuration] = useState(1);
  const [selectedNotes, setSelectedNotes] = useState(new Set());
  const selectedNotesRef = useRef(selectedNotes);
  selectedNotesRef.current = selectedNotes;
  const [bpm, setBpm] = useState(DEFAULT_BPM);
  const [metronome, setMetronome] = useState(false);
  const [freeMode, setFreeMode] = useState(false);
  const [stringColors, setStringColors] = useState(['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff']);
  const [showSettings, setShowSettings] = useState(false);
  const [hoveredNote, setHoveredNote] = useState(null); // { stringIndex, fret }
  const [verticalScroll, setVerticalScroll] = useState(0);
  const [synesthesia, setSynesthesia] = useState([]); // [{ note: 'C', color: '#ff0000' }, ...]
  const [activeColorScheme, setActiveColorScheme] = useState(null); // { name, colors }
  const [loop, setLoop] = useState(false);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(NUM_BARS * SUBDIVISIONS);
  const playingRef = useRef(false);
  const bpmRef = useRef(bpm);
  const metronomeRef = useRef(metronome);
  const loopRef = useRef(false);
  const loopStartRef = useRef(0);
  const loopEndRef = useRef(NUM_BARS * SUBDIVISIONS);
  const selectedBeatRef = useRef(selectedBeat);
  const animFrameRef = useRef(null);

  // Keep refs in sync
  bpmRef.current = bpm;
  metronomeRef.current = metronome;
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
    if (data.notes !== undefined) setNotesTracked(data.notes);
    if (data.bpm !== undefined) setBpm(data.bpm);
    if (data.loop !== undefined) setLoop(data.loop);
    if (data.loopStart !== undefined) setLoopStart(data.loopStart);
    if (data.loopEnd !== undefined) setLoopEnd(data.loopEnd);
    if (data.stringColors !== undefined) setStringColors(data.stringColors);
    if (data.synesthesia !== undefined) setSynesthesia(data.synesthesia);
    if (data.noteDuration !== undefined) setNoteDuration(data.noteDuration);
    if (data.metronome !== undefined) setMetronome(data.metronome);
    if (data.activeColorScheme !== undefined) setActiveColorScheme(data.activeColorScheme);
    if (data.colorSchemes) {
      Object.entries(data.colorSchemes).forEach(([name, scheme]) => {
        saveColorScheme(name, scheme);
      });
    }
  }, [setNotesTracked]);

  // Load from URL on mount
  useEffect(() => {
    const urlState = stateFromUrl();
    if (urlState) {
      applyState(urlState);
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const totalBeats = NUM_BARS * SUBDIVISIONS;
  const handlePlayRef = useRef(null);
  const [noteJump, setNoteJump] = useState(false);
  const noteJumpRef = useRef(false);
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'n' || e.key === 'N') { noteJumpRef.current = !noteJumpRef.current; setNoteJump(noteJumpRef.current); return; }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (noteJumpRef.current) {
          // Jump to previous note beat
          const currentNotes = notesRef.current;
          setSelectedBeat(b => {
            const beats = [...new Set(currentNotes.map(n => Math.floor(n.beat)))].sort((a, c) => a - c);
            const prev = beats.filter(beat => beat < b);
            return prev.length > 0 ? prev[prev.length - 1] : b;
          });
        } else {
          setSelectedBeat(b => Math.max(0, b - 1));
        }
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (noteJumpRef.current) {
          // Jump to next note beat
          const currentNotes = notesRef.current;
          setSelectedBeat(b => {
            const beats = [...new Set(currentNotes.map(n => Math.floor(n.beat)))].sort((a, c) => a - c);
            const next = beats.filter(beat => beat > b);
            return next.length > 0 ? next[0] : b;
          });
        } else {
          setSelectedBeat(b => Math.min(totalBeats - 1, b + 1));
        }
      }
      if (e.key === ' ') {
        e.preventDefault();
        handlePlayRef.current();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
      if (e.key === 'f' || e.key === 'F') {
        setFreeMode(m => !m);
      }
      if (e.key === 'c' || e.key === 'C') {
        setLoop(l => !l);
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedNotesRef.current.size > 0) {
          e.preventDefault();
          setNotes(prev => prev.filter((_, i) => !selectedNotesRef.current.has(i)));
          setSelectedNotes(new Set());
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
      return [...filtered, { stringIndex, fret, beat: selectedBeat, duration: noteDuration }];
    });
  }, [selectedBeat, noteDuration]);

  const handleAdjacentClick = useCallback((stringIndex, fret) => {
    setNotes(prev => {
      const exactMatch = prev.findIndex(
        n => n.stringIndex === stringIndex && n.fret === fret && n.beat === selectedBeat
      );
      if (exactMatch >= 0) {
        return prev.filter((_, i) => i !== exactMatch);
      }
      // Don't remove existing notes on the same string — just add
      return [...prev, { stringIndex, fret, beat: selectedBeat, duration: noteDuration }];
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

  const handleSetDuration = useCallback((value) => {
    setNoteDuration(value);
    if (selectedNotes.size > 0) {
      setNotes(prev => prev.map((n, i) =>
        selectedNotes.has(i) ? { ...n, duration: value } : n
      ));
    }
  }, [selectedNotes]);

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

  const handlePlay = useCallback(() => {
    if (playing) {
      stopPlayback();
      return;
    }

    if (notesRef.current.length === 0) return;

    const ctx = getAudioContext();
    const isLoop = loopRef.current;
    const regionStart = isLoop ? loopStartRef.current : selectedBeatRef.current;
    const regionEnd = isLoop ? loopEndRef.current : NUM_BARS * SUBDIVISIONS;
    const regionDuration = regionEnd - regionStart;

    if (regionDuration <= 0) return;

    playingRef.current = true;
    setPlaying(true);

    const rStart = regionStart;
    const rEnd = regionEnd;
    const rDuration = regionDuration;
    const startTime = ctx.currentTime + 0.05;
    const lookahead = 0.1;
    let nextBeatIndex = 0;
    let nextBeatTime = startTime;

    const animate = () => {
      if (!playingRef.current) return;

      const now = ctx.currentTime;
      const secPerBeat = 60 / bpmRef.current / SUBDIVISIONS;

      if (rDuration <= 0) { stopPlayback(); return; }

      // Update playhead position based on next scheduled beat
      const playheadTime = now;
      const beatsSinceLastScheduled = (playheadTime - (nextBeatTime - secPerBeat)) / secPerBeat;
      const playheadBeatIndex = nextBeatIndex - 1 + Math.min(1, Math.max(0, beatsSinceLastScheduled));
      const playheadBeat = rStart + (playheadBeatIndex % rDuration);

      if (!loopRef.current && playheadBeatIndex >= rDuration) {
        stopPlayback();
        return;
      }

      setCurrentBeat(playheadBeat);

      // Schedule upcoming beats
      const scheduleEnd = now + lookahead;
      const currentNotes = notesRef.current;

      while (nextBeatTime <= scheduleEnd) {
        if (!loopRef.current && nextBeatIndex >= rDuration) break;

        const beatInRegion = nextBeatIndex % rDuration;
        const beat = rStart + beatInRegion;

        currentNotes.forEach(note => {
          if (note.beat === beat) {
            const noteDur = (note.duration || 1) * secPerBeat;
            playNoteAtTime(note.stringIndex, note.fret, nextBeatTime, noteDur);
          }
        });

        if (metronomeRef.current && beat % SUBDIVISIONS === 0) {
          const isDownbeat = beat % (SUBDIVISIONS * 4) === 0;
          playClickAtTime(nextBeatTime, isDownbeat);
        }

        nextBeatIndex++;
        nextBeatTime += secPerBeat;
      }

      animFrameRef.current = requestAnimationFrame(animate);
    };

    animFrameRef.current = requestAnimationFrame(animate);
  }, [playing, stopPlayback]);
  handlePlayRef.current = handlePlay;

  const handleClear = useCallback(() => {
    setNotes([]);
    setSelectedNotes(new Set());
  }, []);

  return (
    <div className="app">
      <div className="toolbar">
        <h1>Guitar Roll</h1>
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
          className="tool-btn"
          onClick={() => setShowSettings(true)}
          title="Settings, colors, save/load"
        >
          Settings
        </button>
        <span className="toolbar-separator" />
        <span style={{ fontSize: '12px', color: '#888', marginRight: 4 }}>BPM:</span>
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
        <span className="toolbar-separator" />
        <button className="play-btn" onClick={handleClear}>
          Clear
        </button>
        <span className="toolbar-separator" />
        <span style={{ fontSize: '12px', color: '#888', marginRight: 4 }}>Duration:</span>
        {[
          { value: 1, label: '1/16' },
          { value: 2, label: '1/8' },
          { value: 4, label: '1/4' },
          { value: 8, label: '1/2' },
          { value: 16, label: '1/1' },
        ].map(d => (
          <button
            key={d.value}
            className={`tool-btn ${noteDuration === d.value ? 'active' : ''}`}
            onClick={() => handleSetDuration(d.value)}
            title={`${d.label} note`}
          >
            {d.label}
          </button>
        ))}
        <span className="toolbar-separator" />
        <span style={{ fontSize: '12px', color: (freeMode || loop || noteJump) ? '#e67e22' : '#888' }}>
          {freeMode ? 'FREE ' : ''}{loop ? 'LOOP ' : ''}{noteJump ? 'JUMP ' : ''}{notes.length} notes{selectedNotes.size > 0 ? ` (${selectedNotes.size} selected)` : ''} | Beat: {selectedBeat + 1} | Bar: {Math.floor(selectedBeat / SUBDIVISIONS) + 1}
        </span>
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
          activeNotes={playing ? [] : notes.filter(n => selectedBeat >= n.beat && selectedBeat < n.beat + (n.duration || 1))}
          playingNotes={playing && currentBeat !== null
            ? notes.filter(n => currentBeat >= n.beat && currentBeat < n.beat + (n.duration || 1))
            : []}
          stringColors={stringColors}
          getNoteColor={getNoteColor}
          hoveredNote={hoveredNote}
          setHoveredNote={setHoveredNote}
          verticalScroll={verticalScroll}
          setVerticalScroll={setVerticalScroll}
        />
        <Timeline
          notes={notes}
          setNotes={setNotes}
          saveSnapshot={saveSnapshot}
          setNotesDrag={setNotesDrag}
          commitDrag={commitDrag}
          freeMode={freeMode}
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
          selectedNotes={selectedNotes}
          setSelectedNotes={setSelectedNotes}
          stringColors={stringColors}
          getNoteColor={getNoteColor}
          hoveredNote={hoveredNote}
          setHoveredNote={setHoveredNote}
          verticalScroll={verticalScroll}
          setVerticalScroll={setVerticalScroll}
        />
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <SettingsModal
          appState={{
            notes, bpm, loop, loopStart, loopEnd,
            stringColors, synesthesia, activeColorScheme,
            noteDuration, metronome,
          }}
          onApplyState={applyState}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

export default App;
