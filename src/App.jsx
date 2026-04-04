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
  const [baseNoteDuration, setBaseNoteDuration] = useState(1);
  const [tuplet, setTuplet] = useState(1);
  const noteDuration = tuplet <= 1 ? baseNoteDuration : baseNoteDuration * (tuplet - 1) / tuplet;
  const noteDurationRef = useRef(noteDuration);
  noteDurationRef.current = noteDuration;
  const tupletRef = useRef(tuplet);
  tupletRef.current = tuplet;
  const [selectedNotes, setSelectedNotes] = useState(new Set());
  const selectedNotesRef = useRef(selectedNotes);
  selectedNotesRef.current = selectedNotes;
  const [timeSignature, setTimeSignature] = useState([4, 4]); // [numerator, denominator]
  const [bpm, setBpm] = useState(DEFAULT_BPM);
  const [metronome, setMetronome] = useState(false);
  const clipboardRef = useRef([]);
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
    if (data.notes !== undefined) setNotesTracked(data.notes);
    if (data.bpm !== undefined) setBpm(data.bpm);
    if (data.loop !== undefined) setLoop(data.loop);
    if (data.loopStart !== undefined) setLoopStart(data.loopStart);
    if (data.loopEnd !== undefined) setLoopEnd(data.loopEnd);
    if (data.stringColors !== undefined) setStringColors(data.stringColors);
    if (data.synesthesia !== undefined) setSynesthesia(data.synesthesia);
    if (data.noteDuration !== undefined) setBaseNoteDuration(data.noteDuration);
    if (data.metronome !== undefined) setMetronome(data.metronome);
    if (data.activeColorScheme !== undefined) setActiveColorScheme(data.activeColorScheme);
    if (data.barSubdivisions !== undefined) setBarSubdivisions(data.barSubdivisions);
    if (data.timeSignature !== undefined) setTimeSignature(data.timeSignature);
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
          const step = tupletRef.current > 1 ? noteDurationRef.current : 1;
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
          const step = tupletRef.current > 1 ? noteDurationRef.current : 1;
          setSelectedBeat(b => Math.min(totalBeats - 1, b + step));
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

  const handleSetDuration = useCallback((base, tup) => {
    setBaseNoteDuration(base);
    setTuplet(tup);
    const dur = tup <= 1 ? base : base * (tup - 1) / tup;
    if (selectedNotes.size > 0) {
      setNotes(prev => prev.map((n, i) =>
        selectedNotes.has(i) ? { ...n, duration: dur } : n
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
      const currentNotes = notesRef.current;

      while (nextBeatTime <= scheduleEnd) {
        if (!loopRef.current && nextBeatIndex >= rDuration) break;

        const beatInRegion = nextBeatIndex % rDuration;
        const beat = rStart + beatInRegion;
        const colDur = colDurationAtBeat(Math.min(beat, tc - 1), bs, bpm, timeSigRef.current[1]);

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
        <span style={{ fontSize: '12px', color: '#888', marginRight: 4 }}>Time:</span>
        <select
          className="duration-select"
          value={`${timeSignature[0]}/${timeSignature[1]}`}
          onChange={(e) => {
            const [num, den] = e.target.value.split('/').map(Number);
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
              setNotesTracked(remapped);
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
        <span style={{ fontSize: '12px', color: '#888', marginLeft: 8, marginRight: 4 }}>Bars:</span>
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
                setNotesTracked(notesRef.current.filter(n => n.beat < tc));
                return prev.slice(0, newCount);
              }
              return prev;
            });
          }}
        />
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
        <select
          className="duration-select"
          value={baseNoteDuration}
          onChange={(e) => handleSetDuration(Number(e.target.value), tuplet)}
        >
          <option value={1}>1/16</option>
          <option value={2}>1/8</option>
          <option value={4}>1/4</option>
          <option value={8}>1/2</option>
          <option value={16}>1/1</option>
        </select>
        <span style={{ fontSize: '12px', color: '#888', marginLeft: 8, marginRight: 4 }}>Tuplet:</span>
        <input
          type="number"
          className="tuplet-input"
          value={tuplet}
          min={1}
          max={15}
          onChange={(e) => {
            const val = Math.max(1, Math.min(15, Number(e.target.value) || 1));
            handleSetDuration(baseNoteDuration, val);
          }}
        />
        {tuplet > 1 && (
          <span style={{ fontSize: '11px', color: '#e67e22', marginLeft: 4 }}>
            = {noteDuration.toFixed(2)} beats
          </span>
        )}
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
          totalBeats={totalBeats}
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
            noteDuration: baseNoteDuration, metronome, barSubdivisions, timeSignature,
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
