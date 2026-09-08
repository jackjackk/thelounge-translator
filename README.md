# Local Bergamot Translator

A Manifest V3 browser extension for Firefox and Chromium/Chrome that translates
Dutch content on configured websites to English with Bergamot WebAssembly,
translates English drafts to Dutch, speaks original Dutch text using a bundled
Piper neural voice, and collects translated message batches for Dutch-learning
sessions with an LLM. Website DOM integration is selected from reusable
selector profiles in `src/config.json`. The browser `Translator` API is not used.

## Runtime privacy model

The installed extension is **runtime-offline for translation and Piper TTS**:

- Bergamot JavaScript, Web Worker code, and WASM are copied into the extension.
- The Dutch → English and English → Dutch model assets are copied into the
  extension under `models/nlen/` and `models/ennl/`.
- The hidden engine page reads those model files from its own extension origin.
- Chat text is never sent to a translation service or model host.
- Piper phonemization, ONNX inference, and audio generation run locally in the
  same extension-origin engine page.
- The Dutch Piper voice model, Piper/eSpeak phonemizer WASM/data, and ONNX
  Runtime Web files are packaged with the extension.
- No Google Storage/GitHub/Hugging Face/model-registry host permission is
  requested by the built extension.

A network connection is needed only by the **build step** when a large model
file is not already present. Bergamot assets and the Piper ONNX model are
checksum-verified and kept under `src/models/`, so later builds can reuse them
offline. The small Piper `.onnx.json` voice configuration is tracked directly
in the source tree and is never downloaded during the build.

## Features

- Firefox + Chrome/Chromium Manifest V3 source.
- Multi-site configuration with reusable selector profiles. The default config enables `chat.revspace.nl` with the `thelounge` profile and `forum.revspace.nl` with the `discourse` profile.
- Bergamot inference runs locally in WebAssembly in an extension-origin engine
  page with a private `MessagePort` connection to the content script.
- Clicking the toolbar icon opens a compact extension popup. The popup contains a global translation ON/OFF switch while the badge continues to show `ON`/`OFF`.
- Persistent translation cache in `storage.local` for repeated messages across
  reloads/browser restarts.
- Bergamot's in-process sentence cache is also enabled.
- Duplicate messages in a batch are deduplicated before inference.
- Click an original Dutch message to synthesize it with bundled **Piper neural
  Dutch TTS** (`nl_NL-pim-medium` by default). The generated PCM audio is played
  through Web Audio and never leaves the browser. Repeated speech has a small
  in-memory PCM cache. URL substrings are removed before either Piper or the
  browser-TTS fallback receives the text, so links are not read aloud.
- While typing in a configured site composer, press **Ctrl+Shift+Y** (or
  **Meta+Shift+Y** on macOS) to replace the current English draft with a local
  Dutch translation. The extension never submits it; you can edit the Dutch
  draft and send it manually.
- Outgoing English → Dutch drafts have their own persistent cache.
- Successful incoming translation batches are saved locally as **Dutch study material**. Both the in-page `Dutch study` panel and browser-action popup can copy **all currently unused Dutch sentences in one combined LLM tutoring prompt**. The popup aggregates the underlying capture batches into prompt-history entries, shows the prompt creation time and an ellipsized Dutch preview, sorts history by most recently used prompt, and provides a compact **Re-copy** action. After a successful new prompt, every contributing stored batch is marked used atomically, so the next copy-all action contains only newly translated or explicitly re-queued material. The default copy-all-unused hotkey is **Ctrl+Shift+L** / **Meta+Shift+L**.
- Configuration lives in `src/config.json`.
- In-page status/debug balloons use vendored Notyf with `debug`, `info`,
  `warning`, and `error` levels.

## Build

Requires Node.js 18+ / npm and Python 3.

```bash
npm install
npm run check
npm run build
```

`npm run build` runs the model preparation step automatically. On the first
build it downloads the three Dutch → English assets, the three English → Dutch
assets, and the configured Piper Dutch ONNX voice **if they are missing**. The
small Piper `.onnx.json` voice configuration is already included in `src/`. All
assets, including that tracked config file, are integrity-checked before the
unpacked extension is built into `dist/`.

You can prepare/verify the model separately with:

```bash
npm run models
```

Once these files exist and pass verification, `npm run models` does not
redownload them:

```text
src/models/
├── nlen/
│   ├── model.nlen.intgemm.alphas.bin
│   ├── lex.50.50.nlen.s2t.bin
│   └── vocab.nlen.spm
├── ennl/
│   ├── model.ennl.intgemm.alphas.bin
│   ├── lex.50.50.ennl.s2t.bin
│   └── vocab.ennl.spm
└── tts/
    ├── nl_NL-pim-medium.onnx
    └── nl_NL-pim-medium.onnx.json
```

The configured build-time download sources are tried in order. GitHub's archived
Firefox Translations model repository is first, with the historical Bergamot
Google Storage location as a fallback. Piper's large ONNX file is obtained from
the pinned Piper voice source only when it is absent. HTTP 429 and transient 5xx
responses are retried with backoff. The Piper voice config is tracked locally,
avoiding a second Hugging Face request entirely. These URLs are used by the Node
build script only; they are not extension runtime permissions.

To make a ZIP:

```bash
npm run package
```

## Load in Chrome / Chromium

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select `dist/`.

## Load in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on…**.
3. Select `dist/manifest.json`.

For permanent Firefox distribution, sign/package it through Mozilla Add-ons or
an appropriate enterprise deployment flow.

## Configuration

Edit `src/config.json` before building. Website integration is split into two
layers:

- `siteGroups`: WebExtension match patterns and the selector profile each group
  uses. A group can contain several website matches, so multiple instances of
  the same application can share one DOM profile.
- `selectorProfiles`: reusable DOM selectors for locating messages/posts, their
  translatable content, elements excluded from extraction, interactive elements
  that must not trigger TTS, and the site's composer textarea.

The default configuration contains:

```json
{
  "siteGroups": [
    {
      "id": "thelounge-instances",
      "label": "The Lounge instances",
      "matches": [
        "https://chat.revspace.nl/*"
      ],
      "selectorProfile": "thelounge"
    },
    {
      "id": "revspace-discourse",
      "label": "RevSpace Discourse forum",
      "matches": [
        "https://forum.revspace.nl/*"
      ],
      "selectorProfile": "discourse"
    }
  ],
  "selectorProfiles": {
    "thelounge": {
      "messageSelectors": [".msg[data-type=\"message\"]"],
      "contentSelectors": [":scope > .content", ".content"],
      "excludedContentSelectors": [
        ".reply-context",
        ".preview",
        ".msg-shown-in-active",
        ".msg-statusmsg"
      ],
      "composer": {
        "inputSelectors": ["textarea#input"],
        "skipSlashCommands": true
      }
    },
    "discourse": {
      "messageSelectors": [".topic-post"],
      "contentSelectors": [
        ":scope .topic-body .cooked",
        ":scope .cooked"
      ],
      "excludedContentSelectors": [
        "aside.quote",
        "blockquote",
        "pre",
        "code",
        ".onebox",
        ".lightbox-wrapper",
        ".poll"
      ],
      "composer": {
        "inputSelectors": ["textarea.d-editor-input"],
        "skipSlashCommands": false
      }
    }
  },
  "sourceLanguage": "nl",
  "targetLanguage": "en",
  "speechLanguage": "nl-NL"
}
```

The full config also contains `interactiveSelectors` in each selector profile.
They prevent clicks on links, buttons, inputs, and other controls from starting
TTS.
Profiles can also declare `messageIdentityAttributes`. The default The Lounge
profile checks `data-id`/`id`, while the Discourse profile checks
`data-post-id`/`id`. These stable identifiers let the study-batch history avoid
recapturing the same lazy-rerendered message while still treating genuinely new
posts/messages as new learning material.

To add another The Lounge instance, add its match pattern to the existing
`thelounge-instances.matches` array instead of duplicating all selectors:

```json
"matches": [
  "https://chat.revspace.nl/*",
  "https://chat.example.org/*"
]
```

Alternatively, create another `siteGroups` entry that points to
`"selectorProfile": "thelounge"`. The same approach works for any other
reusable application profile.

`npm run build` flattens all `siteGroups[].matches` into the generated
`content_scripts`, `host_permissions`, and `web_accessible_resources` manifest
entries. At runtime the content script resolves the matching site group and uses
only that group's selector profile. The hidden engine page accepts connections
only from origins present in those configured site groups.

The supplied Discourse example targets the conventional topic-post DOM: rendered
post content under `.cooked` and the composer textarea
`textarea.d-editor-input`. Quotes, code blocks, oneboxes, lightboxes, and polls
are excluded from translation text to avoid translating duplicated/embedded
content. If a Discourse theme/plugin changes those DOM structures, adjust only
the `discourse` selector profile.

### Local Bergamot models

The model configuration is under `bergamot.localModels`. The default project
bundles direct `nl → en` and `en → nl` models:

- `modelPath`, `shortlistPath`, `vocabPaths`: extension-local model files.
- `expectedBytes`: exact uncompressed file sizes.
- `expectedSha256`: integrity hashes checked by `npm run models`.
- `engineConfig`: model-specific Bergamot settings. The bundled
  `intgemm.alphas` model uses `gemm-precision: int8shiftAlphaAll`.
- `downloadSources`: **build-time only** fallback sources used to populate
  `src/models/`.

The runtime engine implements a custom `TranslatorBacking`. Its registry is
constructed in memory from every entry in `bergamot.localModels`, and
`loadTranslationModel()` selects the matching language pair and reads its files
from the extension package. It never asks Bergamot's default backing to fetch a
registry or model over the network.

### English → Dutch composer hotkey

Composer inputs are selected by the active selector profile. The supplied
profiles use `textarea#input` for The Lounge and `textarea.d-editor-input` for
Discourse. With translation enabled, the default shortcuts are:

- `Ctrl+Shift+Y` on Windows/Linux.
- `Meta+Shift+Y` on macOS.

Press the shortcut after typing an English draft. The extension:

1. checks the persistent English → Dutch cache;
2. runs the bundled `en → nl` Bergamot model on a cache miss;
3. replaces the textarea value and dispatches a normal `input` event so the
   active application updates its composer state;
4. leaves focus and the caret in the composer; and
5. **does not submit the form or press Enter for you**.

If you edit the textarea while translation is running, the result is discarded
instead of overwriting your newer draft. The hotkeys and translation languages
remain global under `outgoingTranslation`, while each selector profile supplies
its own `composer.inputSelectors` and `composer.skipSlashCommands`. The Lounge
profile skips leading `/` commands; the Discourse profile does not.

Example global hotkey configuration:

```json
"outgoingTranslation": {
  "enabled": true,
  "fromLanguage": "en",
  "toLanguage": "nl",
  "hotkeys": [
    {"key": "y", "ctrl": true, "shift": true, "alt": false, "meta": false},
    {"key": "y", "ctrl": false, "shift": true, "alt": false, "meta": true}
  ]
}
```

The toolbar ON/OFF state also controls this composer shortcut.

### Extension popup

Starting with version 2.7.0, clicking the extension icon opens `popup.html`
instead of immediately toggling translation. The first control in the popup is
the global translation switch, so the previous ON/OFF behavior remains directly
available while making room for batch management. The toolbar badge still shows
`ON` or `OFF`.

The popup reads and mutates the same serialized background storage used by the
in-page study panel. It updates automatically when another tab captures or modifies
material. The stored units remain small capture batches, but starting in version
2.7.2 the popup no longer presents those implementation details one-by-one. Instead:

- every currently unused capture batch is shown as one **pending material** aggregate;
- batches that were copied together are grouped back into the single tutoring prompt
  that used them (their shared `copiedAt` timestamp identifies that prompt);
- prompt cards show the prompt creation time, sentence count, source context, and a
  two-line ellipsized preview rather than one row per captured message;
- used prompt groups are ordered by **last use, newest first**; re-copying a prompt
  updates `lastCopiedAt` so that prompt moves to the top without losing its original
  creation timestamp; and
- each historical prompt has a compact **Re-copy** button, while expanding the card
  reveals its Dutch sentences and a **Queue material again** action.

Version 2.7.1 already replaced native `<details>` rows with explicit cards to avoid
the horizontal-line compression seen in some browser popup layouts; version 2.7.2
keeps that fix while making each visible card an aggregate prompt/material group.

### Dutch study batches / LLM lesson prompt

Every successful incoming Dutch → English processing batch can also become a
persistent learning batch. This does **not** call an LLM or any remote API. The
extension stores the Dutch text plus its already-local Bergamot English
translation in `storage.local` for history/inspection, but the clipboard lesson
prompt contains **only the original Dutch text**. English translations are never
inserted into the copied LLM prompt. URL substrings are removed from each Dutch
sentence before it is copied.

There are two management surfaces for the same shared study material:

- clicking the extension toolbar icon opens a compact browser popup with the
  translation ON/OFF switch, prompt/unused-sentence/used-sentence counters,
  **Copy all unused**, refresh, clear-history, and aggregated prompt history;
- the floating **Dutch study** button on configured pages opens the existing
  Shadow-DOM panel with the same underlying capture history.

The main sequential action is **Copy all unused**. It combines every Dutch sentence
from all currently unused stored batches into one clipboard prompt. Once copying
succeeds, all contributing batches are marked used in one serialized background
operation. Running the action again therefore copies only material translated since
the previous lesson, plus any older batches you explicitly re-queued. If there is
no unused material, the extension copies nothing.

In the popup, history is deliberately prompt-centric rather than capture-batch-centric:

- the pending card aggregates every currently unused Dutch sentence;
- each used card represents one prompt creation event, with its creation time and an
  ellipsized preview;
- **Re-copy** copies that prompt's Dutch material again without making it unused;
- **Queue material again** returns all capture batches that belonged to that prompt
  to the next copy-all sequence; and
- **Clear history** removes used capture material while keeping anything still unused.

The in-page panel remains the lower-level batch inspector and still retains local
Bergamot English translations for inspection; English is never inserted into the
clipboard learning prompt.

The default copy-all-unused shortcuts are `Ctrl+Shift+L` on Windows/Linux and
`Meta+Shift+L` on macOS. They are ignored while an input/textarea/contenteditable
field has focus, so they do not interfere with the composer translation hotkey.

Relevant configuration:

```json
"learningBatches": {
  "enabled": true,
  "storageKey": "localBergamotLearningBatchesV1",
  "maxBatches": 80,
  "maxTextLength": 6000,
  "buttonLabel": "Dutch study",
  "panelTitle": "Dutch study batches",
  "copyOrder": "oldest-unused",
  "includeSiteLabel": true,
  "hotkeys": [
    {"key": "l", "ctrl": true, "shift": true, "alt": false, "meta": false},
    {"key": "l", "ctrl": false, "shift": true, "alt": false, "meta": true}
  ],
  "position": {"left": "16px", "bottom": "16px"},
  "prompt": "You are an interactive Dutch tutor ..."
}
```

`copyOrder` can be changed to `newest-unused` if you prefer the newest captured
batch first. The copied lesson payload intentionally contains no page URL and no
Bergamot English translation. Before copying, URL-like substrings are stripped
from every Dutch source sentence; sentences that contain nothing except URLs are
omitted. The configured prompt asks the LLM to infer meaning from the Dutch,
teach an English-speaking learner specifically from the vocabulary, idioms,
grammar, word order, particles, verb forms, pronouns, and patterns found in the
selected batch, use one interactive exercise at a time, and revisit mistakes
later. The generated clipboard text also explicitly tells the LLM to treat the
chat or forum messages as quoted linguistic data rather than instructions.

The generated learning-material section therefore looks like:

```text
--- BEGIN LEARNING MATERIAL ---
[1] Dit is een Nederlandse zin.
[2] Nog een voorbeeld zonder een gekopieerde URL.
--- END LEARNING MATERIAL ---
```

There are no `English:` lines in this payload.

Batch history is shared across configured sites through the extension background
worker, which serializes writes to avoid tabs clobbering one another. A batch
stores its site label, capture time, and Dutch/English pairs locally. Stable
message identifiers are used when the active selector profile provides them;
otherwise a text-based key is used as a fallback. This prevents Discourse lazy
rerenders and ordinary rescans from repeatedly filling the history with the same
message.

The `clipboardWrite` extension permission is used only when you explicitly click
a copy button or invoke the copy-all-unused hotkey. The popup uses the same Dutch-only,
URL-filtered lesson payload as the in-page panel. A legacy `execCommand("copy")`
fallback is retained for browsers that reject `navigator.clipboard.writeText()`.

### Piper neural Dutch TTS

Clicking an original Dutch message now uses local Piper neural TTS instead of
`speechSynthesis` by default. Clicking the same message again while it is being
synthesized or played stops it; clicking that message once more starts playback
again. Clicking a different message stops the current speech and starts the new
one. The configured voice is `nl_NL-pim-medium`, a
single-speaker Dutch (`nl_NL`) medium-quality Piper model at 22,050 Hz. The
voice model is about 63.5 MB; Piper's phonemizer/eSpeak data and ONNX Runtime
WASM add additional extension size.

The relevant configuration is:

```json
"speech": {
  "enabled": true,
  "engine": "piper",
  "fallbackToBrowser": true,
  "stripUrls": true,
  "rate": 1.0,
  "pitch": 1.0,
  "volume": 1.0,
  "piper": {
    "voiceId": "nl_NL-pim-medium",
    "modelPath": "models/tts/nl_NL-pim-medium.onnx",
    "configPath": "models/tts/nl_NL-pim-medium.onnx.json",
    "speakerId": 0,
    "maxTextLength": 1200,
    "audioCacheEntries": 24,
    "ortThreads": 1
  }
}
```

With `stripUrls: true` (the default), TTS removes `http://`, `https://`,
`ftp://`, `www.` links, bare domain/path forms such as `example.nl/page`,
`localhost` URLs, and IPv4 URL forms before synthesis. Only the temporary speech
text is changed; the original Lounge message remains untouched. If a message is
only a URL, speech is skipped. Set `stripUrls` to `false` to restore the previous
behavior.

`rate` is implemented by adjusting Piper's `length_scale`; `volume` is applied
through Web Audio. Piper does not provide an independent pitch control in this
integration, so `pitch` is used only by the optional browser-TTS fallback.

On the first click after loading the extension, the engine page reads the
packaged ONNX model and voice config, initializes ONNX Runtime Web, initializes
the packaged Piper/eSpeak phonemizer, phonemizes the Dutch text, and runs the
voice model. Subsequent clicks reuse the initialized model session. Repeating
the same message at the same rate can use the in-memory audio cache.

The click handler creates/resumes a Web Audio `AudioContext` during the actual
user click. This preserves browser user activation while neural inference runs
asynchronously, so the completed local audio can play without auto-submitting
or changing anything in the active website.

If Piper fails and `fallbackToBrowser` is `true`, the extension shows a warning
and uses the best available Dutch `speechSynthesis` voice for that one message.
Set it to `false` if you want speech to fail closed rather than use the browser
voice.

The build-time Piper ONNX source is pinned in `src/config.json`. The accompanying
`nl_NL-pim-medium.onnx.json` metadata is a tracked, checksum-verified source file
so builds do not depend on downloading that tiny file from Hugging Face. The
installed extension has no Hugging Face host permission and performs no TTS
model/network fetches at runtime.

### Worker startup / structured-clone fix (2.3.1)

Bergamot initializes its WASM worker by sending `TranslatorBacking.options`
through `worker.postMessage()`. Web Worker messages use the structured-clone
algorithm, so functions cannot be included. Version 2.3.0 accidentally passed
the `onerror` callback inside the backing options object, producing
`Function object could not be cloned` before either language model could load.

Version 2.3.1 keeps worker initialization options to cloneable primitive values
only, assigns the error callback to the backing *after* construction, validates
the options with `structuredClone()`, and prewarms the configured worker pool.
The overlay now explicitly reports worker-option validation, individual worker
startup, success, and startup failure.

### What the debug overlay now shows

With `notifications.minLevel` set to `debug`, the page reports the complete local
startup path without displaying chat contents:

1. Configuration loaded, current host, selected site group, and selected selector profile.
2. Persistent message-cache entry count.
3. Engine-host iframe creation/connection.
4. Bergamot WASM worker startup.
5. Confirmation that the local `nl → en` and `en → nl` registry entries are active.
6. Bundled model load start and expected total size.
7. Each local model/shortlist/vocab file being read.
8. Each file's loaded size and elapsed time.
9. Model-ready total size/time.
10. Piper ONNX model/config loading, phonemizer startup, and neural TTS readiness.
11. Piper synthesis/cache timing without displaying the message contents.
12. Per-batch persistent-cache hits/misses and messages submitted to Bergamot.
13. New Dutch/English pairs captured into the persistent study-batch queue.
14. Translation/TTS success, cache persistence warnings, cleanup errors, or
    worker failures.

If a bundled file is missing, corrupt, or the wrong size, the overlay now says
which local file failed and tells you to run:

```bash
npm run models
npm run build
```

then reload the extension.

After debugging, set `notifications.minLevel` to `info` or `warning` to reduce
noise.

### Persistent message cache

Translations are stored in `storage.local`. Incoming `nl → en` messages and
outgoing `en → nl` drafts use separate cache stores. Dutch study-batch history
uses a third storage key and keeps its own used/unused state. Cache keys include the
source/target language pair and a hash of the original text; the full original
text is also checked to protect against hash collisions. Entries are pruned when
`maxEntries` is exceeded.

Turning translation OFF removes rendered translations and releases the Bergamot
worker/model memory. Turning it back ON rescans the conversation; cached messages
render immediately and only cache misses run local inference.

## Source layout

```text
README.md
package.json
scripts/
├── build.mjs
├── fetch-models.mjs
├── package.py
└── validate.mjs
src/
├── manifest.json
├── background.js
├── content.js
├── popup.html
├── popup.css
├── popup.js
├── engine-host.html
├── engine-host.js
├── config.json
├── THIRD_PARTY_NOTICES.md
├── icons/
└── models/
    ├── nlen/                 downloaded/verified at build preparation time
    ├── ennl/                 downloaded/verified at build preparation time
    └── tts/
        └── nl_NL-pim-medium.onnx.json   tracked source metadata; ONNX downloaded separately

dist/                        generated unpacked extension
```

`src/` contains only files that are extension inputs. Project/build tooling stays
beside `src/` at the repository root.

### Piper PCM transport compatibility (2.4.3)

Piper audio is synthesized inside `engine-host.html`, an extension iframe. Firefox and Chrome treat frames/content scripts as separate JavaScript realms, so a valid transferred `ArrayBuffer` is not guaranteed to satisfy `instanceof ArrayBuffer` against the content script's constructor. Version 2.4.3 uses realm-safe PCM detection, accepts ArrayBuffer/typed-array payloads, validates sample rate and finite PCM samples, and transfers an exact standalone PCM byte range. Debug notifications show the PCM byte/sample count before Web Audio playback.

## Discourse lazy-loaded / rerendered posts

Version 2.5.2 makes the DOM watcher resilient to Discourse's dynamic post
stream. A post wrapper can exist before its `.cooked` body is populated, and a
rendered `.cooked` subtree can later be replaced while scrolling. The extension
now treats mutations *inside* an existing configured message container as a
reason to re-check that message, observes text-node changes, and restores a
cached translation when a rerender removes only the injected translation DOM.

The extension also tracks the source text associated with each live message
container. If a virtualized/rerendered container changes before a Bergamot
request finishes, the stale result is discarded instead of being attached to
the new post content, and the current content is queued separately.

## The Lounge bottom-scroll anchoring

Version 2.7.3 avoids the small extra scroll that was previously needed when an
inline translation increased the height of the final visible The Lounge message.
The behavior is configured per selector profile:

```json
"translationScroll": {
  "keepBottomPinned": true,
  "bottomThresholdPx": 32
}
```

Before inserting a translation the content script finds the nearest vertically
scrollable ancestor of the message and measures its distance from the bottom. If
the view was already within `bottomThresholdPx`, it restores the new bottom after
the translation is inserted and during the next two layout frames. If the reader
was farther up the history, the extension does not move the scroll position. An
upward user scroll during those settling frames cancels the pin, so the helper
does not fight intentional scrolling.

The option is enabled for the reusable `thelounge` selector profile and omitted
for the `discourse` profile.
