# Full text

Triage tells you which papers matter. This gets you the papers.

Both parts are optional — litfeed is perfectly useful without ever touching a
PDF.

---

## Downloading

```bash
python fetch_pdfs.py              # tagged articles you kept
python fetch_pdfs.py --all        # every kept article, tagged or not
python fetch_pdfs.py --dry-run    # list what it would fetch
```

Configure where things land:

```yaml
library:
  pdf_dir: ~/Papers
  filename_template: '{author} {year} {title}.pdf'   # {pmid} {doi} also available
```

Two sources by default:

1. **Unpaywall** — open-access copies, publisher and repository
2. **PubMed Central** — free full text via the NCBI OA service

Whatever it cannot get goes to `docs/todos.json`, which becomes the "Full text
needed" column on the app's board.

It reads your decisions from GitHub by default, since the local copy goes stale
the moment you triage on another device. `--local-triage` reads `docs/triage.json`
instead.

### `--resolve-doi`

An opt-in third source that follows the DOI to the publisher and looks for a PDF
link. On an open network it mostly returns the same open-access copies as
Unpaywall. On a network with an institutional subscription it returns subscribed
content, because your institution is granting the access — the same access you
have in a browser.

It is off by default so nobody enables it without meaning to. Turn it on only
where you personally hold that access, and respect the terms that come with it.
It is not a paywall bypass and will not behave as one.

---

## Not downloading the same paper twice

`fetch_pdfs.py` checks three ways before fetching anything, because each alone
has a blind spot:

1. the exact filename it would write
2. the DOI, via your manifest — catches the same paper stored under a different
   name
3. the title against existing filenames — catches entries whose DOI was never
   recorded

This matters more than it sounds. Matching on a computed filename alone reports
papers you already own as missing, and sends you off to re-download them.

---

## Badging what you hold

The app can mark each article "📄 PDF" or "⛔ No PDF" if you tell it what you
have:

```yaml
library:
  manifest: ~/Papers/index.json
  unobtainable_file: ~/Papers/gave-up-on.md
```

```bash
python build_library_index.py     # writes docs/library.json
```

**The manifest** is a JSON file — either a list or an object keyed by anything —
where each entry has at least a `doi`:

```json
[
  {"doi": "10.1234/example", "filename": "Smith 2024 Title.pdf", "has_full_text": true}
]
```

Entries with no DOI are ignored; a DOI is the only identifier stable enough to
match on. `has_full_text` is optional — a manifest that never records it is
treated as a list of things you hold, so a simple inventory works unchanged.

**The unobtainable file** is plain prose. Any `doi.org` or
`pubmed.ncbi.nlm.nih.gov` URL anywhere in it is picked up, so ordinary notes with
links are a valid input:

```markdown
- Tried ILL twice, no response: https://doi.org/10.1234/lost
- Print only, pre-1990: https://pubmed.ncbi.nlm.nih.gov/12345678/
```

Recording what you gave up on is worth the two minutes. Without it you will look
for the same unobtainable paper three times a year.

### Why library.json is a separate file

`docs/feed.json` is rebuilt on a schedule, often by CI, which has no access to
your local collection. If library status were stamped into the feed, every
rebuild would erase it. Keeping it in its own file means CI leaves it alone and
the badges survive.

The consequence: **run `build_library_index.py` locally** whenever your
collection changes. CI cannot do it for you.
