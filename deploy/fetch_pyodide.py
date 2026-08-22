"""Fetch the Pyodide runtime and a fixed package set for serving from this image.

Runs in a build stage only. The version is pinned in the Dockerfile; package files are
verified against the sha256 the release's own lock file records, so a tampered or
truncated download fails the build. At runtime nothing is ever fetched from outside —
that is the point of baking all of this in.
"""

import hashlib
import json
import sys
import urllib.request
from pathlib import Path

CDN = "https://cdn.jsdelivr.net/pyodide/v{version}/full/"

# The interpreter itself. These carry no lock-file hash; they are pinned by the
# versioned path, the same immutability class as a pinned base-image tag.
RUNTIME_FILES = (
    "pyodide.js",
    "pyodide.asm.js",
    "pyodide.asm.wasm",
    "python_stdlib.zip",
    "pyodide-lock.json",
)


def download(url: str, target: Path) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as response:  # noqa: S310 - pinned https URL
        content = response.read()
    target.write_bytes(content)
    return content


def closure(packages: dict, wanted: list[str]) -> list[str]:
    """The requested packages plus everything they depend on, in the lock file."""
    resolved: list[str] = []
    pending = list(wanted)
    while pending:
        name = pending.pop()
        if name in resolved:
            continue
        info = packages.get(name)
        if info is None:
            raise SystemExit(f"package '{name}' is not in this Pyodide release")
        resolved.append(name)
        pending.extend(info.get("depends", []))
    return sorted(resolved)


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: fetch_pyodide.py <dest> <version> <package>...", file=sys.stderr)
        return 2
    dest = Path(sys.argv[1])
    version = sys.argv[2]
    wanted = sys.argv[3:]
    base = CDN.format(version=version)
    dest.mkdir(parents=True, exist_ok=True)

    for name in RUNTIME_FILES:
        print(f"runtime {name}")
        download(base + name, dest / name)

    lock = json.loads((dest / "pyodide-lock.json").read_text(encoding="utf-8"))
    packages = lock["packages"]
    for name in closure(packages, wanted):
        info = packages[name]
        file_name = info["file_name"]
        print(f"package {name} ({file_name})")
        content = download(base + file_name, dest / file_name)
        digest = hashlib.sha256(content).hexdigest()
        if digest != info["sha256"]:
            print(f"sha256 mismatch for {file_name}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
