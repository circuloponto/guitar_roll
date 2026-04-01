import { useState, useCallback, useRef } from 'react';
import Fretboard from './components/Fretboard';
import Timeline from './components/Timeline';
import { playNote, playNoteAtTime, getAudioContext } from './utils/audio';
import { NUM_BARS, SUBDIVISIONS, BPM } from './utils/constants';
import './App.css';

function App() {
  const [notes, setNotes] = useState([]);
  const [playing, setPlaying] = useState(false);
  const [currentBeat, setCurrentBeat] = useState(null);
  const [selectedBeat, setSelectedBeat] = useState(0);
  const [eraser, setEraser] = useState(false);
  const [noteDuration, setNoteDuration] = useState(1);
  const [selectedNotes, setSelectedNotes] = useState(new Set());
  const [loop, setLoop] = useState(false);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(NUM_BARS * SUBDIVISIONS);
  const playingRef = useRef(false);
  const loopRef = useRef(false);
  const loopStartRef = useRef(0);
  const loopEndRef = useRef(NUM_BARS * SUBDIVISIONS);
  const notesRef = useRef(notes);
  const animFrameRef = useRef(null);

  // Keep refs in sync
  loopRef.current = loop;
  loopStartRef.current = loopStart;
  loopEndRef.current = loopEnd;
  notesRef.current = notes;

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
    const secPerBeat = 60 / BPM / SUBDIVISIONS;
    const regionStart = loopStartRef.current;
    const regionEnd = loopEndRef.current;
    const regionDuration = regionEnd - regionStart;

    if (regionDuration <= 0) return;

    playingRef.current = true;
    setPlaying(true);

    const startTime = ctx.currentTime + 0.05;
    const lookahead = 0.1; // schedule 100ms ahead
    let scheduledUpTo = startTime; // audio-time frontier: everything before this is already scheduled

    const animate = () => {
      if (!playingRef.current) return;

      const now = ctx.currentTime;
      const rStart = loopStartRef.current;
      const rEnd = loopEndRef.current;
      const rDuration = rEnd - rStart;
      const totalSec = rDuration * secPerBeat;

      if (rDuration <= 0) { stopPlayback(); return; }

      // Update playhead position
      const elapsed = now - startTime;
      if (loopRef.current) {
        setCurrentBeat(rStart + ((elapsed / secPerBeat) % rDuration));
      } else {
        if (elapsed / secPerBeat >= rDuration) {
          stopPlayback();
          return;
        }
        setCurrentBeat(rStart + elapsed / secPerBeat);
      }

      // Schedule beats between scheduledUpTo and now + lookahead
      const scheduleEnd = now + lookahead;
      const currentNotes = notesRef.current;

      while (scheduledUpTo < scheduleEnd) {
        // What beat does scheduledUpTo correspond to?
        const offsetSec = scheduledUpTo - startTime;

        if (!loopRef.current && offsetSec >= totalSec) break;

        const offsetInLoop = loopRef.current
          ? ((offsetSec % totalSec) + totalSec) % totalSec
          : offsetSec;
        const beatInRegion = Math.floor(offsetInLoop / secPerBeat);
        const beat = rStart + beatInRegion;

        // Snap to exact beat time to stay aligned
        const beatTimeFrac = offsetInLoop - beatInRegion * secPerBeat;
        const beatTime = scheduledUpTo - beatTimeFrac;

        if (beat >= rStart && beat < rEnd && beatTimeFrac < 0.001) {
          currentNotes.forEach(note => {
            if (note.beat === beat) {
              const noteDuration = (note.duration || 1) * secPerBeat;
              playNoteAtTime(note.stringIndex, note.fret, beatTime, noteDuration);
            }
          });
        }

        // Advance to next beat
        scheduledUpTo = beatTime + secPerBeat;
      }

      animFrameRef.current = requestAnimationFrame(animate);
    };

    animFrameRef.current = requestAnimationFrame(animate);
  }, [playing, stopPlayback]);

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
          onMoveNote={handleMoveNote}
          activeNotes={playing ? [] : notes.filter(n => n.beat === selectedBeat)}
          playingNotes={playing && currentBeat !== null
            ? notes.filter(n => currentBeat >= n.beat && currentBeat < n.beat + (n.duration || 1))
            : []}
        />
        <Timeline
          notes={notes}
          setNotes={setNotes}
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
        />
      </div>
    </div>
  );
}

export default App;
