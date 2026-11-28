// A steady timer that keeps running when the browser tab is in the background. Page timers and
// requestAnimationFrame are throttled or paused there (playback would stall, the metronome stutter), but a
// worker's timer is not. Returns a function that stops it.
export function startTicker(fn, ms = 25) {
  let worker = null, url = null, id = null;
  try {
    url = URL.createObjectURL(new Blob([`setInterval(function(){postMessage(0)},${ms})`], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = () => fn();
  } catch {
    worker = null;
    id = setInterval(fn, ms);
  }
  return () => {
    if (worker) { worker.terminate(); worker = null; }
    if (url) { URL.revokeObjectURL(url); url = null; }
    if (id != null) { clearInterval(id); id = null; }
  };
}
