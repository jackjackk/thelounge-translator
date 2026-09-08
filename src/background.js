"use strict";

const api = globalThis.browser ?? globalThis.chrome;
const ENABLED_KEY = "translationEnabled";
const LEARNING_MESSAGE_TYPE = "LOCAL_BERGAMOT_LEARNING_BATCHES";
const UI_MESSAGE_TYPE = "LOCAL_BERGAMOT_EXTENSION_UI";

let learningConfigPromise = null;
let learningMutationChain = Promise.resolve();

async function getEnabled() {
  const result = await api.storage.local.get(ENABLED_KEY);
  return result[ENABLED_KEY] ?? true;
}

async function setEnabled(enabled) {
  await api.storage.local.set({ [ENABLED_KEY]: enabled });
  await updateAction(enabled);
}

async function updateAction(enabled) {
  await Promise.allSettled([
    api.action.setBadgeText({ text: enabled ? "ON" : "OFF" }),
    api.action.setTitle({
      title: enabled
        ? "Local Bergamot Translator — translation ON"
        : "Local Bergamot Translator — translation OFF"
    })
  ]);
}

function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function getLearningConfig() {
  if (!learningConfigPromise) {
    learningConfigPromise = fetch(api.runtime.getURL("config.json"))
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load config.json (${response.status})`);
        return response.json();
      })
      .then((config) => {
        const options = config.learningBatches;
        if (!options?.enabled || !options.storageKey) {
          throw new Error("learningBatches is disabled or missing storageKey in config.json.");
        }
        return options;
      });
  }
  return learningConfigPromise;
}

function sanitizeLearningBatches(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((batch) =>
    batch &&
    typeof batch.id === "string" &&
    Number.isFinite(Number(batch.createdAt)) &&
    Array.isArray(batch.items) &&
    batch.items.some((item) =>
      item && typeof item.source === "string" && typeof item.translation === "string"
    )
  );
}

function newBatchId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}


function normalizeLearningSentence(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .replace(/^[“”„‟"'`]+|[“”„‟"'`]+$/gu, "")
    .replace(/[.!?…]+$/u, "")
    .trim()
    .toLocaleLowerCase("nl-NL");
}

function learningItemKey(entry, context) {
  const site = String(context.siteGroupId || "site");
  const page = String(context.pageKey || context.pageUrl || "page");
  const identity = typeof entry.identity === "string" ? entry.identity.trim() : "";
  if (identity) return `${site}|${page}|id:${identity}`;
  return `${site}|${page}|text:${fnv1a32(`${entry.source}\u0000${entry.translation}`)}`;
}

function pruneLearningBatches(batches, maxBatches) {
  const limit = Math.max(1, Number(maxBatches) || 80);
  while (batches.length > limit) {
    const usedIndex = batches.findIndex((batch) => batch.used);
    batches.splice(usedIndex >= 0 ? usedIndex : 0, 1);
  }
}

async function readLearningBatches(options) {
  const data = await api.storage.local.get(options.storageKey);
  return sanitizeLearningBatches(data[options.storageKey]);
}

async function writeLearningBatches(options, batches) {
  pruneLearningBatches(batches, options.maxBatches);
  await api.storage.local.set({ [options.storageKey]: batches });
}

async function listLearningBatches() {
  const options = await getLearningConfig();
  await learningMutationChain.catch(() => {});
  return readLearningBatches(options);
}

async function mutateLearningBatches(mutator) {
  const operation = learningMutationChain.then(async () => {
    const options = await getLearningConfig();
    const batches = await readLearningBatches(options);
    const meta = await mutator(batches, options) || {};
    await writeLearningBatches(options, batches);
    return { batches, ...meta };
  });
  learningMutationChain = operation.then(() => undefined, () => undefined);
  return operation;
}

async function addLearningBatch(payload) {
  return mutateLearningBatches(async (batches, options) => {
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    const context = payload?.context && typeof payload.context === "object" ? payload.context : {};
    const maxTextLength = Math.max(1, Number(options.maxTextLength) || 6000);
    const existingKeys = new Set(
      batches.flatMap((batch) => batch.items.map((item) => item.key).filter(Boolean))
    );
    const existingSentenceKeys = new Set(
      batches.flatMap((batch) => batch.items
        .map((item) => normalizeLearningSentence(item?.source))
        .filter(Boolean))
    );
    const localKeys = new Set();
    const localSentenceKeys = new Set();
    const items = [];

    for (const entry of entries) {
      if (!entry || typeof entry.source !== "string" || typeof entry.translation !== "string") continue;
      const source = entry.source.trim();
      const translation = entry.translation.trim();
      if (!source || !translation) continue;

      const key = learningItemKey({ ...entry, source, translation }, context);
      const sentenceKey = normalizeLearningSentence(source);
      if (!sentenceKey
          || existingKeys.has(key)
          || localKeys.has(key)
          || existingSentenceKeys.has(sentenceKey)
          || localSentenceKeys.has(sentenceKey)) continue;
      localKeys.add(key);
      localSentenceKeys.add(sentenceKey);

      items.push({
        key,
        source: source.slice(0, maxTextLength),
        translation: translation.slice(0, maxTextLength),
        truncated: source.length > maxTextLength || translation.length > maxTextLength
      });
    }

    if (items.length === 0) {
      return { addedBatchId: null, addedItems: 0 };
    }

    const batch = {
      id: newBatchId(),
      createdAt: Date.now(),
      copiedAt: null,
      used: false,
      siteGroupId: String(context.siteGroupId || ""),
      siteLabel: String(context.siteLabel || context.siteGroupId || "Configured site"),
      selectorProfile: String(context.selectorProfile || ""),
      pageTitle: String(context.pageTitle || ""),
      pageUrl: String(context.pageUrl || ""),
      items
    };
    batches.push(batch);
    return { addedBatchId: batch.id, addedItems: items.length };
  });
}

async function updateLearningBatch(action, payload) {
  return mutateLearningBatches(async (batches) => {
    const id = String(payload?.id || "");
    const index = batches.findIndex((batch) => batch.id === id);

    if (action === "clear-used") {
      const before = batches.length;
      const kept = batches.filter((batch) => !batch.used);
      batches.splice(0, batches.length, ...kept);
      return { changed: before - batches.length };
    }

    if (action === "mark-used-many") {
      const ids = new Set(
        (Array.isArray(payload?.ids) ? payload.ids : [])
          .map((value) => String(value || ""))
          .filter(Boolean)
      );
      if (ids.size === 0) return { changed: 0 };
      const copiedAt = Date.now();
      let changed = 0;
      for (const batch of batches) {
        if (!ids.has(batch.id)) continue;
        batch.used = true;
        batch.copiedAt = copiedAt;
        batch.lastCopiedAt = copiedAt;
        changed += 1;
      }
      return { changed };
    }

    if (action === "touch-used-many") {
      const ids = new Set(
        (Array.isArray(payload?.ids) ? payload.ids : [])
          .map((value) => String(value || ""))
          .filter(Boolean)
      );
      if (ids.size === 0) return { changed: 0 };
      const lastCopiedAt = Date.now();
      let changed = 0;
      for (const batch of batches) {
        if (!ids.has(batch.id) || !batch.used) continue;
        batch.lastCopiedAt = lastCopiedAt;
        changed += 1;
      }
      return { changed, lastCopiedAt };
    }

    if (index < 0) return { changed: 0 };
    if (action === "mark-used") {
      const copiedAt = Date.now();
      batches[index].used = true;
      batches[index].copiedAt = copiedAt;
      batches[index].lastCopiedAt = copiedAt;
      return { changed: 1 };
    }
    if (action === "mark-unused") {
      batches[index].used = false;
      batches[index].copiedAt = null;
      batches[index].lastCopiedAt = null;
      return { changed: 1 };
    }
    if (action === "delete") {
      batches.splice(index, 1);
      return { changed: 1 };
    }
    return { changed: 0 };
  });
}


async function handleUiMessage(message) {
  if (!message || message.type !== UI_MESSAGE_TYPE) return null;
  const action = String(message.action || "");

  if (action === "get-state") {
    return { ok: true, enabled: await getEnabled() };
  }
  if (action === "set-enabled") {
    const enabled = Boolean(message.payload?.enabled);
    await setEnabled(enabled);
    return { ok: true, enabled };
  }
  return { ok: false, error: `Unsupported extension-UI action '${action}'.` };
}
async function handleLearningMessage(message) {
  if (!message || message.type !== LEARNING_MESSAGE_TYPE) return null;
  const action = String(message.action || "");

  if (action === "list") {
    return { ok: true, batches: await listLearningBatches() };
  }
  if (action === "add") {
    return { ok: true, ...(await addLearningBatch(message.payload)) };
  }
  if (["mark-used", "mark-used-many", "touch-used-many", "mark-unused", "delete", "clear-used"].includes(action)) {
    return { ok: true, ...(await updateLearningBatch(action, message.payload)) };
  }
  return { ok: false, error: `Unsupported learning-batch action '${action}'.` };
}

api.runtime.onInstalled.addListener(async () => {
  const existing = await api.storage.local.get(ENABLED_KEY);
  if (typeof existing[ENABLED_KEY] !== "boolean") {
    await api.storage.local.set({ [ENABLED_KEY]: true });
  }
  await updateAction(await getEnabled());
});

api.runtime.onStartup?.addListener(async () => {
  await updateAction(await getEnabled());
});

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  let operation = null;
  let label = "Background";

  if (message?.type === LEARNING_MESSAGE_TYPE) {
    operation = handleLearningMessage(message);
    label = "Learning batches";
  } else if (message?.type === UI_MESSAGE_TYPE) {
    operation = handleUiMessage(message);
    label = "Extension UI";
  } else {
    return undefined;
  }

  void operation
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error(`[${label}] Background operation failed:`, error);
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
  return true;
});

getEnabled().then(updateAction).catch(console.error);
