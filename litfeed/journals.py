"""
Journal table-of-contents fetching.

A keyword feed answers "what was published about my topic". A TOC answers "what
did this journal publish", which is a different and complementary question: it
is how you notice the paper whose title uses none of your vocabulary, and how
you keep a feel for what a field is actually publishing.

Articles whose text matches your scoring keywords are merged into the main
feed. The rest stay in a separate TOC view you can browse or dismiss in bulk.
"""

from __future__ import annotations

import sys
import time

from .pubmed import fetch_records, search
from .query import apply_exclusions


def fetch_journal_tocs(cfg, sleep: float) -> tuple[list[dict], int]:
    """Fetch recent articles per configured journal.

    Returns (journal_results, error_count) where each journal result is
    {name, abbreviation, articleCount, articles}.
    """
    reldate = cfg.journal_lookback_days
    results = []
    errors = 0

    for journal in cfg.journals:
        term = journal["query"]
        if cfg.journal_apply_exclusions:
            # Without this, a large general journal's TOC is dominated by the
            # subjects you already told litfeed you never cover.
            term = apply_exclusions(term, cfg)
        try:
            pmids = search(term, reldate, cfg.journal_max_results)
            articles = fetch_records(pmids, sleep) if pmids else []
            for art in articles:
                art["journal"] = journal["name"]
                art["source"] = "toc"
            print(f"  {journal['name']} -> {len(articles)} articles", file=sys.stderr)
        except Exception as e:
            print(f"  {journal['name']} -> ERROR: {e}", file=sys.stderr)
            articles = []
            errors += 1

        results.append({
            "name": journal["name"],
            "abbreviation": journal["abbreviation"],
            "articleCount": len(articles),
            "articles": articles,
        })
        time.sleep(sleep)

    return results, errors
