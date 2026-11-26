// How the playhead behaves when you pause.
//   checkpoint (the default): Space pauses and the playhead goes back to where you pressed play. Enter then
//     jumps to where the playback was when you paused; Enter again goes to the beginning.
//   remnant: Space pauses and the playhead stays where playback stopped (Space again resumes from there).
//     Enter jumps back to where you last pressed play; Enter again goes to the beginning.
const KEY = 'guitar-roll-playhead-mode';
export const PLAYHEAD_MODES = {
  checkpoint: 'Checkpoint playhead',
  remnant: 'Remnant playhead',
};
export function loadPlayheadMode() {
  try { const v = localStorage.getItem(KEY); return PLAYHEAD_MODES[v] ? v : 'checkpoint'; } catch { return 'checkpoint'; }
}
export function savePlayheadMode(mode) {
  try { localStorage.setItem(KEY, mode); } catch { /* ignore */ }
}
