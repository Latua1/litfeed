"""
Assemble a PubMed query from config.yaml, and filter records against it.

The shape litfeed builds is:

    ( (topic terms) AND (context terms) )  OR  (precise phrases)
    NOT (excluded title terms)

Why that shape, and why the OR field exists at all, is explained in
guide/search-method.md. The short version: an AND of two broad fields is
precise but blind to papers that never use your context vocabulary, and a
third field of phrases specific enough to stand alone recovers them without
dragging the noise a broader first field would.

Set search.raw_query in config.yaml to bypass all of this and use your own
PubMed string verbatim; exclusions are still applied unless you disable them.
"""

from __future__ import annotations

import re


def _tag(term: str, field: str) -> str:
    """Render one term with its PubMed field tag.

    Quoted for multi-word phrases, bare when it ends in a wildcard — PubMed does
    not expand a `*` inside quotes, so `"airway symptom*"[tiab]` silently
    matches nothing while `airway symptom*[tiab]` is a syntax error waiting to
    happen. Single words with a trailing `*` are the only safe wildcard form.
    """
    term = term.strip()
    if not term:
        return ""
    if term.endswith("*") and " " not in term:
        return f"{term}[{field}]"
    return f'"{term}"[{field}]'


def _or_field(terms: list[str], field: str) -> str:
    parts = [t for t in (_tag(x, field) for x in terms) if t]
    return " OR ".join(parts)


def exclusion_clause(terms: list[str]) -> str:
    """Excluded terms as a title-only OR clause.

    Title-only is deliberate and matters: the same terms matched in abstracts
    cost far more true positives, because papers routinely name adjacent topics
    in their background and exclusion criteria without being about them.
    """
    return _or_field(terms, "ti")


def exclusion_regex(terms: list[str]) -> re.Pattern | None:
    """The same terms as a word-boundary regex, for records already fetched.

    Needed because watchlists and journal TOCs are retrieved with their own
    queries; filtering their results in Python keeps one definition of
    "off-topic" instead of two that drift apart.
    """
    parts = []
    for term in terms:
        term = term.strip()
        if not term:
            continue
        if term.endswith("*"):
            parts.append(r"\b" + re.escape(term[:-1]) + r"\w*")
        else:
            parts.append(r"\b" + re.escape(term) + r"\b")
    if not parts:
        return None
    return re.compile("|".join(parts), re.IGNORECASE)


def build_query(cfg) -> str:
    """The main search string, before exclusions."""
    if cfg.raw_query:
        return cfg.raw_query

    field = cfg.search_field
    blocks = []

    topic = _or_field(cfg.topic_terms, field)
    context = _or_field(cfg.context_terms, field)
    if topic and context:
        blocks.append(f"(({topic}) AND ({context}))")
    elif topic:
        blocks.append(f"({topic})")

    precise = _or_field(cfg.precise_phrases, field)
    if precise:
        blocks.append(f"({precise})")

    if not blocks:
        raise ValueError("No search terms configured — see search: in config.yaml")
    return " OR ".join(blocks)


def apply_exclusions(term: str, cfg) -> str:
    """Wrap any query with the configured NOT clause."""
    clause = exclusion_clause(cfg.exclude_title_terms)
    if not clause:
        return term
    return f"({term}) NOT ({clause})"


def is_excluded(article: dict, pattern: re.Pattern | None) -> bool:
    """True if this article's title matches an excluded term."""
    if pattern is None:
        return False
    return bool(pattern.search(article.get("title", "") or ""))
