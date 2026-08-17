#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--adapter-flag", action="store_true")
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--descriptor-dir", type=Path, required=True)
    arguments = parser.parse_args()

    information = arguments.descriptor_dir.stat()
    if not arguments.adapter_flag:
        raise RuntimeError("runner did not preserve the adapter's leading-dash argument")
    if not arguments.descriptor_dir.is_dir() or information.st_uid != os.getuid():
        raise RuntimeError("descriptor directory has the wrong type or owner")
    if information.st_mode & 0o7777 != 0o700:
        raise RuntimeError("descriptor directory is not mode 0700")

    lifecycle_marker = arguments.descriptor_dir / "adapter-owned.tmp"
    lifecycle_marker.write_text("self-driving server fixture\n", encoding="utf-8")
    lifecycle_marker.unlink()
    print(json.dumps({"status": "ok", "scenario": arguments.scenario}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
