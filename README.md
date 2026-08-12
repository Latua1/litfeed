# litfeed

Keep up with a literature you cannot possibly read.

litfeed builds a scored feed of new PubMed articles on a subject you define,
then gives you a keyboard-driven app to triage it — one key to keep, one to
skip, number keys to tag. Decisions sync to a JSON file in your own GitHub repo,
so you can triage on a laptop and continue on a phone.

It is not a reference manager and does not want to be one. It answers one
question, repeatedly: **what came out this week that I should look at?**

```
PubMed keyword query ─┐
Watchlists            ├─→  generate_feed.py  ─→  docs/feed.json ─→  triage app  ─→  triage.json
Tracked researchers   │                                                   │           (your repo)
Journal TOCs ─────────┘                                                   │
                                                                          ↓
                                                              fetch_pdfs.py → full text
```

Everything about your subject lives in one file, `config.yaml`. No search terms
are hardcoded anywhere in the code.

---

## Quick start

```bash
git clone https://github.com/YOUR-USERNAME/litfeed.git
cd litfeed
pip install -r requirements.txt

python setup_wizard.py            # answer ~10 questions, writes config.yaml
python generate_feed.py           # fetch and score (a few minutes)
python -m http.server -d docs     # open http://localhost:8000
```

That gets you a working local feed. Two more steps make it a habit rather than a
demo — publishing the app so you can triage from a phone, and turning on the
weekly rebuild. Both are in **[guide/deploying.md](guide/deploying.md)**.

If you use an AI coding assistant, point it at `config.yaml` and
`guide/search-method.md` and describe your field. Editing that file is the
entire configuration surface, and it is well suited to that kind of help.

---

## Documentation

| Guide | What's in it |
|---|---|
| **[Getting started](guide/getting-started.md)** | Installation, the first run, what each file does |
| **[Search method](guide/search-method.md)** | How to build a query that finds your literature and not everything else. The part that decides whether this tool is useful to you. |
| **[Triage](guide/triage.md)** | The keyboard workflow, tags, priorities, undo, pipeline tags |
| **[Deploying](guide/deploying.md)** | GitHub Pages, sync across devices, the weekly rebuild |
| **[Full text](guide/full-text.md)** | Downloading open-access PDFs, badging what you already hold |
| **[AI hand-off](guide/ai-handoff.md)** | Pointing an assistant at your kept papers and their full text |

---

## What it does

**Four sources, one feed.** A keyword query is the backbone. *Watchlists* follow
a population or subject on any topic, for the cases where your topic vocabulary
never appears in papers you still want. *Tracked researchers* follow people —
with a namesake check against OpenAlex, because `Smith J[Author]` is several
different people. *Journal tables of contents* catch what your keywords miss;
matching ones merge into the feed, the rest stay browsable and dismissable in
bulk.

**A score you can argue with.** Relevance is a keyword heuristic with weights
you set. Every point is traceable, and the app shows the breakdown beside each
abstract with the matched terms highlighted. A better score you cannot inspect
would be worse.

**Triage that keeps up with reading.** `j`/`k` move, `1`-`9` tag, `p` sets
priority, `n` writes a note, `Enter` keeps, `d` skips, `u` undoes. Decisions
queue locally and push in batches, so a flaky connection never blocks you and
nothing is lost when a token expires.

**Your data stays yours.** Decisions live in a plain `triage.json` in a repo you
own, with an export button as the escape hatch. No account, no server, no
service to shut down.

---

## Files

| File | Purpose |
|---|---|
| `config.yaml` | Everything: query, exclusions, scoring, people, journals, tags, sync target |
| `setup_wizard.py` | Writes `config.yaml` by asking questions |
| `generate_feed.py` | Builds `docs/feed.json` and `docs/config.json` |
| `fetch_toc.py` | Builds `docs/toc.json` from the journals you listed |
| `fetch_pdfs.py` | Downloads open-access full text for articles you kept |
| `build_library_index.py` | Builds `docs/library.json` so the app can badge what you hold |
| `docs/` | The app. Served by GitHub Pages, or by any static file server |
| `litfeed/` | Library code: config, query assembly, PubMed, scoring, researchers |
| `examples/` | One worked configuration, fully commented |

---

## Requirements

Python 3.10+, and `biopython`, `PyYAML`, `requests` (`pip install -r
requirements.txt`). A GitHub account only if you want sync across devices.

Set `NCBI_API_KEY` in your environment to raise NCBI's rate limit from 3 to 10
requests per second. [Get one here](https://account.ncbi.nlm.nih.gov/settings/)
— free, and worth it once your feed is large. Never put it in `config.yaml`.

---

## Troubleshooting

**`CERTIFICATE_VERIFY_FAILED` on any PubMed call.** Python's TLS trust store
does not include a certificate your network needs — common on managed machines
and university networks that inspect TLS, and on fresh macOS python.org
installs. Point Python at the `certifi` bundle:

```bash
export SSL_CERT_FILE=$(python3 -m certifi)
```

On macOS, running `/Applications/Python\ 3.x/Install\ Certificates.command`
fixes it permanently. If your network genuinely does intercept TLS, add your
organisation's root certificate to that bundle rather than disabling
verification.

**The feed is enormous / full of the wrong subject.** Normal on a first run.
That is what `exclude_title_terms` is for — see
[guide/search-method.md](guide/search-method.md), which is mostly about how to
narrow a query without quietly destroying your own recall.

**The app shows "No feed yet".** `docs/feed.json` does not exist. Run
`python generate_feed.py`.

**A change to the app doesn't appear.** A service worker caches it. Hard-reload
(Cmd/Ctrl+Shift+R), or unregister the worker in DevTools → Application.

**Sync fails with a 401.** Fine-grained GitHub tokens expire, at most a year
out. Make a new one and paste it in Settings. Nothing is lost — decisions stay
queued locally until a push succeeds.

**A tracked researcher's feed is full of strangers.** PubMed author search
matches surname plus initials. Add `orcid`, `surname` and `initials` to that
entry so litfeed can flag the mismatches, and narrow `pubmed_query` with a topic
AND for very common names. See [guide/search-method.md](guide/search-method.md).

---

## License

MIT — see [LICENSE](LICENSE).

Built by [Rikhard Mäki-Heikkilä](https://rikhard.fi), a physician-researcher who
needed to stop missing papers.
