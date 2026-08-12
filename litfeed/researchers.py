"""
Follow named researchers, and check that the papers really are theirs.

A PubMed author query matches surname plus initials, so `Smith J[Author]` also
returns JL, JD and JW. In a monitoring feed that noise is corrosive: you learn
to distrust the researcher tag, and then it is worth nothing.

OpenAlex knows which ORCID is on a paper, so it can separate them. The catch is
that OpenAlex's own ORCID coverage is patchy, so "not confirmed" is far too
common to act on alone. litfeed therefore flags a paper as *probably someone
else* only when BOTH hold:

  1. OpenAlex does not list the tracked ORCID on it, AND
  2. every same-surname author on the paper has initials incompatible with the
     tracked researcher's.

Anything else is left as "unchecked" (None), which is a different claim from
"wrong person" and must not render the same way. Three states, deliberately:
True / False / None.

Why ORCID is identity metadata rather than a search key: PubMed only carries an
ORCID when the publisher passed one through, and coverage is thin enough that
searching `<orcid>[auid]` instead of the name loses most of a person's output.
Search by name; disambiguate by ORCID.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request

from .pubmed import fetch_records, search

OPENALEX_API = "https://api.openalex.org/works"
OPENALEX_BATCH = 50  # OpenAlex caps OR filters at 50 values


def fetch_researcher_articles(cfg, reldate: int, sleep: float) -> list[dict]:
    """Recent articles for every researcher in config.yaml."""
    all_articles = []
    for researcher in cfg.researchers:
        name = researcher["name"]
        print(f"  Researcher: {name}...", file=sys.stderr)
        try:
            pmids = search(researcher["pubmed_query"], reldate, cfg.researcher_max_results)
        except Exception as e:
            print(f"    Search error: {e}", file=sys.stderr)
            continue

        if not pmids:
            print("    No articles found", file=sys.stderr)
            continue

        articles = fetch_records(pmids, sleep)
        for art in articles:
            art["source"] = "Tracked researcher"
            art["trackedResearcher"] = name
        all_articles.extend(articles)
        print(f"    Found {len(articles)} articles", file=sys.stderr)
        time.sleep(sleep)
    return all_articles


def _openalex_confirmed_pmids(orcid: str, pmids: list[str], email: str) -> set[str] | None:
    """Which of these PMIDs does OpenAlex list this ORCID as an author of?

    Returns None when the lookup could not be completed. That is deliberately
    distinct from an empty set: rendering "we could not check" as "not their
    paper" would brand every article a namesake during an OpenAlex outage.
    """
    confirmed: set[str] = set()
    for i in range(0, len(pmids), OPENALEX_BATCH):
        batch = pmids[i:i + OPENALEX_BATCH]
        ids = "|".join(f"https://pubmed.ncbi.nlm.nih.gov/{p}" for p in batch)
        params = urllib.parse.urlencode({
            "filter": f"ids.pmid:{ids},author.orcid:{orcid}",
            "per-page": 200,
            "select": "ids",
            "mailto": email,  # polite pool: higher, more predictable rate limit
        })
        try:
            req = urllib.request.Request(
                f"{OPENALEX_API}?{params}",
                headers={"User-Agent": f"litfeed ({email})"},
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.load(resp)
        except Exception as e:
            print(f"    OpenAlex lookup failed: {e}", file=sys.stderr)
            return None
        for work in data.get("results", []):
            pmid_url = (work.get("ids") or {}).get("pmid")
            if pmid_url:
                confirmed.add(pmid_url.rsplit("/", 1)[-1])
        time.sleep(0.2)
    return confirmed


def _initials_conflict(author_list: list[str], profile: dict) -> bool:
    """Does every same-surname author on this paper have the wrong initials?

    Initials count as compatible when one is a prefix of the other, so a paper
    indexing someone as the bare "Smith J" still matches a tracked "Smith JW".
    That abbreviation is common and must not read as a different person.
    """
    surname = (profile.get("surname") or "").lower()
    known = (profile.get("initials") or "").upper()
    if not surname or not known:
        return False

    found = []
    for entry in author_list:
        parts = entry.rsplit(" ", 1)
        if len(parts) == 2 and parts[0].lower() == surname:
            found.append(parts[1].upper())
    if not found:
        # The tracked name is not in the author list at all, which happens with
        # collective author records. Not evidence of a namesake.
        return False
    return not any(i.startswith(known[:len(i)]) or known.startswith(i) for i in found)


def verify_authorship(articles: list[dict], cfg) -> None:
    """Set article["researcherVerified"] to True / False / None, in place."""
    by_researcher: dict[str, list[dict]] = {}
    for art in articles:
        name = art.get("trackedResearcher")
        if name and art.get("pmid"):
            by_researcher.setdefault(name, []).append(art)
    if not by_researcher:
        return

    if not cfg.verify_researchers:
        for art in articles:
            art["researcherVerified"] = None
        return

    profiles = {r["name"]: r for r in cfg.researchers}
    print("Verifying researcher authorship via OpenAlex...", file=sys.stderr)

    for name, arts in by_researcher.items():
        profile = profiles.get(name, {})
        orcid = profile.get("orcid", "")
        if not orcid:
            for art in arts:
                art["researcherVerified"] = None
            print(f"  {name}: no ORCID on file, skipped", file=sys.stderr)
            continue

        confirmed = _openalex_confirmed_pmids(orcid, [a["pmid"] for a in arts], cfg.email)
        if confirmed is None:
            for art in arts:
                art["researcherVerified"] = None
            print(f"  {name}: lookup failed, left unverified", file=sys.stderr)
            continue

        flagged = 0
        for art in arts:
            if art["pmid"] in confirmed:
                art["researcherVerified"] = True
            elif _initials_conflict(art.get("authorList") or [], profile):
                art["researcherVerified"] = False
                flagged += 1
            else:
                art["researcherVerified"] = None
        print(
            f"  {name}: {len(arts)} articles, {len(confirmed)} confirmed, "
            f"{flagged} likely namesake",
            file=sys.stderr,
        )
