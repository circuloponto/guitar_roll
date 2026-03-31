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
  const [loop, setLoop] = useState(false);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(NUM_BARS * SUBDIVISIONS);
  const playingRef = useRef(false);
  const loopRef = useRef(false);
  const loopStartRef = useRef(0);
  const loopEndRef = useRef(NUM_BARS * SUBDIVISIONS);
  const animFrameRef = useRef(null);

  // Keep refs in sync
  loopRef.current = loop;
  loopStartRef.current = loopStart;
  loopEndRef.current = loopEnd;

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
      return [...filtered, { stringIndex, fret, beat: selectedBeat, duration: 1 }];
    });
  }, [selectedBeat]);

  const handleDeleteNote = useCallback((noteIndex) => {
    setNotes(prev => prev.filter((_, i) => i !== noteIndex));
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

    if (notes.length === 0) return;

    const ctx = getAudioContext();
    const secPerBeat = 60 / BPM / SUBDIVISIONS;
    const regionStart = loopStart;
    const regionEnd = loopEnd;
    const regionDuration = regionEnd - regionStart;

    if (regionDuration <= 0) return;

    // Only play notes within the loop region
    const regionNotes = notes.filter(n => n.beat >= regionStart && n.beat < regionEnd);

    const scheduleRegion = (startTime) => {
      regionNotes.forEach(note => {
        const noteTime = startTime + (note.beat - regionStart) * secPerBeat;
        const noteDuration = (note.duration || 1) * secPerBeat;
        playNoteAtTime(note.stringIndex, note.fret, noteTime, noteDuration);
      });
      return startTime + regionDuration * secPerBeat;
    };

    const startTime = ctx.currentTime + 0.1;
    let loopEndTime = scheduleRegion(startTime);

    playingRef.current = true;
    setPlaying(true);

    const animate = () => {
      if (!playingRef.current) return;

      const now = ctx.currentTime;
      const elapsed = now - startTime;
      const totalSec = regionDuration * secPerBeat;

      if (loopRef.current) {
        const loopElapsed = elapsed % totalSec;
        setCurrentBeat(regionStart + loopElapsed / secPerBeat);

        if (now > loopEndTime - 0.2) {
          loopEndTime = scheduleRegion(loopEndTime);
        }
      } else {
        const beat = elapsed / secPerBeat;
        if (beat >= regionDuration) {
          stopPlayback();
          return;
        }
        setCurrentBeat(regionStart + beat);
      }

      animFrameRef.current = requestAnimationFrame(animate);
    };

    animFrameRef.current = requestAnimationFrame(animate);
  }, [playing, notes, stopPlayback, loopStart, loopEnd]);

  const handleClear = useCallback(() => {
    setNotes([]);
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
        <span style={{ fontSize: '12px', color: '#888' }}>
          {notes.length} notes | Beat: {selectedBeat + 1} | Bar: {Math.floor(selectedBeat / SUBDIVISIONS) + 1}
        </span>
      </div>
      <div className="main-area">
        <Fretboard onNoteClick={handleFretClick} activeNotes={notes.filter(n => n.beat === selectedBeat)} />
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
        />
      </div>
    </div>
  );
}

export default App;
