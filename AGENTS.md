# Notes for AI assistants working in this repo

Most people configure litfeed with an assistant's help. This file is the
orientation you would otherwise have to reconstruct by reading everything.

## The one rule

**Configuration goes in `config.yaml`. Nothing else.**

Tags, search terms, scoring weights, tracked people, journals, the sync target —
all of it is config. If you are about to edit `litfeed/*.py`, `docs/app.js` or
`generate_feed.py` to change what the user monitors, stop: there is a config key
for it. `config.example.yaml` documents every key in place.

`docs/config.json` is generated from `config.yaml` by `generate_feed.py`. Never
hand-edit it; the next feed build overwrites it.

## Layout

```
config.yaml            the user's configuration (the only file they normally edit)
config.example.yaml    every option, documented inline
setup_wizard.py        writes config.yaml from answers
generate_feed.py       → docs/feed.json + docs/config.json
fetch_toc.py           → docs/toc.json        (run BEFORE generate_feed.py)
fetch_pdfs.py          → PDFs + docs/todos.json
build_library_index.py → docs/library.json    (local only — CI cannot build it)
litfeed/               config, query, pubmed, scoring, researchers, journals, triage
docs/                  the browser app (GitHub Pages serves this folder)
guide/                 documentation
```

## Before changing a query

Read `guide/search-method.md`. It is not background reading — it contains the
specific failure modes, with measured numbers, that make a plausible query
change destroy recall. In particular:

- Exclusions match **titles only**, deliberately. Do not "improve" this to
  abstracts.
- A multi-word term ending in `*` matches **nothing** in PubMed, because
  wildcards do not expand inside quoted phrases. `config.py` rejects these; do
  not work around it, spell out the variants.
- Adding a term to `topic_terms` ANDs it against every loose `context_terms`
  entry, which is usually why an obviously-relevant term returns noise. Precise
  phrases exist for exactly this.
- Study-type words (*review*, *treatment*, *prevalence*) fire more often on
  papers users skip than on papers they keep. Weight them 1-4, not 10.

## Verifying a change

There is no test suite. Verify like this:

```bash
python generate_feed.py --config config.yaml --days 14 --dry-run
```

`--dry-run` reports counts and writes nothing, so it is safe to run repeatedly
while tuning. Compare the article count before and after your change, and look
at the titles — a count alone will not tell you whether the new articles are the
ones the user wanted.

Config errors are reported as a list with a fix in each message; run any script
with a broken config to see them.

## Things that will bite you

- **Never delete or rewrite `triage.json`.** It is the user's data — years of
  decisions, not a cache — and nothing regenerates it. Everything else in the
  repo can be rebuilt from `config.yaml`.
- **Do not gitignore the generated JSON.** GitHub Pages serves it and CI needs
  `config.yaml`. The short `.gitignore` is intentional.
- **Reordering `tags:` shifts every number-key shortcut.** Append; do not
  insert.
- **`docs/library.json` is built locally, never in CI.** CI has no access to the
  user's PDF collection, and rebuilding it there wipes the badges.
- **`CERTIFICATE_VERIFY_FAILED`** is an environment problem, not a code one:
  `export SSL_CERT_FILE=$(python3 -m certifi)`.

## Style

The existing code comments explain *why*, especially where a simpler-looking
approach was tried and failed — the OpenAlex two-condition namesake check, the
never-push-before-pull guard, the title-only exclusions. Match that: if you make
a non-obvious choice, say what the obvious alternative was and why it lost.
