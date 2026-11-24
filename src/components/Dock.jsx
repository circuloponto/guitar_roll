import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { Minus, Square, ExternalLink, LayoutPanelLeft } from 'lucide-react';
import {
  PANEL_TITLES, STRIP_PX, FLOAT_MIN_W, FLOAT_MIN_H,
  loadState, saveState, clearSavedState, defaultState, computeRects, setRatioAt, findParent, dropTarget, isEmptyId, shrinkFromEdge, pruneEmpty,
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

  const { panels, gutters } = useMemo(() => computeRects(st.tree, box, st.minimized), [st.tree, st.minimized, box]);
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
      // The content's own height (scrollHeight can't go below the panel's current height, so it
      // would never let the panel shrink after collapsing).
      const natural = [...body.children].reduce((sum, c) => sum + c.getBoundingClientRect().height, 0);
      const need = natural + 16 /* handle */ + 10 /* border + padding */;
      const par = findParent(s.tree, 'tracks');
      if (!par || par.node.dir !== 'col') return;
      const g = computeRects(s.tree, { w: el.clientWidth, h: el.clientHeight }, s.minimized).gutters.find(x => x.path === par.path);
      if (!g) return;
      const share = Math.max(0.06, Math.min(0.6, need / (g.rect.h * el.clientHeight)));
      const t = par.isA ? share : 1 - share;
      if (Math.abs(t - par.node.ratio) > 0.004) commit(setRatioAt(s, par.path, t));
    });
    window.addEventListener('guitar-roll-fit-tracks', fit);
    return () => window.removeEventListener('guitar-roll-fit-tracks', fit);
  }, [commit]);

  // Make the Tracks window this tall (a share of the dock area), e.g. when the Synth tab opens.
  useEffect(() => {
    const on = (e) => {
      const el = containerRef.current;
      const s = stRef.current;
      if (!el || s.floating.tracks || s.minimized.tracks) return;
      const par = findParent(s.tree, 'tracks');
      if (!par || par.node.dir !== 'col') return;
      const g = computeRects(s.tree, { w: el.clientWidth, h: el.clientHeight }, s.minimized).gutters.find(x => x.path === par.path);
      if (!g) return;
      const want = Math.min(0.8, e.detail?.share || 0.6);
      const own = par.isA ? par.node.ratio : 1 - par.node.ratio;
      if (own >= want) return;
      commit(setRatioAt(s, par.path, par.isA ? want : 1 - want));
    };
    window.addEventListener('guitar-roll-tracks-height', on);
    return () => window.removeEventListener('guitar-roll-tracks-height', on);
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
      const raw = pos / span;
      let node = stRef.current.tree;
      for (const c of g.path) node = node && !node.id ? node[c] : null;
      const hasEmpty = node && !node.id && (isEmptyId(node.a.id) || isEmptyId(node.b.id));
      // dragged (almost) all the way: an empty slot closes
      const r = hasEmpty && raw < lo * 0.5 ? 0.02 : hasEmpty && raw > 1 - lo * 0.5 ? 0.98
        : Math.min(1 - lo, Math.max(lo, raw));
      setSt(setRatioAt(stRef.current, g.path, r));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('dock-resizing');
      const pruned = pruneEmpty(stRef.current);
      stRef.current = pruned;
      setSt(pruned);
      saveState(pruned);
    };
    document.body.classList.add('dock-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Narrow/shorten a panel from an outer edge of the dock: the freed space becomes an empty slot.
  const startEdgeResize = (e, id, side) => {
    if (e.button !== 0) return;
    const r = panelsRef.current[id];
    const res = r && shrinkFromEdge(stRef.current, id, side);
    if (!res) return;
    stRef.current = res.st;
    setSt(res.st);
    startResize(e, { path: res.path, dir: res.dir, rect: r });
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
                  : 'Drag onto the edge of another panel to split it, onto its middle to swap, or onto the dock border. Double-click to minimise.'}
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
                    onClick={() => commit(fl ? dockBack(stRef.current, id, panelsRef.current, box) : undock(stRef.current, id, panelsRef.current[id]))}
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
      {Object.keys(panels).filter(isEmptyId).map((id) => {
        const r = panels[id];
        return (
          <div key={id} className="dock-empty" style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) }}>
            <span>Empty space: drag a panel here</span>
          </div>
        );
      })}
      {Object.keys(PANEL_TITLES).filter(id => !st.floating[id] && !st.minimized[id] && panels[id]).flatMap((id) => {
        const r = panels[id];
        const E = 0.0015;
        return [
          r.x < E && 'w', r.x + r.w > 1 - E && 'e', r.y < E && 'n', r.y + r.h > 1 - E && 's',
        ].filter(Boolean).map((side) => (
          <div
            key={id + side}
            className={`dock-bedge dock-bedge-${side}`}
            style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) }}
            onPointerDown={(e) => startEdgeResize(e, id, side)}
            title="Drag to resize; the freed space can hold another panel"
          />
        ));
      })}
      {gutters.map((g) => {
        const isRow = g.dir === 'row';
        const style = isRow
          ? { left: `calc(${pct(g.rect.x + g.rect.w * g.ratio)} - ${GUTTER / 2}px)`, top: pct(g.rect.y), width: GUTTER, height: pct(g.rect.h) }
          : { top: `calc(${pct(g.rect.y + g.rect.h * g.ratio)} - ${GUTTER / 2}px)`, left: pct(g.rect.x), height: GUTTER, width: pct(g.rect.w) };
        return (
          <div
            key={g.path || 'root'}
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
