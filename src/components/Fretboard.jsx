import { useRef, useState, useCallback } from 'react';
import { NUM_STRINGS, NUM_FRETS, FRET_DOTS, DOUBLE_DOTS, STRING_COLORS } from '../utils/constants';
import { playNote, getNoteName } from '../utils/audio';

const PADDING_LEFT = 12;
const PADDING_RIGHT = 8;
const PADDING_TOP = 2;

// Total cells = NUM_FRETS + 1 (fret 0 is open string, frets 1..NUM_FRETS are normal)
const TOTAL_CELLS = NUM_FRETS + 1;

// Get the Y percent for the top edge of a cell
function cellTopPercent(cell) {
  return PADDING_TOP + (cell / TOTAL_CELLS) * (100 - PADDING_TOP);
}

// Get the Y percent for the center of a cell
function cellCenterPercent(cell) {
  return PADDING_TOP + ((cell + 0.5) / TOTAL_CELLS) * (100 - PADDING_TOP);
}

export default function Fretboard({ onNoteClick, onMoveNote, activeNotes = [], playingNotes = [] }) {
  const containerRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [dragNote, setDragNote] = useState(null); // { stringIndex, fret } of note being dragged
  const dragStartRef = useRef(null); // tracks mousedown position to distinguish click vs drag
  const didDragRef = useRef(false);

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
    const cellHeight = usableH / TOTAL_CELLS;

    const stringIndex = Math.round((x - leftPx) / stringSpacing);
    const fret = Math.floor((y - topPx) / cellHeight);

    if (stringIndex < 0 || stringIndex >= NUM_STRINGS || fret < 0 || fret >= TOTAL_CELLS) {
      return null;
    }

    return { stringIndex, fret };
  }, []);

  const handleMouseMove = useCallback((e) => {
    const pos = getStringAndFret(e);
    setHover(pos);

    if (dragStartRef.current && pos) {
      const start = dragStartRef.current;
      if (pos.stringIndex !== start.stringIndex || pos.fret !== start.fret) {
        didDragRef.current = true;
        setDragNote(pos);
      }
    }
  }, [getStringAndFret]);

  const handleMouseDown = useCallback((e) => {
    const result = getStringAndFret(e);
    if (!result) return;

    const isActive = activeNotes.some(
      n => n.stringIndex === result.stringIndex && n.fret === result.fret
    );

    if (isActive) {
      dragStartRef.current = result;
      didDragRef.current = false;
      setDragNote(result);
      e.preventDefault();
    }
  }, [getStringAndFret, activeNotes]);

  const handleMouseUp = useCallback((e) => {
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
  }, [getStringAndFret, onNoteClick, onMoveNote]);

  const noteName = hover ? getNoteName(hover.stringIndex, hover.fret) : null;

  return (
    <div className="fretboard-container">
      <div className="fretboard-note-box">
        {noteName || '\u00A0'}
      </div>
      <div
        className="fretboard"
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { setHover(null); dragStartRef.current = null; didDragRef.current = false; setDragNote(null); }}
      >
        {/* Nut - horizontal line between fret 0 and fret 1 */}
        <div style={{
          position: 'absolute',
          left: `${PADDING_LEFT - 1}%`,
          right: `${PADDING_RIGHT - 1}%`,
          top: `${cellTopPercent(1)}%`,
          height: 4,
          background: '#ccc',
          zIndex: 2,
        }} />

        {/* Fret wires - between each fret cell */}
        {Array.from({ length: NUM_FRETS - 1 }, (_, i) => (
          <div key={`fret-${i}`} style={{
            position: 'absolute',
            left: `${PADDING_LEFT - 1}%`,
            right: `${PADDING_RIGHT - 1}%`,
            top: `${cellTopPercent(i + 2)}%`,
            height: 1,
            background: '#555',
          }} />
        ))}

        {/* Fret dots - on the LEFT side */}
        {FRET_DOTS.filter(f => f <= NUM_FRETS).map(fret => {
          const isDouble = DOUBLE_DOTS.includes(fret);
          const topPercent = cellCenterPercent(fret);
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
        {Array.from({ length: TOTAL_CELLS }, (_, fret) => (
          <div key={`fnum-${fret}`} style={{
            position: 'absolute',
            right: 10,
            top: `${cellCenterPercent(fret)}%`,
            fontSize: 13,
            color: '#555',
            transform: 'translateY(-50%)',
            pointerEvents: 'none',
          }}>
            {fret}
          </div>
        ))}

        {/* Active notes at current beat */}
        {activeNotes.map((note, i) => {
          const isDragging = dragStartRef.current &&
            note.stringIndex === dragStartRef.current.stringIndex &&
            note.fret === dragStartRef.current.fret;
          if (isDragging) return null;
          const isPlaying = playingNotes.some(
            p => p.stringIndex === note.stringIndex && p.fret === note.fret
          );
          return (
            <div key={`active-${i}`} style={{
              position: 'absolute',
              left: `${PADDING_LEFT + (note.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
              top: `${cellCenterPercent(note.fret)}%`,
              width: 28,
              height: 10,
              borderRadius: 5,
              background: STRING_COLORS[note.stringIndex],
              boxShadow: isPlaying ? `0 0 10px 3px ${STRING_COLORS[note.stringIndex]}` : 'none',
              transform: 'translate(-50%, -50%) rotate(-35deg)',
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
              top: `${cellCenterPercent(note.fret)}%`,
              width: 28,
              height: 10,
              borderRadius: 5,
              background: STRING_COLORS[note.stringIndex],
              boxShadow: `0 0 10px 3px ${STRING_COLORS[note.stringIndex]}`,
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
            top: `${cellCenterPercent(dragNote.fret)}%`,
            width: 28,
            height: 10,
            borderRadius: 5,
            background: STRING_COLORS[dragNote.stringIndex],
            opacity: 0.8,
            transform: 'translate(-50%, -50%) rotate(-35deg)',
            pointerEvents: 'none',
            zIndex: 11,
          }} />
        )}

        {/* Hover indicator - pill in center of cell */}
        {hover && (
          <div style={{
            position: 'absolute',
            left: `${PADDING_LEFT + (hover.stringIndex / (NUM_STRINGS - 1)) * (100 - PADDING_LEFT - PADDING_RIGHT)}%`,
            top: `${cellCenterPercent(hover.fret)}%`,
            width: 28,
            height: 10,
            borderRadius: 5,
            background: '#fff',
            transform: 'translate(-50%, -50%) rotate(-35deg)',
            pointerEvents: 'none',
            zIndex: 10,
          }} />
        )}
      </div>
    </div>
  );
}
