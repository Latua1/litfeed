"""
Load and validate config.yaml — the single file that turns litfeed into *your*
literature monitor.

Everything the tool does is driven from here: the PubMed query, the exclusion
list, the scoring weights, the people and journals watched, the triage tags, and
where triage decisions are synced. No search terms are hardcoded anywhere else.

Usage:
    from litfeed.config import load_config
    cfg = load_config()          # finds config.yaml next to the repo root
    cfg = load_config("other.yaml")
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - guidance is more useful than a traceback
    print(
        "PyYAML is not installed. Run:  pip install -r requirements.txt",
        file=sys.stderr,
    )
    raise

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = REPO_ROOT / "config.yaml"
EXAMPLE_CONFIG_PATH = REPO_ROOT / "config.example.yaml"

# Written by the wizard and read by both Python and the browser app. Keys the
# PWA needs are mirrored into docs/config.json by generate_feed.py.
DOCS_DIR = REPO_ROOT / "docs"

# Keys the triage app binds itself. A tag may not claim one of these, or the
# shortcut silently stops navigating and starts tagging.
RESERVED_HOTKEYS = set("jkdpxnu")


class ConfigError(Exception):
    """Raised when config.yaml is missing something the tool cannot invent."""


class Config:
    """A parsed config.yaml with typed accessors and sensible fallbacks.

    Attributes are read lazily through properties rather than copied into
    __init__, so a key added to config.yaml is visible without touching this
    class in more than one place.
    """

    def __init__(self, data: dict, path: Path):
        self.data = data or {}
        self.path = path

    # -- project ------------------------------------------------------------

    @property
    def project_name(self) -> str:
        return self.data.get("project", {}).get("name", "litfeed")

    @property
    def project_description(self) -> str:
        return self.data.get("project", {}).get("description", "")

    @property
    def email(self) -> str:
        """Contact address sent to NCBI, Unpaywall and OpenAlex.

        Not optional and not decorative: NCBI's E-utilities policy requires it,
        and Unpaywall rejects requests without one. All three use it to reach
        you before they rate-limit you.
        """
        email = self.data.get("project", {}).get("email", "").strip()
        if not email or "@" not in email:
            raise ConfigError(
                f"project.email must be a real email address (found {email!r} in {self.path}).\n"
                "NCBI, Unpaywall and OpenAlex all require a contact address."
            )
        return email

    @property
    def ncbi_api_key(self) -> str:
        """Optional. Raises NCBI's rate limit from 3 to 10 requests/second.

        Read from the environment, never from config.yaml — a key in a file that
        gets committed is a key that gets published.
        """
        return os.environ.get("NCBI_API_KEY", "")

    # -- search -------------------------------------------------------------

    @property
    def lookback_days(self) -> int:
        return int(self.data.get("search", {}).get("lookback_days", 365))

    @property
    def raw_query(self) -> str:
        """Escape hatch: a complete PubMed query string, used verbatim.

        When set, the structured term lists below are ignored entirely. Intended
        for a query you built and tested in PubMed's own interface.
        """
        return (self.data.get("search", {}).get("raw_query") or "").strip()

    @property
    def topic_terms(self) -> list[str]:
        return list(self.data.get("search", {}).get("topic_terms") or [])

    @property
    def context_terms(self) -> list[str]:
        return list(self.data.get("search", {}).get("context_terms") or [])

    @property
    def precise_phrases(self) -> list[str]:
        return list(self.data.get("search", {}).get("precise_phrases") or [])

    @property
    def exclude_title_terms(self) -> list[str]:
        return list(self.data.get("search", {}).get("exclude_title_terms") or [])

    @property
    def search_field(self) -> str:
        """PubMed field tag applied to topic/context terms. [tiab] = title+abstract."""
        return self.data.get("search", {}).get("field", "tiab")

    @property
    def retmax(self) -> int:
        return int(self.data.get("search", {}).get("max_results", 9999))

    # -- watchlists ---------------------------------------------------------

    @property
    def watchlists(self) -> list[dict]:
        """Extra PubMed streams that follow a subject rather than the main topic.

        Each entry is {name, query, label?}. They are fetched separately, tagged
        with their label, and get their own filter chip in the app — useful when
        a population you care about is rarely described in your topic vocabulary,
        so the main query never retrieves it.
        """
        out = []
        for w in self.data.get("watchlists") or []:
            if not w.get("query"):
                continue
            out.append({
                "name": w.get("name", "Watchlist"),
                "query": w["query"],
                "label": w.get("label") or w.get("name", "Watchlist"),
                "max_results": int(w.get("max_results", 999)),
            })
        return out

    # -- researchers --------------------------------------------------------

    @property
    def researchers(self) -> list[dict]:
        out = []
        for r in self.data.get("researchers") or []:
            if not r.get("pubmed_query"):
                continue
            out.append({
                "name": r.get("name", r["pubmed_query"]),
                "surname": r.get("surname", ""),
                "initials": r.get("initials", ""),
                "affiliation": r.get("affiliation", ""),
                "focus": r.get("focus", ""),
                "pubmed_query": r["pubmed_query"],
                "orcid": r.get("orcid", ""),
            })
        return out

    @property
    def researcher_max_results(self) -> int:
        return int(self.data.get("researcher_options", {}).get("max_results", 100))

    @property
    def verify_researchers(self) -> bool:
        """Check authorship against OpenAlex to catch namesakes. See litfeed/researchers.py."""
        return bool(self.data.get("researcher_options", {}).get("verify_via_openalex", True))

    # -- journals -----------------------------------------------------------

    @property
    def journals(self) -> list[dict]:
        out = []
        for j in self.data.get("journals") or []:
            if not j.get("query"):
                continue
            out.append({
                "name": j.get("name", j["query"]),
                "abbreviation": j.get("abbreviation", ""),
                "query": j["query"],
            })
        return out

    @property
    def journal_lookback_days(self) -> int:
        return int(self.data.get("journal_options", {}).get("lookback_days", 30))

    @property
    def journal_max_results(self) -> int:
        return int(self.data.get("journal_options", {}).get("max_results", 100))

    @property
    def journal_apply_exclusions(self) -> bool:
        return bool(self.data.get("journal_options", {}).get("apply_exclusions", True))

    # -- scoring ------------------------------------------------------------

    @property
    def score_keywords(self) -> dict[str, int]:
        raw = self.data.get("scoring", {}).get("keywords") or {}
        return {str(k): int(v) for k, v in raw.items()}

    @property
    def score_bonuses(self) -> dict:
        b = self.data.get("scoring", {}).get("bonuses") or {}
        return {
            "has_abstract": int(b.get("has_abstract", 5)),
            "abstract_min_chars": int(b.get("abstract_min_chars", 200)),
            "title_terms": list(b.get("title_terms") or []),
            "title_term_points": int(b.get("title_term_points", 8)),
        }

    @property
    def score_max_count(self) -> int:
        """How many times one keyword may score, so a single term cannot dominate."""
        return int(self.data.get("scoring", {}).get("max_count_per_keyword", 3))

    # -- triage -------------------------------------------------------------

    @property
    def tags(self) -> list[dict]:
        """Triage tags, in display order.

        The first nine get number-key shortcuts automatically. Any tag may name a
        letter `hotkey`, and any tag may be marked `pipeline: true` to show that
        an external script consumes it.
        """
        out = []
        for t in self.data.get("tags") or []:
            if isinstance(t, str):
                out.append({"name": t, "hotkey": "", "pipeline": False})
            elif t.get("name"):
                out.append({
                    "name": t["name"],
                    "hotkey": (t.get("hotkey") or "").lower()[:1],
                    "pipeline": bool(t.get("pipeline")),
                })
        return out

    @property
    def queue_options(self) -> list[dict]:
        """Optional per-article dropdowns recorded in triage.json for downstream use.

        Each is {key, label, values: [{value, label}]}. They exist so a writing or
        analysis script downstream can read a decision you made during triage
        ("how deep", "which section") without a second pass over the papers.
        """
        out = []
        for opt in self.data.get("queue_options") or []:
            if not opt.get("key"):
                continue
            values = []
            for v in opt.get("values") or []:
                if isinstance(v, str):
                    values.append({"value": v, "label": v})
                else:
                    values.append({"value": v.get("value", ""), "label": v.get("label", v.get("value", ""))})
            out.append({
                "key": opt["key"],
                "label": opt.get("label", opt["key"]),
                "values": values,
            })
        return out

    # -- sync ---------------------------------------------------------------

    @property
    def github(self) -> dict:
        g = self.data.get("github") or {}
        return {
            "owner": g.get("owner", ""),
            "repo": g.get("repo", ""),
            "path": g.get("path", "triage.json"),
            "branch": g.get("branch", ""),
        }

    # -- library ------------------------------------------------------------

    @property
    def library(self) -> dict:
        lib = self.data.get("library") or {}
        return {
            "pdf_dir": os.path.expanduser(lib.get("pdf_dir", "")),
            "manifest": os.path.expanduser(lib.get("manifest", "")),
            "unobtainable_file": os.path.expanduser(lib.get("unobtainable_file", "")),
            "filename_template": lib.get("filename_template", "{author} {year} {title}.pdf"),
        }

    @property
    def knowledge_file(self) -> str:
        """Markdown file shown in the app's KB tab. Relative to docs/."""
        return self.data.get("knowledge_file", "knowledge.md")

    # -- derived ------------------------------------------------------------

    def validate(self) -> list[str]:
        """Return a list of human-readable problems. Empty list means good."""
        problems = []
        try:
            self.email
        except ConfigError as e:
            problems.append(str(e))

        if not self.raw_query and not self.topic_terms and not self.precise_phrases:
            problems.append(
                "No search defined. Set search.topic_terms (+ context_terms), "
                "or search.precise_phrases, or search.raw_query."
            )
        if self.topic_terms and not self.context_terms and not self.precise_phrases:
            problems.append(
                "search.topic_terms is set but context_terms is empty. A single loose "
                "field usually returns thousands of off-topic records — either add "
                "context_terms to AND against, or move the terms to precise_phrases."
            )
        if not self.tags:
            problems.append("No tags defined. Add at least one entry under `tags:`.")

        # PubMed does not expand a wildcard inside a quoted phrase, and every
        # multi-word term has to be quoted. So "airway symptom*" is not a broad
        # search — it is a search for a literal asterisk, and it returns nothing.
        # Silent zero recall is the worst failure this tool can have, so it is an
        # error rather than a warning.
        for field in ("topic_terms", "context_terms", "precise_phrases", "exclude_title_terms"):
            for term in self.data.get("search", {}).get(field) or []:
                term = str(term).strip()
                if term.endswith("*") and " " in term:
                    stem = term.rstrip("*").rsplit(" ", 1)
                    problems.append(
                        f"search.{field}: {term!r} is a multi-word term with a wildcard, which "
                        "PubMed cannot expand inside a quoted phrase — it would match nothing. "
                        f"Write out the variants instead, e.g. {stem[0] + ' ' + stem[1]!r} and "
                        f"{stem[0] + ' ' + stem[1] + 's'!r}."
                    )

        seen_hotkeys = {}
        for tag in self.tags:
            key = tag["hotkey"]
            if not key:
                continue
            if key in RESERVED_HOTKEYS:
                problems.append(
                    f"tag '{tag['name']}' claims hotkey '{key}', which is reserved "
                    "(j/k navigate; d skip, p priority, x exclude, n notes, u undo)."
                )
            if key in seen_hotkeys:
                problems.append(
                    f"tags '{seen_hotkeys[key]}' and '{tag['name']}' both claim hotkey '{key}'."
                )
            seen_hotkeys[key] = tag["name"]
        return problems

    def to_app_config(self) -> dict:
        """The subset the browser app needs, written to docs/config.json."""
        tags = []
        for i, tag in enumerate(self.tags):
            tags.append({
                "name": tag["name"],
                # First nine tags get the number row for free; a letter hotkey
                # overrides nothing, it just adds reach for tags past position 9.
                "numberKey": i + 1 if i < 9 else None,
                "hotkey": tag["hotkey"],
                "pipeline": tag["pipeline"],
            })
        return {
            "appName": self.project_name,
            "description": self.project_description,
            "github": self.github,
            "tags": tags,
            "queueOptions": self.queue_options,
            "scoreKeywords": self.score_keywords,
            "scoreBonuses": self.score_bonuses,
            "scoreMaxCount": self.score_max_count,
            "watchlists": [{"name": w["name"], "label": w["label"]} for w in self.watchlists],
            "knowledgeFile": self.knowledge_file,
        }


def load_config(path: str | Path | None = None) -> Config:
    """Read config.yaml, or explain exactly what to do if it isn't there."""
    cfg_path = Path(path) if path else DEFAULT_CONFIG_PATH
    if not cfg_path.exists():
        raise ConfigError(
            f"No config file at {cfg_path}.\n\n"
            "Create one either way:\n"
            "  python setup_wizard.py          # interactive, ~2 minutes\n"
            f"  cp {EXAMPLE_CONFIG_PATH.name} config.yaml   # then edit it\n"
        )
    with open(cfg_path, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    cfg = Config(data, cfg_path)

    problems = cfg.validate()
    if problems:
        raise ConfigError(
            f"{cfg_path} has {len(problems)} problem(s):\n  - "
            + "\n  - ".join(problems)
        )
    return cfg


def slugify(text: str) -> str:
    """Lowercase, hyphenated identifier — used for localStorage namespacing."""
    return re.sub(r"[^a-z0-9]+", "-", (text or "litfeed").lower()).strip("-") or "litfeed"
