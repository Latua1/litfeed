#!/usr/bin/env python3
"""
Build docs/library.json — what the app uses to badge each article with whether
you already hold its full text, or have accepted that you never will.

Two inputs, both optional and both configured under `library:` in config.yaml:

  manifest            a JSON index of your PDF collection. Either a list of
                      entries or an object keyed by anything, where each entry
                      has at least {"doi": ..., "has_full_text": true}.
                      Entries without a DOI are ignored — a DOI is the only
                      identifier stable enough to match on.

  unobtainable_file   a plain markdown or text file listing papers you have
                      given up on. Any doi.org or pubmed.ncbi.nlm.nih.gov URL
                      anywhere in it is picked up, so the file can be prose.

Kept SEPARATE from feed.json on purpose: feed.json is regenerated on a schedule,
often by CI, which has no access to your local PDF collection. library.json is
built locally whenever your collection changes, and CI leaves it alone — so the
badges survive a feed refresh.

Usage:
    python build_library_index.py
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from litfeed.config import ConfigError, load_config

OUT_PATH = Path(__file__).resolve().parent / "docs" / "library.json"


def normalize_doi(doi: str) -> str:
    if not doi:
        return ""
    d = doi.strip().lower()
    d = re.sub(r"^https?://(dx\.)?doi\.org/", "", d)
    return re.sub(r"^doi:\s*", "", d)


def load_have_dois(manifest_path: Path | None) -> list[str]:
    """DOIs from the manifest whose full text you actually hold."""
    if not manifest_path:
        return []
    if not manifest_path.exists():
        print(f"  {manifest_path} not found — skipping 'have' set", file=sys.stderr)
        return []

    with open(manifest_path, encoding="utf-8") as f:
        data = json.load(f)

    dois = set()
    items = data.items() if isinstance(data, dict) else enumerate(data)
    for key, entry in items:
        if not isinstance(entry, dict):
            continue
        # A manifest that never records has_full_text is treated as "every
        # entry is held" — otherwise a simple list of owned PDFs would index
        # as empty, which reads as a broken tool rather than a lax schema.
        if "has_full_text" in entry and not entry["has_full_text"]:
            continue
        # Some manifests key the object by DOI, so the key is worth trying too.
        for candidate in (entry.get("doi"), key if isinstance(key, str) else None):
            nd = normalize_doi(candidate or "")
            if nd and not nd.startswith("no_doi"):
                dois.add(nd)
    return sorted(dois)


def load_unobtainable(path: Path | None) -> tuple[list[str], list[str]]:
    """DOIs and PMIDs scraped out of the accepted-as-lost list."""
    if not path:
        return [], []
    if not path.exists():
        print(f"  {path} not found — skipping 'unobtainable' set", file=sys.stderr)
        return [], []

    text = path.read_text(encoding="utf-8")
    dois = {normalize_doi(m) for m in re.findall(r"doi\.org/([^\s>)\]]+)", text, re.IGNORECASE)}
    dois.discard("")
    pmids = set(re.findall(r"pubmed\.ncbi\.nlm\.nih\.gov/(\d+)", text))
    return sorted(dois), sorted(pmids)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the full-text availability index")
    parser.add_argument("--config", help="Path to config.yaml")
    args = parser.parse_args()

    try:
        cfg = load_config(args.config)
    except ConfigError as e:
        print(f"\n{e}\n", file=sys.stderr)
        return 1

    lib = cfg.library
    manifest = Path(lib["manifest"]) if lib["manifest"] else None
    unobtainable = Path(lib["unobtainable_file"]) if lib["unobtainable_file"] else None

    if not manifest and not unobtainable:
        print(
            "Neither library.manifest nor library.unobtainable_file is set in "
            "config.yaml — nothing to index. The app simply shows no badges.",
            file=sys.stderr,
        )
        return 0

    print("=== Building library.json ===", file=sys.stderr)
    have = load_have_dois(manifest)
    lost_dois, lost_pmids = load_unobtainable(unobtainable)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump({
            "generated": datetime.now(timezone.utc).isoformat(),
            "haveDois": have,
            "unobtainableDois": lost_dois,
            "unobtainablePmids": lost_pmids,
        }, f, indent=2, ensure_ascii=False)

    print(
        f"Wrote {len(have)} held DOIs, {len(lost_dois)} unobtainable DOIs, "
        f"{len(lost_pmids)} unobtainable PMIDs to {OUT_PATH}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
