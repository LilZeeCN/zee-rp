"""Content-addressed storage for compiler-owned page artifacts."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

import PIL
from .fonts import FONT_PATHS, FALLBACK_FONT_PATHS


def fingerprint():
    scripts = Path(__file__).resolve().parents[1]
    inputs = [scripts / "rp_language.py", scripts / "rp_dsl.py", scripts / "proto.py"]
    for folder in ("proto_engine", "rplang"):
        inputs.extend(sorted((scripts / folder).glob("*.py")))
    digest = hashlib.sha256(PIL.__version__.encode())
    for path in inputs:
        digest.update(path.read_bytes())
    for name in (*FONT_PATHS, *FALLBACK_FONT_PATHS):
        try:
            info = os.stat(name)
            digest.update(f"{name}:{info.st_size}:{info.st_mtime_ns}".encode())
        except OSError:
            pass
    return digest.hexdigest()


def has_external_assets(node):
    if isinstance(node, list):
        return any(has_external_assets(item) for item in node)
    if not isinstance(node, dict):
        return False
    if node.get("type") == "image" or any(key in node for key in ("src", "image", "file", "leftIcon")):
        return True
    return any(has_external_assets(value) for value in node.values())


def page_key(context, page, slug, name):
    data = json.dumps([context, page, slug, name], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(data.encode()).hexdigest()


def rebase(value, old, new):
    if isinstance(value, str) and value.startswith(old + "/"):
        return new + value[len(old):]
    if isinstance(value, list):
        return [rebase(item, old, new) for item in value]
    if isinstance(value, dict):
        return {key: rebase(item, old, new) for key, item in value.items()}
    return value


def restore(directory, key, output):
    entry = Path(directory, key)
    try:
        if entry.is_symlink():
            return None
        record = json.loads((entry / "bundle.json").read_text(encoding="utf-8"))
        sources = []
        for relative in record["files"]:
            path = Path(relative)
            source = entry / path
            if path.is_absolute() or ".." in path.parts or not source.is_file() or source.is_symlink():
                return None
            sources.append((source, Path(output, path)))
        for source, target in sources:
            shutil.copyfile(source, target)
        os.utime(entry, None)
        return rebase(record["content"], "@output", output)
    except (OSError, ValueError, KeyError, TypeError):
        return None


def store(directory, key, output, files, content):
    root = Path(directory)
    target = root / key
    try:
        root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".stage-", dir=root) as stage:
            entry = Path(stage) / "entry"
            entry.mkdir()
            for relative in files:
                target_file = entry / relative
                target_file.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(Path(output, relative), target_file)
            record = {"files": sorted(files), "content": rebase(content, output, "@output")}
            (entry / "bundle.json").write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
            if not target.exists():
                entry.rename(target)
    except OSError:
        pass
