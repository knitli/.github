#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2025 Knitli Inc. <knitli@knit.li>
# SPDX-FileContributor: Adam Poulemanos <adam@knit.li>
#
# SPDX-License-Identifier: MIT OR Apache-2.0
#
# Replaces British spellings with American equivalents across a list of
# files, using scripts/teaparty/dictionary.yml as the word list. This is the
# engine behind the "teaparty" reusable workflow.
#
# Case handling:
#   - "colour"  -> "color"   (lowercase preserved)
#   - "Colour"  -> "Color"   (capitalized preserved)
#   - "COLOUR"  -> "COLOR"   (all-caps preserved)
#   - "backgroundColour" -> "backgroundColor" (camelCase inner boundary)
# Matches are only replaced at a word boundary: start/end of string, a
# non-letter, or a lower->upper case transition (so camelCase identifiers are
# handled without also matching inside e.g. "discolouration" twice or
# clobbering unrelated substrings).

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    print("teaparty: PyYAML is required (pip install pyyaml)", file=sys.stderr)
    sys.exit(2)


def load_dictionary(path: Path) -> dict[str, str]:
    with path.open(encoding="utf-8") as fh:
        raw = yaml.safe_load(fh) or {}
    return {str(k).lower(): str(v) for k, v in raw.items()}


def build_pattern(words: list[str]) -> re.Pattern[str]:
    # Longest-first so multi-word entries (if any are ever added) can't be
    # shadowed by a shorter entry that's a prefix of them.
    escaped = sorted((re.escape(w) for w in words), key=len, reverse=True)
    return re.compile("(" + "|".join(escaped) + ")", re.IGNORECASE)


def _is_start_boundary(text: str, idx: int) -> bool:
    if idx == 0:
        return True
    prev = text[idx - 1]
    if not prev.isalpha():
        return True
    # camelCase boundary: "background|Colour"
    return prev.islower() and text[idx].isupper()


def _is_end_boundary(text: str, idx: int) -> bool:
    if idx == len(text):
        return True
    nxt = text[idx]
    if not nxt.isalpha():
        return True
    # camelCase boundary: "colour|Value"
    return text[idx - 1].islower() and nxt.isupper()


def match_case(source: str, replacement: str) -> str:
    if source.isupper() and len(source) > 1:
        return replacement.upper()
    if source[:1].isupper():
        return replacement[:1].upper() + replacement[1:]
    return replacement


def replace_in_text(
    text: str, mapping: dict[str, str], pattern: re.Pattern[str]
) -> tuple[str, int]:
    hits = 0
    out: list[str] = []
    last = 0
    for m in pattern.finditer(text):
        start, end = m.start(), m.end()
        if not (_is_start_boundary(text, start) and _is_end_boundary(text, end)):
            continue
        word = m.group(0)
        replacement = match_case(word, mapping[word.lower()])
        if replacement == word:
            continue
        out.append(text[last:start])
        out.append(replacement)
        last = end
        hits += 1
    out.append(text[last:])
    return ("".join(out), hits)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dictionary", required=True, type=Path)
    parser.add_argument(
        "--files-from",
        required=True,
        type=Path,
        help="newline-separated list of candidate file paths",
    )
    parser.add_argument(
        "--changed-files-out",
        required=True,
        type=Path,
        help="where to write the newline-separated list of files actually touched",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report what would change without writing files",
    )
    args = parser.parse_args()

    mapping = load_dictionary(args.dictionary)
    if not mapping:
        print("teaparty: dictionary is empty, nothing to do")
        args.changed_files_out.write_text("", encoding="utf-8")
        return 0

    pattern = build_pattern(list(mapping.keys()))
    candidates = [
        line.strip()
        for line in args.files_from.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]

    touched: list[str] = []
    total_hits = 0
    for rel_path in candidates:
        path = Path(rel_path)
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, ValueError):
            continue

        new_text, hits = replace_in_text(text, mapping, pattern)
        if hits == 0:
            continue

        total_hits += hits
        touched.append(rel_path)
        verb = "would fix" if args.dry_run else "fixed"
        print(f"teaparty: {verb} {hits} spelling(s) in {rel_path}")
        if not args.dry_run:
            path.write_text(new_text, encoding="utf-8")

    args.changed_files_out.write_text("\n".join(touched), encoding="utf-8")
    print(f"teaparty: {len(touched)} file(s), {total_hits} replacement(s) total")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
