import { useRef, useState, useCallback, useEffect } from 'react';
import { NUM_STRINGS, NUM_FRETS, FRET_DOTS, DOUBLE_DOTS, CELL_WIDTH, NUM_BARS, SUBDIVISIONS } from '../utils/constants';
import { playNote, getNoteName } from '../utils/audio';

const MAX_DURATION = NUM_BARS * SUBDIVISIONS;

const PADDING_LEFT = 12;
const PADDING_RIGHT = 8;
const PADDING_TOP = 2;

// Total cells = NUM_FRETS + 1 (fret 0 is open string, frets 1..NUM_FRETS are normal)
const TOTAL_CELLS = NUM_FRETS + 1;
const ZOOM_PADDING = 2; // extra frets shown above/below notes
const MIN_ZOOM_SPAN = 5; // minimum frets visible when zoomed

// Get the Y percent for the top edge of a cell within a visible range
function cellTopPercent(cell, viewStart = 0, viewCells = TOTAL_CELLS) {
  return PADDING_TOP + ((cell - viewStart) / viewCells) * (100 - PADDING_TOP);
}

// Get the Y percent for the center of a cell within a visible range
function cellCenterPercent(cell, viewStart = 0, viewCells = TOTAL_CELLS) {
  return PADDING_TOP + ((cell - viewStart + 0.5) / viewCells) * (100 - PADDING_TOP);
}

export default function Fretboard({ onNoteClick, onMoveNote, onDurationChange, onBeatChange, activeNotes = [], playingNotes = [], zoom = false, zoomNotes = [], stringColors, getNoteColor, hoveredNote, setHoveredNote }) {
  const containerRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [dragNote, setDragNote] = useState(null); // { stringIndex, fret } of note being dragged
  const dragStartRef = useRef(null); // tracks mousedown position to distinguish click vs drag
  const didDragRef = useRef(false);
  const [durationMode, setDurationMode] = useState(false);
  const [durationDrag, setDurationDrag] = useState(null);
  const durationDragRef = useRef(null);
  const [moveMode, setMoveMode] = useState(false);
  const [moveDrag, setMoveDrag] = useState(null); // { stringIndex, fret, beat }
  const moveDragRef = useRef(null);
  const viewStartRef = useRef(0);
  const viewCellsRef = useRef(TOTAL_CELLS);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'l' || e.key === 'L') { setDurationMode(m => !m); setMoveMode(false); }
      if (e.key === 'm' || e.key === 'M') { setMoveMode(m => !m); setDurationMode(false); }
      if (e.key === 'Escape') { setDurationMode(false); setMoveMode(false); }
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
    const h = rect.height;

    const leftPx = w * PADDING_LEFT / 100;
    const rightPx = w * PADDING_RIGHT / 100;
    const topPx = h * PADDING_TOP / 100;

    const usableW = w - leftPx - rightPx;
    const usableH = h - topPx;
    const stringSpacing = usableW / (NUM_STRINGS - 1);
    const cellHeight = usableH / viewCellsRef.current;

    const stringIndex = Math.round((x - leftPx) / stringSpacing);
    const fret = viewStartRef.current + Math.floor((y - topPx) / cellHeight);

    if (stringIndex < 0 || stringIndex >= NUM_STRINGS || fret < viewStartRef.current || fret >= viewStartRef.current + viewCellsRef.current) {
      return null;
    }

    return { stringIndex, fret };
  }, []);

  const handleMouseMove = useCallback((e) => {
    const pos = getStringAndFret(e);
    setHover(pos);
    setHoveredNote(pos);

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

        const handleDurationMove = (moveE) => {
          const d = durationDragRef.current;
          if (!d) return;
          const dx = moveE.clientX - d.startX;
          const dBeats = Math.round(dx / CELL_WIDTH);
          const newDuration = Math.max(1, Math.min(MAX_DURATION - d.noteBeat, d.startDuration + dBeats));
          setDurationDrag({ stringIndex: d.stringIndex, fret: d.fret, duration: newDuration });
          onDurationChange(d.stringIndex, d.fret, newDuration);
        };
        const handleDurationUp = () => {
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

        const handleMoveMove = (moveE) => {
          const d = moveDragRef.current;
          if (!d) return;
          const dx = moveE.clientX - d.startX;
          const dBeats = Math.round(dx / CELL_WIDTH);
          const newBeat = Math.max(0, Math.min(MAX_DURATION - (d.noteDuration || 1), d.startBeat + dBeats));
          if (newBeat !== d.currentBeat) {
            onBeatChange(d.stringIndex, d.fret, d.currentBeat, newBeat);
            d.currentBeat = newBeat;
            setMoveDrag({ stringIndex: d.stringIndex, fret: d.fret, beat: newBeat });
          }
        };
        const handleMoveUp = () => {
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

    if (activeNote) {
      dragStartRef.current = result;
      didDragRef.current = false;
      setDragNote(result);
      e.preventDefault();
    }
  }, [getStringAndFret, activeNotes, durationMode, moveMode, onDurationChange, onBeatChange]);

  const handleMouseUp = useCallback((e) => {
    // Block all other interactions in modifier modes
    if (durationMode || moveMode) return;

    if (dragStartRef.current && didDragRef.current) {
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
      onNoteClick(result.stringIndex, result.fret);
    }
  }, [getStringAndFret, onNoteClick, onMoveNote, durationMode]);

  // Compute zoom range from all notes in the loop region
  let viewStart = 0;
  let viewCells = TOTAL_CELLS;
  if (zoom && zoomNotes.length > 0) {
    const frets = zoomNotes.map(n => n.fret);
    const minFret = Math.min(...frets);
    const maxFret = Math.max(...frets);
    viewStart = Math.max(0, minFret - ZOOM_PADDING);
    const viewEnd = Math.min(TOTAL_CELLS, maxFret + ZOOM_PADDING + 1);
    viewCells = Math.max(MIN_ZOOM_SPAN, viewEnd - viewStart);
    if (viewEnd - viewStart < viewCells) {
      const center = (minFret + maxFret) / 2;
      viewStart = Math.max(0, Math.round(center - viewCells / 2));
      if (viewStart + viewCells > TOTAL_CELLS) viewStart = TOTAL_CELLS - viewCells;
    }
  }
  viewStartRef.current = viewStart;
  viewCellsRef.current = viewCells;

  const noteName = hover ? getNoteName(hover.stringIndex, hover.fret) : null;

  return (
    <div className="fretboard-container">
      <div className="fretboard-note-box">
        {durationMode ? <span style={{ color: '#3498db' }}>Duration Mode (L)</span>
          : moveMode ? <span style={{ color: '#e67e22' }}>Move Mode (M)</span>
          : noteName || '\u00A0'}
      </div>
      <div
        className="fretboard"
        ref={containerRef}
        style={(durationMode || moveMode) ? { cursor: 'ew-resize' } : undefined}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { setHover(null); setHoveredNote(null); if (!durationDragRef.current && !moveDragRef.current) { dragStartRef.current = null; didDragRef.current = false; setDragNote(null); } }}
      >
        {/* Nut - horizontal line between fret 0 and fret 1 (only if visible) */}
        {viewStart < 1 && 1 < viewStart + viewCells && (
          <div style={{
            position: 'absolute',
            left: `${PADDING_LEFT - 1}%`,
            right: `${PADDING_RIGHT - 1}%`,
            top: `${cellTopPercent(1, viewStart, viewCells)}%`,
            height: 4,
            background: '#ccc',
            zIndex: 2,
          }} />
        )}

        {/* Fret wires */}
        {Array.from({ length: NUM_FRETS - 1 }, (_, i) => i + 2)
          .filter(f => f >= viewStart && f < viewStart + viewCells)
          .map(f => (
            <div key={`fret-${f}`} style={{
              position: 'absolute',
              left: `${PADDING_LEFT - 1}%`,
              right: `${PADDING_RIGHT - 1}%`,
              top: `${cellTopPercent(f, viewStart, viewCells)}%`,
              height: 1,
              background: '#555',
            }} />
          ))}

        {/* Fret dots */}
        {FRET_DOTS.filter(f => f <= NUM_FRETS && f >= viewStart && f < viewStart + viewCells).map(fret => {
          const isDouble = DOUBLE_DOTS.includes(fret);
          const topPercent = cellCenterPercent(fret, viewStart, viewCells);
          return isDouble ? (
            <div key={`dot-${fret}`}>
              <div className="fret-dot" style={{ left: '3%', top: `calc(${topPercent}% - 5px)` }} />
              <div className="fret-dot" style={{ left: '3%', top: `calc(${topPercent}% + 5px)` }} />
            </div>
          ) : (
            <div key={`dot-${fret}`} className="fret-dot" style={{ left: '3%', top: `${topPercent}%` }} />
          );
        })}

        {/* Strings - vertical lines */}
        {Array.from({ length: NUM_STRINGS }, (_, i) => {
          const leftPercent = PADDING_LEFT + (i / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT);
          const thickness = NUM_STRINGS - i;
          return (
            <div key={`string-${i}`} style={{
              position: 'absolute',
              left: `${leftPercent}%`,
              top: `${PADDING_TOP}%`,
              bottom: 0,
              width: Math.max(1, thickness * 0.5),
              background: '#ddd',
              transform: 'translateX(-50%)',
            }} />
          );
        })}

        {/* Fret numbers on the right */}
        {Array.from({ length: viewCells }, (_, i) => {
          const fret = viewStart + i;
          if (fret >= TOTAL_CELLS) return null;
          return (
            <div key={`fnum-${fret}`} style={{
              position: 'absolute',
              right: 10,
              top: `${cellCenterPercent(fret, viewStart, viewCells)}%`,
              fontSize: 13,
              color: '#555',
              transform: 'translateY(-50%)',
              pointerEvents: 'none',
            }}>
              {fret}
            </div>
          );
        })}

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
              top: `${cellCenterPercent(note.fret, viewStart, viewCells)}%`,
              width: 40,
              height: 20,
              borderRadius: '50%',
              background: color,
              filter: 'blur(10px)',
              opacity: 0.6,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
              zIndex: 4,
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
              top: `${cellCenterPercent(note.fret, viewStart, viewCells)}%`,
              width: 28,
              height: 10,
              borderRadius: 5,
              background: color,
              boxShadow: isPlaying ? `0 0 10px 3px ${color}` : 'none',
              transform: 'translate(-50%, -50%) rotate(-35deg)',
              pointerEvents: 'none',
              zIndex: 5,
            }} />
          );
        })}

        {/* Duration drag indicator - circular gauge */}
        {durationDrag && (() => {
          const leftPercent = PADDING_LEFT + (durationDrag.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT);
          const topPercent = cellCenterPercent(durationDrag.fret, viewStart, viewCells);
          const color = getNoteColor(durationDrag.stringIndex, durationDrag.fret);
          const durationLabels = { 1: '1/16', 2: '1/8', 4: '1/4', 8: '1/2', 16: '1/1' };
          const label = durationLabels[durationDrag.duration] || `${durationDrag.duration}`;
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
              left: `${leftPercent}%`,
              top: `${topPercent}%`,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
              zIndex: 30,
            }}>
              <svg width={size} height={size} style={{ display: 'block' }}>
                {/* Background circle */}
                <circle
                  cx={size / 2} cy={size / 2} r={radius}
                  fill="rgba(0,0,0,0.85)"
                  stroke="#444"
                  strokeWidth={strokeWidth}
                />
                {/* Fill arc */}
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
                {/* Label text */}
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
            top: `calc(${cellCenterPercent(hover.fret, viewStart, viewCells)}% - 8px)`,
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
          const leftPercent = PADDING_LEFT + (moveDrag.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT);
          const topPercent = cellCenterPercent(moveDrag.fret, viewStart, viewCells);
          const color = '#e67e22';
          const beat = moveDrag.beat;
          const bar = Math.floor(beat / SUBDIVISIONS) + 1;
          const beatInBar = (beat % SUBDIVISIONS) + 1;
          const label = `${bar}.${beatInBar}`;
          const fillPercent = Math.min(100, (beat / (MAX_DURATION - 1)) * 100);
          const size = 64;
          const strokeWidth = 6;
          const radius = (size - strokeWidth) / 2;
          const circumference = 2 * Math.PI * radius;
          const dashOffset = circumference * (1 - fillPercent / 100);
          return (
            <div style={{
              position: 'absolute',
              left: `${leftPercent}%`,
              top: `${topPercent}%`,
              transform: 'translate(-50%, -50%)',
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
            top: `calc(${cellCenterPercent(hover.fret, viewStart, viewCells)}% - 8px)`,
            fontSize: 10,
            color: '#aaa',
            pointerEvents: 'none',
            zIndex: 12,
            whiteSpace: 'nowrap',
          }}>
            drag to move beat
          </div>
        )}

        {/* Playing notes glow background */}
        {playingNotes.map((note, i) => {
          const color = getNoteColor(note.stringIndex, note.fret);
          return (
            <div key={`glow-${i}`} style={{
              position: 'absolute',
              left: `${PADDING_LEFT + (note.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
              top: `${cellCenterPercent(note.fret, viewStart, viewCells)}%`,
              width: 60,
              height: 30,
              borderRadius: '50%',
              background: color,
              filter: 'blur(14px)',
              opacity: 0.7,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
              zIndex: 3,
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
              top: `${cellCenterPercent(note.fret, viewStart, viewCells)}%`,
              width: 28,
              height: 10,
              borderRadius: 5,
              background: getNoteColor(note.stringIndex, note.fret),
              boxShadow: `0 0 10px 3px ${getNoteColor(note.stringIndex, note.fret)}`,
              opacity: 0.7,
              transform: 'translate(-50%, -50%) rotate(-35deg)',
              pointerEvents: 'none',
              zIndex: 4,
            }} />
          ))}

        {/* Drag preview note */}
        {dragNote && dragStartRef.current && (
          <div style={{
            position: 'absolute',
            left: `${PADDING_LEFT + (dragNote.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
            top: `${cellCenterPercent(dragNote.fret, viewStart, viewCells)}%`,
            width: 28,
            height: 10,
            borderRadius: 5,
            background: getNoteColor(dragNote.stringIndex, dragNote.fret),
            opacity: 0.8,
            transform: 'translate(-50%, -50%) rotate(-35deg)',
            pointerEvents: 'none',
            zIndex: 11,
          }} />
        )}

        {/* Hover indicator - pill in center of cell */}
        {hover && !durationMode && !moveMode && (
          <div style={{
            position: 'absolute',
            left: `${PADDING_LEFT + (hover.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
            top: `${cellCenterPercent(hover.fret, viewStart, viewCells)}%`,
            width: 28,
            height: 10,
            borderRadius: 5,
            background: '#fff',
            transform: 'translate(-50%, -50%) rotate(-35deg)',
            pointerEvents: 'none',
            zIndex: 10,
          }} />
        )}

        {/* External hover highlight (from piano roll) */}
        {!hover && hoveredNote && hoveredNote.fret >= viewStart && hoveredNote.fret < viewStart + viewCells && (
          <div style={{
            position: 'absolute',
            left: `${PADDING_LEFT + (hoveredNote.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
            top: `${cellCenterPercent(hoveredNote.fret, viewStart, viewCells)}%`,
            width: 28,
            height: 10,
            borderRadius: 5,
            background: getNoteColor(hoveredNote.stringIndex, hoveredNote.fret),
            opacity: 0.6,
            transform: 'translate(-50%, -50%) rotate(-35deg)',
            pointerEvents: 'none',
            zIndex: 10,
          }} />
        )}
      </div>
    </div>
  );
}
