import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  PANEL_TITLES, loadState, saveState, clearSavedState, defaultState, buildTree, computeRects,
  applyRatio, dropTarget, COLLAPSED_PX,
} from '../utils/dockLayout';

const MIN_PX = 90;       // smallest a split side may be dragged to
const GUTTER = 8;        // grab width of a resize gutter
const DRAG_START_PX = 5; // movement before a handle press becomes a drag

function useIsMobile() {
  const q = '(max-width: 768px)';
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

// Lays the four panels out as resizable, re-dockable cards. Panels are always rendered
// flat (keyed by id) and positioned from the layout tree, so moving one never remounts it.
export default function Dock({ menu, tracks, fretboard, timeline }) {
  const mobile = useIsMobile();
  const containerRef = useRef(null);
  const [st, setSt] = useState(() => loadState(window.innerWidth - 40, window.innerHeight - 40));
  const [drag, setDrag] = useState(null); // { id, x, y, hit }
  const stRef = useRef(st);
  stRef.current = st;

  const { panels, gutters } = useMemo(() => computeRects(buildTree(st, window.innerWidth - 40)), [st]);
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  const content = { menu, tracks, fretboard, timeline };

  const commit = useCallback((t) => { setSt(t); saveState(t); }, []);

  const resetLayout = useCallback(() => {
    clearSavedState();
    const el = containerRef.current;
    setSt(defaultState(el?.clientWidth, el?.clientHeight));
  }, []);

  // ---- resize a split by dragging its gutter ----
  const startResize = (e, g) => {
    e.preventDefault();
    const cr = containerRef.current.getBoundingClientRect();
    const isRow = g.dir === 'row';
    const origin = isRow ? cr.left + g.rect.x * cr.width : cr.top + g.rect.y * cr.height;
    const span = isRow ? g.rect.w * cr.width : g.rect.h * cr.height;
    const lo = Math.min(0.5, MIN_PX / span);
    const move = (ev) => {
      const pos = (isRow ? ev.clientX : ev.clientY) - origin;
      const r = Math.min(1 - lo, Math.max(lo, pos / span));
      setSt(applyRatio(stRef.current, g.key, g.inv, r));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('dock-resizing');
      saveState(stRef.current);
    };
    document.body.classList.add('dock-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---- drag a panel by its handle to dock it somewhere else ----
  const startDrag = (e, id) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    let active = false;
    const hitAt = (ev) => {
      const cr = containerRef.current.getBoundingClientRect();
      const fx = (ev.clientX - cr.left) / cr.width;
      const fy = (ev.clientY - cr.top) / cr.height;
      return dropTarget(id, stRef.current, panelsRef.current, fx, fy);
    };
    const move = (ev) => {
      if (!active) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_START_PX) return;
        active = true;
        document.body.classList.add('dock-dragging');
      }
      setDrag({ id, x: ev.clientX, y: ev.clientY, hit: hitAt(ev) });
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
      document.body.classList.remove('dock-dragging');
      if (active) {
        const h = hitAt(ev);
        if (h) commit(h.apply(stRef.current));
      }
      setDrag(null);
    };
    const key = (ev) => {
      if (ev.key === 'Escape') { active = false; up(ev); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
  };

  if (mobile) {
    return (
      <>
        {menu}
        {tracks}
        <div className="main-area">{fretboard}{timeline}</div>
      </>
    );
  }

  const pct = (v) => `${v * 100}%`;
  const hl = drag?.hit ? drag.hit.rect : null;
  const collapsed = st.menu !== 'top' && st.menuCollapsed;

  return (
    <div className="dock" ref={containerRef}>
      {Object.keys(PANEL_TITLES).map((id) => {
        const r = panels[id];
        return (
          <div
            key={id}
            className={`dock-panel dock-panel-${id}${drag?.id === id ? ' dragging' : ''}`}
            style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) }}
          >
            <div className="dock-card">
              <div
                className="dock-handle"
                onPointerDown={(e) => startDrag(e, id)}
                title={id === 'menu'
                  ? 'Drag to the left or right edge for a side bar, or the top edge for the top bar.'
                  : id === 'tracks'
                    ? 'Drag above or below the fretboard and timeline.'
                    : 'Drag onto the other half to swap the fretboard and timeline.'}
              >
                {id === 'menu' && st.menu !== 'top' && (
                  <button
                    className="dock-reset dock-collapse"
                    onClick={() => commit({ ...st, menuCollapsed: !st.menuCollapsed })}
                    title={collapsed ? 'Expand menu' : 'Collapse menu'}
                  >
                    {(st.menu === 'left') === collapsed ? '›' : '‹'}
                  </button>
                )}
                {!(id === 'menu' && collapsed) && <span className="dock-grip">⠿</span>}
                {!(id === 'menu' && collapsed) && <span className="dock-title">{PANEL_TITLES[id]}</span>}
                {id === 'menu' && !collapsed && (
                  <button className="dock-reset" onClick={resetLayout} title="Restore the default layout">
                    Reset layout
                  </button>
                )}
              </div>
              <div className="dock-body" style={id === 'menu' && collapsed ? { display: 'none' } : undefined}>{content[id]}</div>
            </div>
          </div>
        );
      })}
      {gutters.map((g) => {
        const isRow = g.dir === 'row';
        const style = isRow
          ? { left: `calc(${pct(g.rect.x + g.rect.w * g.ratio)} - ${GUTTER / 2}px)`, top: pct(g.rect.y), width: GUTTER, height: pct(g.rect.h) }
          : { top: `calc(${pct(g.rect.y + g.rect.h * g.ratio)} - ${GUTTER / 2}px)`, left: pct(g.rect.x), height: GUTTER, width: pct(g.rect.w) };
        return (
          <div
            key={g.key}
            className={`dock-gutter ${isRow ? 'row' : 'col'}`}
            style={style}
            onPointerDown={(e) => startResize(e, g)}
            title="Drag to resize"
          />
        );
      })}
      {hl && (
        <div
          className="dock-drop"
          style={{ left: pct(hl.x), top: pct(hl.y), width: pct(hl.w), height: pct(hl.h) }}
        />
      )}
      {drag && <div className="dock-ghost" style={{ left: drag.x + 12, top: drag.y + 12 }}>{PANEL_TITLES[drag.id]}</div>}
    </div>
  );
}
