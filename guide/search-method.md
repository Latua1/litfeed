# Building a search that works

This is the guide that decides whether litfeed is useful to you. The software is
the easy part; a query that finds your literature without burying you is not.

Everything below is stated generically on purpose. There is no term list you can
copy — a term list is only good relative to a set of papers you have already
judged, so a borrowed one is untested by definition.

---

## The shape

litfeed assembles this:

```
( (topic terms) AND (context terms) )   ← the backbone
   OR (precise phrases)                 ← what the backbone cannot reach
   NOT (excluded title terms)           ← what shares your vocabulary but isn't yours
```

Each field does a different job, and the reason to keep them separate is the
whole method.

### Field 1 AND field 2: the backbone

Two broad fields ANDed together. Topic terms are what you study; context terms
are the setting, population or method that makes a paper yours rather than
somebody else's.

Neither field is precise alone. Their intersection usually is. "Asthma" retrieves
a hundred thousand papers a year and "athlete" retrieves another vast literature,
but asthma AND athlete is a manageable stream that is almost all relevant.

**The trap in field 1.** Context terms are usually loose — words like *training*,
*exercise*, *worker*, *patients*. Every new term you add to field 1 is ANDed
against all of them, so a term that feels obviously on-topic can return mostly
noise.

The way to know is to measure, not to reason. Add the candidate term, re-run,
and look at the titles it newly returns. Two real examples from a respiratory
feed, where each term was clearly on-topic and each was wrong:

- adding a drug name yielded 64 new articles, led by *"Preparation and properties
  of raspberry functional chewable tablets"*
- adding a piece of equipment yielded 46, led by *"A Review on Face Mask
  Recognition"*

Both were correct as topic terms. Both were useless in field 1, because the loose
context field let them through. As precise phrases at the top level, the same
terms returned the actual literature.

### Field 3: precise phrases

Phrases specific enough to retrieve on with no context word attached, ORed in
alongside the backbone.

Two things go here. First, terms that field 1 makes noisy (above). Second, and
more important: **papers that never mention your context at all.**

That second group is invisible until you go looking for it, and it can be large.
A named condition, a named test, a named protocol — the papers studying it often
do not name any population, so a query that requires a context word cannot reach
them no matter how good field 1 is. In one measured case, adding a phrase field
recovered around 220 articles per two-year window, dominated by two named
conditions whose literature the backbone had never once returned.

So: when you notice a paper you should have seen and didn't, ask whether it uses
any of your context vocabulary. If it does not, no amount of field-1 tuning will
ever find it, and a precise phrase is the only fix.

**Where the ceiling is.** A phrase has to be specific enough that its ordinary
English meaning is rare. Terms tested and rejected in one real feed, each for a
different reason worth recognising:

| Term | New articles | Why it failed |
|---|---|---|
| a common symptom phrase | 424 | Ordinary clinical English; matched several unrelated diseases |
| a regulatory body's acronym | 197 | The acronym is also a common surname |
| a chemical name | 142 | Retrieved industrial chemistry |
| a device name | 21 | The device is standard in a different specialty |

Say the phrase aloud in a field that is not yours. If it still means something
there, it belongs in field 1 instead.

### Field 4: exclusions, on titles only

Subjects that share your vocabulary and are never yours.

**Match titles, not abstracts.** This is the single most important choice in the
whole exclusion mechanism. Papers routinely name adjacent subjects in their
background and exclusion criteria without being about them — an asthma paper
that contrasts itself with COPD, a sports paper that lists cancer among its
exclusions. Matching abstracts catches all of those. In one measured feed,
title-only exclusions removed 33% of the corpus at a cost of **one** wanted
paper; the same terms on abstracts would have cost an order of magnitude more.

**Test every term against papers you have already kept.** This is the discipline
that makes exclusions safe, and it is why the tool records your decisions in a
file you can read. Before adopting a term, check it against your kept list:

```python
import json, re
triage = json.load(open("triage.json"))
term = re.compile(r"\bCOPD\b", re.IGNORECASE)      # the term you're considering
hits = [a["title"] for a in triage["committed"].values() if term.search(a["title"])]
print(f"{len(hits)} kept papers would be lost:")
for h in hits: print(" -", h)
```

Zero hits means it is safe. One or two means read them and decide deliberately.
Many means you have found a real subject boundary, not a noise term.

**The residual risk has a shape.** The one paper the 33% exclusion cost above
was a *method* paper — a detection algorithm that happened to be validated in an
excluded disease. That is the failure mode to watch for: you exclude a subject,
and lose the methods work done inside it. If that keeps happening, narrow the
term list. Do not move to abstract matching.

**What not to exclude** is as instructive as what to exclude. Terms that look
obviously off-topic and each cost a real paper, in one measured feed:

- a word that is also a common acronym (matched a named questionnaire, and a
  paper with a pun in its title)
- an animal species (the animal-model work on the exact mechanism studied)
- an infection (the return-to-activity-after-infection literature)
- an injury type (consensus statements that also covered the topic)

Every one was defensible in the abstract and wrong in the data. Measure.

---

## Scoring

The score orders your review queue. It does not need to be right, it needs to be
useful and inspectable.

Weights in `config.yaml`; the app shows the per-term breakdown next to each
abstract with matches highlighted, so a score that looks wrong is diagnosable in
one glance.

**Rough shape that works.** What you actually study: 10-15. Your methods and
measures: 5-8. Study-type words (*review*, *randomized*, *cohort*): 1-4, as
tie-breakers only.

**Study-type words start high in everyone's first draft, and belong low.** They
fire on everything, including everything you skip. Measured against real triage
decisions in one feed: *"treatment"* appeared in 45% of skipped papers versus 25%
of kept ones; *"review"* 36% versus 23%; *"meta-analysis"* 13% versus 6%. At
their original weights they were actively promoting the wrong material.

**Test a weight the same way you test an exclusion** — against decisions you
already made:

```python
import json, collections
triage = json.load(open("triage.json"))
kept = [a["title"].lower() for a in triage["committed"].values()]
term = "prevalence"
rate = sum(term in t for t in kept) / max(len(kept), 1)
print(f"{term!r} appears in {rate:.0%} of kept papers")
```

Compare that against how often it appears across the feed as a whole. A term that
fires no more often on your keeps than on the corpus is carrying no information,
whatever your intuition says.

---

## Tracked researchers

Following people is different from following topics, and fails differently.

**Search by name, not ORCID.** PubMed only carries an ORCID when the publisher
passed one through, and coverage is thin. Measured across five researchers who
have one, searching `<orcid>[auid]` instead of the name returned roughly 10% of
their papers — and in every case a strict subset of the name query, adding
nothing. Searching by ORCID would lose 90% of a person's output.

**Use ORCID to check, not to find.** `Smith J[Author]` matches JW, JL and JD
alike; in one feed about 13% of researcher hits were other people. litfeed
verifies each hit against OpenAlex and flags a paper as *probably someone else*
only when OpenAlex does not list the tracked ORCID **and** every same-surname
author has incompatible initials.

Both conditions are required, and the reason matters. OpenAlex alone is far too
noisy to act on: in one measured run it failed to confirm 26 of 173 articles, of
which only 3 were genuinely other people — the rest were real papers OpenAlex
simply had no ORCID for. Flagging all 26 would have trained the eye to ignore the
flag entirely. Adding the initials test cut it to exactly the 3 true namesakes.

That is a general principle worth carrying: **a warning that is usually wrong is
worse than no warning**, because it destroys the value of the times it is right.

**Verify an ORCID before you paste it.** Registries hold multiple people per
name — one common name had seven other entries.

```bash
curl -H "Accept: application/json" https://pub.orcid.org/v3.0/<orcid>/record
```

Confirm it resolves to *their* papers, not just their name. And note that a real
record can list no works publicly, so an empty ORCID works list is not evidence
against it — check `<orcid>[auid]` on PubMed instead.

---

## Journals and watchlists

**Journal TOCs** answer a question keywords cannot: *what is this field actually
publishing?* Articles matching your scoring keywords merge into the feed; the
rest stay browsable, grouped by issue, dismissable a whole issue at a time.

Watch for sibling journals sharing a title prefix. `"Respir Med"[ta]` also
matches *Respir Med Case Rep*, *Respir Med Res* and *Respir Med X*. Exclude them
explicitly.

**Watchlists** follow a subject on any topic. Reach for one when a population you
care about is barely described in your topic vocabulary. The diagnostic: search
your context term alone for a year, and count how many hits contain any topic
term. In one case only 3 of 367 papers about a sport contained any respiratory
word — meaning the main query was blind to that sport, and only a separate
stream could see it.

---

## The loop

1. Start with a first draft: topic and context terms, nothing else.
2. Run it. Look at what comes back, especially the tail.
3. Triage a hundred papers. You now have data.
4. Add exclusions for what you keep skipping — testing each against your keeps.
5. Add precise phrases for what you notice missing.
6. Retune weights against your keep/skip rates.
7. Repeat every few months. Vocabulary shifts; so should the query.

Steps 3 and 4 are the whole point, and you cannot skip to them. Until you have
triaged real papers you have no measuring stick, and every decision is taste.
