#!/usr/bin/env python3
"""Validate the Fresh package fields used by this plugin."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "package.json"


def fail(message: str) -> None:
    print(f"package.json: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(str(error))

    name = manifest.get("name")
    if not isinstance(name, str) or re.fullmatch(r"[a-z0-9-]+", name) is None:
        fail("name must contain only lowercase letters, numbers, and hyphens")

    version = manifest.get("version")
    if not isinstance(version, str) or re.fullmatch(r"\d+\.\d+\.\d+", version) is None:
        fail("version must use MAJOR.MINOR.PATCH format")

    if manifest.get("type") != "plugin":
        fail('type must be "plugin"')

    fresh = manifest.get("fresh")
    if not isinstance(fresh, dict):
        fail("fresh must be an object")

    entry = fresh.get("entry")
    if not isinstance(entry, str) or not entry:
        fail("fresh.entry must name the plugin entry point")
    if not (ROOT / entry).is_file():
        fail(f"fresh.entry does not exist: {entry}")

    minimum = fresh.get("min_version")
    if not isinstance(minimum, str) or re.fullmatch(r"\d+\.\d+\.\d+", minimum) is None:
        fail("fresh.min_version must use MAJOR.MINOR.PATCH format")

    api_version = fresh.get("min_api_version")
    if not isinstance(api_version, int) or isinstance(api_version, bool) or api_version < 0:
        fail("fresh.min_api_version must be a non-negative integer")

    print(f"Validated {name} {version} ({entry})")


if __name__ == "__main__":
    main()
