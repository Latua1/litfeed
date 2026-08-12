#!/usr/bin/env python3
"""
Build the article feed.

Fetches from every source in config.yaml — the main keyword query, any
watchlists, any tracked researchers — merges in whatever journal TOC articles
match your scoring keywords, deduplicates, scores, and writes:

    docs/feed.json     the feed the app reads
    docs/config.json   the settings the app needs (tags, keywords, sync target)

Usage:
    python generate_feed.py
    python generate_feed.py --config other.yaml
    python generate_feed.py --days 90        # override the lookback window
    python generate_feed.py --dry-run        # report counts, write nothing
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from litfeed import pubmed, scoring
from litfeed.config import ConfigError, load_config
from litfeed.query import apply_exclusions, build_query, exclusion_regex, is_excluded
from litfeed.researchers import fetch_researcher_articles, verify_authorship

HERE = Path(__file__).resolve().parent
FEED_PATH = HERE / "docs" / "feed.json"
TOC_PATH = HERE / "docs" / "toc.json"
APP_CONFIG_PATH = HERE / "docs" / "config.json"


def load_toc_matches(cfg) -> list[dict]:
    """TOC articles that match a scoring keyword, shaped like feed articles.

    Only the matching ones join the main feed. The rest stay in toc.json, where
    the app shows them grouped by journal and issue for browsing.
    """
    if not TOC_PATH.exists():
        print("No docs/toc.json yet — skipping TOC merge (run fetch_toc.py)", file=sys.stderr)
        return []

    with open(TOC_PATH, encoding="utf-8") as f:
        toc = json.load(f)

    keywords = cfg.score_keywords
    matched = []
    for journal in toc.get("journals", []):
        for art in journal.get("articles", []):
            if scoring.matches_keywords(art, keywords):
                matched.append({
                    **art,
                    "journal": art.get("journal") or journal.get("name", ""),
                    "source": "Journal TOC",
                    "trackedResearcher": None,
                })
    print(f"TOC merge: {len(matched)} keyword-matching articles", file=sys.stderr)
    return matched


def build_feed(cfg, reldate: int) -> dict:
    sleep = pubmed.configure(cfg)
    excl = exclusion_regex(cfg.exclude_title_terms)

    # 1. Main query
    query = apply_exclusions(build_query(cfg), cfg)
    print(f"Searching PubMed (lookback {reldate} days)...", file=sys.stderr)
    pmids = pubmed.search(query, reldate, cfg.retmax)
    print(f"  {len(pmids)} PMIDs; fetching records...", file=sys.stderr)
    keyword_articles = pubmed.fetch_records(pmids, sleep)
    for art in keyword_articles:
        art["source"] = "PubMed keyword"
        art.setdefault("trackedResearcher", None)
    print(f"  {len(keyword_articles)} articles fetched.", file=sys.stderr)

    # 2. Watchlists — a subject followed on any topic
    watch_articles = []
    for watch in cfg.watchlists:
        print(f"Watchlist: {watch['name']}...", file=sys.stderr)
        try:
            wq = apply_exclusions(watch["query"], cfg)
            wpmids = pubmed.search(wq, reldate, watch["max_results"])
            found = pubmed.fetch_records(wpmids, sleep)
        except Exception as e:
            print(f"  Error: {e}", file=sys.stderr)
            continue
        for art in found:
            art["source"] = watch["label"]
            art.setdefault("trackedResearcher", None)
        watch_articles.extend(found)
        print(f"  {len(found)} articles.", file=sys.stderr)

    # 3. Tracked researchers
    researcher_articles = []
    if cfg.researchers:
        print("Fetching tracked researchers...", file=sys.stderr)
        researcher_articles = fetch_researcher_articles(cfg, reldate, sleep)
        verify_authorship(researcher_articles, cfg)

    # 4. Journal TOC matches
    toc_articles = load_toc_matches(cfg)

    # 5. Merge. Watchlists go last so a paper the main query already found keeps
    #    its original source label.
    merged = keyword_articles + researcher_articles + toc_articles + watch_articles
    unique = pubmed.deduplicate(merged)

    # 6. Drop excluded titles. A tracked researcher's paper survives regardless:
    #    that stream follows people, not topics, and silently hiding their work
    #    because of its subject defeats the point of following them.
    before = len(unique)
    unique = [a for a in unique if a.get("trackedResearcher") or not is_excluded(a, excl)]
    if before != len(unique):
        print(f"Excluded {before - len(unique)} off-topic articles by title", file=sys.stderr)
    print(f"Total unique articles: {len(unique)}", file=sys.stderr)

    ranked = scoring.score_and_rank(
        unique, cfg.score_keywords, cfg.score_bonuses, cfg.score_max_count
    )

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    articles = [{
        "id": a.get("pmid", ""),
        "title": a.get("title", ""),
        "authors": a.get("authors", ""),
        "journal": a.get("journal", ""),
        "year": a.get("year", ""),
        "source": a.get("source", ""),
        "pmid": a.get("pmid", ""),
        "doi": a.get("doi", ""),
        "abstract": a.get("abstract", ""),
        "score": a.get("score", 0),
        "rank": a.get("rank", 0),
        "trackedResearcher": a.get("trackedResearcher"),
        "researcherVerified": a.get("researcherVerified"),
        "fetchDate": today,
    } for a in ranked]

    return {
        "generated": datetime.now(timezone.utc).isoformat(),
        "articleCount": len(articles),
        "articles": articles,
    }


def write_app_config(cfg) -> None:
    """Mirror the settings the browser app needs into docs/config.json.

    Written on every feed build rather than by hand, so editing config.yaml is
    always enough — there is no second place to remember to update.
    """
    APP_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(APP_CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg.to_app_config(), f, indent=2, ensure_ascii=False)
    print(f"Wrote {APP_CONFIG_PATH}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the litfeed article feed")
    parser.add_argument("--config", help="Path to config.yaml")
    parser.add_argument("--days", type=int, help="Override search.lookback_days")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and report, write nothing")
    args = parser.parse_args()

    try:
        cfg = load_config(args.config)
    except ConfigError as e:
        print(f"\n{e}\n", file=sys.stderr)
        return 1

    reldate = args.days or cfg.lookback_days
    print(f"=== {cfg.project_name} — building feed ===", file=sys.stderr)

    feed = build_feed(cfg, reldate)

    if args.dry_run:
        print(f"\nDry run: {feed['articleCount']} articles, nothing written.", file=sys.stderr)
        return 0

    FEED_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(FEED_PATH, "w", encoding="utf-8") as f:
        json.dump(feed, f, indent=2, ensure_ascii=False)
    print(f"\nWrote {feed['articleCount']} articles to {FEED_PATH}", file=sys.stderr)

    write_app_config(cfg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
