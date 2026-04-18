---
name: java-batch-replace
description: Batch-replace code or text across `.java` files under a target directory using a packaged Python script. Use when Codex needs to update the same snippet, statement, import, annotation, or multi-line code block in many Java source files, preview replacements with dry-run, apply regex-based replacements, delete matched code, or create backups before writing.
---

# Java Batch Replace

Use `scripts/replace_java_text.py` to perform one replacement across a Java source tree.

## Workflow

1. Resolve the target directory that contains the `.java` files.
2. Choose literal replacement first. Use regex only when literal matching is not sufficient.
3. Run a preview with `--dry-run` before writing changes.
4. Add `--backup` when the replacement is broad or risky.
5. For multi-line snippets, place the old and new blocks in temporary files and use `--old-file` and `--new-file`.
6. Review the reported file count and replacement count after the run.

## Commands

Run the script with Python:

```bash
python "<skill-dir>/scripts/replace_java_text.py" <root> --old "<old>" --new "<new>" --dry-run
```

Literal replacement:

```bash
python "<skill-dir>/scripts/replace_java_text.py" ./src --old "foo();" --new "bar();" --dry-run
```

Multi-line replacement:

```bash
python "<skill-dir>/scripts/replace_java_text.py" ./src --old-file old.txt --new-file new.txt --backup
```

Regex replacement:

```bash
python "<skill-dir>/scripts/replace_java_text.py" ./src --old "System\.out\.println\(.*?\);" --regex
```

Custom encoding:

```bash
python "<skill-dir>/scripts/replace_java_text.py" ./src --old "foo();" --new "bar();" --encoding utf-16
```

## Behavior Notes

- Scan the target directory recursively and only modify files ending in `.java`.
- Omit `--new` to delete matched content. This is the safest way to express an empty replacement in PowerShell.
- Inline `--old` and `--new` values decode `\n`, `\r`, `\t`, and `\\` once, so `--new "line1\nline2"` writes a real newline.
- Accept literal or regex matching.
- Support multi-line literal replacement through `--old-file` and `--new-file`.
- Strip UTF-8 BOM from template files loaded with `--old-file` or `--new-file`.
- Normalize newline differences for multi-line literal replacements while preserving the target file's existing newline style.
- Return a non-zero exit code for invalid directories, invalid argument combinations, empty old payloads, unreadable files, or regex failures.

## When Updating The Skill

- Patch `scripts/replace_java_text.py` directly if the replacement behavior needs to change.
- Re-run a representative dry-run and an actual write test after modifying the script.
