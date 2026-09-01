# The Lounge Local Translator

Translates The Lounge messages from a configurable source language to English:

`bericht [EN: message]`

Translation uses the browser's local `Translator` API.

## Browser

Desktop:

* Chrome 138+
* Microsoft Edge
* Brave/Chromium when the Translator API/backend is enabled
* Firefox/Safari: not supported

For Brave, if `Translator` is undefined, enable the Chromium feature:

`--enable-features=TranslationAPI`

Restart Brave afterwards.

## Language pack

Open:

`brave://on-device-translation-internals/`

Install the source ↔ English pack, e.g. `nl-en`.

## Install

1. Install Violentmonkey.
2. Enable **Allow User Scripts** in the browser's extension settings if required.
3. Open the GitHub `thelounge-translator.user.js` file and click **Raw** to install it.
4. In the script's Violentmonkey settings, override its Match with:

   `https://YOUR-THELOUNGE-HOST/*`

   Do not merge the original `example.invalid` match.
5. Reload The Lounge.
6. Use **Source** to choose `nl`, `de`, `fr`, etc.
7. Click **Enable XX→EN**.

The selected source language is saved locally. English is always the target.
