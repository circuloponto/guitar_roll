import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { Minus, Square, ExternalLink, LayoutPanelLeft } from 'lucide-react';
import {
  PANEL_TITLES, STRIP_PX, FLOAT_MIN_W, FLOAT_MIN_H,
  loadState, saveState, clearSavedState, defaultState, buildTree, computeRects, applyRatio, dropTarget,
  toggleMinimized, undock, dockBack, raiseFloating, setFloatRect,
} from '../utils/dockLayout';

const MIN_PX = 90;       // smallest a split side may be dragged to
const GUTTER = 8;        // grab width of a resize gutter
const DRAG_START_PX = 5; // movement before a handle press becomes a drag
const FLOAT_Z = 30;
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

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

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// FL Studio style windows: panels resize against their neighbours (which adapt), minimise to a
// title strip, and undock into floating windows. Panels are always rendered flat (keyed by id) and
// positioned from the layout state, so docking, undocking and moving never remount them.
export default function Dock({ menu, tracks, fretboard, timeline }) {
  const mobile = useIsMobile();
  const containerRef = useRef(null);
  const [st, setSt] = useState(() => loadState(window.innerWidth - 40, window.innerHeight - 40));
  const [drag, setDrag] = useState(null); // { id, x, y, hit }
  const [box, setBox] = useState({ w: Math.max(400, window.innerWidth - 40), h: Math.max(300, window.innerHeight - 100) });
  const stRef = useRef(st);
  stRef.current = st;

  // size of the dock area in px (floating windows and minimised strips are sized in px)
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const measure = () => setBox(prev => (el.clientWidth > 0 && (Math.abs(prev.w - el.clientWidth) > 0.5 || Math.abs(prev.h - el.clientHeight) > 0.5)
      ? { w: el.clientWidth, h: el.clientHeight } : prev));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mobile]);

  const tree = useMemo(() => buildTree(st), [st]);
  const { panels, gutters } = useMemo(() => computeRects(tree, box), [tree, box]);
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  const content = { menu, tracks, fretboard, timeline };

  const commit = useCallback((t) => { setSt(t); saveState(t); }, []);

  // The Tracks panel grows or shrinks to fit its content when the track list is expanded/collapsed.
  useEffect(() => {
    const fit = () => requestAnimationFrame(() => {
      const el = containerRef.current;
      const body = el?.querySelector('.dock-panel-tracks .dock-body');
      const s = stRef.current;
      if (!el || !body || s.floating.tracks || s.minimized.tracks) return;
      const H = el.clientHeight;
      const menuTop = s.menu === 'top' && !s.floating.menu;
      const menuShare = menuTop ? (s.minimized.menu ? STRIP_PX / H : s.sizes.menuTop) : 0;
      const centerPx = H * (1 - menuShare);
      if (!(centerPx > 0)) return;
      // The content's own height (scrollHeight can't go below the panel's current height, so it
      // would never let the panel shrink after collapsing).
      const natural = [...body.children].reduce((sum, c) => sum + c.getBoundingClientRect().height, 0);
      const need = natural + 16 /* handle */ + 10 /* border + padding */;
      const t = Math.max(0.06, Math.min(0.6, need / centerPx));
      if (Math.abs(t - s.sizes.tracks) > 0.004) commit({ ...s, sizes: { ...s.sizes, tracks: t } });
    });
    window.addEventListener('guitar-roll-fit-tracks', fit);
    return () => window.removeEventListener('guitar-roll-fit-tracks', fit);
  }, [commit]);

  const resetLayout = useCallback(() => {
    clearSavedState();
    const el = containerRef.current;
    setSt(defaultState(el?.clientWidth, el?.clientHeight));
  }, []);

  // "Reset layout" from Settings > Look & Feel
  useEffect(() => {
    const on = () => resetLayout();
    window.addEventListener('guitar-roll-reset-layout', on);
    return () => window.removeEventListener('guitar-roll-reset-layout', on);
  }, [resetLayout]);

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

  // ---- drag a docked panel by its title bar to dock it somewhere else ----
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

  // ---- floating windows: move by the title bar, resize from any edge or corner ----
  const startFloatDrag = (e, id) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const start = stRef.current.floating[id];
    if (!start) return;
    const cr = containerRef.current.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const move = (ev) => {
      const x = clamp(start.x + (ev.clientX - sx) / cr.width, 0.06 - start.w, 0.94);
      const y = clamp(start.y + (ev.clientY - sy) / cr.height, 0, 0.95);
      setSt(setFloatRect(stRef.current, id, { ...start, x, y }));
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

  const startFloatResize = (e, id, dir) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r0 = stRef.current.floating[id];
    if (!r0) return;
    const cr = containerRef.current.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const minW = FLOAT_MIN_W / cr.width, minH = FLOAT_MIN_H / cr.height;
    const move = (ev) => {
      const dx = (ev.clientX - sx) / cr.width, dy = (ev.clientY - sy) / cr.height;
      let { x, y, w, h } = r0;
      if (dir.includes('e')) w = clamp(r0.w + dx, minW, 1.5);
      if (dir.includes('s')) h = clamp(r0.h + dy, minH, 1.5);
      if (dir.includes('w')) { const nw = clamp(r0.w - dx, minW, 1.5); x = r0.x + (r0.w - nw); w = nw; }
      if (dir.includes('n')) { const nh = clamp(r0.h - dy, minH, 1.5); y = r0.y + (r0.h - nh); h = nh; }
      setSt(setFloatRect(stRef.current, id, { x, y: Math.max(0, y), w, h }));
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

  return (
    <div className="dock" ref={containerRef}>
      {Object.keys(PANEL_TITLES).map((id) => {
        const fl = st.floating[id];
        const minimized = !!st.minimized[id];
        let style;
        let vertical = false;
        if (fl) {
          style = {
            left: fl.x * box.w, top: fl.y * box.h, width: fl.w * box.w,
            height: minimized ? STRIP_PX : fl.h * box.h,
            zIndex: FLOAT_Z + Math.max(0, st.order.indexOf(id)),
          };
        } else {
          const r = panels[id];
          if (!r) return null;
          style = { left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) };
          if (minimized) {
            vertical = r.w * box.w <= STRIP_PX + 14;
            if (vertical) { style.width = STRIP_PX; } else { style.height = STRIP_PX; }
          }
        }
        const onDouble = (e) => { if (!e.target.closest('button')) commit(toggleMinimized(stRef.current, id)); };
        return (
          <div
            key={id}
            className={`dock-panel dock-panel-${id}${fl ? ' floating' : ''}${minimized ? ' minimized' : ''}${vertical ? ' vertical' : ''}${drag?.id === id ? ' dragging' : ''}`}
            style={style}
            onPointerDownCapture={fl ? () => { const n = raiseFloating(stRef.current, id); if (n !== stRef.current) commit(n); } : undefined}
          >
            <div className="dock-card">
              <div
                className="dock-handle"
                onPointerDown={(e) => { if (fl) startFloatDrag(e, id); else if (!minimized) startDrag(e, id); }}
                onDoubleClick={onDouble}
                title={fl
                  ? 'Drag to move this window. Double-click to minimise.'
                  : id === 'menu'
                    ? 'Drag to the left or right edge for a side bar, or the top edge for the top bar. Double-click to minimise.'
                    : id === 'tracks'
                      ? 'Drag above or below the fretboard and timeline. Double-click to minimise.'
                      : 'Drag onto the other half to swap the fretboard and timeline. Double-click to minimise.'}
              >
                <span className="dock-grip">⠿</span>
                <span className="dock-title">{PANEL_TITLES[id]}</span>
                <span className="dock-btns">
                  {id === 'menu' && !minimized && (
                    <button className="dock-reset" onClick={resetLayout} title="Restore the default layout">
                      Reset layout
                    </button>
                  )}
                  <button
                    className="dock-btn"
                    onClick={() => commit(toggleMinimized(stRef.current, id))}
                    title={minimized ? 'Restore' : 'Minimise'}
                    aria-label={minimized ? 'Restore' : 'Minimise'}
                  >
                    {minimized ? <Square size={10} /> : <Minus size={11} />}
                  </button>
                  <button
                    className="dock-btn"
                    onClick={() => commit(fl ? dockBack(stRef.current, id) : undock(stRef.current, id, panelsRef.current[id]))}
                    title={fl ? 'Dock back into the layout' : 'Undock into a floating window'}
                    aria-label={fl ? 'Dock' : 'Undock'}
                  >
                    {fl ? <LayoutPanelLeft size={11} /> : <ExternalLink size={11} />}
                  </button>
                </span>
              </div>
              <div className="dock-body" style={minimized ? { display: 'none' } : undefined}>{content[id]}</div>
            </div>
            {fl && !minimized && EDGES.map((d) => (
              <div key={d} className={`dock-edge dock-edge-${d}`} onPointerDown={(e) => startFloatResize(e, id, d)} />
            ))}
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
