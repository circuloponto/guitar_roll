import { useState, useCallback, useRef, useEffect } from 'react';
import Fretboard from './components/Fretboard';
import Timeline from './components/Timeline';
import { playNote, playNoteAtTime, playClickAtTime, getAudioContext, getNoteName } from './utils/audio';
import { NUM_BARS, SUBDIVISIONS, BPM as DEFAULT_BPM } from './utils/constants';
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
  const [eraser, setEraser] = useState(false);
  const [noteDuration, setNoteDuration] = useState(1);
  const [selectedNotes, setSelectedNotes] = useState(new Set());
  const [bpm, setBpm] = useState(DEFAULT_BPM);
  const [metronome, setMetronome] = useState(false);
  const [fretboardZoom, setFretboardZoom] = useState(false);
  const [stringColors, setStringColors] = useState(['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff']);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [hoveredNote, setHoveredNote] = useState(null); // { stringIndex, fret }
  const [synesthesia, setSynesthesia] = useState([]); // [{ note: 'C', color: '#ff0000' }, ...]
  const [loop, setLoop] = useState(false);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(NUM_BARS * SUBDIVISIONS);
  const playingRef = useRef(false);
  const bpmRef = useRef(bpm);
  const metronomeRef = useRef(metronome);
  const loopRef = useRef(false);
  const loopStartRef = useRef(0);
  const loopEndRef = useRef(NUM_BARS * SUBDIVISIONS);
  const animFrameRef = useRef(null);

  // Keep refs in sync
  bpmRef.current = bpm;
  metronomeRef.current = metronome;
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

  const totalBeats = NUM_BARS * SUBDIVISIONS;
  const handlePlayRef = useRef(null);
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setSelectedBeat(b => Math.max(0, b - 1));
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setSelectedBeat(b => Math.min(totalBeats - 1, b + 1));
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
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [totalBeats, undo, redo]);

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
    const regionStart = loopStartRef.current;
    const regionEnd = loopEndRef.current;
    const regionDuration = regionEnd - regionStart;

    if (regionDuration <= 0) return;

    playingRef.current = true;
    setPlaying(true);

    const startTime = ctx.currentTime + 0.05;
    const lookahead = 0.1;
    let nextBeatIndex = 0; // counts subdivisions from start, independent of tempo
    let nextBeatTime = startTime; // when the next beat is scheduled to play

    const animate = () => {
      if (!playingRef.current) return;

      const now = ctx.currentTime;
      const secPerBeat = 60 / bpmRef.current / SUBDIVISIONS;
      const rStart = loopStartRef.current;
      const rEnd = loopEndRef.current;
      const rDuration = rEnd - rStart;

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
          className={`tool-btn ${loop ? 'active' : ''}`}
          onClick={() => setLoop(l => !l)}
          title="Loop playback"
        >
          ⟳ Loop
        </button>
        <button
          className={`tool-btn ${eraser ? 'active' : ''}`}
          onClick={() => setEraser(e => !e)}
          title="Eraser: click notes on timeline to delete"
        >
          ✕ Eraser
        </button>
        <button
          className={`tool-btn ${metronome ? 'active' : ''}`}
          onClick={() => setMetronome(m => !m)}
          title="Metronome"
        >
          Metronome
        </button>
        <button
          className={`tool-btn ${fretboardZoom ? 'active' : ''}`}
          onClick={() => setFretboardZoom(z => !z)}
          title="Zoom fretboard to follow played notes"
        >
          Zoom
        </button>
        <button
          className="tool-btn"
          onClick={() => setShowColorPicker(p => !p)}
          title="Customize string colors"
        >
          Colors
        </button>
        <span className="toolbar-separator" />
        <span style={{ fontSize: '12px', color: '#888', marginRight: 4 }}>BPM:</span>
        <input
          type="number"
          className="bpm-input"
          defaultValue={bpm}
          min={30}
          max={300}
          key="bpm-input"
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
        <span style={{ fontSize: '12px', color: '#888' }}>
          {notes.length} notes{selectedNotes.size > 0 ? ` (${selectedNotes.size} selected)` : ''} | Beat: {selectedBeat + 1} | Bar: {Math.floor(selectedBeat / SUBDIVISIONS) + 1}
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
          activeNotes={playing ? [] : notes.filter(n => n.beat === selectedBeat)}
          playingNotes={playing && currentBeat !== null
            ? notes.filter(n => currentBeat >= n.beat && currentBeat < n.beat + (n.duration || 1))
            : []}
          zoom={fretboardZoom}
          zoomNotes={fretboardZoom ? notes.filter(n => n.beat >= loopStart && n.beat < loopEnd) : []}
          stringColors={stringColors}
          getNoteColor={getNoteColor}
          hoveredNote={hoveredNote}
          setHoveredNote={setHoveredNote}
        />
        <Timeline
          notes={notes}
          setNotes={setNotes}
          saveSnapshot={saveSnapshot}
          setNotesDrag={setNotesDrag}
          commitDrag={commitDrag}
          currentBeat={currentBeat}
          selectedBeat={selectedBeat}
          setSelectedBeat={setSelectedBeat}
          playing={playing}
          eraser={eraser}
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
        />
      </div>

      {/* Color Picker Popup */}
      {showColorPicker && (
        <div className="color-picker-overlay" onClick={() => setShowColorPicker(false)}>
          <div className="color-picker-popup" onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>String Colors</h3>
            {['E', 'A', 'D', 'G', 'B', 'e'].map((name, i) => (
              <div key={i} className="color-picker-row">
                <span className="color-picker-label">{name}</span>
                <input
                  type="color"
                  value={stringColors[i]}
                  onChange={(e) => setStringColors(prev => {
                    const next = [...prev];
                    next[i] = e.target.value;
                    return next;
                  })}
                />
                <span className="color-picker-hex">{stringColors[i]}</span>
              </div>
            ))}
            <hr style={{ border: 'none', borderTop: '1px solid #444', margin: '14px 0' }} />
            <h3 style={{ margin: '0 0 10px', fontSize: 16 }}>Synesthesia</h3>
            <p style={{ fontSize: 11, color: '#888', margin: '0 0 10px' }}>Map note names to colors (overrides string colors)</p>
            {synesthesia.map((s, i) => (
              <div key={i} className="color-picker-row">
                <select
                  value={s.note}
                  onChange={(e) => setSynesthesia(prev => {
                    const next = [...prev];
                    next[i] = { ...next[i], note: e.target.value };
                    return next;
                  })}
                  className="synesthesia-select"
                >
                  <option value="">--</option>
                  {['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
                <input
                  type="color"
                  value={s.color}
                  onChange={(e) => setSynesthesia(prev => {
                    const next = [...prev];
                    next[i] = { ...next[i], color: e.target.value };
                    return next;
                  })}
                />
                <span className="color-picker-hex">{s.color}</span>
                <button
                  className="synesthesia-remove"
                  onClick={() => setSynesthesia(prev => prev.filter((_, j) => j !== i))}
                  title="Remove"
                >
                  x
                </button>
              </div>
            ))}
            <button
              className="tool-btn"
              style={{ marginTop: 6, width: '100%', fontSize: 18, padding: '4px' }}
              onClick={() => setSynesthesia(prev => [...prev, { note: '', color: '#ffffff' }])}
            >
              +
            </button>
            <button className="tool-btn" style={{ marginTop: 12, width: '100%' }} onClick={() => setShowColorPicker(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
