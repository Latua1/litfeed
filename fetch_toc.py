#!/usr/bin/env python3
"""
Fetch recent tables of contents for the journals in config.yaml.

Writes docs/toc.json. Run this before generate_feed.py: keyword-matching TOC
articles are merged into the main feed, and the rest stay browsable in the app's
TOC view.

Usage:
    python fetch_toc.py
    python fetch_toc.py --days 60
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from litfeed import pubmed, scoring
from litfeed.config import ConfigError, load_config
from litfeed.journals import fetch_journal_tocs

TOC_PATH = Path(__file__).resolve().parent / "docs" / "toc.json"


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch journal tables of contents")
    parser.add_argument("--config", help="Path to config.yaml")
    parser.add_argument("--days", type=int, help="Override journal_options.lookback_days")
    args = parser.parse_args()

    try:
        cfg = load_config(args.config)
    except ConfigError as e:
        print(f"\n{e}\n", file=sys.stderr)
        return 1

    if not cfg.journals:
        print("No journals configured — nothing to do. Add entries under `journals:`.", file=sys.stderr)
        return 0

    if args.days:
        cfg.data.setdefault("journal_options", {})["lookback_days"] = args.days

    sleep = pubmed.configure(cfg)
    print(f"Fetching {len(cfg.journals)} journal TOCs (last {cfg.journal_lookback_days} days)...\n",
          file=sys.stderr)

    results, errors = fetch_journal_tocs(cfg, sleep)

    keywords = cfg.score_keywords
    bonuses = cfg.score_bonuses
    for journal in results:
        for art in journal["articles"]:
            art["score"] = scoring.score_article(art, keywords, bonuses, cfg.score_max_count)

    total = sum(j["articleCount"] for j in results)

    # Never clobber a good TOC with an empty result caused by a total fetch
    # failure — offline, or a proxy intercepting TLS. A genuinely empty window
    # still writes; only "everything errored" bails.
    if total == 0 and errors == len(cfg.journals) and TOC_PATH.exists():
        print(f"\nAll {errors} fetches failed; keeping the existing {TOC_PATH}.", file=sys.stderr)
        return 1

    toc = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "reldate": cfg.journal_lookback_days,
        "journals": results,
    }
    TOC_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(TOC_PATH, "w", encoding="utf-8") as f:
        json.dump(toc, f, indent=2, ensure_ascii=False)

    print(f"\nWrote {total} articles across {len(results)} journals to {TOC_PATH}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
