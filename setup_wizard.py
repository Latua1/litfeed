#!/usr/bin/env python3
"""
Write config.yaml by answering questions. Takes about two minutes.

Everything it asks has a default, so pressing Enter through the whole thing
produces a working (if generic) configuration. Nothing here is permanent —
config.yaml is a plain text file you will edit many times as you learn what
your query actually returns.

Usage:
    python setup_wizard.py
    python setup_wizard.py --output myconfig.yaml
    python setup_wizard.py --force          # overwrite an existing config.yaml
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("PyYAML is not installed. Run:  pip install -r requirements.txt", file=sys.stderr)
    sys.exit(1)

HERE = Path(__file__).resolve().parent
DEFAULT_OUTPUT = HERE / "config.yaml"

RESERVED_HOTKEYS = set("jkdpxnu")


def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    try:
        answer = input(f"{prompt}{suffix}: ").strip()
    except EOFError:
        answer = ""
    return answer or default


def ask_list(prompt: str, default: list[str] | None = None) -> list[str]:
    """Comma-separated list. Empty input keeps the default."""
    default = default or []
    shown = ", ".join(default)
    answer = ask(f"{prompt}\n  (comma-separated)", shown)
    return [t.strip() for t in answer.split(",") if t.strip()]


def ask_yes(prompt: str, default: bool = True) -> bool:
    answer = ask(f"{prompt} (y/n)", "y" if default else "n").lower()
    return answer.startswith("y")


def section(title: str) -> None:
    print(f"\n\033[1m{title}\033[0m")
    print("-" * len(title))


def main() -> int:
    parser = argparse.ArgumentParser(description="Create config.yaml interactively")
    parser.add_argument("--output", help="Where to write (default: config.yaml)")
    parser.add_argument("--force", action="store_true", help="Overwrite an existing file")
    args = parser.parse_args()

    out_path = Path(args.output) if args.output else DEFAULT_OUTPUT
    if out_path.exists() and not args.force:
        print(f"{out_path} already exists. Re-run with --force to overwrite it.", file=sys.stderr)
        return 1

    print("\nlitfeed setup")
    print("=============")
    print("Enter accepts the default shown in brackets.\n")

    # -- project ------------------------------------------------------------
    section("1. Project")
    name = ask("What are you monitoring? (short name)", "My literature feed")
    description = ask("One-line description", "")
    email = ask("Your email (required by NCBI, Unpaywall and OpenAlex)")
    while "@" not in email:
        print("  NCBI requires a real contact address — they use it before rate-limiting you.")
        email = ask("Your email")

    # -- search -------------------------------------------------------------
    section("2. Search")
    print("litfeed builds:  (topic AND context) OR precise-phrases  NOT excluded-titles")
    print("Topic terms are what you study. Context terms narrow it to your setting,")
    print("population or method. See guide/search-method.md for why both matter.\n")

    topic = ask_list("Topic terms", ["asthma", "wheeze"])
    context = ask_list("Context terms (ANDed against the topic)", ["athlete", "exercise"])
    precise = ask_list(
        "Precise phrases — specific enough to retrieve on their own, ORed in\n"
        "  (leave empty for now; add them once you see what the query misses)",
        [],
    )
    exclude = ask_list(
        "Title terms to exclude — subjects you never cover\n"
        "  (start empty; add them from what you actually find yourself skipping)",
        [],
    )
    lookback = ask("Lookback window in days", "365")

    # -- researchers --------------------------------------------------------
    section("3. Tracked researchers (optional)")
    print("Follow specific people regardless of topic. You can add more later.")
    researchers = []
    while ask_yes("Add a researcher?" if not researchers else "Add another?", default=False):
        r_name = ask("  Full name")
        if not r_name:
            break
        surname = ask("  Surname (for the namesake check)", r_name.split()[-1])
        initials = ask("  Initials, e.g. JW (for the namesake check)", "")
        orcid = ask("  ORCID (optional, disambiguates namesakes)", "")
        default_query = f"{surname} {initials}[Author]" if initials else f"{surname}[Author]"
        query = ask("  PubMed query", default_query)
        researchers.append({
            "name": r_name, "surname": surname, "initials": initials,
            "orcid": orcid, "pubmed_query": query,
        })

    # -- journals -----------------------------------------------------------
    section("4. Journals (optional)")
    print("Recent tables of contents, to catch papers your keywords miss.")
    print("Use the NLM abbreviation, e.g.  Thorax  or  Br J Sports Med\n")
    journals = []
    for abbrev in ask_list("Journal abbreviations", []):
        journals.append({
            "name": abbrev,
            "abbreviation": abbrev,
            "query": f'"{abbrev}"[ta]',
        })

    # -- tags ---------------------------------------------------------------
    section("5. Triage tags")
    print("What you sort papers into. The first nine get number-key shortcuts.")
    tag_names = ask_list("Tags", ["read-later", "methods", "key-paper", "teaching"])
    tags: list[dict] = []
    for tag in tag_names:
        # A one-letter shortcut is only offered past the number row, where it is
        # the difference between a keyboard tag and a click-only one.
        entry: dict = {"name": tag}
        if len(tags) >= 9:
            candidate = tag[:1].lower()
            if candidate.isalpha() and candidate not in RESERVED_HOTKEYS:
                entry["hotkey"] = candidate
        tags.append(entry)

    # -- sync ---------------------------------------------------------------
    section("6. Sync (optional)")
    print("Triage decisions are pushed to triage.json in a GitHub repo, which is")
    print("also how the app works across devices. Leave blank to decide later —")
    print("you can set it in the app's Settings pane instead.\n")
    gh_owner = ask("GitHub username or org", "")
    gh_repo = ask("Repository name", "")

    # -- library ------------------------------------------------------------
    section("7. Full-text library (optional)")
    pdf_dir = ask("Folder to save downloaded PDFs into", "")
    manifest = ask("JSON manifest of PDFs you already hold", "")

    config = {
        "project": {"name": name, "description": description, "email": email},
        "search": {
            "lookback_days": int(lookback) if lookback.isdigit() else 365,
            "field": "tiab",
            "topic_terms": topic,
            "context_terms": context,
            "precise_phrases": precise,
            "exclude_title_terms": exclude,
        },
        "watchlists": [],
        "researchers": researchers,
        "researcher_options": {"max_results": 100, "verify_via_openalex": True},
        "journals": journals,
        "journal_options": {"lookback_days": 30, "max_results": 100, "apply_exclusions": True},
        "scoring": {
            # Seeded from the search terms so the first feed is ranked rather
            # than alphabetical. Tune these against your own keeps and skips —
            # see guide/search-method.md.
            "keywords": {
                **{t: 10 for t in topic},
                **{t: 5 for t in context},
                **{p: 12 for p in precise},
            },
            "bonuses": {
                "has_abstract": 5,
                "abstract_min_chars": 200,
                "title_terms": ["review", "meta-analysis", "consensus", "guideline"],
                "title_term_points": 8,
            },
            "max_count_per_keyword": 3,
        },
        "tags": tags,
        "queue_options": [],
        "github": {"owner": gh_owner, "repo": gh_repo, "path": "triage.json", "branch": ""},
        "library": {
            "pdf_dir": pdf_dir,
            "manifest": manifest,
            "unobtainable_file": "",
            "filename_template": "{author} {year} {title}.pdf",
        },
        "knowledge_file": "knowledge.md",
    }

    with open(out_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(config, f, sort_keys=False, allow_unicode=True, default_flow_style=False)

    print(f"\nWrote {out_path}\n")
    print("Next:")
    print("  python generate_feed.py          # build the feed (a few minutes)")
    print("  python -m http.server -d docs    # then open http://localhost:8000")
    print("\nThe first query is a first draft. Look at what comes back, then edit")
    print("config.yaml — that iteration is the actual work. guide/search-method.md")
    print("covers how to do it without breaking your own recall.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
