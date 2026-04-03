export const NUM_STRINGS = 6;
export const NUM_FRETS = 24;
export const NUM_BARS = 16;
export const SUBDIVISIONS = 4; // 4 subdivisions per bar (16th note feel)
export const CELL_WIDTH = 30; // pixels per subdivision
export const BAR_WIDTH = CELL_WIDTH * SUBDIVISIONS;
export const BPM = 120;

// String names (low to high, left to right on vertical fretboard)
export const STRING_NAMES = ['E', 'A', 'D', 'G', 'B', 'e'];

// Fret dot positions (standard guitar)
export const FRET_DOTS = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24];
export const DOUBLE_DOTS = [12, 24];

// String colors
export const STRING_COLORS = [
  '#e74c3c', // E - red
  '#e67e22', // A - orange
  '#f1c40f', // D - yellow
  '#2ecc71', // G - green
  '#3498db', // B - blue
  '#9b59b6', // e - purple
];
