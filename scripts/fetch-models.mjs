import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const config = JSON.parse(await readFile(join(src, "config.json"), "utf8"));
const models = Array.isArray(config.bergamot?.localModels) ? config.bergamot.localModels : [];

if (models.length === 0) {
  throw new Error("src/config.json must define at least one bergamot.localModels entry.");
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function basename(path) {
  return path.split("/").pop();
}

function buildBergamotAssets(model) {
  const vocabPaths = model.vocabPaths || [];
  const vocabBytes = model.expectedBytes?.vocabs || vocabPaths.map(() => model.expectedBytes?.vocab);
  const vocabHashes = model.expectedSha256?.vocabs || vocabPaths.map(() => model.expectedSha256?.vocab);

  return [
    {
      key: "model",
      path: model.modelPath,
      bytes: model.expectedBytes?.model,
      hash: model.expectedSha256?.model
    },
    {
      key: "shortlist",
      path: model.shortlistPath,
      bytes: model.expectedBytes?.shortlist,
      hash: model.expectedSha256?.shortlist
    },
    ...vocabPaths.map((path, index) => ({
      key: index === 0 ? "vocab" : `vocab${index + 1}`,
      path,
      bytes: vocabBytes[index],
      hash: vocabHashes[index]
    }))
  ];
}

function buildPiperAssets(piper) {
  return [
    {
      key: "model",
      path: piper.modelPath,
      bytes: piper.expectedBytes?.model,
      hash: piper.expectedSha256?.model
    },
    {
      key: "config",
      path: piper.configPath,
      bytes: piper.expectedBytes?.config,
      hash: piper.expectedSha256?.config,
      bundled: true
    }
  ];
}

async function isValidExisting(asset) {
  const target = join(src, asset.path);
  if (!existsSync(target)) return false;
  const data = await readFile(target);
  if (Number.isFinite(asset.bytes) && data.byteLength !== asset.bytes) return false;
  if (asset.hash && sha256(data) !== asset.hash.toLowerCase()) return false;
  return true;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function retryDelayMs(response, attempt, source) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 60_000);
    }

    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(date - Date.now(), 0), 60_000);
    }
  }

  const base = Number.isFinite(source.retryBaseDelayMs) ? source.retryBaseDelayMs : 1500;
  return Math.min(base * (2 ** (attempt - 1)), 30_000);
}

async function fetchWithRetry(url, source) {
  const attempts = Number.isInteger(source.attempts) && source.attempts > 0 ? source.attempts : 4;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: { "user-agent": "thelounge-bergamot-extension-build" }
      });

      if (response.ok) {
        return response;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === attempts) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const delay = retryDelayMs(response, attempt, source);
      console.warn(`  HTTP ${response.status}; retrying in ${Math.ceil(delay / 1000)}s (${attempt}/${attempts})...`);
      await sleep(delay);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        throw error;
      }

      const delay = retryDelayMs(null, attempt, source);
      console.warn(`  download attempt ${attempt}/${attempts} failed: ${error.message}; retrying in ${Math.ceil(delay / 1000)}s...`);
      await sleep(delay);
    }
  }

  throw lastError || new Error("download failed");
}

async function downloadSource(asset, source) {
  const filename = basename(asset.path);
  const suffix = source.suffix || "";
  const url = new URL(`${filename}${suffix}`, source.baseUrl).href;
  console.log(`  trying ${url}`);

  const response = await fetchWithRetry(url, source);

  let data = Buffer.from(await response.arrayBuffer());
  if (source.compression === "gzip") {
    data = gunzipSync(data);
  } else if (source.compression !== "none") {
    throw new Error(`Unsupported compression '${source.compression}'.`);
  }

  if (Number.isFinite(asset.bytes) && data.byteLength !== asset.bytes) {
    throw new Error(`size mismatch: got ${data.byteLength}, expected ${asset.bytes}`);
  }

  const actualHash = sha256(data);
  if (asset.hash && actualHash !== asset.hash.toLowerCase()) {
    throw new Error(`SHA-256 mismatch: got ${actualHash}, expected ${asset.hash}`);
  }

  return data;
}

async function ensureAsset(owner, asset) {
  const target = join(src, asset.path);
  if (await isValidExisting(asset)) {
    console.log(`Model asset OK: ${asset.path}`);
    return;
  }

  if (asset.bundled) {
    throw new Error(
      `Bundled source asset ${asset.path} is missing or failed integrity verification. `
        + "Restore that tracked file from the extension source; it is intentionally not downloaded at build time."
    );
  }

  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.download`;
  await rm(temporary, { force: true });

  const failures = [];
  for (const source of owner.downloadSources || []) {
    try {
      const data = await downloadSource(asset, source);
      await writeFile(temporary, data);
      await rename(temporary, target);
      console.log(`Downloaded and verified: ${asset.path} (${data.byteLength} bytes)`);
      return;
    } catch (error) {
      failures.push(`${source.baseUrl}: ${error.message}`);
      console.warn(`  failed: ${error.message}`);
    }
  }

  await rm(temporary, { force: true });
  throw new Error(
    `Could not obtain ${asset.path}. Tried all configured build-time model sources:\n- ${failures.join("\n- ")}\n`
      + "No browser/runtime fallback will be used because this extension is configured for fully local model loading."
  );
}

for (const model of models) {
  if (!model?.from || !model?.to) {
    throw new Error("Every bergamot.localModels entry must define from and to.");
  }
  if (!Array.isArray(model.downloadSources) || model.downloadSources.length === 0) {
    throw new Error(`Bundled model ${model.from} -> ${model.to} needs at least one build-time downloadSources entry.`);
  }

  const assets = buildBergamotAssets(model);
  if (assets.length < 3) {
    throw new Error(`Bundled model ${model.from} -> ${model.to} must provide model, shortlist, and vocab files.`);
  }

  console.log(`Preparing bundled Bergamot model ${model.from} -> ${model.to}...`);
  for (const asset of assets) {
    await ensureAsset(model, asset);
  }
  console.log(`Bundled Bergamot model ${model.from} -> ${model.to} is present and checksum-verified.`);
}

const piper = config.speech?.engine === "piper" ? config.speech?.piper : null;
if (piper) {
  if (!piper.voiceId || !piper.modelPath || !piper.configPath) {
    throw new Error("speech.piper must define voiceId, modelPath, and configPath.");
  }
  if (!Array.isArray(piper.downloadSources) || piper.downloadSources.length === 0) {
    throw new Error(`Bundled Piper voice ${piper.voiceId} needs at least one build-time downloadSources entry.`);
  }

  console.log(`Preparing bundled Piper voice ${piper.voiceId}...`);
  for (const asset of buildPiperAssets(piper)) {
    await ensureAsset(piper, asset);
  }

  const voiceConfig = JSON.parse(await readFile(join(src, piper.configPath), "utf8"));
  if (voiceConfig?.espeak?.voice !== "nl") {
    throw new Error(`Bundled Piper voice ${piper.voiceId} does not declare Dutch espeak voice 'nl'.`);
  }
  if (!Number.isFinite(voiceConfig?.audio?.sample_rate) || voiceConfig.audio.sample_rate <= 0) {
    throw new Error(`Bundled Piper voice ${piper.voiceId} has an invalid sample rate.`);
  }
  console.log(
    `Bundled Piper voice ${piper.voiceId} is present and verified (${voiceConfig.audio.sample_rate} Hz, espeak=${voiceConfig.espeak.voice}).`
  );
}
