# Getting started

## Install

```bash
git clone https://github.com/YOUR-USERNAME/litfeed.git
cd litfeed
pip install -r requirements.txt
```

Python 3.10 or newer. Three dependencies: `biopython` (PubMed), `PyYAML`
(config), `requests` (full-text download).

## Configure

Either way works:

```bash
python setup_wizard.py                 # ~10 questions, two minutes
cp config.example.yaml config.yaml     # or edit the commented template
```

The wizard gets you running. `config.example.yaml` is the better reference once
you know what you want — every option is documented in place.

Only two things are actually required:

- **`project.email`** — NCBI, Unpaywall and OpenAlex all require a contact
  address, and use it to reach you before they rate-limit you.
- **A search** — topic terms plus context terms, or precise phrases, or a raw
  PubMed query.

Everything else (researchers, journals, watchlists, sync, full text) is optional
and can be added later.

### An API key is worth two minutes

```bash
export NCBI_API_KEY=your_key_here      # https://account.ncbi.nlm.nih.gov/settings/
```

Raises NCBI's limit from 3 to 10 requests/second, which matters once your feed
is large. Read from the environment only — never put it in `config.yaml`, which
is a file you will commit.

## First run

```bash
python fetch_toc.py         # journal tables of contents (skip if you listed none)
python generate_feed.py     # the feed itself
```

`generate_feed.py` writes two files: `docs/feed.json` (the articles) and
`docs/config.json` (the settings the browser app needs, mirrored from
`config.yaml`). It regenerates the second one every time, so `config.yaml` stays
the only place you edit.

Useful flags:

```bash
python generate_feed.py --days 90      # a shorter window while you tune
python generate_feed.py --dry-run      # report counts, write nothing
python generate_feed.py --config other.yaml
```

`--dry-run` with a short window is the fast loop for query tuning: it tells you
how many articles a change returns without rewriting anything.

## Open the app

```bash
python -m http.server -d docs
```

Then http://localhost:8000. Press `j` to open the first article.

A local server is required — `file://` will not work, because the browser blocks
`fetch` on local files.

To triage from a phone, or keep decisions across devices, publish it:
**[deploying.md](deploying.md)**.

## Then tune

Your first query will be wrong. That is expected and not a problem — it is the
input to the actual work, which is
**[search-method.md](search-method.md)**.

The short version: triage a hundred papers first, so you have real decisions to
measure against. Then add exclusions for what you keep skipping and precise
phrases for what you notice missing, testing each change against papers you
already kept.

---

## What each file does

**You edit:**

| File | |
|---|---|
| `config.yaml` | Everything about your subject. The only file you normally touch. |
| `docs/knowledge.md` | Your running notes, shown in the app's third tab on wide screens. |

**You run:**

| Script | |
|---|---|
| `setup_wizard.py` | Writes `config.yaml` from answers. |
| `generate_feed.py` | Builds `docs/feed.json` + `docs/config.json`. |
| `fetch_toc.py` | Builds `docs/toc.json`. Run before `generate_feed.py` — matching TOC articles get merged into the feed. |
| `fetch_pdfs.py` | Downloads open-access full text for articles you kept. |
| `build_library_index.py` | Builds `docs/library.json` so the app can badge papers you already hold. |

**Generated — commit these, do not edit them:**

`docs/feed.json`, `docs/config.json`, `docs/toc.json`, `docs/library.json`,
`docs/todos.json`. They must be committed or GitHub Pages has nothing to serve.

**Written by the app:** `triage.json`, in the GitHub repo you configure. That
file is your data. Everything else can be rebuilt from `config.yaml`.

**Library code** lives in `litfeed/`. You should not need to read it to use the
tool, but it is commented for when you do:

| Module | |
|---|---|
| `config.py` | Loading and validating `config.yaml` |
| `query.py` | Assembling the PubMed query, applying exclusions |
| `pubmed.py` | Search, fetch, parse, deduplicate |
| `scoring.py` | The keyword heuristic |
| `researchers.py` | Following people, and the namesake check |
| `journals.py` | Journal tables of contents |
| `triage.py` | Reading `triage.json` back into Python |
