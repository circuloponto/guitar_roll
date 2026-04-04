import { useState, useCallback, useRef, useEffect } from 'react';
import Fretboard from './components/Fretboard';
import Timeline from './components/Timeline';
import { playNote, playNoteAtTime, playClickAtTime, getAudioContext, getNoteName } from './utils/audio';
import { NUM_BARS, SUBDIVISIONS, BPM as DEFAULT_BPM } from './utils/constants';
import { defaultBarSubdivisions, totalColumns, beatToBar, beatToTime, colDurationAtBeat, remapNotes, barStartBeats } from './utils/barLayout';
import { stateFromUrl, saveColorScheme } from './utils/storage';
import { loadHotkeys, matchesHotkey } from './utils/hotkeys';
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
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [stringColors, setStringColors] = useState(['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff']);
  const [showSettings, setShowSettings] = useState(false);
  const [hotkeys, setHotkeys] = useState(loadHotkeys);
  const hotkeysRef = useRef(hotkeys);
  hotkeysRef.current = hotkeys;
  const [hoveredNote, setHoveredNote] = useState(null); // { stringIndex, fret }
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
    if (data.barSubdivisions !== undefined) setBarSubdivisions(data.barSubdivisions);
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
          setSelectedBeat(b => Math.max(0, b - 1));
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
          setSelectedBeat(b => Math.min(totalBeats - 1, b + 1));
        }
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
      if (matchesHotkey(e, hk.freeMode)) {
        setFreeMode(m => !m);
      }
      if (matchesHotkey(e, hk.deleteNotes) || matchesHotkey(e, hk.deleteNotesAlt)) {
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

  const startPlayback = useCallback((fromBeat) => {
    if (notesRef.current.length === 0) return;

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
      const currentColDur = colDurationAtBeat(Math.min(currentBeatAbs, tc - 1), bs, bpm);
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
      const currentNotes = notesRef.current;

      while (nextBeatTime <= scheduleEnd) {
        if (!loopRef.current && nextBeatIndex >= rDuration) break;

        const beatInRegion = nextBeatIndex % rDuration;
        const beat = rStart + beatInRegion;
        const colDur = colDurationAtBeat(Math.min(beat, tc - 1), bs, bpm);

        currentNotes.forEach(note => {
          if (note.beat >= beat && note.beat < beat + 1) {
            const offset = (note.beat - beat) * colDur;
            const noteDur = (note.duration || 1) * colDur;
            playNoteAtTime(note.stringIndex, note.fret, nextBeatTime + offset, noteDur);
          }
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
        <span style={{ fontSize: '12px', color: (freeMode || noteJump) ? '#e67e22' : '#888' }}>
          {freeMode ? 'FREE ' : ''}{noteJump ? 'JUMP ' : ''}{notes.length} notes{selectedNotes.size > 0 ? ` (${selectedNotes.size} selected)` : ''} | Beat: {selectedBeat + 1} | Bar: {Math.floor(selectedBeat / SUBDIVISIONS) + 1}
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
          hotkeys={hotkeys}
        />
        <Timeline
          notes={notes}
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
            noteDuration, metronome, barSubdivisions,
          }}
          onApplyState={applyState}
          onClose={() => setShowSettings(false)}
          onHotkeysChange={setHotkeys}
        />
      )}
    </div>
  );
}

export default App;
