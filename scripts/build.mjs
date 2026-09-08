import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const dist = join(root, "dist");

const packages = {
  bergamot: join(root, "node_modules", "@browsermt", "bergamot-translator"),
  notyf: join(root, "node_modules", "notyf"),
  piperWasm: join(root, "node_modules", "@diffusionstudio", "piper-wasm"),
  onnx: join(root, "node_modules", "onnxruntime-web")
};

const vendorFiles = [
  [packages.bergamot, "translator.js", "vendor/bergamot/translator.js"],
  [packages.bergamot, "worker/translator-worker.js", "vendor/bergamot/worker/translator-worker.js"],
  [packages.bergamot, "worker/bergamot-translator-worker.js", "vendor/bergamot/worker/bergamot-translator-worker.js"],
  [packages.bergamot, "worker/bergamot-translator-worker.wasm", "vendor/bergamot/worker/bergamot-translator-worker.wasm"],
  [packages.notyf, "notyf.min.js", "vendor/notyf/notyf.min.js"],
  [packages.notyf, "notyf.min.css", "vendor/notyf/notyf.min.css"],
  [packages.piperWasm, "build/piper_phonemize.js", "vendor/piper/piper_phonemize.js"],
  [packages.piperWasm, "build/piper_phonemize.wasm", "vendor/piper/piper_phonemize.wasm"],
  [packages.piperWasm, "build/piper_phonemize.data", "vendor/piper/piper_phonemize.data"],
  [packages.onnx, "dist/ort.min.js", "vendor/onnxruntime/ort.min.js"],
  [packages.onnx, "dist/ort-wasm.wasm", "vendor/onnxruntime/ort-wasm.wasm"],
  [packages.onnx, "dist/ort-wasm-simd.wasm", "vendor/onnxruntime/ort-wasm-simd.wasm"],
  [packages.onnx, "dist/ort-wasm-threaded.wasm", "vendor/onnxruntime/ort-wasm-threaded.wasm"],
  [packages.onnx, "dist/ort-wasm-simd-threaded.wasm", "vendor/onnxruntime/ort-wasm-simd-threaded.wasm"]
];

for (const [pkg, sourcePath] of vendorFiles) {
  if (!existsSync(join(pkg, sourcePath))) {
    console.error(`Missing ${join(pkg, sourcePath)}`);
    console.error("Run `npm install` first so all vendored Bergamot/Piper/ONNX/Notyf runtime files are available.");
    process.exit(1);
  }
}

const config = JSON.parse(await readFile(join(src, "config.json"), "utf8"));
if (!Array.isArray(config.siteGroups) || config.siteGroups.length === 0) {
  throw new Error("src/config.json siteGroups must contain at least one configured site group.");
}
if (!config.selectorProfiles || typeof config.selectorProfiles !== "object") {
  throw new Error("src/config.json selectorProfiles is required.");
}

for (const group of config.siteGroups) {
  if (!Array.isArray(group.matches) || group.matches.length === 0) {
    throw new Error(`Site group '${group.id || group.label || "unnamed"}' must contain at least one WebExtension match pattern.`);
  }
  if (!config.selectorProfiles[group.selectorProfile]) {
    throw new Error(`Site group '${group.id || group.label || "unnamed"}' references missing selector profile '${group.selectorProfile}'.`);
  }
}

const siteMatches = [...new Set(config.siteGroups.flatMap((group) => group.matches))];

const localModels = Array.isArray(config.bergamot?.localModels)
  ? config.bergamot.localModels
  : [];
if (localModels.length === 0) {
  throw new Error("src/config.json bergamot.localModels must contain at least one bundled model.");
}

const modelFiles = localModels.flatMap((model) => [
  model.modelPath,
  model.shortlistPath,
  ...(model.vocabPaths || [])
]);

const piper = config.speech?.engine === "piper" ? config.speech?.piper : null;
const piperFiles = piper ? [piper.modelPath, piper.configPath] : [];

for (const relativePath of [...modelFiles, ...piperFiles]) {
  if (!relativePath || !existsSync(join(src, relativePath))) {
    throw new Error(`Missing bundled model file src/${relativePath}. Run \`npm run models\` first.`);
  }
}

function originMatch(pattern) {
  if (pattern === "<all_urls>") return pattern;
  const match = /^(\*|http|https|file|ftp):\/\/([^/]+)\/.*$/.exec(pattern);
  if (!match) {
    throw new Error(`Unsupported site match pattern: ${pattern}`);
  }
  return `${match[1]}://${match[2]}/*`;
}

const siteOriginMatches = [...new Set(siteMatches.map(originMatch))];
const manifest = JSON.parse(await readFile(join(src, "manifest.json"), "utf8"));
manifest.content_scripts[0].matches = siteMatches;
manifest.web_accessible_resources[0].matches = siteOriginMatches;
// Translation and TTS models are bundled and loaded from the extension origin.
// No remote model host permissions are required at runtime.
manifest.host_permissions = siteOriginMatches;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await writeFile(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

for (const file of [
  "background.js",
  "content.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "config.json",
  "engine-host.html",
  "engine-host.js",
  "THIRD_PARTY_NOTICES.md"
]) {
  await cp(join(src, file), join(dist, file));
}
await cp(join(src, "icons"), join(dist, "icons"), { recursive: true });
await cp(join(src, "models"), join(dist, "models"), { recursive: true });

for (const [pkg, sourcePath, destinationPath] of vendorFiles) {
  const destination = join(dist, destinationPath);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(pkg, sourcePath), destination);
}

async function copyLicense(pkg, destinationDir) {
  for (const licenseName of ["LICENSE", "LICENSE.txt", "LICENSE.md", "license", "license.txt"]) {
    const source = join(pkg, licenseName);
    if (existsSync(source)) {
      await mkdir(join(dist, destinationDir), { recursive: true });
      await cp(source, join(dist, destinationDir, licenseName));
      return;
    }
  }
}

await copyLicense(packages.bergamot, "vendor/bergamot");
await copyLicense(packages.notyf, "vendor/notyf");
await copyLicense(packages.piperWasm, "vendor/piper");
await copyLicense(packages.onnx, "vendor/onnxruntime");

console.log(`Built ${manifest.name} ${manifest.version} in ${dist}`);
console.log(`Content matches: ${siteMatches.join(", ")}`);
console.log(`Selector profiles: ${config.siteGroups.map((group) => `${group.label || group.id} -> ${group.selectorProfile}`).join(", ")}`);
console.log(`Bundled translation models: ${localModels.map((model) => `${model.from} -> ${model.to}`).join(", ")} (${modelFiles.length} files)`);
if (piper) {
  console.log(`Bundled Piper voice: ${piper.voiceId} (${piperFiles.length} files)`);
}
console.log("Runtime model networking: disabled (translation and TTS models are packaged in dist/models/)");
