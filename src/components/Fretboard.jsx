import { useRef, useState, useCallback, useEffect } from 'react';
import { NUM_STRINGS, NUM_FRETS, FRET_DOTS, DOUBLE_DOTS, CELL_WIDTH, SUBDIVISIONS } from '../utils/constants';
import { playNote, getNoteName } from '../utils/audio';
import { matchesHotkey, formatHotkey } from '../utils/hotkeys';

// totalBeats passed as prop (totalBeats)

const PADDING_LEFT = 12;
const PADDING_RIGHT = 8;
const BASE_FRET_HEIGHT = 40; // pixels per fret cell at zoom 1

// Total cells = NUM_FRETS + 1 (fret 0 is open string, frets 1..NUM_FRETS are normal)
const TOTAL_CELLS = NUM_FRETS + 1;



export default function Fretboard({ onNoteClick, onAdjacentClick, onMoveNote, onDurationChange, onBeatChange, saveSnapshot, commitDrag, freeMode = false, totalBeats, activeNotes = [], backgroundActiveNotes = [], playingNotes = [], stringColors, getNoteColor, hoveredNote, setHoveredNote, hotkeys, hoverPreview = false, hoverVolume = 0.3, snapUnit = 1, fretboardZoom = 1, setFretboardZoom, voicingPreview, fingeringMode = false, notes = [], selectedBeat, selectedNotes, setSelectedNotes, autoScroll, hoverPill }) {
  const FRET_HEIGHT = BASE_FRET_HEIGHT * fretboardZoom;
  const GRID_HEIGHT = TOTAL_CELLS * FRET_HEIGHT;
  const cellTopPx = (cell) => cell * FRET_HEIGHT;
  const cellCenterPx = (cell) => (cell + 0.5) * FRET_HEIGHT;
  const containerRef = useRef(null);
  const scrollRef = useRef(null);
  const [hover, setHover] = useState(null);
  const lastPreviewRef = useRef(null);
  const [dragNote, setDragNote] = useState(null); // { stringIndex, fret } of note being dragged
  const dragStartRef = useRef(null); // tracks mousedown position to distinguish click vs drag
  const didDragRef = useRef(false);
  const [durationMode, setDurationMode] = useState(false);
  const [durationDrag, setDurationDrag] = useState(null);
  const durationDragRef = useRef(null);
  const [moveMode, setMoveMode] = useState(false);
  const [adjacentMode, setAdjacentMode] = useState(false);
  const [moveDrag, setMoveDrag] = useState(null); // { stringIndex, fret, beat }
  const moveDragRef = useRef(null);
  const [fretMarquee, setFretMarquee] = useState(null); // { x1, y1, x2, y2 } in px
  const fretMarqueeRef = useRef(null);

  const hotkeysRef = useRef(hotkeys);
  hotkeysRef.current = hotkeys;

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT') return;
      const hk = hotkeysRef.current;
      if (matchesHotkey(e, hk.durationMode)) { setDurationMode(m => !m); setMoveMode(false); setAdjacentMode(false); }
      if (matchesHotkey(e, hk.moveMode)) { setMoveMode(m => !m); setDurationMode(false); setAdjacentMode(false); }
      if (matchesHotkey(e, hk.adjacentMode)) { setAdjacentMode(m => !m); setDurationMode(false); setMoveMode(false); }
      if (matchesHotkey(e, hk.escape)) { setDurationMode(false); setMoveMode(false); setAdjacentMode(false); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const getStringAndFret = useCallback((e) => {
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const w = rect.width;

    const leftPx = w * PADDING_LEFT / 100;
    const rightPx = w * PADDING_RIGHT / 100;
    const usableW = w - leftPx - rightPx;
    const stringSpacing = usableW / (NUM_STRINGS - 1);

    const stringIndex = Math.round((x - leftPx) / stringSpacing);
    const fret = Math.floor(y / FRET_HEIGHT);

    if (stringIndex < 0 || stringIndex >= NUM_STRINGS || fret < 0 || fret >= TOTAL_CELLS) {
      return null;
    }

    return { stringIndex, fret };
  }, [FRET_HEIGHT]);

  const handleMouseMove = useCallback((e) => {
    const pos = getStringAndFret(e);
    setHover(pos);
    setHoveredNote(pos);

    // Preview sound on hover (only when position changes and enabled)
    if (hoverPreview && pos) {
      const key = `${pos.stringIndex}_${pos.fret}`;
      if (lastPreviewRef.current !== key) {
        lastPreviewRef.current = key;
        playNote(pos.stringIndex, pos.fret, 0.15, hoverVolume);
      }
    } else {
      lastPreviewRef.current = null;
    }

    // Skip note-move drag in modifier modes
    if (durationMode || moveMode) return;

    if (dragStartRef.current && pos) {
      const start = dragStartRef.current;
      if (pos.stringIndex !== start.stringIndex || pos.fret !== start.fret) {
        didDragRef.current = true;
        setDragNote(pos);
      }
    }
  }, [getStringAndFret, durationMode, moveMode]);

  const handleMouseDown = useCallback((e) => {
    const result = getStringAndFret(e);
    if (!result) return;

    const activeNote = activeNotes.find(
      n => n.stringIndex === result.stringIndex && n.fret === result.fret
    );

    // Shift+drag marquee: select active notes in region (works in any mode)
    if (e.shiftKey) {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const startX = e.clientX - rect.left;
      const startY = e.clientY - rect.top + (scrollRef.current?.scrollTop || 0);
      fretMarqueeRef.current = { startX, startY, didMove: false };
      setSelectedNotes(new Set());

      const handleMarqueeMove = (moveE) => {
        if (!fretMarqueeRef.current) return;
        const mx = moveE.clientX - rect.left;
        const my = moveE.clientY - rect.top + (scrollRef.current?.scrollTop || 0);
        const dx = mx - fretMarqueeRef.current.startX;
        const dy = my - fretMarqueeRef.current.startY;
        if (!fretMarqueeRef.current.didMove && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        fretMarqueeRef.current.didMove = true;

        const x1 = Math.min(fretMarqueeRef.current.startX, mx);
        const y1 = Math.min(fretMarqueeRef.current.startY, my);
        const x2 = Math.max(fretMarqueeRef.current.startX, mx);
        const y2 = Math.max(fretMarqueeRef.current.startY, my);
        setFretMarquee({ x1, y1, x2, y2 });

        // Select active notes whose fretboard position falls within the marquee
        const selected = new Set();
        const containerW = container.clientWidth;
        const usableW = containerW * (100 - PADDING_LEFT - PADDING_RIGHT) / 100;
        const leftPx = containerW * PADDING_LEFT / 100;
        activeNotes.forEach(note => {
          const noteX = leftPx + (note.stringIndex / (NUM_STRINGS - 1)) * usableW;
          const noteY = cellCenterPx(note.fret);
          if (noteX >= x1 && noteX <= x2 && noteY >= y1 && noteY <= y2) {
            const idx = notes.findIndex(n =>
              n.stringIndex === note.stringIndex && n.fret === note.fret &&
              selectedBeat >= n.beat && selectedBeat < n.beat + (n.duration || 1)
            );
            if (idx >= 0) selected.add(idx);
          }
        });
        setSelectedNotes(selected);
      };

      const handleMarqueeUp = () => {
        fretMarqueeRef.current = null;
        setFretMarquee(null);
        window.removeEventListener('mousemove', handleMarqueeMove);
        window.removeEventListener('mouseup', handleMarqueeUp);
      };

      window.addEventListener('mousemove', handleMarqueeMove);
      window.addEventListener('mouseup', handleMarqueeUp);
      e.preventDefault();
      return;
    }

    if (durationMode) {
      if (activeNote) {
        durationDragRef.current = {
          stringIndex: result.stringIndex,
          fret: result.fret,
          startX: e.clientX,
          startDuration: activeNote.duration || 1,
          noteBeat: activeNote.beat,
        };
        setDurationDrag({
          stringIndex: result.stringIndex,
          fret: result.fret,
          duration: activeNote.duration || 1,
        });

        saveSnapshot();
        const isFree = freeMode;
        const handleDurationMove = (moveE) => {
          const d = durationDragRef.current;
          if (!d) return;
          const dx = moveE.clientX - d.startX;
          const dBeats = dx / CELL_WIDTH;
          const rawDuration = d.startDuration + dBeats;
          const snap = snapUnit;
          const newDuration = isFree
            ? Math.max(0.1, Math.min(totalBeats - d.noteBeat, rawDuration))
            : Math.max(snap, Math.min(totalBeats - d.noteBeat, Math.round(rawDuration / snap) * snap));
          setDurationDrag({ stringIndex: d.stringIndex, fret: d.fret, duration: newDuration });
          onDurationChange(d.stringIndex, d.fret, newDuration);
        };
        const handleDurationUp = () => {
          commitDrag();
          durationDragRef.current = null;
          setDurationDrag(null);
          window.removeEventListener('mousemove', handleDurationMove);
          window.removeEventListener('mouseup', handleDurationUp);
        };
        window.addEventListener('mousemove', handleDurationMove);
        window.addEventListener('mouseup', handleDurationUp);
      }
      e.preventDefault();
      return;
    }

    if (moveMode) {
      if (activeNote) {
        moveDragRef.current = {
          stringIndex: result.stringIndex,
          fret: result.fret,
          startX: e.clientX,
          startBeat: activeNote.beat,
          currentBeat: activeNote.beat,
          noteDuration: activeNote.duration || 1,
        };
        setMoveDrag({
          stringIndex: result.stringIndex,
          fret: result.fret,
          beat: activeNote.beat,
        });
        saveSnapshot();
        const isFree = freeMode;

        const handleMoveMove = (moveE) => {
          const d = moveDragRef.current;
          if (!d) return;
          const dx = moveE.clientX - d.startX;
          const dBeats = dx / CELL_WIDTH;
          const rawBeat = d.startBeat + dBeats;
          const snap = snapUnit;
          const newBeat = isFree
            ? Math.max(0, Math.min(totalBeats - (d.noteDuration || 1), rawBeat))
            : Math.max(0, Math.min(totalBeats - (d.noteDuration || 1), Math.round(rawBeat / snap) * snap));
          if (newBeat !== d.currentBeat) {
            onBeatChange(d.stringIndex, d.fret, d.currentBeat, newBeat);
            d.currentBeat = newBeat;
            setMoveDrag({ stringIndex: d.stringIndex, fret: d.fret, beat: newBeat });
          }
        };
        const handleMoveUp = () => {
          commitDrag();
          moveDragRef.current = null;
          setMoveDrag(null);
          window.removeEventListener('mousemove', handleMoveMove);
          window.removeEventListener('mouseup', handleMoveUp);
        };
        window.addEventListener('mousemove', handleMoveMove);
        window.addEventListener('mouseup', handleMoveUp);
      }
      e.preventDefault();
      return;
    }

    if (activeNote && !adjacentMode) {
      dragStartRef.current = result;
      didDragRef.current = false;
      setDragNote(result);
      e.preventDefault();
    }
  }, [getStringAndFret, activeNotes, durationMode, moveMode, adjacentMode, freeMode, onDurationChange, onBeatChange, fingeringMode, notes, selectedBeat, setSelectedNotes]);

  const handleMouseUp = useCallback((e) => {
    // Block all other interactions in modifier modes (except adjacent)
    if (durationMode || moveMode) return;

    if (!adjacentMode && dragStartRef.current && didDragRef.current) {
      const pos = getStringAndFret(e);
      if (pos) {
        playNote(pos.stringIndex, pos.fret);
        onMoveNote(dragStartRef.current.stringIndex, dragStartRef.current.fret, pos.stringIndex, pos.fret);
      }
      dragStartRef.current = null;
      didDragRef.current = false;
      setDragNote(null);
      return;
    }

    dragStartRef.current = null;
    didDragRef.current = false;
    setDragNote(null);

    const result = getStringAndFret(e);
    if (result) {
      playNote(result.stringIndex, result.fret);
      if (fingeringMode) {
        // In fingering mode, clicking toggles selection of matching notes at current beat
        const matchingIndices = [];
        notes.forEach((n, i) => {
          if (n.stringIndex === result.stringIndex && n.fret === result.fret &&
              selectedBeat >= n.beat && selectedBeat < n.beat + (n.duration || 1)) {
            matchingIndices.push(i);
          }
        });
        if (matchingIndices.length > 0) {
          setSelectedNotes(prev => {
            const next = new Set(prev);
            matchingIndices.forEach(i => {
              if (next.has(i)) next.delete(i);
              else next.add(i);
            });
            return next;
          });
        }
        return;
      }
      if (adjacentMode) {
        onAdjacentClick(result.stringIndex, result.fret);
      } else {
        onNoteClick(result.stringIndex, result.fret);
      }
    }
  }, [getStringAndFret, onNoteClick, onAdjacentClick, onMoveNote, durationMode, adjacentMode, moveMode, fingeringMode, notes, selectedBeat, setSelectedNotes]);


  // Auto-scroll fretboard to show hovered note (from piano roll — only when local hover is null)
  useEffect(() => {
    if (!(autoScroll?.onHover ?? true)) return;
    if (!hoveredNote || !scrollRef.current || hover) return;
    const noteTop = cellTopPx(hoveredNote.fret);
    const noteBottom = noteTop + FRET_HEIGHT;
    const container = scrollRef.current;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;

    if (noteTop < viewTop) {
      container.scrollTo({ top: Math.max(0, noteTop - 20), behavior: 'smooth' });
    } else if (noteBottom > viewBottom) {
      container.scrollTo({ top: noteBottom - container.clientHeight + 20, behavior: 'smooth' });
    }
  }, [hoveredNote, hover, autoScroll]);

  // Auto-scroll fretboard to show playing notes during playback
  useEffect(() => {
    if (!(autoScroll?.onPlayback ?? true)) return;
    if (!playingNotes.length || !scrollRef.current) return;
    let minFret = Infinity, maxFret = -Infinity;
    for (const n of playingNotes) {
      if (n.fret < minFret) minFret = n.fret;
      if (n.fret > maxFret) maxFret = n.fret;
    }
    const regionTop = cellTopPx(minFret);
    const regionBottom = cellTopPx(maxFret) + FRET_HEIGHT;
    const container = scrollRef.current;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;

    if (regionTop < viewTop || regionBottom > viewBottom) {
      const center = (regionTop + regionBottom) / 2;
      container.scrollTo({ top: center - container.clientHeight / 2, behavior: 'smooth' });
    }
  }, [playingNotes, autoScroll]);


  // Ctrl+scroll zoom on fretboard
  useEffect(() => {
    const handleWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (!scrollRef.current) return;
      const rect = scrollRef.current.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top || e.clientY > rect.bottom) return;
      e.preventDefault();
      if (setFretboardZoom) {
        setFretboardZoom(z => {
          const newZ = z * (1 - e.deltaY * 0.002);
          return Math.max(0.5, Math.min(4, newZ));
        });
      }
    };
    document.addEventListener('wheel', handleWheel, { passive: false });
    return () => document.removeEventListener('wheel', handleWheel);
  }, [setFretboardZoom]);

  const noteName = hover ? getNoteName(hover.stringIndex, hover.fret) : null;

  return (
    <div className="fretboard-container">
      <div className="fretboard-note-box">
        {durationMode ? <span style={{ color: '#3498db' }}>Duration Mode ({hotkeys ? formatHotkey(hotkeys.durationMode) : 'L'})</span>
          : moveMode ? <span style={{ color: '#e67e22' }}>Move Mode ({hotkeys ? formatHotkey(hotkeys.moveMode) : 'M'})</span>
          : adjacentMode ? <span style={{ color: '#2ecc71' }}>Adjacent Mode ({hotkeys ? formatHotkey(hotkeys.adjacentMode) : 'A'})</span>
          : noteName || '\u00A0'}
      </div>
      <div
        className="fretboard-scroll"
        ref={scrollRef}
      >
      <div
        className="fretboard"
        ref={containerRef}
        style={{
          height: GRID_HEIGHT,
          cursor: (durationMode || moveMode) ? 'ew-resize' : adjacentMode ? 'cell' : undefined,
        }}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { setHover(null); setHoveredNote(null); if (!durationDragRef.current && !moveDragRef.current) { dragStartRef.current = null; didDragRef.current = false; setDragNote(null); } }}
      >
        {/* Open fret area background */}
        <div style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          height: FRET_HEIGHT,
          background: '#1a1a1a',
          borderBottom: 'none',
        }} />

        {/* Nut - horizontal line between fret 0 and fret 1 */}
        <div style={{
          position: 'absolute',
          left: `${PADDING_LEFT - 2}%`,
          right: `${PADDING_RIGHT - 2}%`,
          top: cellTopPx(1) - 2,
          height: 5,
          background: '#d4c9a8',
          borderRadius: 2,
          zIndex: 2,
        }} />

        {/* Fret wires */}
        {Array.from({ length: NUM_FRETS - 1 }, (_, i) => (
          <div key={`fret-${i}`} style={{
            position: 'absolute',
            left: `${PADDING_LEFT - 1}%`,
            right: `${PADDING_RIGHT - 1}%`,
            top: cellTopPx(i + 2),
            height: 1,
            background: '#555',
          }} />
        ))}

        {/* Fret dots */}
        {FRET_DOTS.filter(f => f <= NUM_FRETS).map(fret => {
          const isDouble = DOUBLE_DOTS.includes(fret);
          const top = cellCenterPx(fret);
          return isDouble ? (
            <div key={`dot-${fret}`}>
              <div className="fret-dot" style={{ left: '3%', top: top - 5 }} />
              <div className="fret-dot" style={{ left: '3%', top: top + 5 }} />
            </div>
          ) : (
            <div key={`dot-${fret}`} className="fret-dot" style={{ left: '3%', top }} />
          );
        })}

        {/* Strings - vertical lines (thicker in open area) */}
        {Array.from({ length: NUM_STRINGS }, (_, i) => {
          const leftPercent = PADDING_LEFT + (i / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT);
          const thickness = NUM_STRINGS - i;
          const nutTop = cellTopPx(1);
          return (
            <div key={`string-${i}`}>
              {/* Open area string (thicker) */}
              <div style={{
                position: 'absolute',
                left: `${leftPercent}%`,
                top: 0,
                height: nutTop,
                width: Math.max(3, thickness * 1.2),
                background: '#ccc',
                transform: 'translateX(-50%)',
                zIndex: 1,
              }} />
              {/* Fretted area string */}
              <div style={{
                position: 'absolute',
                left: `${leftPercent}%`,
                top: nutTop,
                bottom: 0,
                width: Math.max(1, thickness * 0.5),
                background: '#ddd',
                transform: 'translateX(-50%)',
                zIndex: 1,
              }} />
            </div>
          );
        })}

        {/* Fret numbers on the right */}
        {Array.from({ length: TOTAL_CELLS }, (_, fret) => (
          <div key={`fnum-${fret}`} style={{
            position: 'absolute',
            right: 10,
            top: cellCenterPx(fret),
            fontSize: 13,
            color: '#ccc',
            transform: 'translateY(-50%)',
            pointerEvents: 'none',
          }}>
            {fret}
          </div>
        ))}

        {/* Background track notes (white, dimmed) */}
        {backgroundActiveNotes.map((note, i) => (
          <div key={`bg-${i}`} style={{
            position: 'absolute',
            left: `${PADDING_LEFT + (note.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
            top: cellCenterPx(note.fret),
            width: 32,
            height: 12,
            borderRadius: 6,
            background: '#fff',
            opacity: note._trackOpacity ?? 0.2,
            transform: 'translate(-50%, -50%) rotate(-50deg)',
            pointerEvents: 'none',
            zIndex: 4,
          }} />
        ))}

        {/* Active notes glow blur */}
        {activeNotes.map((note, i) => {
          const isDragging = dragStartRef.current &&
            note.stringIndex === dragStartRef.current.stringIndex &&
            note.fret === dragStartRef.current.fret;
          if (isDragging) return null;
          const color = getNoteColor(note.stringIndex, note.fret);
          return (
            <div key={`blur-${i}`} style={{
              position: 'absolute',
              left: `${PADDING_LEFT + (note.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
              top: cellCenterPx(note.fret),
              width: 40,
              height: 20,
              borderRadius: '50%',
              background: color,
              filter: 'blur(10px)',
              opacity: 0.7,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
              zIndex: 5,
            }} />
          );
        })}

        {/* Active notes at current beat */}
        {activeNotes.map((note, i) => {
          const isDragging = dragStartRef.current &&
            note.stringIndex === dragStartRef.current.stringIndex &&
            note.fret === dragStartRef.current.fret;
          if (isDragging) return null;
          const isPlaying = playingNotes.some(
            p => p.stringIndex === note.stringIndex && p.fret === note.fret
          );
          const color = getNoteColor(note.stringIndex, note.fret);
          return (
            <div key={`active-${i}`} style={{
              position: 'absolute',
              left: `${PADDING_LEFT + (note.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
              top: cellCenterPx(note.fret),
              width: 32,
              height: 12,
              borderRadius: 6,
              background: color,
              boxShadow: isPlaying ? `0 0 10px 3px ${color}` : 'none',
              transform: 'translate(-50%, -50%) rotate(-50deg)',
              pointerEvents: 'none',
              zIndex: 7,
            }} />
          );
        })}

        {/* Selection outlines */}
        {selectedNotes && selectedNotes.size > 0 && activeNotes.map((note, i) => {
          const noteIdx = notes.findIndex(n =>
            n.stringIndex === note.stringIndex && n.fret === note.fret &&
            selectedBeat >= n.beat && selectedBeat < n.beat + (n.duration || 1)
          );
          if (noteIdx < 0 || !selectedNotes.has(noteIdx)) return null;
          return (
            <div key={`sel-${i}`} style={{
              position: 'absolute',
              left: `${PADDING_LEFT + (note.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
              top: cellCenterPx(note.fret),
              width: 38,
              height: 18,
              borderRadius: 8,
              border: '2px solid #fff',
              background: 'transparent',
              transform: 'translate(-50%, -50%) rotate(-50deg)',
              pointerEvents: 'none',
              zIndex: 8,
            }} />
          );
        })}

        {/* Voice leading preview */}
        {voicingPreview && voicingPreview.map((v, i) => (
          <div key={`vp-${i}`} style={{
            position: 'absolute',
            left: `${PADDING_LEFT + (v.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
            top: cellCenterPx(v.fret),
            width: 36,
            height: 16,
            borderRadius: 8,
            border: '2px solid rgba(46, 204, 113, 0.8)',
            background: 'rgba(46, 204, 113, 0.2)',
            transform: 'translate(-50%, -50%) rotate(-50deg)',
            pointerEvents: 'none',
            zIndex: 9,
            animation: 'chord-blink 0.6s ease-in-out infinite',
          }} />
        ))}

        {/* Fretboard marquee */}
        {fretMarquee && (
          <div style={{
            position: 'absolute',
            left: fretMarquee.x1,
            top: fretMarquee.y1,
            width: fretMarquee.x2 - fretMarquee.x1,
            height: fretMarquee.y2 - fretMarquee.y1,
            border: '1px solid rgba(100, 160, 255, 0.8)',
            background: 'rgba(100, 160, 255, 0.1)',
            pointerEvents: 'none',
            zIndex: 25,
          }} />
        )}

        {/* Duration drag indicator - circular gauge */}
        {durationDrag && (() => {
          const color = getNoteColor(durationDrag.stringIndex, durationDrag.fret);
          const durationLabels = freeMode ? {} : { 1: '1/16', 2: '1/8', 4: '1/4', 8: '1/2', 16: '1/1' };
          const label = durationLabels[durationDrag.duration] || (freeMode ? durationDrag.duration.toFixed(1) : `${durationDrag.duration}`);
          // Fill percentage: 1 beat = ~6%, 16 beats = 100%
          const fillPercent = Math.min(100, (durationDrag.duration / 16) * 100);
          const size = 64;
          const strokeWidth = 6;
          const radius = (size - strokeWidth) / 2;
          const circumference = 2 * Math.PI * radius;
          const dashOffset = circumference * (1 - fillPercent / 100);
          return (
            <div style={{
              position: 'absolute',
              left: '50%',
              top: 12,
              transform: 'translateX(-50%)',
              pointerEvents: 'none',
              zIndex: 30,
            }}>
              <svg width={size} height={size} style={{ display: 'block' }}>
                <circle
                  cx={size / 2} cy={size / 2} r={radius}
                  fill="rgba(0,0,0,0.85)"
                  stroke="#444"
                  strokeWidth={strokeWidth}
                />
                <circle
                  cx={size / 2} cy={size / 2} r={radius}
                  fill="none"
                  stroke={color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  strokeLinecap="round"
                  transform={`rotate(-90 ${size / 2} ${size / 2})`}
                  style={{ filter: `drop-shadow(0 0 6px ${color})` }}
                />
                <text
                  x={size / 2} y={size / 2}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="#fff"
                  fontSize={14}
                  fontWeight="bold"
                >
                  {label}
                </text>
              </svg>
            </div>
          );
        })()}

        {/* D-key hint on hovered active note */}
        {durationMode && !durationDrag && hover && activeNotes.some(
          n => n.stringIndex === hover.stringIndex && n.fret === hover.fret
        ) && (
          <div style={{
            position: 'absolute',
            left: `calc(${PADDING_LEFT + (hover.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}% + 18px)`,
            top: cellCenterPx(hover.fret) - 8,
            fontSize: 10,
            color: '#aaa',
            pointerEvents: 'none',
            zIndex: 12,
            whiteSpace: 'nowrap',
          }}>
            drag to resize
          </div>
        )}

        {/* Move drag indicator - circular gauge */}
        {moveDrag && (() => {
          const color = '#e67e22';
          const beat = moveDrag.beat;
          const bar = Math.floor(beat / SUBDIVISIONS) + 1;
          const beatInBar = freeMode ? (beat % SUBDIVISIONS + 1).toFixed(1) : (beat % SUBDIVISIONS) + 1;
          const label = `${bar}.${beatInBar}`;
          const fillPercent = Math.min(100, (beat / (totalBeats - 1)) * 100);
          const size = 64;
          const strokeWidth = 6;
          const radius = (size - strokeWidth) / 2;
          const circumference = 2 * Math.PI * radius;
          const dashOffset = circumference * (1 - fillPercent / 100);
          return (
            <div style={{
              position: 'absolute',
              left: '50%',
              top: 12,
              transform: 'translateX(-50%)',
              pointerEvents: 'none',
              zIndex: 30,
            }}>
              <svg width={size} height={size} style={{ display: 'block' }}>
                <circle
                  cx={size / 2} cy={size / 2} r={radius}
                  fill="rgba(0,0,0,0.85)"
                  stroke="#444"
                  strokeWidth={strokeWidth}
                />
                <circle
                  cx={size / 2} cy={size / 2} r={radius}
                  fill="none"
                  stroke={color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  strokeLinecap="round"
                  transform={`rotate(-90 ${size / 2} ${size / 2})`}
                  style={{ filter: `drop-shadow(0 0 6px ${color})` }}
                />
                <text
                  x={size / 2} y={size / 2}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="#fff"
                  fontSize={14}
                  fontWeight="bold"
                >
                  {label}
                </text>
              </svg>
            </div>
          );
        })()}

        {/* Move mode hint on hovered active note */}
        {moveMode && !moveDrag && hover && activeNotes.some(
          n => n.stringIndex === hover.stringIndex && n.fret === hover.fret
        ) && (
          <div style={{
            position: 'absolute',
            left: `calc(${PADDING_LEFT + (hover.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}% + 18px)`,
            top: cellCenterPx(hover.fret) - 8,
            fontSize: 10,
            color: '#aaa',
            pointerEvents: 'none',
            zIndex: 12,
            whiteSpace: 'nowrap',
          }}>
            drag to move beat
          </div>
        )}

        {/* Solid mask behind playing notes to hide string lines */}
        {playingNotes.map((note, i) => (
          <div key={`mask-${i}`} style={{
            position: 'absolute',
            left: `${PADDING_LEFT + (note.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
            top: cellCenterPx(note.fret),
            width: 38,
            height: 18,
            borderRadius: 9,
            background: '#000',
            transform: 'translate(-50%, -50%) rotate(-50deg)',
            pointerEvents: 'none',
            zIndex: 2,
          }} />
        ))}

        {/* Solid mask behind active notes to hide string lines */}
        {activeNotes.map((note, i) => {
          const isDragging = dragStartRef.current &&
            note.stringIndex === dragStartRef.current.stringIndex &&
            note.fret === dragStartRef.current.fret;
          if (isDragging) return null;
          return (
            <div key={`amask-${i}`} style={{
              position: 'absolute',
              left: `${PADDING_LEFT + (note.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
              top: cellCenterPx(note.fret),
              width: 34,
              height: 16,
              borderRadius: 8,
              background: '#000',
              transform: 'translate(-50%, -50%) rotate(-50deg)',
              pointerEvents: 'none',
              zIndex: 2,
            }} />
          );
        })}

        {/* Playing notes glow background */}
        {playingNotes.map((note, i) => {
          const color = getNoteColor(note.stringIndex, note.fret);
          return (
            <div key={`glow-${i}`} style={{
              position: 'absolute',
              left: `${PADDING_LEFT + (note.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
              top: cellCenterPx(note.fret),
              width: 60,
              height: 30,
              borderRadius: '50%',
              background: color,
              filter: 'blur(14px)',
              opacity: 0.8,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
              zIndex: 5,
            }} />
          );
        })}

        {/* Playing notes not on the selected beat */}
        {playingNotes
          .filter(p => !activeNotes.some(a => a.stringIndex === p.stringIndex && a.fret === p.fret))
          .map((note, i) => (
            <div key={`playing-${i}`} style={{
              position: 'absolute',
              left: `${PADDING_LEFT + (note.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
              top: cellCenterPx(note.fret),
              width: 32,
              height: 12,
              borderRadius: 6,
              background: getNoteColor(note.stringIndex, note.fret),
              boxShadow: `0 0 10px 3px ${getNoteColor(note.stringIndex, note.fret)}`,
              transform: 'translate(-50%, -50%) rotate(-50deg)',
              pointerEvents: 'none',
              zIndex: 6,
            }} />
          ))}

        {/* Drag preview note */}
        {dragNote && dragStartRef.current && (
          <div style={{
            position: 'absolute',
            left: `${PADDING_LEFT + (dragNote.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
            top: cellCenterPx(dragNote.fret),
            width: 28,
            height: 10,
            borderRadius: 5,
            background: getNoteColor(dragNote.stringIndex, dragNote.fret),
            opacity: 0.8,
            transform: 'translate(-50%, -50%) rotate(-50deg)',
            pointerEvents: 'none',
            zIndex: 11,
          }} />
        )}

        {/* Hover indicator - pill in center of cell */}
        {(hoverPill?.fretboard ?? true) && hover && !durationMode && !moveMode && (
          <div style={{
            position: 'absolute',
            left: `${PADDING_LEFT + (hover.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
            top: cellCenterPx(hover.fret),
            width: 32,
            height: 12,
            borderRadius: 6,
            background: getNoteColor(hover.stringIndex, hover.fret),
            opacity: 0.5,
            transform: 'translate(-50%, -50%) rotate(-50deg)',
            pointerEvents: 'none',
            zIndex: 10,
          }} />
        )}

        {/* External hover highlight (from piano roll) */}
        {(hoverPill?.pianoRoll ?? true) && !hover && hoveredNote && hoveredNote.fret >= 0 && hoveredNote.fret < TOTAL_CELLS && (
          <div style={{
            position: 'absolute',
            left: `${PADDING_LEFT + (hoveredNote.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
            top: cellCenterPx(hoveredNote.fret),
            width: 28,
            height: 10,
            borderRadius: 5,
            background: getNoteColor(hoveredNote.stringIndex, hoveredNote.fret),
            opacity: 0.6,
            transform: 'translate(-50%, -50%) rotate(-50deg)',
            pointerEvents: 'none',
            zIndex: 10,
          }} />
        )}
      </div>
      </div>
    </div>
  );
}
