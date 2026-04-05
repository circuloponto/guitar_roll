import { useState, useRef, useEffect } from 'react';

const NOTE_VALUES = [
  { value: 0.125, label: '1/128' },
  { value: 0.25, label: '1/64' },
  { value: 0.5, label: '1/32' },
  { value: 1, label: '1/16' },
  { value: 2, label: '1/8' },
  { value: 4, label: '1/4' },
  { value: 8, label: '1/2' },
  { value: 16, label: '1/1' },
];

const TUPLET_POSITIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export default function DurationPicker({ baseNoteDuration, tuplet, noteDuration, durationOverride, onChange }) {
  const [open, setOpen] = useState(false);
  const [editingTuplet, setEditingTuplet] = useState(false);
  const [tupletText, setTupletText] = useState('');
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
        setEditingTuplet(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleBaseClick = (value) => {
    onChange(value, tuplet);
  };

  const handleTupletClick = (val) => {
    onChange(baseNoteDuration, val === tuplet ? 1 : val);
  };

  const handleCenterClick = () => {
    setEditingTuplet(true);
    setTupletText(String(tuplet));
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commitTupletEdit = () => {
    const val = Math.max(1, Math.min(15, parseInt(tupletText) || 1));
    onChange(baseNoteDuration, val);
    setEditingTuplet(false);
  };

  const currentLabel = NOTE_VALUES.find(nv => nv.value === baseNoteDuration)?.label || '?';

  // Circle geometry
  const dialSize = 80;
  const cx = dialSize / 2;
  const cy = dialSize / 2;
  const radius = 30;

  return (
    <div className="duration-picker" ref={containerRef}>
      <button
        className={`duration-picker-btn ${open ? 'open' : ''}`}
        onClick={() => setOpen(o => !o)}
      >
        {currentLabel}{tuplet > 1 ? ` ÷${tuplet}` : ''}
        {(tuplet > 1 || durationOverride != null) && <span className="dp-beats"> = {noteDuration.toFixed(2)}</span>}
      </button>

      {open && (
        <div className="duration-picker-popup">
          {/* Note value grid */}
          <div className="dp-note-grid">
            {NOTE_VALUES.map(nv => (
              <button
                key={nv.value}
                className={`dp-note-btn ${nv.value === baseNoteDuration ? 'active' : ''}`}
                onClick={() => handleBaseClick(nv.value)}
              >
                {nv.label}
              </button>
            ))}
          </div>

          <div className="dp-divider" />

          {/* Tuplet dial */}
          <div className="dp-tuplet-section">
            <div className="dp-tuplet-label">Tuplet</div>
            <div className="tuplet-dial" style={{ width: dialSize, height: dialSize }}>
              <svg width={dialSize} height={dialSize} viewBox={`0 0 ${dialSize} ${dialSize}`}>
                <circle cx={cx} cy={cy} r={radius} fill="none" stroke="#333" strokeWidth={2} />
                {TUPLET_POSITIONS.map(val => {
                  const angle = ((val - 1) / TUPLET_POSITIONS.length) * 2 * Math.PI - Math.PI / 2;
                  const x = cx + radius * Math.cos(angle);
                  const y = cy + radius * Math.sin(angle);
                  const isActive = val === tuplet;
                  return (
                    <g key={val} style={{ cursor: 'pointer' }} onClick={() => handleTupletClick(val)}>
                      <circle
                        cx={x} cy={y}
                        r={isActive ? 7 : 5}
                        fill={isActive ? '#e67e22' : '#2a2a2a'}
                        stroke={isActive ? '#e67e22' : '#555'}
                        strokeWidth={1}
                      />
                      <text
                        x={x} y={y}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={9}
                        fontWeight="bold"
                        fill={isActive ? '#000' : '#999'}
                        style={{ pointerEvents: 'none' }}
                      >
                        {val}
                      </text>
                    </g>
                  );
                })}
              </svg>
              {/* Center: shows current tuplet or input */}
              {editingTuplet ? (
                <input
                  ref={inputRef}
                  className="tuplet-center-input"
                  value={tupletText}
                  onChange={(e) => setTupletText(e.target.value)}
                  onBlur={commitTupletEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitTupletEdit();
                    if (e.key === 'Escape') setEditingTuplet(false);
                    e.stopPropagation();
                  }}
                />
              ) : (
                <div
                  className="tuplet-center"
                  onClick={handleCenterClick}
                  title="Click to type any tuplet (1-15)"
                >
                  {tuplet > 1 ? tuplet : '-'}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
