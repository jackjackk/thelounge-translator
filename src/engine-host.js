"use strict";

let configPromise = null;
let translator = null;
let translatorPromise = null;
let localModelConfigs = [];
let piperSession = null;
let piperSessionPromise = null;
let phonemizerPending = null;
let ttsChain = Promise.resolve();
const ttsAudioCache = new Map();
const activePorts = new Set();

function getConfig() {
  if (!configPromise) {
    configPromise = fetch(new URL("config.json", import.meta.url))
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Could not load config.json (${response.status})`);
        }
        return response.json();
      });
  }
  return configPromise;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || ""
  };
}

function broadcast(message) {
  for (const port of activePorts) {
    try {
      port.postMessage(message);
    } catch {
      activePorts.delete(port);
    }
  }
}

async function loadBundledFile(label, relativePath, expectedBytes) {
  const url = new URL(relativePath, import.meta.url);
  const startedAt = performance.now();

  broadcast({
    type: "STATUS",
    status: "MODEL_FILE_LOADING",
    label,
    path: relativePath,
    expectedBytes
  });

  let response;
  try {
    response = await fetch(url);
  } catch (cause) {
    throw new Error(
      `Could not read bundled Bergamot ${label} file '${relativePath}' from the extension package. Rebuild with 'npm run build'.`,
      { cause }
    );
  }

  if (!response.ok) {
    throw new Error(
      `Bundled Bergamot ${label} file '${relativePath}' returned HTTP ${response.status}. Rebuild with 'npm run build'.`
    );
  }

  const buffer = await response.arrayBuffer();
  if (Number.isFinite(expectedBytes) && buffer.byteLength !== expectedBytes) {
    throw new Error(
      `Bundled Bergamot ${label} file '${relativePath}' has ${buffer.byteLength} bytes; expected ${expectedBytes}. Re-run 'npm run models' and rebuild.`
    );
  }

  broadcast({
    type: "STATUS",
    status: "MODEL_FILE_READY",
    label,
    path: relativePath,
    bytes: buffer.byteLength,
    elapsedMs: Math.round(performance.now() - startedAt)
  });

  return buffer;
}


function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

async function loadBundledPiperFile(label, relativePath, expectedBytes) {
  const url = new URL(relativePath, import.meta.url);
  const startedAt = performance.now();

  broadcast({
    type: "STATUS",
    status: "TTS_FILE_LOADING",
    label,
    path: relativePath,
    expectedBytes
  });

  let response;
  try {
    response = await fetch(url);
  } catch (cause) {
    throw new Error(
      `Could not read bundled Piper ${label} file '${relativePath}' from the extension package. Rebuild with 'npm run build'.`,
      { cause }
    );
  }

  if (!response.ok) {
    throw new Error(
      `Bundled Piper ${label} file '${relativePath}' returned HTTP ${response.status}. Rebuild with 'npm run build'.`
    );
  }

  const buffer = await response.arrayBuffer();
  if (Number.isFinite(expectedBytes) && buffer.byteLength !== expectedBytes) {
    throw new Error(
      `Bundled Piper ${label} file '${relativePath}' has ${buffer.byteLength} bytes; expected ${expectedBytes}. Re-run 'npm run models' and rebuild.`
    );
  }

  broadcast({
    type: "STATUS",
    status: "TTS_FILE_READY",
    label,
    path: relativePath,
    bytes: buffer.byteLength,
    elapsedMs: Math.round(performance.now() - startedAt)
  });

  return buffer;
}

function makeInt64Tensor(ort, values, dimensions) {
  return new ort.Tensor(
    "int64",
    BigInt64Array.from(values, (value) => BigInt(value)),
    dimensions
  );
}

async function getPiperSession() {
  if (piperSession) return piperSession;
  if (piperSessionPromise) return piperSessionPromise;

  piperSessionPromise = (async () => {
    const config = await getConfig();
    if (!config.speech?.enabled || config.speech?.engine !== "piper") {
      throw new Error("Piper speech is not enabled in config.json.");
    }

    const piper = config.speech?.piper;
    if (!piper?.modelPath || !piper?.configPath) {
      throw new Error("speech.piper modelPath/configPath is missing in config.json.");
    }

    const ort = globalThis.ort;
    const createPiperPhonemize = globalThis.createPiperPhonemize;
    if (!ort?.InferenceSession || typeof createPiperPhonemize !== "function") {
      throw new Error(
        "Bundled Piper runtime did not initialize. Verify vendor/onnxruntime and vendor/piper files in dist/."
      );
    }

    const startedAt = performance.now();
    broadcast({
      type: "STATUS",
      status: "TTS_ENGINE_LOADING",
      voiceId: piper.voiceId
    });

    const threads = clamp(Math.trunc(Number(piper.ortThreads) || 1), 1, 4);
    ort.env.wasm.numThreads = threads;
    ort.env.wasm.wasmPaths = new URL("vendor/onnxruntime/", import.meta.url).href;

    const [voiceConfigBuffer, modelBuffer] = await Promise.all([
      loadBundledPiperFile("voice config", piper.configPath, piper.expectedBytes?.config),
      loadBundledPiperFile("ONNX voice model", piper.modelPath, piper.expectedBytes?.model)
    ]);

    let voiceConfig;
    try {
      voiceConfig = JSON.parse(new TextDecoder().decode(voiceConfigBuffer));
    } catch (cause) {
      throw new Error(`Bundled Piper voice config '${piper.configPath}' is not valid JSON.`, { cause });
    }

    if (!voiceConfig?.espeak?.voice || !Number.isFinite(voiceConfig?.audio?.sample_rate)) {
      throw new Error(`Bundled Piper voice config '${piper.configPath}' is missing required Piper metadata.`);
    }

    broadcast({
      type: "STATUS",
      status: "TTS_ONNX_LOADING",
      voiceId: piper.voiceId,
      threads
    });

    const session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });

    broadcast({
      type: "STATUS",
      status: "TTS_PHONEMIZER_LOADING",
      voiceId: piper.voiceId
    });

    const phonemizer = await createPiperPhonemize({
      print(data) {
        if (!phonemizerPending) return;
        try {
          const parsed = JSON.parse(String(data));
          if (!Array.isArray(parsed?.phoneme_ids)) return;
          const pending = phonemizerPending;
          phonemizerPending = null;
          clearTimeout(pending.timer);
          pending.resolve(parsed.phoneme_ids);
        } catch {
          // Emscripten can print non-JSON informational lines; ignore those.
        }
      },
      printErr(message) {
        if (!phonemizerPending) {
          console.debug("[The Lounge/Piper phonemizer]", message);
          return;
        }
        const pending = phonemizerPending;
        phonemizerPending = null;
        clearTimeout(pending.timer);
        pending.reject(new Error(String(message)));
      },
      locateFile(url) {
        if (url.endsWith(".wasm")) {
          return new URL("vendor/piper/piper_phonemize.wasm", import.meta.url).href;
        }
        if (url.endsWith(".data")) {
          return new URL("vendor/piper/piper_phonemize.data", import.meta.url).href;
        }
        return url;
      }
    });

    piperSession = {
      ort,
      session,
      phonemizer,
      voiceConfig,
      settings: piper
    };

    broadcast({
      type: "STATUS",
      status: "TTS_READY",
      voiceId: piper.voiceId,
      sampleRate: voiceConfig.audio.sample_rate,
      modelBytes: modelBuffer.byteLength,
      elapsedMs: Math.round(performance.now() - startedAt),
      threads
    });

    return piperSession;
  })();

  try {
    return await piperSessionPromise;
  } finally {
    piperSessionPromise = null;
  }
}

async function phonemizeDutch(runtime, text) {
  if (phonemizerPending) {
    throw new Error("Piper phonemizer is unexpectedly busy.");
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!phonemizerPending) return;
      phonemizerPending = null;
      reject(new Error("Piper phonemizer timed out."));
    }, 15000);

    phonemizerPending = { resolve, reject, timer };
    try {
      runtime.phonemizer.callMain([
        "-l",
        runtime.voiceConfig.espeak.voice,
        "--input",
        JSON.stringify([{ text: text.trim() }]),
        "--espeak_data",
        "/espeak-ng-data"
      ]);
    } catch (error) {
      phonemizerPending = null;
      clearTimeout(timer);
      reject(error);
    }
  });
}

function pruneTtsAudioCache(maxEntries) {
  while (ttsAudioCache.size > maxEntries) {
    const oldestKey = ttsAudioCache.keys().next().value;
    ttsAudioCache.delete(oldestKey);
  }
}

async function synthesizePiperInternal(request) {
  const runtime = await getPiperSession();
  const rawText = String(request?.text || "").replace(/\s+/g, " ").trim();
  if (!rawText) {
    throw new Error("Cannot synthesize an empty message.");
  }

  const maxTextLength = Math.max(1, Number(runtime.settings.maxTextLength) || 1200);
  const text = rawText.slice(0, maxTextLength);
  const rate = clamp(Number(request?.rate) || 1, 0.55, 1.8);
  const speakerId = Math.max(0, Math.trunc(Number(request?.speakerId ?? runtime.settings.speakerId) || 0));
  const cacheKey = `${runtime.settings.voiceId}|${speakerId}|${rate.toFixed(3)}|${text}`;
  const cached = ttsAudioCache.get(cacheKey);
  if (cached) {
    ttsAudioCache.delete(cacheKey);
    ttsAudioCache.set(cacheKey, cached);
    broadcast({ type: "STATUS", status: "TTS_AUDIO_CACHE_HIT", voiceId: runtime.settings.voiceId });
    return {
      pcm: cached.pcm.slice(),
      sampleRate: cached.sampleRate,
      voiceId: runtime.settings.voiceId,
      cached: true
    };
  }

  const startedAt = performance.now();
  broadcast({
    type: "STATUS",
    status: "TTS_SYNTHESIZING",
    voiceId: runtime.settings.voiceId,
    characters: text.length
  });

  const phonemeIds = await phonemizeDutch(runtime, text);
  if (!Array.isArray(phonemeIds) || phonemeIds.length === 0) {
    throw new Error("Piper phonemizer returned no phoneme IDs.");
  }

  const baseInference = runtime.voiceConfig.inference || {};
  const baseLengthScale = Number(baseInference.length_scale) || 1;
  const noiseScale = Number(baseInference.noise_scale) || 0.667;
  const noiseW = Number(baseInference.noise_w) || 0.8;
  const lengthScale = baseLengthScale / rate;

  const feeds = {
    input: makeInt64Tensor(runtime.ort, phonemeIds, [1, phonemeIds.length]),
    input_lengths: makeInt64Tensor(runtime.ort, [phonemeIds.length], [1]),
    scales: new runtime.ort.Tensor(
      "float32",
      Float32Array.from([noiseScale, lengthScale, noiseW]),
      [3]
    )
  };

  if (Object.keys(runtime.voiceConfig.speaker_id_map || {}).length > 0) {
    feeds.sid = makeInt64Tensor(runtime.ort, [speakerId], [1]);
  }

  const outputs = await runtime.session.run(feeds);
  const output = outputs.output || Object.values(outputs)[0];
  if (!output?.data) {
    throw new Error("Piper ONNX model returned no audio output tensor.");
  }

  const pcm = output.data instanceof Float32Array
    ? new Float32Array(output.data)
    : Float32Array.from(output.data);
  const sampleRate = runtime.voiceConfig.audio.sample_rate;
  const maxEntries = Math.max(0, Math.trunc(Number(runtime.settings.audioCacheEntries) || 0));

  if (maxEntries > 0) {
    ttsAudioCache.set(cacheKey, { pcm: pcm.slice(), sampleRate });
    pruneTtsAudioCache(maxEntries);
  }

  broadcast({
    type: "STATUS",
    status: "TTS_SYNTHESIZED",
    voiceId: runtime.settings.voiceId,
    characters: text.length,
    samples: pcm.length,
    sampleRate,
    elapsedMs: Math.round(performance.now() - startedAt)
  });

  return {
    pcm,
    sampleRate,
    voiceId: runtime.settings.voiceId,
    cached: false
  };
}

function synthesizePiper(request) {
  const next = ttsChain.then(
    () => synthesizePiperInternal(request),
    () => synthesizePiperInternal(request)
  );
  ttsChain = next.catch(() => {});
  return next;
}

async function disposePiper() {
  const active = piperSession;
  piperSession = null;
  piperSessionPromise = null;
  ttsAudioCache.clear();
  if (phonemizerPending) {
    const pending = phonemizerPending;
    phonemizerPending = null;
    clearTimeout(pending.timer);
    pending.reject(new Error("Piper runtime was stopped."));
  }
  try {
    await active?.session?.release?.();
  } catch (error) {
    console.debug("[The Lounge/Piper engine] Cleanup warning:", error);
  }
}

async function getTranslator() {
  if (translator) return translator;
  if (translatorPromise) return translatorPromise;

  translatorPromise = (async () => {
    const config = await getConfig();
    const bergamotModule = await import("./vendor/bergamot/translator.js");
    const { BatchTranslator, TranslatorBacking } = bergamotModule;

    localModelConfigs = Array.isArray(config.bergamot.localModels)
      ? config.bergamot.localModels
      : [];
    if (localModelConfigs.length === 0) {
      throw new Error("bergamot.localModels is missing or empty in config.json.");
    }

    class LocalModelBacking extends TranslatorBacking {
      async loadModelRegistery() {
        const registry = localModelConfigs.map((model) => ({ from: model.from, to: model.to }));
        broadcast({
          type: "STATUS",
          status: "LOCAL_REGISTRY_READY",
          pairs: registry
        });
        return registry;
      }

      async loadTranslationModel({ from, to }) {
        const model = localModelConfigs.find((candidate) => candidate.from === from && candidate.to === to);
        if (!model) {
          throw new Error(`No bundled model available to translate from '${from}' to '${to}'`);
        }

        const startedAt = performance.now();
        broadcast({
          type: "STATUS",
          status: "MODEL_LOADING",
          from,
          to,
          expectedBytes:
            (model.expectedBytes?.model || 0)
            + (model.expectedBytes?.shortlist || 0)
            + (model.expectedBytes?.vocab || 0)
        });

        const [modelBuffer, shortlist, ...vocabs] = await Promise.all([
          loadBundledFile("model", model.modelPath, model.expectedBytes?.model),
          loadBundledFile("shortlist", model.shortlistPath, model.expectedBytes?.shortlist),
          ...(model.vocabPaths || []).map((path, index) =>
            loadBundledFile(
              `vocab${(model.vocabPaths || []).length > 1 ? ` ${index + 1}` : ""}`,
              path,
              model.expectedBytes?.vocab
            )
          )
        ]);

        const totalBytes = modelBuffer.byteLength
          + shortlist.byteLength
          + vocabs.reduce((sum, buffer) => sum + buffer.byteLength, 0);

        broadcast({
          type: "STATUS",
          status: "MODEL_READY",
          from,
          to,
          bytes: totalBytes,
          elapsedMs: Math.round(performance.now() - startedAt)
        });

        return {
          model: modelBuffer,
          shortlist,
          vocabs,
          qualityModel: null,
          config: model.engineConfig || {}
        };
      }
    }

    // TranslatorBacking.loadWorker() sends `backing.options` to the Web Worker
    // through postMessage(). Keep this object strictly structured-cloneable:
    // callbacks/functions MUST NOT be stored in it.
    const workerInitOptions = {
      pivotLanguage: config.bergamot.pivotLanguage,
      cacheSize: config.bergamot.sentenceCacheSize,
      useNativeIntGemm: false
    };

    // Fail immediately with a useful message if a future edit accidentally puts
    // an uncloneable value (for example a function) back into worker options.
    try {
      structuredClone(workerInitOptions);
    } catch (cause) {
      throw new Error(
        `Bergamot worker options are not structured-cloneable: ${cause?.message || cause}`,
        { cause }
      );
    }

    const reportWorkerError = (error) => {
      console.error("[Local Bergamot engine] Worker error:", error);
      broadcast({ type: "ENGINE_ERROR", error: serializeError(error) });
    };

    const backing = new LocalModelBacking(workerInitOptions);

    // TranslatorBacking normally reads onerror from its constructor options, but
    // doing that would place the function in `backing.options` and make
    // worker.postMessage({ ..., args: [this.options] }) fail. Assign the handler
    // after construction so it is never sent across the worker boundary.
    backing.onerror = reportWorkerError;

    const workerCount = Math.max(Number(config.bergamot.workers) || 1, 1);
    broadcast({
      type: "STATUS",
      status: "WORKER_POOL_STARTING",
      workers: workerCount,
      initOptions: { ...workerInitOptions }
    });

    // Pre-start every worker before exposing BatchTranslator. Apart from making
    // startup diagnostics deterministic, this avoids an upstream BatchTranslator
    // behaviour where a worker-start failure is reported through onerror but the
    // queued translation promises can otherwise remain unresolved.
    const prewarmedWorkers = [];
    try {
      for (let index = 0; index < workerCount; index += 1) {
        broadcast({
          type: "STATUS",
          status: "WORKER_STARTING",
          worker: index + 1,
          workers: workerCount
        });
        const loaded = await backing.loadWorker();
        prewarmedWorkers.push({ idle: true, ...loaded });
        broadcast({
          type: "STATUS",
          status: "WORKER_READY",
          worker: index + 1,
          workers: workerCount
        });
      }
    } catch (error) {
      for (const entry of prewarmedWorkers) {
        try {
          entry.worker?.terminate();
        } catch {}
      }
      broadcast({
        type: "STATUS",
        status: "WORKER_START_FAILED",
        error: serializeError(error)
      });
      throw error;
    }

    const instance = new BatchTranslator({
      workers: workerCount,
      batchSize: config.bergamot.batchSize,
      onerror: reportWorkerError
    }, backing);

    // Reuse the workers that were successfully initialized above; with the pool
    // already at workerLimit, BatchTranslator does not need to create another one.
    instance.workers.push(...prewarmedWorkers);

    translator = instance;
    return instance;
  })();

  try {
    return await translatorPromise;
  } finally {
    translatorPromise = null;
  }
}

async function disposeTranslator() {
  const active = translator;
  translator = null;
  translatorPromise = null;
  localModelConfigs = [];
  if (active) {
    await active.delete?.();
  }
}

async function disposeAllEngines() {
  await Promise.allSettled([disposeTranslator(), disposePiper()]);
}

function attachPort(port) {
  let closed = false;
  activePorts.add(port);

  port.onmessage = async (event) => {
    const message = event.data;
    if (!message || typeof message !== "object" || closed) return;

    if (message.type === "TRANSLATE") {
      const coldStart = !translator && !translatorPromise;
      if (coldStart) {
        port.postMessage({ type: "STATUS", status: "ENGINE_LOADING" });
      }

      try {
        const engine = await getTranslator();
        if (coldStart) {
          port.postMessage({ type: "STATUS", status: "ENGINE_READY" });
        }
        const response = await engine.translate(message.request);
        port.postMessage({
          type: "RESULT",
          id: message.id,
          text: response.target.text
        });
      } catch (error) {
        port.postMessage({
          type: "ERROR",
          id: message.id,
          error: serializeError(error)
        });
      }
      return;
    }

    if (message.type === "SYNTHESIZE_SPEECH") {
      try {
        const result = await synthesizePiper(message.request);
        // Always transfer an exact, standalone ArrayBuffer. This avoids leaking
        // a larger backing buffer if a future ONNX Runtime returns a view with a
        // non-zero byteOffset, and gives the content script one stable transport
        // representation across Firefox/Chrome extension realms.
        const pcmBuffer = result.pcm.buffer.slice(
          result.pcm.byteOffset,
          result.pcm.byteOffset + result.pcm.byteLength
        );
        broadcast({
          type: "STATUS",
          status: "TTS_PCM_TRANSPORT",
          bytes: pcmBuffer.byteLength,
          samples: result.pcm.length,
          sampleRate: result.sampleRate
        });
        port.postMessage({
          type: "TTS_RESULT",
          id: message.id,
          pcm: pcmBuffer,
          sampleRate: result.sampleRate,
          voiceId: result.voiceId,
          cached: result.cached
        }, [pcmBuffer]);
      } catch (error) {
        port.postMessage({
          type: "ERROR",
          id: message.id,
          error: serializeError(error)
        });
      }
      return;
    }

    if (message.type === "SHUTDOWN") {
      closed = true;
      try {
        await disposeAllEngines();
      } catch (error) {
        console.debug("[Local Bergamot engine] Cleanup warning:", error);
      }
      try {
        port.postMessage({ type: "STATUS", status: "ENGINE_STOPPED" });
        port.postMessage({ type: "SHUTDOWN_ACK" });
      } catch {}
      activePorts.delete(port);
      port.close();
    }
  };

  port.start?.();
  port.postMessage({ type: "READY" });
}

function matchPatternAllowsOrigin(pattern, origin) {
  if (pattern === "<all_urls>") return true;

  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  const match = /^(\*|http|https):\/\/([^/]+)\/.*$/.exec(pattern);
  if (!match) return false;

  const [, scheme, hostPattern] = match;
  if (scheme !== "*" && url.protocol !== `${scheme}:`) return false;
  if (scheme === "*" && url.protocol !== "http:" && url.protocol !== "https:") return false;

  const hostname = url.hostname.toLowerCase();
  const expected = hostPattern.toLowerCase();
  if (expected === "*") return true;
  if (expected.startsWith("*.")) {
    const base = expected.slice(2);
    return hostname === base || hostname.endsWith(`.${base}`);
  }
  return hostname === expected;
}

async function isAllowedParentOrigin(origin) {
  const config = await getConfig();
  const siteMatches = (config.siteGroups || []).flatMap((group) => group.matches || []);
  return siteMatches.some((pattern) => matchPatternAllowsOrigin(pattern, origin));
}

window.addEventListener("message", async (event) => {
  if (event.data?.type !== "LOCAL_BERGAMOT_CONNECT" && event.data?.type !== "THELOUNGE_BERGAMOT_CONNECT") return;
  if (event.ports.length !== 1) return;
  if (!(await isAllowedParentOrigin(event.origin))) {
    console.warn("[Local Bergamot engine] Rejected connection from unexpected origin:", event.origin);
    event.ports[0].close();
    return;
  }
  attachPort(event.ports[0]);
});
