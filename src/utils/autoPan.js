// Shared auto-pan helper: scrolls a container element when the cursor nears its edges
// during a drag. Consumers call .start(clientX, clientY, moveCb) on mousedown, .update
// on every mousemove, and .stop() on mouseup. moveCb fires after each auto-scroll tick
// so the drag's computation can re-run against the new scroll offset.
export function createAutoPan(getContainer) {
  let state = null;
  const tick = () => {
    if (!state) return;
    const body = getContainer();
    if (body) {
      const rect = body.getBoundingClientRect();
      const EDGE = 60;
      const MAX = 28;
      let dx = 0, dy = 0;
      if (state.clientX > rect.right - EDGE) {
        dx = Math.min(1, (state.clientX - (rect.right - EDGE)) / EDGE) * MAX;
      } else if (state.clientX < rect.left + EDGE) {
        dx = -Math.min(1, ((rect.left + EDGE) - state.clientX) / EDGE) * MAX;
      }
      if (state.clientY > rect.bottom - EDGE) {
        dy = Math.min(1, (state.clientY - (rect.bottom - EDGE)) / EDGE) * MAX;
      } else if (state.clientY < rect.top + EDGE) {
        dy = -Math.min(1, ((rect.top + EDGE) - state.clientY) / EDGE) * MAX;
      }
      let scrolled = false;
      if (dx !== 0) {
        const before = body.scrollLeft;
        body.scrollLeft = Math.max(0, Math.min(body.scrollWidth - body.clientWidth, body.scrollLeft + dx));
        if (body.scrollLeft !== before) scrolled = true;
      }
      if (dy !== 0) {
        const before = body.scrollTop;
        body.scrollTop = Math.max(0, Math.min(body.scrollHeight - body.clientHeight, body.scrollTop + dy));
        if (body.scrollTop !== before) scrolled = true;
      }
      if (scrolled && state.moveCb) state.moveCb(state.clientX, state.clientY);
    }
    if (state) state.rafId = requestAnimationFrame(tick);
  };
  const api = {
    start(initialClientX, initialClientY, moveCb) {
      api.stop();
      state = { clientX: initialClientX, clientY: initialClientY, moveCb };
      state.rafId = requestAnimationFrame(tick);
    },
    update(clientX, clientY) {
      if (state) { state.clientX = clientX; state.clientY = clientY; }
    },
    stop() {
      if (state?.rafId) cancelAnimationFrame(state.rafId);
      state = null;
    },
  };
  return api;
}
