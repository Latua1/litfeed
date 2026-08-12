#!/usr/bin/env python3
"""
Download full text for the articles you kept.

Sources, in order:
  1. Unpaywall     — open-access copies, publisher and repository
  2. PubMed Central — free full text via the NCBI OA service
  3. DOI resolution — OPT-IN, off by default (see below)

Anything it cannot get is written to docs/todos.json as a manual to-do list.

About --resolve-doi
-------------------
This follows the DOI to the publisher and looks for a PDF link. On an open
network it mostly returns the same open-access copies as step 1. On a network
with an institutional subscription it returns subscribed content, because your
institution is granting the access — the same access you have in a browser.

It is off by default so that nobody enables it without meaning to. Turn it on
only where you personally hold that access, and respect the publisher terms
that come with it. It is not a paywall bypass and will not behave as one.

Usage:
    python fetch_pdfs.py                 # tagged articles, open access only
    python fetch_pdfs.py --all           # every committed article, tagged or not
    python fetch_pdfs.py --dry-run       # list what it would fetch
    python fetch_pdfs.py --resolve-doi   # also try publisher sites (see above)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import requests

from litfeed.config import ConfigError, load_config
from litfeed.triage import committed_articles, load_triage

HERE = Path(__file__).resolve().parent
LOCAL_TRIAGE = HERE / "docs" / "triage.json"
TODOS_PATH = HERE / "docs" / "todos.json"

MIN_PDF_BYTES = 10_000  # anything smaller is an error page, not a paper


def sanitize_filename(text: str, max_len: int = 120) -> str:
    text = re.sub(r'[<>:"/\\|?*]', "", text or "")
    text = re.sub(r"\s+", " ", text).strip().rstrip(".")
    if len(text) > max_len:
        text = text[:max_len].rsplit(" ", 1)[0]
    return text


def make_filename(article: dict, template: str) -> str:
    """Render the configured filename template for one article."""
    authors = article.get("authors", "Unknown") or "Unknown"
    multiple = "," in authors or "et al" in authors.lower()
    # Strip any "et al." the stored string already carries before appending our
    # own, or a single-author-plus-et-al string renders as "Smith A et al. et al."
    first_author = re.sub(r"\s*et\s+al\.?\s*$", "", authors.split(",")[0].strip(), flags=re.IGNORECASE)
    author_part = f"{first_author} et al." if multiple else first_author

    name = template.format(
        author=author_part,
        year=article.get("year", "") or "",
        title=sanitize_filename(article.get("title", "Untitled")),
        pmid=article.get("pmid", ""),
        doi=(article.get("doi", "") or "").replace("/", "_"),
    )
    name = sanitize_filename(name, max_len=200)
    return name if name.lower().endswith(".pdf") else name + ".pdf"


def norm_doi(doi: str) -> str:
    d = (doi or "").strip().lower()
    d = re.sub(r"^https?://(dx\.)?doi\.org/", "", d)
    return re.sub(r"^doi:\s*", "", d)


def norm_text(text: str) -> str:
    # PubMed and CrossRef leave <sub>/<i> markup in titles.
    text = re.sub(r"<[^>]+>", "", text or "")
    text = re.sub(r"[^a-z0-9]+", " ", text.lower())
    return re.sub(r"\s+", " ", text).strip()


class LocalLibrary:
    """Whatever you already hold, so nothing is downloaded twice.

    Three passes, because each alone has a blind spot:
      1. exact filename — misses the same paper stored under another name
      2. DOI via the manifest — misses entries whose DOI was never recorded
      3. title against filename — catches the rest
    Getting this wrong is not harmless: it reports papers you own as missing and
    sends you off to re-download them.
    """

    def __init__(self, pdf_dir: Path | None, manifest: Path | None):
        self.pdf_dir = pdf_dir
        self.manifest = manifest
        self._doi_index: dict | None = None
        self._names: dict | None = None

    def doi_index(self) -> dict:
        if self._doi_index is None:
            self._doi_index = {}
            if self.manifest and self.manifest.exists():
                try:
                    data = json.loads(self.manifest.read_text(encoding="utf-8"))
                    entries = data.values() if isinstance(data, dict) else data
                    for entry in entries:
                        doi = norm_doi(entry.get("doi", ""))
                        if doi:
                            self._doi_index.setdefault(doi, entry.get("filename"))
                except Exception as e:
                    print(f"  (could not read {self.manifest}: {e})", file=sys.stderr)
        return self._doi_index

    def already_have(self, article: dict, filename: str) -> str | None:
        if not self.pdf_dir or not self.pdf_dir.exists():
            return None
        if (self.pdf_dir / filename).exists():
            return filename

        doi = norm_doi(article.get("doi", ""))
        if doi:
            hit = self.doi_index().get(doi)
            if hit and (self.pdf_dir / hit).exists():
                return hit

        title = norm_text(article.get("title", ""))[:55]
        if len(title) > 20:
            if self._names is None:
                self._names = {p.name: norm_text(p.name) for p in self.pdf_dir.glob("*.pdf")}
            for name, normalized in self._names.items():
                if title in normalized:
                    return name
        return None


def try_unpaywall(doi: str, email: str) -> list[str]:
    """Candidate open-access PDF URLs for a DOI, best first."""
    if not doi:
        return []
    try:
        resp = requests.get(
            f"https://api.unpaywall.org/v2/{doi}", params={"email": email}, timeout=15
        )
        if resp.status_code != 200:
            return []
        data = resp.json()
    except Exception as e:
        print(f"    Unpaywall error: {e}", file=sys.stderr)
        return []

    urls: list[str] = []
    for loc in data.get("oa_locations", []) or []:
        pdf_url = loc.get("url_for_pdf")
        if pdf_url:
            urls.append(pdf_url)

        # PMC locations expose an article URL, not a PDF one; the /pdf/ suffix
        # is the direct file.
        for candidate in (loc.get("pmh_id", "") or "", loc.get("url", "") or ""):
            match = re.search(r"(?:pmc/articles/|pubmedcentral[^0-9]*)(?:PMC)?(\d+)", candidate)
            if match:
                urls.append(f"https://www.ncbi.nlm.nih.gov/pmc/articles/PMC{match.group(1)}/pdf/")

        landing = loc.get("url_for_landing_page")
        if landing and landing not in urls:
            urls.append(landing)

    best = (data.get("best_oa_location") or {}).get("url_for_pdf")
    if best and best in urls:
        urls.remove(best)
        urls.insert(0, best)
    return urls


def try_pmc(pmid: str, email: str) -> str | None:
    """PubMed Central PDF for a PMID via the NCBI OA service.

    Plain HTTP with an explicit timeout rather than Bio.Entrez: Entrez.read()
    downloads DTD files on first parse with no timeout, and will hang a run
    indefinitely if NCBI stalls.
    """
    if not pmid:
        return None
    try:
        resp = requests.get(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi",
            params={"dbfrom": "pubmed", "db": "pmc", "id": pmid,
                    "retmode": "json", "email": email},
            timeout=15,
        )
        if resp.status_code != 200:
            return None

        pmc_id = None
        for linkset in resp.json().get("linksets", []):
            for db in linkset.get("linksetdbs", []) or []:
                if db.get("dbto") == "pmc" and db.get("links"):
                    pmc_id = str(db["links"][0])
                    break
        if not pmc_id:
            return None

        oa = requests.get(
            "https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi",
            params={"id": f"PMC{pmc_id}"}, timeout=15,
        )
        if oa.status_code == 200:
            import xml.etree.ElementTree as ET
            root = ET.fromstring(oa.text)
            for link in root.iter("link"):
                if link.get("format") == "pdf":
                    href = link.get("href", "")
                    if href.startswith("ftp://ftp.ncbi.nlm.nih.gov/"):
                        href = href.replace("ftp://ftp.ncbi.nlm.nih.gov/",
                                            "https://ftp.ncbi.nlm.nih.gov/")
                    return href or None
    except Exception as e:
        print(f"    PMC error: {e}", file=sys.stderr)
    return None


def try_doi_resolution(doi: str, headers: dict) -> str | None:
    """Follow the DOI and look for the publisher's PDF link. Opt-in — see module docstring."""
    if not doi:
        return None
    try:
        resp = requests.get(f"https://doi.org/{doi}", headers=headers, timeout=20,
                            allow_redirects=True)
        if resp.status_code != 200:
            return None
        final_url = resp.url
        if "application/pdf" in resp.headers.get("Content-Type", ""):
            return final_url

        host = urlparse(final_url).netloc
        # Per-publisher URL shapes. These are the documented public patterns,
        # not a way around access control: without entitlement they return the
        # same landing page.
        if "sciencedirect.com" in host:
            pii = re.search(r"/pii/(S\d+)", final_url)
            if pii:
                return f"https://www.sciencedirect.com/science/article/pii/{pii.group(1)}/pdfft"
        if "wiley.com" in host:
            for old, new in (("/abs/", "/pdfdirect/"), ("/full/", "/pdfdirect/")):
                if old in final_url:
                    return final_url.replace(old, new)
        if "springer.com" in host or "nature.com" in host:
            if "/article/" in final_url:
                return final_url.rstrip("/") + ".pdf"
        if "tandfonline.com" in host:
            swapped = re.sub(r"/doi/(abs|full)/", "/doi/pdf/", final_url)
            if swapped != final_url:
                return swapped
        if "bmj.com" in host:
            return final_url.rstrip("/") + ".full.pdf"
        if "mdpi.com" in host:
            return final_url.replace("/htm", "/pdf")
    except Exception as e:
        print(f"    DOI resolution error: {e}", file=sys.stderr)
    return None


def download(url: str, target: Path, headers: dict) -> bool:
    """Fetch a URL to disk, only if it really is a PDF."""
    try:
        resp = requests.get(url, headers=headers, timeout=45, allow_redirects=True, stream=True)
        if resp.status_code != 200:
            return False

        first = next(resp.iter_content(chunk_size=1024), b"")
        # Publishers return a login page with HTTP 200 constantly, so the magic
        # bytes are the only trustworthy signal.
        if not first.startswith(b"%PDF") and "pdf" not in resp.headers.get("Content-Type", "").lower():
            return False

        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "wb") as f:
            f.write(first)
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)

        if target.stat().st_size < MIN_PDF_BYTES:
            target.unlink()
            return False
        return True
    except Exception as e:
        print(f"    Download error: {e}", file=sys.stderr)
        if target.exists():
            target.unlink()
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Download full text for kept articles")
    parser.add_argument("--config", help="Path to config.yaml")
    parser.add_argument("--all", action="store_true", help="Include committed articles with no tags")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be downloaded")
    parser.add_argument("--resolve-doi", action="store_true",
                        help="Also follow DOIs to publisher sites (see the module docstring)")
    parser.add_argument("--local-triage", action="store_true",
                        help="Read docs/triage.json instead of the GitHub copy")
    args = parser.parse_args()

    try:
        cfg = load_config(args.config)
    except ConfigError as e:
        print(f"\n{e}\n", file=sys.stderr)
        return 1

    lib_cfg = cfg.library
    pdf_dir = Path(lib_cfg["pdf_dir"]) if lib_cfg["pdf_dir"] else None
    if not pdf_dir:
        print("library.pdf_dir is not set in config.yaml — nowhere to save files.", file=sys.stderr)
        return 1
    manifest = Path(lib_cfg["manifest"]) if lib_cfg["manifest"] else None

    triage = load_triage(cfg, LOCAL_TRIAGE, prefer_remote=not args.local_triage)
    to_fetch = committed_articles(triage, tagged_only=not args.all)

    print("\n=== Full text download ===", file=sys.stderr)
    print(f"Committed: {len(triage.get('committed') or {})}", file=sys.stderr)
    print(f"To fetch:  {len(to_fetch)}", file=sys.stderr)
    print(f"Target:    {pdf_dir}", file=sys.stderr)
    print(f"Sources:   Unpaywall, PMC{', DOI resolution' if args.resolve_doi else ''}\n",
          file=sys.stderr)

    if not to_fetch:
        return 0

    headers = {
        "User-Agent": f"litfeed/1.0 (mailto:{cfg.email})",
        "Accept": "application/pdf,*/*",
    }
    library = LocalLibrary(pdf_dir, manifest)
    downloaded, failed, skipped = [], [], []

    for i, art in enumerate(to_fetch, 1):
        filename = make_filename(art, lib_cfg["filename_template"])
        target = pdf_dir / filename
        print(f"[{i}/{len(to_fetch)}] {(art.get('title') or 'Unknown')[:80]}...", file=sys.stderr)

        have = library.already_have(art, filename)
        if have:
            note = "" if have == filename else "  (different filename, matched by DOI or title)"
            print(f"  Already have: {have}{note}", file=sys.stderr)
            skipped.append(art)
            continue

        if args.dry_run:
            print(f"  Would download: {filename}", file=sys.stderr)
            continue

        doi = art.get("doi", "")
        candidates = [(u, "Unpaywall") for u in try_unpaywall(doi, cfg.email)]

        pmc_url = try_pmc(art.get("pmid", ""), cfg.email)
        if pmc_url and pmc_url not in [u for u, _ in candidates]:
            candidates.append((pmc_url, "PMC"))

        if args.resolve_doi:
            doi_url = try_doi_resolution(doi, headers)
            if doi_url and doi_url not in [u for u, _ in candidates]:
                candidates.append((doi_url, "DOI"))

        got = False
        for url, source in candidates:
            print(f"  Trying {source}: {url[:80]}...", file=sys.stderr)
            if download(url, target, headers):
                print(f"  OK ({target.stat().st_size // 1024} KB) -> {filename}", file=sys.stderr)
                downloaded.append({**art, "filename": filename, "source": source})
                got = True
                break

        if not got:
            if not candidates:
                print("  No source found", file=sys.stderr)
            failed.append(art)
        time.sleep(0.5)

    print("\n=== Summary ===", file=sys.stderr)
    print(f"Downloaded:  {len(downloaded)}", file=sys.stderr)
    print(f"Already had: {len(skipped)}", file=sys.stderr)
    print(f"Failed:      {len(failed)}", file=sys.stderr)

    if failed and not args.dry_run:
        todos = [{
            "title": a.get("title", "Unknown"),
            "description": f"Tags: {', '.join(a.get('tags') or [])}. Fetch manually.",
            "pmid": a.get("pmid", ""),
            "doi": a.get("doi", ""),
            "link": (f"https://doi.org/{a['doi']}" if a.get("doi")
                     else f"https://pubmed.ncbi.nlm.nih.gov/{a.get('pmid', '')}/"),
            "action": "Get full text",
            "done": False,
        } for a in failed]
        TODOS_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(TODOS_PATH, "w", encoding="utf-8") as f:
            json.dump({"generated": datetime.now().isoformat(), "todos": todos},
                      f, indent=2, ensure_ascii=False)
        print(f"\nWrote {len(todos)} manual to-dos to {TODOS_PATH}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
