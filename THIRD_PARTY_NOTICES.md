# Third-party notices

## UltraBox / BeepBox synthesizer (MIT)

`public/vendor/ultrabox_synth.js` is the UltraBox synthesis engine
(https://github.com/ultraabox/ultrabox_typescript, a fork of BeepBox by John Nesky), used to render
the UltraBox instruments. `public/vendor/ultrabox_presets.json` holds the instrument presets that
ship with UltraBox. The UltraBox sample packs are not included.

Copyright (c) 2012-2022 John Nesky and contributing authors. Licensed under the MIT License; the
full text is in `public/vendor/ULTRABOX_LICENSE.md`.

## Basic Pitch (Apache License 2.0)

`public/vendor/basic-pitch/` holds the model files of Spotify's Basic Pitch
(https://github.com/spotify/basic-pitch-ts), used for the audio-to-notes draft (Transcription).
The `@spotify/basic-pitch` package and TensorFlow.js run it in the browser; nothing is uploaded.
Copyright Spotify AB. Licensed under the Apache License 2.0; the text is in
`public/vendor/basic-pitch/LICENSE`.
