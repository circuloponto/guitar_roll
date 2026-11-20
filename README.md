# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## Copying notes between apps (guitar-roll <-> 43_scales)

Ctrl/Cmd+C puts the selected notes on the **system clipboard** as JSON; Ctrl/Cmd+V pastes
that JSON (or the in-app clipboard if the clipboard holds something else) at the playhead.
Pasted notes that run past the last bar extend the timeline.

Time is in **quarter notes**, so it is independent of each app's grid:

```json
{
  "format": "tonomancy-notes",
  "version": 1,
  "source": "guitar-roll",
  "notes": [
    { "start": 0, "length": 1, "midi": 64, "velocity": 0.8, "hint": { "s": 5, "f": 0 } }
  ]
}
```

- `start` is relative to the earliest copied note; `length` is the note length.
- `midi` is the pitch. `velocity` (0-1), `hint` (string 0-5 / fret) and `bend`/`slideTo`/`ghost` are optional;
  receivers ignore what they don't know. `hint` is only used if it still matches `midi`.
- guitar-roll: `quarters = columns * 4 / timeSignatureDenominator`.
- 43_scales: one cell is a 16th note, so `quarters = cells / 4`.
- Pitches the guitar cannot play (outside MIDI 40-88) are skipped on paste into guitar-roll.

Implementation: `src/utils/noteClipboard.js` (`serializeNotes`, `parseNotes`).
