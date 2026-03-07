#!/usr/bin/env python3

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_ENTRY_HTML = ROOT_DIR / "index.html"
META_NAME = "app-asset-version"
VERSION_VAR_NAME = "__APP_ASSET_VERSION__"


@dataclass
class UpdateResult:
    file_path: Path
    changed: bool
    script_count: int
    content: str


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Interactively bump local JS asset versions.")
    parser.add_argument("version", nargs="?", help="Explicit target version, e.g. 2026.03.06.2")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing files")
    parser.add_argument("--yes", action="store_true", help="Skip prompts and apply suggested/custom version directly")
    return parser


def get_today_prefix() -> str:
    return datetime.now().strftime("%Y.%m.%d")


def resolve_current_version(content: str) -> str:
    meta_match = re.search(rf'<meta\s+name="{re.escape(META_NAME)}"\s+content="([^"]+)"', content, re.IGNORECASE)
    if meta_match:
        return meta_match.group(1).strip()

    version_var_match = re.search(rf'window\.{re.escape(VERSION_VAR_NAME)}\s*=\s*"([^"]+)"', content)
    if version_var_match:
        return version_var_match.group(1).strip()

    return ""


def resolve_suggested_version(current_version: str) -> str:
    today_prefix = get_today_prefix()
    match = re.fullmatch(r"(\d{4}\.\d{2}\.\d{2})\.(\d+)", current_version or "")
    if match and match.group(1) == today_prefix:
        return f"{today_prefix}.{int(match.group(2)) + 1}"
    return f"{today_prefix}.1"


def is_valid_version(version: str) -> bool:
    return bool(re.fullmatch(r"\d{4}\.\d{2}\.\d{2}\.\d+", version.strip()))


def prompt_yes_no(prompt: str, default: bool = True) -> bool:
    suffix = "[Y/n]" if default else "[y/N]"
    while True:
        raw = input(f"{prompt} {suffix}: ").strip().lower()
        if not raw:
            return default
        if raw in {"y", "yes"}:
            return True
        if raw in {"n", "no"}:
            return False
        print("Please answer y or n.")


def choose_target_version(current_version: str, explicit_version: str, non_interactive: bool) -> tuple[str, bool]:
    suggested = resolve_suggested_version(current_version)

    if explicit_version:
      target = explicit_version.strip()
      if not is_valid_version(target):
          raise ValueError(f"Invalid version format: {target}")
      return target, False

    if non_interactive:
        return suggested, False

    print(f"Current version : {current_version or '(none)'}")
    print(f"Suggested next  : {suggested}")
    raw = input("Enter target version (leave blank to use suggested): ").strip()
    target = raw or suggested
    if not is_valid_version(target):
        raise ValueError(f"Invalid version format: {target}")
    dry_run = prompt_yes_no("Preview only", default=False)
    return target, dry_run


def collect_html_files(root_dir: Path) -> list[Path]:
    html_files: list[Path] = []
    for path in root_dir.rglob("*.html"):
        parts = set(path.parts)
        if ".git" in parts or "node_modules" in parts or "dist" in parts:
            continue
        html_files.append(path)
    return sorted(html_files)


def update_version_meta(content: str, version: str) -> str:
    return re.sub(
        rf'(<meta\s+name="{re.escape(META_NAME)}"\s+content=")([^"]+)(")',
        rf'\g<1>{version}\3',
        content,
        count=1,
        flags=re.IGNORECASE,
    )


def update_version_var(content: str, version: str) -> str:
    return re.sub(
        rf'(window\.{re.escape(VERSION_VAR_NAME)}\s*=\s*")([^"]+)("\s*;)',
        rf'\g<1>{version}\3',
        content,
        count=1,
    )


def update_script_src_value(src: str, version: str) -> str:
    trimmed = src.strip()
    if not trimmed or trimmed.startswith(("http://", "https://", "//")):
        return trimmed
    if not re.search(r"\.js(?:\?|$)", trimmed, flags=re.IGNORECASE):
        return trimmed

    parsed = urlsplit(trimmed)
    params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    params["v"] = version
    next_query = urlencode(params)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, next_query, parsed.fragment))


def update_script_tags(content: str, version: str) -> tuple[str, int]:
    changed_count = 0

    def repl(match: re.Match[str]) -> str:
        nonlocal changed_count
        prefix, src, suffix = match.groups()
        next_src = update_script_src_value(src, version)
        if next_src != src:
            changed_count += 1
        return f"{prefix}{next_src}{suffix}"

    updated = re.sub(r'(<script\b[^>]*\bsrc=")([^"]+)("[^>]*></script>)', repl, content, flags=re.IGNORECASE)
    return updated, changed_count


def process_html_file(file_path: Path, version: str) -> UpdateResult:
    original = file_path.read_text(encoding="utf-8")
    updated = update_version_meta(original, version)
    updated = update_version_var(updated, version)
    updated, script_count = update_script_tags(updated, version)
    return UpdateResult(
        file_path=file_path,
        changed=(updated != original),
        script_count=script_count,
        content=updated,
    )


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()

    base_content = DEFAULT_ENTRY_HTML.read_text(encoding="utf-8")
    current_version = resolve_current_version(base_content)
    target_version, interactive_dry_run = choose_target_version(
        current_version=current_version,
        explicit_version=args.version or "",
        non_interactive=args.yes,
    )
    dry_run = bool(args.dry_run or interactive_dry_run)

    results = [process_html_file(file_path, target_version) for file_path in collect_html_files(ROOT_DIR)]
    changed_files = [item for item in results if item.changed]

    print(f"[Version] current: {current_version or '(none)'}")
    print(f"[Version] target:  {target_version}")
    print(f"[Version] mode:    {'dry-run' if dry_run else 'write'}")

    if not changed_files:
        print("[Version] no HTML files needed changes.")
        return 0

    for item in changed_files:
        rel = item.file_path.relative_to(ROOT_DIR)
        print(f"[Version] update {rel} (script tags: {item.script_count})")

    if dry_run:
        return 0

    if not args.yes and not args.version:
        if not prompt_yes_no("Apply these changes", default=True):
            print("[Version] cancelled.")
            return 0

    for item in changed_files:
        item.file_path.write_text(item.content, encoding="utf-8")

    print("[Version] done.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n[Version] cancelled by user.")
        raise SystemExit(130)
    except Exception as exc:
        print(f"[Version] failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
