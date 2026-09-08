import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
src = root / "src"
dist = root / "dist"
manifest = json.loads((src / "manifest.json").read_text())
out = root / f"thelounge-bergamot-extension-{manifest['version']}.zip"

if not dist.is_dir():
    raise SystemExit("dist/ does not exist. Run `npm run build` first.")

with ZipFile(out, "w", ZIP_DEFLATED) as archive:
    for path in sorted(dist.rglob("*")):
        if path.is_file():
            archive.write(path, path.relative_to(dist))
print(out)
