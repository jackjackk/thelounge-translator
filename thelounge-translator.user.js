// ==UserScript==
// @name         The Lounge NL → EN Translator
// @namespace    thelounge-local-translator
// @version      1.3.0
// @description  Automatically translate Dutch The Lounge messages to English using the browser's local Translator API.
// @match        https://example.invalid/*
// @grant        none
// @run-at       document-idle
// @inject-into  page
// @noframes
// ==/UserScript==

(() => {
    "use strict";

    const SOURCE_LANGUAGE = "nl";
    const TARGET_LANGUAGE = "en";

    const MESSAGE_SELECTOR = '.msg[data-type="message"]';
    const TRANSLATION_CLASS = "local-en-translation";
    const STATE_ATTRIBUTE = "data-local-translation-state";

    let translator = null;
    let creatingTranslator = false;
    let processing = false;
    let rescanTimer = null;

    const queue = [];

    // -------------------------------------------------------------------------
    // Message handling
    // -------------------------------------------------------------------------

    function getContentElement(message) {
        return (
            message.querySelector(":scope > .content")
            || message.querySelector(".content")
        );
    }

    function getMessageText(message) {
        const content = getContentElement(message);

        if (!content) {
            return "";
        }

        const clone = content.cloneNode(true);

        clone.querySelectorAll([
            ".reply-context",
            ".preview",
            ".msg-shown-in-active",
            ".msg-statusmsg",
            `.${TRANSLATION_CLASS}`,
        ].join(",")).forEach((element) => element.remove());

        return clone.textContent
            .replace(/\s+/g, " ")
            .trim();
    }

    function appendTranslation(message, text) {
        const content = getContentElement(message);

        if (!content) {
            return;
        }

        content
            .querySelector(`.${TRANSLATION_CLASS}`)
            ?.remove();

        const element = document.createElement("div");

        element.className = TRANSLATION_CLASS;
        element.textContent = text;

        Object.assign(element.style, {
            opacity: "0.72",
            fontStyle: "italic",
            marginTop: "2px",
        });

        content.appendChild(element);
    }

    function enqueueMessage(message) {
        if (!translator) {
            return;
        }

        if (!(message instanceof HTMLElement)) {
            return;
        }

        if (!message.matches(MESSAGE_SELECTOR)) {
            return;
        }

        if (message.hasAttribute(STATE_ATTRIBUTE)) {
            return;
        }

        const text = getMessageText(message);

        if (!text) {
            return;
        }

        message.setAttribute(
            STATE_ATTRIBUTE,
            "queued"
        );

        queue.push({
            element: message,
            text,
        });

        processQueue();
    }

    async function processQueue() {
        if (
            processing
            || !translator
            || queue.length === 0
        ) {
            return;
        }

        processing = true;

        try {
            while (translator && queue.length > 0) {
                const { element, text } = queue.shift();

                if (!element.isConnected) {
                    continue;
                }

                try {
                    element.setAttribute(
                        STATE_ATTRIBUTE,
                        "translating"
                    );

                    const translated =
                        await translator.translate(text);

                    if (!element.isConnected) {
                        continue;
                    }

                    appendTranslation(
                        element,
                        translated
                    );

                    element.setAttribute(
                        STATE_ATTRIBUTE,
                        "done"
                    );
                } catch (error) {
                    console.error(
                        "[NL→EN] Translation failed:",
                        text,
                        error
                    );

                    element.removeAttribute(
                        STATE_ATTRIBUTE
                    );
                }
            }
        } finally {
            processing = false;

            if (translator && queue.length > 0) {
                processQueue();
            }
        }
    }

    // -------------------------------------------------------------------------
    // Existing messages
    // -------------------------------------------------------------------------

    function scanExistingMessages() {
        if (!translator) {
            return;
        }

        document
            .querySelectorAll(MESSAGE_SELECTOR)
            .forEach(enqueueMessage);
    }

    function scheduleRescan() {
        if (!translator) {
            return;
        }

        clearTimeout(rescanTimer);

        rescanTimer = setTimeout(
            scanExistingMessages,
            150
        );
    }

    // -------------------------------------------------------------------------
    // Watch The Lounge
    // -------------------------------------------------------------------------

    function startObserver() {
        const observer = new MutationObserver((mutations) => {
            if (!translator) {
                return;
            }

            let shouldRescan = false;

            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (!(node instanceof HTMLElement)) {
                        continue;
                    }

                    if (node.matches?.(MESSAGE_SELECTOR)) {
                        enqueueMessage(node);
                        continue;
                    }

                    const messages =
                        node.querySelectorAll?.(
                            MESSAGE_SELECTOR
                        );

                    if (messages?.length) {
                        messages.forEach(enqueueMessage);
                        shouldRescan = true;
                    }
                }
            }

            if (shouldRescan) {
                scheduleRescan();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
        });
    }

    // -------------------------------------------------------------------------
    // Translator initialization
    // -------------------------------------------------------------------------

    async function createTranslator() {
        if (translator || creatingTranslator) {
            return;
        }

        if (!("Translator" in globalThis)) {
            console.error(
                "[NL→EN] Translator API unavailable."
            );

            return;
        }

        creatingTranslator = true;

        try {
            translator = await Translator.create({
                sourceLanguage: SOURCE_LANGUAGE,
                targetLanguage: TARGET_LANGUAGE,

                monitor(monitor) {
                    monitor.addEventListener(
                        "downloadprogress",
                        (event) => {
                            console.log(
                                `[NL→EN] Model download: ${
                                    Math.round(event.loaded * 100)
                                }%`
                            );
                        }
                    );
                },
            });

            console.log(
                "[NL→EN] Translator ready."
            );

            /*
             * Translate everything already visible.
             */
            scanExistingMessages();

            /*
             * Additional scans catch messages The Lounge may still
             * be rendering asynchronously.
             */
            setTimeout(scanExistingMessages, 250);
            setTimeout(scanExistingMessages, 1000);

        } catch (error) {
            translator = null;

            console.warn(
                "[NL→EN] Automatic initialization failed:",
                error
            );

            /*
             * Chromium may require transient user activation to
             * create the Translator. Retry silently on the user's
             * first interaction with The Lounge.
             */
            if (
                error.name === "NotAllowedError"
                || error.name === "SecurityError"
            ) {
                armUserActivationRetry();
            } else {
                console.error(
                    "[NL→EN] Could not initialize translator.",
                    error
                );
            }
        } finally {
            creatingTranslator = false;
        }
    }

    let activationRetryArmed = false;

    function armUserActivationRetry() {
        if (activationRetryArmed) {
            return;
        }

        activationRetryArmed = true;

        console.log(
            "[NL→EN] Waiting for user interaction to initialize Translator."
        );

        const retry = () => {
            activationRetryArmed = false;

            document.removeEventListener(
                "pointerdown",
                retry,
                true
            );

            document.removeEventListener(
                "keydown",
                retry,
                true
            );

            /*
             * Run immediately while transient user activation
             * is still available.
             */
            createTranslator();
        };

        document.addEventListener(
            "pointerdown",
            retry,
            true
        );

        document.addEventListener(
            "keydown",
            retry,
            true
        );
    }

    // -------------------------------------------------------------------------
    // Start
    // -------------------------------------------------------------------------

    startObserver();
    createTranslator();

    console.log(
        "[NL→EN] The Lounge translator loaded."
    );
})();
