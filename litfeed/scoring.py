"""
Relevance scoring — a transparent keyword heuristic, not a model.

Every point an article scores can be traced to a term you put in config.yaml,
and the app shows that breakdown next to the abstract. That is the whole design
goal: a score you can argue with beats a better score you cannot inspect.

Tuning advice lives in guide/search-method.md. The one rule worth repeating
here: check a candidate weight against articles you have already kept and
skipped before you trust it. Terms that feel central to your field ("review",
"treatment") often fire more on the papers you skip than the ones you keep.
"""

from __future__ import annotations


def score_article(article: dict, keywords: dict[str, int], bonuses: dict, max_count: int = 3) -> int:
    """Score one article 0-100 from its title and abstract."""
    text = f"{article.get('title', '')} {article.get('abstract', '')}".lower()
    if not text.strip():
        return 0

    raw = 0
    for keyword, weight in keywords.items():
        # Capped per keyword so one term repeated through an abstract cannot
        # outweigh three different terms that each matched once.
        count = min(text.count(keyword.lower()), max_count)
        if count:
            raw += weight * count

    abstract = article.get("abstract", "") or ""
    if len(abstract) > bonuses.get("abstract_min_chars", 200):
        raw += bonuses.get("has_abstract", 0)

    title_lower = (article.get("title", "") or "").lower()
    if any(t.lower() in title_lower for t in bonuses.get("title_terms", [])):
        raw += bonuses.get("title_term_points", 0)

    return min(raw, 100)


def score_and_rank(articles: list[dict], keywords: dict[str, int], bonuses: dict,
                   max_count: int = 3) -> list[dict]:
    """Score every article, sort by score, and stamp a 1-based rank."""
    for art in articles:
        art["score"] = score_article(art, keywords, bonuses, max_count)

    # Title as the tie-break so the order is stable between runs; without it,
    # equal-scoring articles shuffle every week and the diff is unreadable.
    articles.sort(key=lambda a: (-a["score"], a.get("title", "")))
    for i, art in enumerate(articles):
        art["rank"] = i + 1
    return articles


def matches_keywords(article: dict, keywords: dict[str, int]) -> bool:
    """True if any scoring keyword appears — used to filter journal TOCs."""
    text = f"{article.get('title', '')} {article.get('abstract', '')}".lower()
    return any(kw.lower() in text for kw in keywords)
