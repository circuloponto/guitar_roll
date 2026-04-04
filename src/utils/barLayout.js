import { NUM_BARS, SUBDIVISIONS } from './constants';

// Default: all bars have the same number of subdivisions
export function defaultBarSubdivisions() {
  return Array(NUM_BARS).fill(SUBDIVISIONS);
}

// Total number of columns (beats) across all bars
export function totalColumns(barSubs) {
  return barSubs.reduce((sum, s) => sum + s, 0);
}

// Get the starting beat index of each bar
export function barStartBeats(barSubs) {
  const starts = [0];
  for (let i = 0; i < barSubs.length - 1; i++) {
    starts.push(starts[i] + barSubs[i]);
  }
  return starts;
}

// Convert a flat beat index to { barIndex, subIndex }
export function beatToBar(beat, barSubs) {
  let remaining = beat;
  for (let i = 0; i < barSubs.length; i++) {
    if (remaining < barSubs[i]) {
      return { barIndex: i, subIndex: remaining };
    }
    remaining -= barSubs[i];
  }
  return { barIndex: barSubs.length - 1, subIndex: barSubs[barSubs.length - 1] - 1 };
}

// Fixed bar pixel width (all bars same visual width)
function barPixelWidth(cellWidth) {
  return SUBDIVISIONS * cellWidth;
}

// Get pixel width of a single column in a given bar
export function colWidth(barIndex, barSubs, cellWidth) {
  return barPixelWidth(cellWidth) / barSubs[barIndex];
}

// Convert a beat to pixel X position (variable column widths)
export function beatToX(beat, barSubs, cellWidth) {
  const bpw = barPixelWidth(cellWidth);
  let x = 0;
  let remaining = beat;

  for (let i = 0; i < barSubs.length; i++) {
    if (remaining <= barSubs[i]) {
      x += (remaining / barSubs[i]) * bpw;
      break;
    }
    x += bpw;
    remaining -= barSubs[i];
  }

  return x;
}

// Convert pixel X to beat (variable column widths, fractional for free mode)
export function xToBeat(x, barSubs, cellWidth, snap = true) {
  const bpw = barPixelWidth(cellWidth);
  let remaining = x;
  let beat = 0;

  for (let i = 0; i < barSubs.length; i++) {
    if (remaining <= bpw) {
      const fraction = remaining / bpw;
      const rawBeat = fraction * barSubs[i];
      beat += snap ? Math.floor(rawBeat) : rawBeat;
      break;
    }
    remaining -= bpw;
    beat += barSubs[i];
  }

  return beat;
}

// Total grid width in pixels (all bars same width)
export function gridTotalWidth(barSubs, cellWidth) {
  return NUM_BARS * barPixelWidth(cellWidth);
}

// Get the pixel width for a note's duration
export function durationToWidth(beat, duration, barSubs, cellWidth) {
  return beatToX(beat + duration, barSubs, cellWidth) - beatToX(beat, barSubs, cellWidth);
}

// Get the beat label for a given beat index: "1", "1.1", "1.2", etc.
export function beatLabel(beat, barSubs) {
  const { barIndex, subIndex } = beatToBar(beat, barSubs);
  if (subIndex === 0) return `${barIndex + 1}`;
  return `${barIndex + 1}.${subIndex}`;
}

// Check if a beat is the first beat of a bar
export function isBarStart(beat, barSubs) {
  const starts = barStartBeats(barSubs);
  return starts.includes(beat);
}

// Get the bar index for a given beat
export function getBarIndex(beat, barSubs) {
  return beatToBar(beat, barSubs).barIndex;
}

// Remap notes when a bar's subdivision count changes
export function remapNotes(notes, oldBarSubs, newBarSubs, changedBarIndex) {
  const oldStart = barStartBeats(oldBarSubs);
  const newStart = barStartBeats(newBarSubs);
  const barBegin = oldStart[changedBarIndex];
  const oldBarEnd = barBegin + oldBarSubs[changedBarIndex];
  const shift = newBarSubs[changedBarIndex] - oldBarSubs[changedBarIndex];

  return notes.map(n => {
    if (n.beat >= oldBarEnd) {
      // Note is after the changed bar — shift it
      return { ...n, beat: n.beat + shift };
    }
    if (n.beat >= barBegin && n.beat < oldBarEnd) {
      // Note is inside the changed bar — rescale its position within the bar
      const fraction = (n.beat - barBegin) / oldBarSubs[changedBarIndex];
      return { ...n, beat: barBegin + fraction * newBarSubs[changedBarIndex] };
    }
    return n;
  });
}

// Get time in seconds for a given beat position
export function beatToTime(beat, barSubs, bpm) {
  const barDuration = 60 / bpm; // each bar = one beat at BPM
  let time = 0;
  let remaining = beat;

  for (let i = 0; i < barSubs.length; i++) {
    const colDuration = barDuration / barSubs[i];
    if (remaining <= barSubs[i]) {
      time += remaining * colDuration;
      break;
    }
    time += barDuration;
    remaining -= barSubs[i];
  }

  return time;
}

// Get the duration in seconds of one column at a specific beat
export function colDurationAtBeat(beat, barSubs, bpm) {
  const { barIndex } = beatToBar(beat, barSubs);
  const barDuration = 60 / bpm;
  return barDuration / barSubs[barIndex];
}
