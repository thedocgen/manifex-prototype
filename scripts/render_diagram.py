#!/usr/bin/env python3
"""
Manifex → DocGen MonodrawAPI bridge.

Reads a structured diagram spec from stdin, builds a .monojson via
MonodrawAPI, renders it to ASCII via MonojsonRenderer, prints the
ASCII to stdout.

Spec format (JSON):
{
  "boxes": [
    {"id": "ui",   "text": "UI Layer",  "col": 2,  "row": 2, "w": 14, "h": 3},
    {"id": "api",  "text": "API",       "col": 22, "row": 2, "w": 14, "h": 3},
    {"id": "db",   "text": "Database",  "col": 42, "row": 2, "w": 14, "h": 3}
  ],
  "lines": [
    {"from": "ui",  "from_attach": "right", "to": "api", "to_attach": "left", "label": "request"},
    {"from": "api", "from_attach": "right", "to": "db",  "to_attach": "left"}
  ]
}

Attach values: "top" | "bottom" | "left" | "right".

The script intentionally fails fast on bad input — the caller (the
Next.js route) is expected to validate the spec before sending it
here. On failure, exit code is non-zero and stderr carries the error.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

DOCGEN_TOOLS = Path("/workspace/tools")
sys.path.insert(0, str(DOCGEN_TOOLS))
sys.path.insert(0, str(DOCGEN_TOOLS / "MonodrawRender"))

from MonodrawApi.monodraw_api import MonodrawAPI  # noqa: E402
from MonodrawApi.constants import (  # noqa: E402
    ATTACH_TOP,
    ATTACH_BOTTOM,
    ATTACH_LEFT,
    ATTACH_RIGHT,
)
from MonodrawRender.monojson_renderer import MonojsonRenderer  # noqa: E402

ATTACH = {
    "top": ATTACH_TOP,
    "bottom": ATTACH_BOTTOM,
    "left": ATTACH_LEFT,
    "right": ATTACH_RIGHT,
}


def build_monojson(spec: dict, out_path: Path) -> None:
    api = MonodrawAPI()
    api.new()

    box_ids: dict[str, str] = {}
    for b in spec.get("boxes", []):
        bid = api.add_rectangle(
            x=int(b["col"]),
            y=int(b["row"]),
            width=int(b["w"]),
            height=int(b["h"]),
            text=str(b.get("text", "")),
        )
        box_ids[str(b["id"])] = bid

    for line in spec.get("lines", []):
        from_id = box_ids.get(str(line["from"]))
        to_id = box_ids.get(str(line["to"]))
        if not from_id or not to_id:
            raise ValueError(f"line references unknown box id: {line}")
        from_attach = ATTACH[str(line.get("from_attach", "right")).lower()]
        to_attach = ATTACH[str(line.get("to_attach", "left")).lower()]
        api.add_arrow_line(from_id, from_attach, to_id, to_attach)

    api.save(str(out_path))


def render_to_ascii(monojson_path: Path) -> str:
    renderer = MonojsonRenderer(str(monojson_path))
    renderer.load()
    # MonojsonRenderer may expose .render() returning a string, or it may
    # write to stdout. Inspect and adapt.
    if hasattr(renderer, "render"):
        result = renderer.render()
        if isinstance(result, str):
            return result
    # Fallback: let it print, capture via the canvas if present.
    if hasattr(renderer, "canvas") and hasattr(renderer.canvas, "to_string"):
        return renderer.canvas.to_string()
    raise RuntimeError("MonojsonRenderer produced no string output")


def main() -> int:
    try:
        spec = json.loads(sys.stdin.read())
    except json.JSONDecodeError as e:
        print(f"invalid spec json: {e}", file=sys.stderr)
        return 2

    if not isinstance(spec, dict) or "boxes" not in spec:
        print("spec must be an object with a 'boxes' key", file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory(prefix="manifex_diagram_") as tmp:
        mj = Path(tmp) / "diagram.monojson"
        try:
            build_monojson(spec, mj)
            ascii_art = render_to_ascii(mj)
        except Exception as e:
            print(f"diagram render failed: {type(e).__name__}: {e}", file=sys.stderr)
            return 3

    sys.stdout.write(ascii_art)
    if not ascii_art.endswith("\n"):
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
