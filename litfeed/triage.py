"""
Read triage.json — the record of what you decided about each article.

Shape (written by the browser app, read by the Python tools):

    {
      "syncedAt": "2026-08-12T09:00:00.000Z",
      "committed": {
        "12345678": {
          "tags": ["methods"], "priority": "normal", "exclude": false,
          "notes": "...", "options": {"depth": "deep"},
          "committedAt": "...", "title": "...", "authors": "...",
          "journal": "...", "year": "2026", "doi": "10.1000/x", "score": 62
        }
      },
      "skipped": ["12345679", ...]
    }

The app pushes this to GitHub, so the copy in your working directory goes stale
the moment you triage on another device. `load_triage` therefore prefers the
remote and says loudly when it falls back to local — silently reading a stale
file looks exactly like "you have not committed anything recently".
"""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from pathlib import Path


def load_triage(cfg, local_path: Path, prefer_remote: bool = True) -> dict:
    """Load triage.json, preferring the GitHub copy when one is configured."""
    gh = cfg.github
    if prefer_remote and gh["owner"] and gh["repo"]:
        repo = f"{gh['owner']}/{gh['repo']}"
        try:
            raw = subprocess.run(
                ["gh", "api", f"repos/{repo}/contents/{gh['path']}", "--jq", ".content"],
                capture_output=True, text=True, timeout=30, check=True,
            ).stdout
            triage = json.loads(base64.b64decode(raw))
            print(f"source: GitHub {repo} (synced {triage.get('syncedAt', '?')})", file=sys.stderr)
            return triage
        except FileNotFoundError:
            print("!! gh CLI not installed — falling back to the local file", file=sys.stderr)
        except Exception as e:
            print(f"!! could not reach GitHub ({type(e).__name__}) — falling back to local", file=sys.stderr)

    if not local_path.exists():
        print(
            f"No triage file at {local_path}. Open the app, triage some articles, "
            "then run this again.",
            file=sys.stderr,
        )
        return {"committed": {}, "skipped": []}

    with open(local_path, encoding="utf-8") as f:
        triage = json.load(f)
    print(
        f"!! LOCAL {local_path} synced {triage.get('syncedAt', '?')} — "
        "anything committed since then is MISSING.",
        file=sys.stderr,
    )
    return triage


def committed_articles(triage: dict, tagged_only: bool = True) -> list[dict]:
    """Committed entries as a flat list, each carrying its pmid."""
    out = []
    for pmid, art in (triage.get("committed") or {}).items():
        if tagged_only and not (art.get("tags") or []):
            continue
        out.append({"pmid": pmid, **art})
    return out
