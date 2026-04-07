import { useState, useEffect, useRef } from 'react';

export default function NumberInput({ value, min, max, step = 1, onChange, className, ...rest }) {
  const [text, setText] = useState(String(value));
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(null);
  const inputRef = useRef(null);

  // Sync external value changes
  useEffect(() => {
    setText(String(value));
  }, [value]);

  const clamp = (v) => {
    let c = v;
    if (min != null) c = Math.max(min, c);
    if (max != null) c = Math.min(max, c);
    return c;
  };

  const commit = () => {
    const v = Number(text);
    if (isNaN(v)) {
      setText(String(value));
      return;
    }
    const clamped = clamp(v);
    onChange(clamped);
    setText(String(clamped));
  };

  const handleMouseDown = (e) => {
    // Only start drag on middle click or if input isn't focused
    if (document.activeElement === inputRef.current) return;
    e.preventDefault();
    dragRef.current = {
      startY: e.clientY,
      startValue: value,
      moved: false,
    };

    const handleMove = (moveE) => {
      if (!dragRef.current) return;
      const dy = dragRef.current.startY - moveE.clientY;
      if (Math.abs(dy) > 2) {
        dragRef.current.moved = true;
        setDragging(true);
      }
      const delta = Math.round(dy / 4) * step;
      const newVal = clamp(dragRef.current.startValue + delta);
      if (newVal !== value) onChange(newVal);
    };

    const handleUp = () => {
      const wasDragging = dragRef.current?.moved;
      dragRef.current = null;
      setDragging(false);
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      // If didn't drag, focus the input for typing
      if (!wasDragging && inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="numeric"
      className={`number-input ${className || ''} ${dragging ? 'dragging' : ''}`}
      value={text}
      onMouseDown={handleMouseDown}
      onChange={(e) => {
        const val = e.target.value;
        // Allow only digits, minus, decimal
        if (val !== '' && !/^-?\d*\.?\d*$/.test(val)) return;
        setText(val);
        const v = Number(val);
        if (!isNaN(v) && val !== '' && val !== '-') {
          if ((min == null || v >= min) && (max == null || v <= max)) {
            onChange(v);
          }
        }
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.target.blur();
        if (e.key === 'ArrowUp') { e.preventDefault(); onChange(clamp(value + step)); }
        if (e.key === 'ArrowDown') { e.preventDefault(); onChange(clamp(value - step)); }
      }}
      {...rest}
    />
  );
}
