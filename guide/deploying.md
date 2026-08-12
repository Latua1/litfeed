# Deploying

Two things turn litfeed from a local script into something you actually keep
using: the app on a URL you can open from a phone, and a feed that rebuilds
itself.

Both are free, and both run on GitHub.

---

## 1. Your own repository

Fork or clone litfeed into a repo of your own. It can be private — GitHub Pages
serves from private repos on paid plans, and everything below works either way.

**Commit your generated files.** `docs/feed.json`, `docs/config.json`,
`docs/toc.json` and `config.yaml` all belong in the repo: Pages serves the JSON,
and CI needs the config to rebuild it. The shipped `.gitignore` is deliberately
short for this reason.

The only thing that must never be committed is a token.

---

## 2. GitHub Pages

Settings → Pages → **Source: Deploy from a branch** → branch `main`, folder
**`/docs`** → Save.

A minute later the app is at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

Open it on your phone and add it to the home screen — it is a PWA, so it gets an
icon, runs full-screen, and works offline against the last feed it cached.

**A public Pages site is public.** Your feed and your `config.yaml` are readable
by anyone who finds the URL. Usually that is fine, and occasionally it is not:
`triage.json` contains your private notes about papers. If that matters, use a
private repo, or keep `triage.json` in a separate private repo and point
`github.path` at it.

---

## 3. Sync

Triage decisions are written to `triage.json` in a repo you own, via the GitHub
API from the browser. That is what lets you triage on a laptop and continue on a
phone.

**Make a token.** [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new):

- **Repository access:** Only select repositories → your litfeed repo
- **Permissions:** Repository permissions → **Contents** → **Read and write**

That single permission is all it needs. Do not grant the classic `repo` scope,
which is far broader.

**Paste it** into the app: Settings → Access token → Test token. Testing a valid
token saves it. The owner/repo/path fields above it default to whatever you put
in `config.yaml` and can be overridden per device.

**Where the token lives.** Browser localStorage, in plain text. Anyone with
access to that browser profile can read it. This is why a fine-grained,
single-repo, Contents-only token matters — it bounds the damage to one
repository of literature notes. Revoke it from the GitHub token page if a device
is lost. Tokens expire after a year at most; when yours does, sync fails with a
401, you make a new one, and nothing is lost because decisions stay queued
locally until a push succeeds.

---

## 4. The weekly rebuild

`.github/workflows/update-feed.yml` rebuilds the feed on a schedule and commits
the result, so the app is current whenever you open it.

**It ships disabled**, because a fork that runs on its owner's behalf hits NCBI
on a schedule they never chose. To turn it on:

1. **Edit the cron line.** Pick your own minute and hour rather than leaving the
   default — every fork sharing one schedule means every fork hitting NCBI in the
   same minute.
2. **Delete the `if:` line** from the job. It currently lets manual runs through
   while keeping the schedule inert.
3. Settings → Actions → General → Workflow permissions → **Read and write**.
4. Optional: add `NCBI_API_KEY` as a repository secret (Settings → Secrets and
   variables → Actions).

You can always run it by hand from the Actions tab without any of this.

**CI does not rebuild `docs/library.json`.** That file is derived from your local
full-text collection, which the runner cannot see; rebuilding it there would
wipe every badge. Run `build_library_index.py` locally when your collection
changes. See [full-text.md](full-text.md).

---

## Running it entirely locally

No GitHub at all:

```bash
python -m http.server -d docs
```

Decisions live in browser localStorage, and **Settings → Export triage.json**
downloads them. You lose cross-device sync and the backup that a git history
gives you — clearing site data wipes everything. Fine for evaluating the tool,
risky as a long-term home for a year of decisions.

---

## Updating the app

The service worker serves everything network-first and falls back to cache only
when offline, so a deployed change reaches you on the next load without any
cache-busting ritual.

If something looks stale anyway: hard-reload (Cmd/Ctrl+Shift+R), or unregister
the worker in DevTools → Application → Service Workers.
