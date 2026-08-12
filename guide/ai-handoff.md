# Handing off to an AI assistant

litfeed ships no AI integration and calls no model. It produces two things an
assistant can work with, and that turns out to be enough:

- **`triage.json`** — the papers you kept, with your tags, notes and priorities
- **your PDF folder** — the full text of those papers

Point an assistant at both and you can ask for a summary, a draft, a comparison,
a gap analysis, without first re-finding the literature.

---

## The two-part prompt

Something like this, in a repo containing `triage.json` and with your PDFs on
disk:

> Read `triage.json`. Take every paper tagged `for-the-review` that I have not
> already covered. For each one, find the PDF in `~/Papers` (filenames are
> `Author Year Title.pdf`). Read the full text — not the abstract. Then write a
> 400-word synthesis of what they collectively show, and say explicitly where
> they disagree with each other.

Three things in there are doing real work:

**A tag as the selector.** `for-the-review` is a decision you made while reading
the abstract, at the moment you were best placed to make it. The assistant
inherits your judgement instead of re-deriving it from titles. This is what
[pipeline tags](triage.md#pipeline-tags) are for.

**"Full text, not the abstract."** Worth stating every time. An abstract omits
the sample size caveat, the actual effect size, the thing the discussion section
concedes. Anything written from abstracts will read fine and be subtly wrong in
exactly the places that matter.

**"Where they disagree."** A synthesis that reports agreement is usually a
synthesis that stopped reading. The disagreements are where the useful work is.

---

## Selecting papers yourself

`triage.json` is plain JSON; filter it in three lines:

```python
import json
triage = json.load(open("triage.json"))

by_tag  = [a for a in triage["committed"].values() if "methods" in a.get("tags", [])]
high    = [a for a in triage["committed"].values() if a.get("priority") == "high"]
noted   = [a for a in triage["committed"].values() if a.get("notes")]
recent  = [a for a in triage["committed"].values() if a.get("committedAt", "") > "2026-01-01"]

for a in by_tag:
    print(f"{a['title']}\n  {a.get('doi','')}  — {a.get('notes','')}\n")
```

Feed that list to an assistant, or write it to a file and reference it.

The `options` field holds whatever [queue options](triage.md#queue-options) you
configured — a good place to have recorded "skim" versus "extract data" while
reading, so the downstream ask can respect it.

---

## Closing the loop

The board's **Done** column reads an optional `docs/done.json`:

```json
{"idToLabel": {"12345678": "Draft §3", "12345679": "Newsletter #7"}}
```

Write it from whatever you do downstream and the board stops showing papers you
have already used. Without it, every paper you kept sits in the queue forever and
the board slowly stops meaning anything.

---

## Two things to insist on

**Verify citations against the PDF, not against the model.** Model-generated
DOIs, page numbers and author lists are frequently plausible and wrong. Resolve
every DOI you intend to publish:

```bash
curl -s https://api.crossref.org/works/10.1234/example | python3 -m json.tool | head -30
```

If it does not resolve to the paper you think it is, the citation is wrong no
matter how confident the prose around it sounds.

**Read what you cite.** An assistant that has read forty PDFs can produce a
paragraph you would not have written and cannot defend. That is fine as a draft
and dangerous as a submission. The value here is in not re-finding the
literature — not in outsourcing the judgement about it.
