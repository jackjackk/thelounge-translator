# Third-party notices

## Bergamot Translator

This extension uses `@browsermt/bergamot-translator` 0.4.9, licensed under the
Mozilla Public License 2.0 (MPL-2.0).

The build copies Bergamot's JavaScript worker and WebAssembly runtime from the
installed npm package into `dist/vendor/bergamot/`. No remotely hosted JavaScript
or WebAssembly is executed by the extension.

## Firefox Translations Dutch → English model

The build prepares the legacy Firefox Translations `tiny/nlen` model set and
bundles the verified uncompressed assets into `dist/models/nlen/`:

- `model.nlen.intgemm.alphas.bin`
- `lex.50.50.nlen.s2t.bin`
- `vocab.nlen.spm`

The source model repository is the archived Mozilla
`mozilla/firefox-translations-models` repository, which carries a repository-level
MPL-2.0 license. The model files are downloaded only during build preparation;
the installed extension loads its packaged copies locally.

The configured SHA-256 hashes are recorded in `config.json` and checked by
`scripts/fetch-models.mjs` before the files are accepted.

## Notyf

This extension uses `notyf` 3.10.0 for in-page toast/balloon notifications.
Notyf is licensed under the MIT License. The build copies its minified JavaScript
and CSS from the installed npm package into `dist/vendor/notyf/`, so the extension
does not load notification code or styles from a CDN at runtime.

## Piper neural Dutch text-to-speech

This extension uses a bundled Piper-compatible Dutch neural voice for local
text-to-speech. The default voice is `nl_NL-pim-medium` from the
`rhasspy/piper-voices` repository. The voice repository is published under the
MIT License; the voice model card identifies its source voice dataset as CC0.
The ONNX model is pinned to the repository commit configured in `config.json`
and its SHA-256 is verified by `scripts/fetch-models.mjs` before packaging.

The installed extension reads the ONNX model and voice JSON from
`dist/models/tts/`; no TTS model is downloaded while the extension is running.

## Piper phonemizer WebAssembly

This extension uses `@diffusionstudio/piper-wasm` 1.0.0, licensed under the MIT
License. Its `piper_phonemize.js`, `piper_phonemize.wasm`, and bundled eSpeak
NG data file are copied from the installed npm package to `dist/vendor/piper/`.
These files convert Dutch text to the phoneme IDs expected by the Piper model.

## ONNX Runtime Web

This extension uses `onnxruntime-web` 1.18.0, licensed under the MIT License, to
run the bundled Piper ONNX model in WebAssembly. The build copies ONNX Runtime
JavaScript and WASM files into `dist/vendor/onnxruntime/`; the installed
extension does not fetch ONNX Runtime from a CDN.
