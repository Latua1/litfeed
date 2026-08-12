"""
PubMed access: search, fetch, parse.

One place where Entrez is configured and where a PubmedArticle XML record is
flattened into the dict shape the rest of litfeed and the browser app use.
"""

from __future__ import annotations

import sys
import time

from Bio import Entrez

# NCBI asks for no more than 3 requests/second without an API key, 10 with one.
# We fetch in batches and sleep between them rather than tracking a rate.
BATCH_SIZE = 20
SLEEP_BETWEEN_BATCHES = 0.5
SLEEP_WITH_API_KEY = 0.15


def configure(cfg) -> float:
    """Point Entrez at the configured contact address. Returns the sleep interval."""
    Entrez.email = cfg.email
    key = cfg.ncbi_api_key
    if key:
        Entrez.api_key = key
        return SLEEP_WITH_API_KEY
    return SLEEP_BETWEEN_BATCHES


def search(term: str, reldate: int, retmax: int) -> list[str]:
    """PMIDs matching a query within the lookback window.

    datetype="edat" is the Entrez date — when PubMed first carried the record —
    rather than the publication date. It is the right choice for a monitoring
    feed: it answers "what is new to me", where the publication date answers
    "what was printed", and journals backfill old issues constantly.
    """
    handle = Entrez.esearch(
        db="pubmed",
        term=term,
        reldate=reldate,
        datetype="edat",
        retmax=retmax,
    )
    results = Entrez.read(handle)
    handle.close()
    return list(results.get("IdList", []))


def fetch_records(pmids: list[str], sleep: float = SLEEP_BETWEEN_BATCHES) -> list[dict]:
    """Full records for a list of PMIDs, parsed and flattened.

    A failed batch is reported and skipped rather than aborting the run: losing
    20 of 3000 articles to a transient NCBI error is a much better outcome than
    losing all of them.
    """
    articles = []
    for i in range(0, len(pmids), BATCH_SIZE):
        batch = pmids[i:i + BATCH_SIZE]
        try:
            handle = Entrez.efetch(db="pubmed", id=",".join(batch), rettype="xml")
            records = Entrez.read(handle)
            handle.close()
            for record in records.get("PubmedArticle", []):
                parsed = parse_article(record)
                if parsed:
                    articles.append(parsed)
            time.sleep(sleep)
        except Exception as e:
            print(f"    Error fetching batch {i}-{i + len(batch)}: {e}", file=sys.stderr)
    return articles


def parse_article(record: dict) -> dict | None:
    """Flatten one PubmedArticle XML record. Returns None if it has no title."""
    medline = record.get("MedlineCitation", {})
    pmid = str(medline.get("PMID", ""))
    art = medline.get("Article", {})

    title = str(art.get("ArticleTitle", ""))
    if not title:
        return None

    author_list = art.get("AuthorList", [])
    # The display string stops at three names; all_authors keeps the full list
    # for the namesake check in researchers.py, where three is not enough to
    # find a tracked author inside a large collaboration.
    all_authors = [
        f"{a.get('LastName', '')} {a.get('Initials', '')}".strip()
        for a in author_list
        if a.get("LastName")
    ]

    abstract_parts = art.get("Abstract", {}).get("AbstractText", [])
    abstract = " ".join(str(p) for p in abstract_parts)

    journal_info = art.get("Journal", {})
    journal = str(journal_info.get("Title", ""))
    journal_issue = journal_info.get("JournalIssue", {})
    pub_date = journal_issue.get("PubDate", {})
    year = str(pub_date.get("Year", ""))
    if not year:
        medline_date = str(pub_date.get("MedlineDate", ""))
        year = medline_date[:4] if medline_date else ""

    doi = ""
    for eid in record.get("PubmedData", {}).get("ArticleIdList", []):
        if eid.attributes.get("IdType") == "doi":
            doi = str(eid)
            break
    if not doi:
        for eid in art.get("ELocationID", []):
            if eid.attributes.get("EIdType") == "doi":
                doi = str(eid)
                break

    return {
        "id": pmid,
        "pmid": pmid,
        "title": title,
        "authors": format_authors(author_list),
        "authorList": all_authors,
        "journal": journal,
        "year": year,
        "volume": str(journal_issue.get("Volume", "")),
        "issue": str(journal_issue.get("Issue", "")),
        "doi": doi,
        "abstract": abstract,
        "link": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
    }


def format_authors(author_list: list, max_authors: int = 3) -> str:
    """'Smith AB, Jones CD, Lee EF et al.'"""
    if not author_list:
        return "Unknown"
    names = []
    for a in author_list[:max_authors]:
        name = f"{a.get('LastName', '')} {a.get('Initials', '')}".strip()
        if name:
            names.append(name)
    if not names:
        return "Unknown"
    result = ", ".join(names)
    if len(author_list) > max_authors:
        result += " et al."
    return result


def deduplicate(articles: list[dict]) -> list[dict]:
    """Merge duplicates by PMID, keeping researcher attribution wherever it appears.

    The same paper legitimately arrives from several sources. Whichever copy is
    seen first wins the metadata, but a researcher tag on a later copy is merged
    in — otherwise following a person silently stops working for any paper the
    keyword query happened to find first.
    """
    seen: dict[str, dict] = {}
    for art in articles:
        pmid = art.get("pmid", "")
        if not pmid:
            continue
        if pmid in seen:
            existing = seen[pmid]
            if art.get("trackedResearcher") and not existing.get("trackedResearcher"):
                existing["trackedResearcher"] = art["trackedResearcher"]
                existing["source"] = f"{existing.get('source', '')} + Tracked researcher".strip(" +")
                # Verification belongs to the attribution, so it has to travel
                # with it or the merged article looks unchecked.
                existing["researcherVerified"] = art.get("researcherVerified")
        else:
            seen[pmid] = art
    return list(seen.values())
