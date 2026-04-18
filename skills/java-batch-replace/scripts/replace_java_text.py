#!/usr/bin/env python3
"""
Batch replace code content in all Java files under a target directory.

Examples:
  python replace_java_text.py ./src --old "foo" --new "bar" --dry-run
  python replace_java_text.py ./src --old-file old.txt --new-file new.txt
  python replace_java_text.py ./src --old-file old.java --new-file new.java --backup
  python replace_java_text.py ./src --old "System.out.println\\(.*?\\);" --new "" --regex
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Recursively replace text in all .java files under a directory."
    )
    parser.add_argument("root", help="Root directory to scan")
    parser.add_argument(
        "--old",
        help="Old text to replace (literal by default, regex when --regex is set)",
    )
    parser.add_argument(
        "--new",
        default="",
        help="Replacement text (default: empty string)",
    )
    parser.add_argument(
        "--old-file",
        help="Read old text from a file, useful for multi-line code blocks",
    )
    parser.add_argument(
        "--new-file",
        help="Read replacement text from a file, useful for multi-line code blocks",
    )
    parser.add_argument(
        "--regex",
        action="store_true",
        help="Treat the old text as a regular expression",
    )
    parser.add_argument(
        "--ignore-case",
        action="store_true",
        help="Ignore case when --regex is set",
    )
    parser.add_argument(
        "--encoding",
        default="utf-8",
        help="File encoding used to read and write Java files (default: utf-8)",
    )
    parser.add_argument(
        "--backup",
        action="store_true",
        help="Create a .bak backup before modifying each file",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview affected files without writing changes",
    )
    return parser.parse_args()


def read_text(path: Path, encoding: str) -> str:
    with path.open("r", encoding=encoding, newline="") as handle:
        return handle.read()


def write_text(path: Path, content: str, encoding: str) -> None:
    with path.open("w", encoding=encoding, newline="") as handle:
        handle.write(content)


def strip_bom(text: str) -> str:
    if text.startswith("\ufeff"):
        return text[1:]
    return text


def normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def detect_newline(text: str) -> str:
    if "\r\n" in text:
        return "\r\n"
    if "\n" in text:
        return "\n"
    if "\r" in text:
        return "\r"
    return "\n"


def load_payload(
    inline_value: str | None, file_value: str | None, encoding: str, label: str
) -> str:
    if bool(inline_value) == bool(file_value):
        raise SystemExit(f"You must provide exactly one of --{label} or --{label}-file.")

    if file_value:
        return strip_bom(read_text(Path(file_value), encoding))

    return inline_value or ""


def iter_java_files(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*.java") if path.is_file())


def replace_literal(content: str, old: str, new: str) -> tuple[str, int]:
    count = content.count(old)
    if count == 0:
        if "\n" not in old and "\r" not in old:
            return content, 0

        newline = detect_newline(content)
        normalized_content = normalize_newlines(content)
        normalized_old = normalize_newlines(old)
        normalized_new = normalize_newlines(new)
        normalized_count = normalized_content.count(normalized_old)
        if normalized_count == 0:
            return content, 0

        updated = normalized_content.replace(normalized_old, normalized_new)
        return updated.replace("\n", newline), normalized_count

    return content.replace(old, new), count


def replace_regex(content: str, pattern: str, new: str, ignore_case: bool) -> tuple[str, int]:
    flags = re.MULTILINE
    if ignore_case:
        flags |= re.IGNORECASE
    return re.subn(pattern, new, content, flags=flags)


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()

    if not root.exists():
        print(f"Directory does not exist: {root}", file=sys.stderr)
        return 1
    if not root.is_dir():
        print(f"Path is not a directory: {root}", file=sys.stderr)
        return 1

    old_text = load_payload(args.old, args.old_file, args.encoding, "old")
    new_text = (
        load_payload(args.new, args.new_file, args.encoding, "new")
        if args.new_file
        else args.new
    )

    if old_text == "":
        print("Old text cannot be empty.", file=sys.stderr)
        return 1

    java_files = iter_java_files(root)
    if not java_files:
        print(f"No .java files found under: {root}")
        return 0

    changed_files = 0
    total_replacements = 0
    failed_files: list[tuple[Path, str]] = []

    for file_path in java_files:
        try:
            original = read_text(file_path, args.encoding)
            if args.regex:
                updated, replacements = replace_regex(
                    original, old_text, new_text, args.ignore_case
                )
            else:
                updated, replacements = replace_literal(original, old_text, new_text)

            if replacements == 0:
                continue

            changed_files += 1
            total_replacements += replacements

            print(f"[MATCH] {file_path} ({replacements} replacement(s))")

            if args.dry_run:
                continue

            if args.backup:
                backup_path = file_path.with_suffix(file_path.suffix + ".bak")
                shutil.copy2(file_path, backup_path)

            write_text(file_path, updated, args.encoding)
        except Exception as exc:  # noqa: BLE001
            failed_files.append((file_path, str(exc)))

    mode = "Preview" if args.dry_run else "Completed"
    print(
        f"{mode}: {changed_files} file(s), {total_replacements} replacement(s), "
        f"{len(failed_files)} failure(s)."
    )

    if failed_files:
        print("\nFailures:", file=sys.stderr)
        for file_path, reason in failed_files:
            print(f"  - {file_path}: {reason}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
