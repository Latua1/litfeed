# Triage

The app exists to make one decision fast, hundreds of times: **is this paper
worth my attention or not?**

Everything is reachable from the keyboard, because the moment you reach for the
mouse the pace drops and a backlog becomes a chore you avoid.

## Keys

| Key | |
|---|---|
| `j` / `k`, or ↓ / ↑ | Next / previous article |
| `1`-`9` | Toggle a tag |
| a letter you configured | Toggle a tag past the number row |
| `p` | Cycle priority: Normal → High → Low |
| `x` | Exclude from the queue |
| `n` | Jump to the notes field |
| `Enter` | **Keep** |
| `d`, Delete, Backspace | **Skip** |
| `u` | Undo the last decision |
| `Esc` | Back / close panel |

`Enter` and `Delete` work from inside the notes field too, so writing a note and
deciding never requires the mouse.

## The two decisions

**Keep** records the article, your tags, priority and notes in `triage.json`, and
removes it from the review queue. Permanent, in the sense that it survives a feed
rebuild.

**Skip** records the id and removes it. Also permanent — a skipped article does
not come back next week, which is the property that lets a feed run for years.

Both advance to the next article automatically. That is the loop: read the title,
glance at the score breakdown, press a key, next.

**`u` undoes either one**, including a bulk dismiss, and restores any notes and
tags you had written. Single-step only — it reverses the last action, not a
history. Use it the moment you notice, not five articles later.

## Tags

Defined in `config.yaml`, in display order. The first nine get number keys
automatically; past that a tag needs a letter:

```yaml
tags:
  - name: methods
  - name: key-paper
  - name: for-the-review
    hotkey: r
    pipeline: true
```

`j k d p x n u` are reserved by the app; litfeed refuses to start if a tag claims
one, rather than silently breaking navigation.

**Adding a tag is cheap, reordering is not.** Number keys are positional, so
inserting a tag at position 2 shifts every shortcut after it — and those live in
your fingers within a week. Append new tags at the end.

### Pipeline tags

Mark a tag `pipeline: true` when an external script consumes it. The app renders
those differently, as a reminder that the exact spelling is load-bearing: rename
the tag and the script silently stops finding anything.

This is the mechanism that connects triage to real work. Tagging a paper
`for-the-review` while reading means the script that assembles that review can
find it later, without a second pass over the literature:

```python
import json
triage = json.load(open("triage.json"))
papers = [a for a in triage["committed"].values() if "for-the-review" in a.get("tags", [])]
```

## Priority and exclusion

**Priority** (`p`) orders the Queue tab and the board: High first, then Normal,
then Low. It is about what you read next, not how good the paper is.

**Exclude** (`x`) keeps a paper in your collection but out of the queue — the
right state for something worth having on record that you are not going to act
on.

## Queue options

Optional per-article dropdowns, declared in `config.yaml`:

```yaml
queue_options:
  - key: depth
    label: Reading depth
    values:
      - {value: skim, label: Skim}
      - {value: full, label: Full read}
```

They land in `triage.json` under `options`. The point is to catch a decision at
the moment you are best placed to make it — while looking at the abstract —
rather than reconstructing it later from a title.

## The three views

**Feed** — your review queue, highest score first. Kept articles collapse into a
section at the bottom.

**TOC** — journal tables of contents, grouped by journal and issue, with anything
already in your feed or already reviewed hidden. Every group has a **Dismiss**
button that skips the whole issue as one undoable action. That button is what
makes browsing a TOC sustainable: most issues are entirely irrelevant to you, and
they should cost one click, not twenty.

**Board** — everything you kept, in columns: Queue, Full text needed, Done,
Excluded, Untagged. "Full text needed" comes from `docs/todos.json`, written by
`fetch_pdfs.py`. "Done" comes from an optional `docs/done.json` you write from
whatever you do downstream:

```json
{"idToLabel": {"12345678": "Episode 12", "12345679": "Draft §3"}}
```

The **Untagged** column is a quiet quality check. Papers land there when you kept
them without saying why, which usually means you were moving fast and will not
remember the reason in a month.

## Search

The search box covers titles, authors, abstracts, **and your own notes and
tags**. That last part is what makes notes worth writing: a note you can find
again is a note that pays for itself.

## Filters

The funnel icon: status, tracked researcher, minimum score, journal, sort order.
A badge shows how many filters are active, because a forgotten filter looks
exactly like an empty feed.

The chips above the list are quicker: All, Review, Kept, Researchers, one per
watchlist, TOC, Board.

## Batching

Decisions queue locally and push to GitHub after N of them (Settings → Push
size). Default 1 — every decision pushes immediately.

Raise it if you triage on a slow connection or in long sittings; the queue
survives a reload, and nothing is lost if a push fails. The `↑` button in the
header flushes early.

**Two safety rules are built in**, both from real data loss:

- litfeed never pushes before a successful pull. A push writes the whole store,
  so pushing a store that failed to load would erase everything already there.
  Your decisions stay queued locally until a pull succeeds.
- An empty token field never overwrites a saved token. Password managers autofill
  password inputs, and saving that autofill destroys a working token in a way
  that only surfaces later as an unexplained 401.

## Without sync

The app works with no GitHub account at all: decisions live in browser
localStorage, and **Settings → Export triage.json** downloads the same file the
app would have pushed.

Fine for trying it out or for a single-machine workflow. Be aware that clearing
site data wipes it, and that this is the one mode where you can lose decisions.
