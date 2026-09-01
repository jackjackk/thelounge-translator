// ==UserScript==
// @name         The Lounge Local Translator
// @namespace    thelounge-local-translator
// @version      1.1.0
// @description  Translate The Lounge messages locally to English using the browser Translator API.
// @match        https://example.invalid/*
// @grant        none
// @run-at       document-idle
// @inject-into  page
// @noframes
// ==/UserScript==

(() => {
    "use strict";

    const TARGET_LANGUAGE = "en";
    const DEFAULT_SOURCE_LANGUAGE = "nl";

    const STORAGE_KEY = "thelounge-translator.source-language";

    const MESSAGE_SELECTOR = '.msg[data-type="message"]';
    const TRANSLATION_CLASS = "local-en-translation";
    const STATE_ATTRIBUTE = "data-local-translation-state";

    let translator = null;
    let processing = false;
    let rescanTimer = null;

    const queue = [];

    let enableButton;
    let sourceButton;

    // -------------------------------------------------------------------------
    // Settings
    // -------------------------------------------------------------------------

    function getSourceLanguage() {
        return (
            localStorage.getItem(STORAGE_KEY)
            || DEFAULT_SOURCE_LANGUAGE
        );
    }

    function setSourceLanguage(language) {
        localStorage.setItem(
            STORAGE_KEY,
            language.toLowerCase()
        );

        destroyTranslator();
        resetMessages();
        updateControls();
    }

    function destroyTranslator() {
        try {
            translator?.destroy?.();
        } catch {
            // Ignore cleanup errors.
        }

        translator = null;
        processing = false;
        queue.length = 0;
    }

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

        // Remove things that aren't part of the actual chat message.
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

        const element = document.createElement("span");

        element.className = TRANSLATION_CLASS;
        element.textContent = ` [EN: ${text}]`;

        Object.assign(element.style, {
            opacity: "0.72",
            fontStyle: "italic",
            marginLeft: "0.4ch",
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

        // Prevent translating the same DOM message twice.
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

                    // The Lounge may have replaced the DOM node
                    // while translation was running.
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
                        "[The Lounge Translator] Translation failed:",
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

        const messages =
            document.querySelectorAll(MESSAGE_SELECTOR);

        console.debug(
            `[The Lounge Translator] Scanning ${messages.length} existing messages`
        );

        messages.forEach(enqueueMessage);
    }

    /*
     * The Lounge is a Vue application and can replace chunks of the
     * message DOM when changing channels / loading history.
     *
     * Debouncing avoids rescanning hundreds of times during one render.
     */
    function scheduleRescan() {
        if (!translator) {
            return;
        }

        clearTimeout(rescanTimer);

        rescanTimer = setTimeout(() => {
            scanExistingMessages();
        }, 150);
    }

    function resetMessages() {
        queue.length = 0;

        document
            .querySelectorAll(MESSAGE_SELECTOR)
            .forEach((message) => {
                message.removeAttribute(
                    STATE_ATTRIBUTE
                );

                message
                    .querySelector(`.${TRANSLATION_CLASS}`)
                    ?.remove();
            });
    }

    // -------------------------------------------------------------------------
    // Mutation observer
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

                    /*
                     * Fast path for newly-arriving messages.
                     */
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

            /*
             * Useful when The Lounge rerenders a channel or loads
             * an older batch of messages.
             */
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
    // Translator
    // -------------------------------------------------------------------------

    async function enableTranslator() {
        if (translator) {
            return;
        }

        if (!("Translator" in globalThis)) {
            console.error(
                "[The Lounge Translator] Translator API unavailable."
            );

            enableButton.textContent =
                "Translator unavailable";

            enableButton.disabled = true;

            return;
        }

        const sourceLanguage =
            getSourceLanguage();

        enableButton.disabled = true;
        sourceButton.disabled = true;

        enableButton.textContent =
            `Starting ${sourceLanguage.toUpperCase()}→EN…`;

        try {
            /*
             * Keep Translator.create() directly inside the user
             * interaction path.
             */
            translator = await Translator.create({
                sourceLanguage,
                targetLanguage: TARGET_LANGUAGE,

                monitor(monitor) {
                    monitor.addEventListener(
                        "downloadprogress",
                        (event) => {
                            const percent =
                                Math.round(
                                    event.loaded * 100
                                );

                            enableButton.textContent =
                                `Downloading ${sourceLanguage.toUpperCase()}→EN ${percent}%`;
                        }
                    );
                },
            });

            console.log(
                `[The Lounge Translator] ${sourceLanguage} → en ready`
            );

            enableButton.textContent =
                `${sourceLanguage.toUpperCase()}→EN enabled`;

            sourceButton.disabled = false;

            /*
             * IMPORTANT:
             * Translate every message that is already present
             * when translation gets enabled.
             */
            scanExistingMessages();

            /*
             * The Lounge may still be finishing a Vue render,
             * so scan again shortly afterwards.
             */
            setTimeout(scanExistingMessages, 250);
            setTimeout(scanExistingMessages, 1000);

        } catch (error) {
            console.error(
                "[The Lounge Translator] Could not create translator:",
                error
            );

            translator = null;

            enableButton.disabled = false;
            sourceButton.disabled = false;

            enableButton.textContent =
                `Enable ${sourceLanguage.toUpperCase()}→EN`;
        }
    }

    // -------------------------------------------------------------------------
    // UI
    // -------------------------------------------------------------------------

    function updateControls() {
        const source =
            getSourceLanguage();

        sourceButton.textContent =
            `Source: ${source.toUpperCase()}`;

        sourceButton.title =
            "Change source language";

        if (translator) {
            enableButton.disabled = true;

            enableButton.textContent =
                `${source.toUpperCase()}→EN enabled`;
        } else {
            enableButton.disabled = false;

            enableButton.textContent =
                `Enable ${source.toUpperCase()}→EN`;
        }
    }

    function changeSourceLanguage() {
        const current =
            getSourceLanguage();

        const value = prompt(
            "Source language code (nl, de, fr, etc.):",
            current
        );

        if (value === null) {
            return;
        }

        const language =
            value.trim().toLowerCase();

        if (!language) {
            return;
        }

        if (language === "en") {
            alert(
                "English is already the target language."
            );
            return;
        }

        setSourceLanguage(language);
    }

    function createControls() {
        const controls =
            document.createElement("div");

        Object.assign(controls.style, {
            position: "fixed",
            top: "8px",
            right: "8px",
            zIndex: "2147483647",
            display: "flex",
            gap: "4px",
            fontFamily: "sans-serif",
            fontSize: "12px",
        });

        enableButton =
            document.createElement("button");

        sourceButton =
            document.createElement("button");

        for (const button of [
            enableButton,
            sourceButton,
        ]) {
            button.type = "button";

            Object.assign(button.style, {
                padding: "7px 10px",
                border: "0",
                borderRadius: "5px",
                cursor: "pointer",
                background: "#444",
                color: "#fff",
                boxShadow:
                    "0 2px 6px rgba(0, 0, 0, 0.35)",
            });
        }

        enableButton.addEventListener(
            "click",
            enableTranslator
        );

        sourceButton.addEventListener(
            "click",
            changeSourceLanguage
        );

        controls.append(
            sourceButton,
            enableButton
        );

        document.body.appendChild(
            controls
        );

        updateControls();
    }

    // -------------------------------------------------------------------------
    // Start
    // -------------------------------------------------------------------------

    startObserver();
    createControls();

    console.log(
        "[The Lounge Translator] userscript loaded"
    );
})();
