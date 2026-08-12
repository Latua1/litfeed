// litfeed — triage app
//
// Reads three generated files, all of them optional except the first:
//   config.json   settings mirrored from config.yaml (tags, scoring, sync target)
//   feed.json     the scored article feed
//   toc.json      journal tables of contents
//   library.json  which articles you already hold full text for
//   done.json     ids that are finished, for the board view
//
// Nothing about any particular subject is hardcoded here. If you find yourself
// editing this file to change tags, keywords or the repo, edit config.yaml and
// re-run generate_feed.py instead.

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STORE_KEYS = {
    draft: 'litfeedDraft',
    pat: 'litfeedPAT',
    repo: 'litfeedRepo',
    batch: 'litfeedBatchSize',
    pending: 'litfeedPending',
    lastSync: 'litfeedLastSync',
    lastPull: 'litfeedLastPull',
};

const BATCH_SIZE_OPTIONS = [1, 5, 10, 25];
const DEFAULT_BATCH_SIZE = 1;
const TAG_HOTKEY_COUNT = 9;

// Populated from config.json at boot. The defaults here only keep the app from
// crashing when config.json is missing — they are not a usable configuration.
const CONFIG = {
    appName: 'litfeed',
    description: '',
    github: { owner: '', repo: '', path: 'triage.json', branch: '' },
    tags: [],
    queueOptions: [],
    scoreKeywords: {},
    scoreBonuses: { has_abstract: 5, abstract_min_chars: 200, title_terms: [], title_term_points: 8 },
    scoreMaxCount: 3,
    watchlists: [],
    knowledgeFile: 'knowledge.md',
};

async function loadAppConfig() {
    try {
        const resp = await fetch('config.json');
        if (resp.ok) Object.assign(CONFIG, await resp.json());
    } catch {
        // Left at defaults. The app still runs; the status bar says what's wrong.
    }
}

const tagNames = () => CONFIG.tags.map(t => t.name);
const pipelineTags = () => new Set(CONFIG.tags.filter(t => t.pipeline).map(t => t.name));
const letterHotkeys = () => {
    const map = {};
    for (const t of CONFIG.tags) if (t.hotkey) map[t.hotkey] = t.name;
    return map;
};

// ---------------------------------------------------------------------------
// State — draft (localStorage) vs kept (GitHub triage.json)
// ---------------------------------------------------------------------------

class FeedStore {
    constructor() {
        this.articles = [];
        this.committed = {};   // from triage.json: articles you kept
        this.skippedIds = [];  // from triage.json: ids you rejected
        this.draft = this._loadDraft();
    }

    _loadDraft() {
        try {
            return JSON.parse(localStorage.getItem(STORE_KEYS.draft)) || {};
        } catch {
            return {};
        }
    }

    _saveDraft() {
        localStorage.setItem(STORE_KEYS.draft, JSON.stringify(this.draft));
    }

    getDraft(articleId) {
        return this.draft[articleId] || {
            tags: [], priority: 'normal', exclude: false, notes: '', options: {},
        };
    }

    setDraft(articleId, updates) {
        this.draft[articleId] = { ...this.getDraft(articleId), ...updates };
        this._saveDraft();
    }

    removeDraft(articleId) {
        delete this.draft[articleId];
        this._saveDraft();
    }

    isInReviewList(articleId) {
        if (this.committed[articleId]) return false;
        if (this.skippedIds.includes(articleId)) return false;
        return true;
    }

    getReviewArticles() {
        return this.articles.filter(a => this.isInReviewList(a.id));
    }

    async fetchFeed() {
        const resp = await fetch('feed.json');
        if (!resp.ok) throw new Error(`Feed fetch failed: ${resp.status}`);
        const data = await resp.json();
        this.articles = data.articles || [];
        return data;
    }
}

// ---------------------------------------------------------------------------
// GitHub sync
// ---------------------------------------------------------------------------

class GitHubSync {
    constructor(store) {
        this.store = store;
        this._pending = this._loadPending();
        this._applyPending();

        // A push writes the WHOLE store over triage.json. If the pull never
        // succeeded the store is empty, and pushing it would erase every past
        // decision on GitHub. Never push what we have not first read.
        this._pulledOk = false;
        this._lastSha = null;
    }

    // --- target repo ---

    repo() {
        let saved = {};
        try {
            saved = JSON.parse(localStorage.getItem(STORE_KEYS.repo)) || {};
        } catch { /* fall through to config */ }
        return {
            owner: saved.owner || CONFIG.github.owner || '',
            repo: saved.repo || CONFIG.github.repo || '',
            path: saved.path || CONFIG.github.path || 'triage.json',
        };
    }

    setRepo({ owner, repo, path }) {
        localStorage.setItem(STORE_KEYS.repo, JSON.stringify({
            owner: (owner || '').trim(),
            repo: (repo || '').trim(),
            path: (path || '').trim() || 'triage.json',
        }));
    }

    isConfigured() {
        const r = this.repo();
        return !!(r.owner && r.repo);
    }

    repoLabel() {
        const r = this.repo();
        return r.owner && r.repo ? `${r.owner}/${r.repo}` : '(no repository set)';
    }

    _apiUrl() {
        const r = this.repo();
        return `https://api.github.com/repos/${r.owner}/${r.repo}/contents/${r.path}`;
    }

    // --- token ---

    _getToken() {
        return localStorage.getItem(STORE_KEYS.pat) || '';
    }

    // Only ever persist a deliberate, non-empty value. The settings field is a
    // password input, which password managers will happily autofill over, and
    // saving an empty field verbatim silently destroys a working token —
    // surfacing much later as an opaque 401.
    setToken(token) {
        const clean = (token || '').trim();
        if (!clean) return false;
        localStorage.setItem(STORE_KEYS.pat, clean);
        return true;
    }

    clearToken() {
        localStorage.removeItem(STORE_KEYS.pat);
    }

    tokenSummary() {
        const t = this._getToken();
        if (!t) return 'No token saved';
        return `Saved: ${t.slice(0, 11)}…${t.slice(-4)} (${t.length} chars)`;
    }

    hasToken() {
        return !!this._getToken();
    }

    // Turn a failed GitHub response into something actionable. An expired or
    // revoked token is 401; a live token without Contents:write on this repo
    // is 403; a repo the token cannot see is 404, not "file missing".
    describeError(status) {
        const label = this.repoLabel();
        if (status === 401) return 'Token expired or invalid — create a new one in Settings';
        if (status === 403) return `Token lacks Contents: Read and write on ${label}`;
        if (status === 404) return `Repo or file not found — check the token can see ${label}`;
        return `GitHub API error: ${status}`;
    }

    async testToken(token) {
        const raw = token || '';
        const clean = raw.trim();

        if (!this.isConfigured()) return { ok: false, message: 'Set the owner and repository first' };
        if (!clean) return { ok: false, message: 'No token entered' };
        if (raw !== clean) return { ok: false, message: 'Token has leading/trailing whitespace — re-copy it' };
        if (/\s/.test(clean)) return { ok: false, message: 'Token contains a space or line break — the paste was mangled' };
        if (clean.startsWith('github_pat_') && clean.length < 80) {
            return { ok: false, message: `Token looks truncated (${clean.length} chars; expect ~93)` };
        }
        if (!/^(github_pat_|ghp_|gho_)/.test(clean)) {
            return { ok: false, message: 'Doesn\'t look like a GitHub token (expected github_pat_… or ghp_…)' };
        }

        let resp;
        try {
            resp = await fetch(this._apiUrl(), {
                headers: { 'Authorization': `Bearer ${clean}`, 'Accept': 'application/vnd.github+json' },
            });
        } catch {
            return { ok: false, message: 'Could not reach GitHub — check your connection' };
        }

        if (resp.ok) return { ok: true, message: 'Token works. Sync is live.' };
        if (resp.status === 404) {
            // GitHub hides private repos a token cannot access behind a 404, so
            // this is far more often an access problem than a missing file. The
            // file itself is created on first push.
            return {
                ok: true,
                message: `Reachable, but ${this.repo().path} doesn't exist yet — it will be created on your first push.`,
            };
        }

        const body = await resp.json().catch(() => ({}));
        const detail = body.message ? ` — GitHub said: "${body.message}"` : '';
        return { ok: false, message: this.describeError(resp.status) + detail };
    }

    // --- batching ---

    getBatchSize() {
        const stored = parseInt(localStorage.getItem(STORE_KEYS.batch) || '', 10);
        return BATCH_SIZE_OPTIONS.includes(stored) ? stored : DEFAULT_BATCH_SIZE;
    }

    setBatchSize(size) {
        const parsed = parseInt(size, 10);
        const normalized = BATCH_SIZE_OPTIONS.includes(parsed) ? parsed : DEFAULT_BATCH_SIZE;
        localStorage.setItem(STORE_KEYS.batch, String(normalized));
        return normalized;
    }

    getPendingCount() {
        return Object.keys(this._pending.committed).length + this._pending.skipped.length;
    }

    _loadPending() {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORE_KEYS.pending)) || {};
            return {
                committed: parsed.committed && typeof parsed.committed === 'object' ? parsed.committed : {},
                skipped: Array.isArray(parsed.skipped) ? parsed.skipped.map(String) : [],
            };
        } catch {
            return { committed: {}, skipped: [] };
        }
    }

    _savePending() {
        if (this.getPendingCount() === 0) {
            localStorage.removeItem(STORE_KEYS.pending);
            return;
        }
        localStorage.setItem(STORE_KEYS.pending, JSON.stringify(this._pending));
    }

    _applyPending() {
        for (const [id, entry] of Object.entries(this._pending.committed)) {
            this.store.committed[id] = entry;
            this.store.removeDraft(id);
        }
        for (const id of this._pending.skipped) {
            if (!this.store.skippedIds.includes(id)) this.store.skippedIds.push(id);
            delete this.store.committed[id];
            this.store.removeDraft(id);
        }
    }

    _queueCommitted(id, entry) {
        this._pending.committed[id] = entry;
        this._pending.skipped = this._pending.skipped.filter(x => x !== id);
        this._savePending();
    }

    _queueSkipped(id) {
        delete this._pending.committed[id];
        if (!this._pending.skipped.includes(id)) this._pending.skipped.push(id);
        this._savePending();
    }

    _clearPending() {
        this._pending = { committed: {}, skipped: [] };
        this._savePending();
    }

    async _flushIfNeeded(force = false) {
        const batchSize = this.getBatchSize();
        const pendingCount = this.getPendingCount();
        if (!force && pendingCount < batchSize) {
            return { pushed: false, pendingCount, batchSize };
        }
        await this._push();
        return { pushed: true, pushedCount: pendingCount, batchSize };
    }

    async flushPending() {
        return this._flushIfNeeded(true);
    }

    canPush() {
        return this._pulledOk;
    }

    // --- transfer ---

    async pull() {
        const token = this._getToken();
        if (!token) throw new Error('No GitHub token configured');
        if (!this.isConfigured()) throw new Error('No repository configured');

        const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' };
        const resp = await fetch(this._apiUrl(), { headers });

        if (!resp.ok) {
            if (resp.status === 404) {
                // Nothing on the remote yet. An empty store is genuinely correct
                // here, so pushing it is safe.
                this.store.committed = {};
                this.store.skippedIds = [];
                this._applyPending();
                this._pulledOk = true;
                return 0;
            }
            this._pulledOk = false;
            throw new Error(this.describeError(resp.status));
        }

        const data = await resp.json();
        this._lastSha = data.sha;
        const triage = JSON.parse(decodeURIComponent(escape(atob(data.content))));

        this.store.committed = triage.committed || {};
        this.store.skippedIds = (triage.skipped || []).map(String);
        this._applyPending();

        // Drafts for already-decided articles are dead weight and would
        // resurrect old notes on an undo.
        for (const id of Object.keys(this.store.committed)) delete this.store.draft[id];
        for (const id of this.store.skippedIds) delete this.store.draft[id];
        this.store._saveDraft();

        this._pulledOk = true;
        localStorage.setItem(STORE_KEYS.lastPull, new Date().toISOString());
        return Object.keys(this.store.committed).length;
    }

    async commitArticle(article, draftState) {
        const entry = {
            tags: draftState.tags || [],
            priority: draftState.priority || 'normal',
            exclude: draftState.exclude || false,
            notes: draftState.notes || '',
            options: draftState.options || {},
            committedAt: new Date().toISOString(),
            title: article.title,
            authors: article.authors,
            journal: article.journal,
            year: article.year,
            doi: article.doi,
            score: article.score,
        };
        this.store.committed[article.id] = entry;
        this.store.removeDraft(article.id);
        this._queueCommitted(article.id, entry);
        return this._flushIfNeeded();
    }

    async skipArticle(articleId) {
        return this.skipArticles([articleId]);
    }

    async skipArticles(articleIds) {
        for (const id of articleIds) {
            if (!this.store.skippedIds.includes(id)) this.store.skippedIds.push(id);
            delete this.store.committed[id];
            this.store.removeDraft(id);
            this._queueSkipped(id);
        }
        return this._flushIfNeeded();
    }

    triageDocument() {
        return {
            syncedAt: new Date().toISOString(),
            committed: this.store.committed,
            skipped: this.store.skippedIds,
        };
    }

    async _push() {
        // Hard guard: refuse to overwrite the remote with a store we never read.
        // Decisions stay queued locally, so nothing is lost by waiting.
        if (!this._pulledOk) {
            throw new Error('Not synced yet — pull from GitHub before pushing (your decisions are saved locally)');
        }
        const token = this._getToken();
        const content = JSON.stringify(this.triageDocument(), null, 2);
        const encoded = btoa(unescape(encodeURIComponent(content)));
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
        };

        if (!this._lastSha) {
            try {
                const getResp = await fetch(this._apiUrl(), { headers });
                if (getResp.ok) this._lastSha = (await getResp.json()).sha;
            } catch { /* file doesn't exist yet */ }
        }

        const body = {
            message: `Triage update ${new Date().toISOString().slice(0, 16)}`,
            content: encoded,
        };
        if (this._lastSha) body.sha = this._lastSha;

        const putResp = await fetch(this._apiUrl(), {
            method: 'PUT', headers, body: JSON.stringify(body),
        });

        if (!putResp.ok) {
            const err = await putResp.json().catch(() => ({}));
            throw new Error(err.message || this.describeError(putResp.status));
        }

        this._lastSha = (await putResp.json()).content?.sha;
        this._clearPending();
        localStorage.setItem(STORE_KEYS.lastSync, new Date().toISOString());
    }

    getLastSync() { return localStorage.getItem(STORE_KEYS.lastSync); }
    getLastPull() { return localStorage.getItem(STORE_KEYS.lastPull); }
}

// ---------------------------------------------------------------------------
// App controller
// ---------------------------------------------------------------------------

class App {
    constructor() {
        this.store = new FeedStore();
        this.sync = new GitHubSync(this.store);
        this.currentArticle = null;
        this.filteredArticles = [];
        this.currentIndex = -1;
        this.renderedCount = 0;
        this.RENDER_BATCH = 50;
        this.toc = null;
        this.library = { have: new Set(), unobtainableDois: new Set(), unobtainablePmids: new Set() };
        this._sessionCount = 0;
        this._lastAction = null;
        // Which list is on screen: 'list' (feed), 'toc' or 'board'. Keep/skip
        // re-render the active view so triage advances in place.
        this._currentView = 'list';
        this.filters = {
            search: '', quickFilter: 'all', status: 'all',
            researchers: [], minScore: 0, sort: 'score', journal: '',
        };

        this._bindElements();
        this._applyConfigToDom();
        this._bindEvents();
        this._bindKeyboard();
        this._registerSW();
        this._updateBatchSizeButtons();
        this._updateSyncStatus();
        this.loadLibrary();
        this.loadFeed().then(() => this._autoPull());
        this.loadToc();
        this.loadBoardData();
    }

    // -- config into the DOM ------------------------------------------------

    _applyConfigToDom() {
        document.title = CONFIG.appName;
        const title = document.getElementById('app-title');
        if (title) title.textContent = CONFIG.appName;

        // One filter chip per watchlist, inserted before the TOC chip so the
        // subject streams sit with the other content filters.
        const chips = this.el.quickFilters;
        const tocChip = chips?.querySelector('[data-filter="toc"]');
        for (const w of CONFIG.watchlists) {
            const btn = document.createElement('button');
            btn.className = 'chip';
            btn.dataset.filter = `watch:${w.label}`;
            btn.textContent = w.name;
            chips.insertBefore(btn, tocChip);
        }

        const hint = CONFIG.tags.some(t => t.hotkey)
            ? `1-9, ${CONFIG.tags.filter(t => t.hotkey).map(t => t.hotkey).join(', ')}`
            : '1-9';
        for (const id of ['tag-hint', 'tag-hint-sidebar']) {
            const el = document.getElementById(id);
            if (el) el.textContent = hint;
        }

        this._renderQueueOptionGroups();
        this._updateRepoFields();
    }

    // The optional per-article dropdowns declared in config.yaml. Rendered into
    // both the desktop and mobile triage panes, or nothing at all when none are
    // configured — which is the common case.
    _renderQueueOptionGroups() {
        const html = CONFIG.queueOptions.map(opt => `
            <div class="triage-section">
                <h4>${this._esc(opt.label)}</h4>
                <div class="queue-option-group" data-option="${this._esc(opt.key)}">
                    <button class="queue-opt" data-value="">Default</button>
                    ${opt.values.map(v =>
                        `<button class="queue-opt" data-value="${this._esc(v.value)}">${this._esc(v.label)}</button>`
                    ).join('')}
                </div>
            </div>`).join('');

        for (const id of ['detail-queue-options', 'mobile-queue-options']) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.innerHTML = html;
            el.addEventListener('click', (e) => {
                const btn = e.target.closest('.queue-opt');
                if (!btn || !this.currentArticle) return;
                const key = btn.closest('.queue-option-group')?.dataset.option;
                if (!key) return;
                const draft = this.store.getDraft(this.currentArticle.id);
                this.store.setDraft(this.currentArticle.id, {
                    options: { ...(draft.options || {}), [key]: btn.dataset.value },
                });
                this._updateSidebarState();
            });
        }
    }

    // -- library cross-reference -------------------------------------------

    async loadLibrary() {
        try {
            const resp = await fetch('library.json');
            if (!resp.ok) return;
            const data = await resp.json();
            this.library.have = new Set((data.haveDois || []).map(d => this._normDoi(d)));
            this.library.unobtainableDois = new Set((data.unobtainableDois || []).map(d => this._normDoi(d)));
            this.library.unobtainablePmids = new Set((data.unobtainablePmids || []).map(String));
            if (this.store.articles.length) this._reRenderCurrentView();
            if (this.currentArticle) this._renderLibraryBadge(this.currentArticle);
        } catch { /* no library.json — badges simply don't show */ }
    }

    _normDoi(doi) {
        if (!doi) return '';
        return String(doi).trim().toLowerCase()
            .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
            .replace(/^doi:\s*/, '');
    }

    _libraryStatus(art) {
        const doi = this._normDoi(art.doi);
        if (doi && this.library.have.has(doi)) return 'have';
        if (doi && this.library.unobtainableDois.has(doi)) return 'unobtainable';
        if (art.pmid && this.library.unobtainablePmids.has(String(art.pmid))) return 'unobtainable';
        return '';
    }

    // -- element binding ----------------------------------------------------

    _bindElements() {
        this.el = {
            feedList: document.getElementById('feed-list'),
            searchInput: document.getElementById('search-input'),
            quickFilters: document.getElementById('quick-filters'),
            statusText: document.getElementById('status-text'),
            syncDot: document.getElementById('sync-dot'),
            detailView: document.getElementById('detail-view'),
            detailScore: document.getElementById('detail-score'),
            detailTitle: document.getElementById('detail-title'),
            detailAuthors: document.getElementById('detail-authors'),
            detailJournal: document.getElementById('detail-journal'),
            detailResearcher: document.getElementById('detail-researcher-badge'),
            detailLibrary: document.getElementById('detail-library-badge'),
            detailAbstract: document.getElementById('detail-abstract'),
            detailTitleShort: document.querySelector('.detail-title-short'),
            btnPubmed: document.getElementById('btn-pubmed'),
            btnCopyDoi: document.getElementById('btn-copy-doi'),
            btnPrev: document.getElementById('btn-prev'),
            btnNext: document.getElementById('btn-next'),
            navCounter: document.getElementById('nav-counter'),
            filterPanel: document.getElementById('filter-panel'),
            filterBadge: document.getElementById('filter-badge'),
            filterStatus: document.getElementById('filter-status'),
            filterResearchers: document.getElementById('filter-researchers'),
            filterMinScore: document.getElementById('filter-min-score'),
            minScoreValue: document.getElementById('min-score-value'),
            filterSort: document.getElementById('filter-sort'),
            filterJournal: document.getElementById('filter-journal'),
            settingsPanel: document.getElementById('settings-panel'),
            settingsPat: document.getElementById('settings-pat'),
            settingsGhOwner: document.getElementById('settings-gh-owner'),
            settingsGhRepo: document.getElementById('settings-gh-repo'),
            settingsGhPath: document.getElementById('settings-gh-path'),
            settingsBatchSize: document.getElementById('settings-batch-size'),
            settingsBatchStatus: document.getElementById('settings-batch-status'),
            syncStatus: document.getElementById('sync-status'),
            btnSync: document.getElementById('btn-sync'),
            sidebar: document.getElementById('sidebar'),
            sidebarTags: document.getElementById('sidebar-tags'),
            sidebarPriority: document.getElementById('sidebar-priority'),
            sidebarExclude: document.getElementById('sidebar-exclude'),
            sidebarNotes: document.getElementById('sidebar-notes'),
            sidebarPubmed: document.getElementById('sidebar-pubmed'),
            sidebarCopyDoi: document.getElementById('sidebar-copy-doi'),
            btnCommit: document.getElementById('btn-commit'),
            btnSkip: document.getElementById('btn-skip'),
            detailTags: document.getElementById('detail-tags'),
            detailPriority: document.getElementById('detail-priority'),
            detailExclude: document.getElementById('detail-exclude'),
            detailNotesDesktop: document.getElementById('detail-notes-desktop'),
            detailCommit: document.getElementById('detail-commit'),
            detailSkip: document.getElementById('detail-skip'),
            tabNotes: document.getElementById('tab-notes'),
            tabQueue: document.getElementById('tab-queue'),
            tabKb: document.getElementById('tab-kb'),
            queueList: document.getElementById('queue-list'),
            kbContent: document.getElementById('kb-content'),
        };
    }

    _bindEvents() {
        this.el.searchInput.addEventListener('input', () => {
            this.filters.search = this.el.searchInput.value.trim().toLowerCase();
            this.renderList();
        });

        this.el.quickFilters.addEventListener('click', (e) => {
            const chip = e.target.closest('.chip');
            if (!chip) return;
            this.el.quickFilters.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            this.filters.quickFilter = chip.dataset.filter;
            if (chip.dataset.filter === 'toc') {
                this._currentView = 'toc';
                this.renderToc();
            } else if (chip.dataset.filter === 'pipeline') {
                this._currentView = 'board';
                this.renderBoard();
            } else {
                this._currentView = 'list';
                this.renderList();
            }
        });

        document.getElementById('btn-filter').addEventListener('click', () => this._openFilterPanel());
        document.getElementById('btn-close-filter').addEventListener('click', () => this._closeFilterPanel());
        document.getElementById('btn-refresh').addEventListener('click', () => this.loadFeed(true));
        document.getElementById('btn-back').addEventListener('click', () => this.closeDetail());

        this.el.btnPrev.addEventListener('click', () => this._navigate(-1));
        this.el.btnNext.addEventListener('click', () => this._navigate(1));

        this.el.btnCopyDoi.addEventListener('click', () => this._copyDoi());
        this.el.sidebarCopyDoi?.addEventListener('click', () => this._copyDoi());

        this.el.filterStatus.addEventListener('click', (e) => {
            const chip = e.target.closest('.chip');
            if (!chip) return;
            this.el.filterStatus.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            this.filters.status = chip.dataset.value;
        });

        this.el.filterMinScore.addEventListener('input', () => {
            this.filters.minScore = parseInt(this.el.filterMinScore.value, 10);
            this.el.minScoreValue.textContent = this.filters.minScore;
        });

        this.el.filterSort.addEventListener('click', (e) => {
            const chip = e.target.closest('.chip');
            if (!chip) return;
            this.el.filterSort.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            this.filters.sort = chip.dataset.value;
        });

        this.el.filterJournal.addEventListener('change', () => {
            this.filters.journal = this.el.filterJournal.value;
        });

        document.getElementById('btn-clear-filters').addEventListener('click', () => {
            this.filters = { search: '', quickFilter: 'all', status: 'all', researchers: [], minScore: 0, sort: 'score', journal: '' };
            this.el.searchInput.value = '';
            this.el.filterMinScore.value = 0;
            this.el.minScoreValue.textContent = '0';
            this.el.filterJournal.value = '';
            this.el.filterStatus.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            this.el.filterStatus.querySelector('[data-value="all"]').classList.add('active');
            this.el.filterSort.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            this.el.filterSort.querySelector('[data-value="score"]').classList.add('active');
            this.el.filterResearchers.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            this.el.quickFilters.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            this.el.quickFilters.querySelector('[data-filter="all"]').classList.add('active');
            this._currentView = 'list';
            this._closeFilterPanel();
        });

        this.el.btnSync.addEventListener('click', () => this._doSync());
        document.getElementById('btn-pull')?.addEventListener('click', () => this._doPull());
        document.getElementById('btn-export')?.addEventListener('click', () => this._exportTriage());

        // --- settings ---
        document.getElementById('btn-settings').addEventListener('click', () => {
            // Never prefill the secret — an autofilling password manager would
            // overwrite it, and the close handler would then save the overwrite.
            this.el.settingsPat.value = '';
            this._updateRepoFields();
            this._updateTokenSummary();
            this._updateBatchSizeButtons();
            this._updateSyncStatus();
            this.el.settingsPanel.classList.remove('hidden');
        });
        document.getElementById('btn-close-settings').addEventListener('click', () => this._closeSettings());
        document.getElementById('btn-clear-token')?.addEventListener('click', () => {
            this.sync.clearToken();
            this.el.settingsPat.value = '';
            document.getElementById('token-status').textContent = '';
            this._updateTokenSummary();
            this._toast('Token cleared');
        });

        for (const el of [this.el.settingsGhOwner, this.el.settingsGhRepo, this.el.settingsGhPath]) {
            el?.addEventListener('change', () => this._saveRepoFromFields());
        }

        document.getElementById('btn-test-token')?.addEventListener('click', async () => {
            const status = document.getElementById('token-status');
            this._saveRepoFromFields();
            // Test what's typed; with nothing typed, test the saved token.
            const typed = this.el.settingsPat.value;
            const token = typed.trim() ? typed : this.sync._getToken();

            status.className = 'settings-hint';
            status.textContent = 'Checking…';

            const result = await this.sync.testToken(token);
            status.textContent = result.message;
            status.className = 'settings-hint ' + (result.ok ? 'token-good' : 'token-bad');

            if (result.ok) {
                this.sync.setToken(token);
                this.el.settingsPat.value = '';
                this._updateTokenSummary();
            } else {
                document.getElementById('token-help').open = true;
            }
        });

        this.el.settingsBatchSize?.addEventListener('click', (e) => {
            const chip = e.target.closest('.chip');
            if (!chip) return;
            this.sync.setBatchSize(chip.dataset.value);
            this._updateBatchSizeButtons();
            this._updateSyncStatus();
        });

        // --- triage controls, all three layouts ---
        for (const el of [this.el.sidebarTags, this.el.detailTags, document.getElementById('mobile-tags')]) {
            el?.addEventListener('click', (e) => {
                const chip = e.target.closest('.tag-chip');
                if (chip) this._toggleTag(chip.dataset.tag);
            });
        }
        for (const el of [this.el.sidebarPriority, this.el.detailPriority, document.getElementById('mobile-priority')]) {
            el?.addEventListener('click', () => this._cyclePriority());
        }
        for (const el of [this.el.sidebarExclude, this.el.detailExclude, document.getElementById('mobile-exclude')]) {
            el?.addEventListener('click', () => this._toggleExclude());
        }
        for (const el of [this.el.sidebarNotes, this.el.detailNotesDesktop, document.getElementById('detail-notes')]) {
            el?.addEventListener('input', (e) => {
                if (!this.currentArticle) return;
                this.store.setDraft(this.currentArticle.id, { notes: e.target.value });
                this._syncNotesFields(e.target);
            });
        }
        for (const el of [this.el.btnCommit, this.el.detailCommit, document.getElementById('mobile-commit')]) {
            el?.addEventListener('click', () => this._commitCurrent());
        }
        for (const el of [this.el.btnSkip, this.el.detailSkip, document.getElementById('mobile-skip')]) {
            el?.addEventListener('click', () => this._skipCurrent());
        }
        for (const id of ['btn-undo', 'detail-undo', 'mobile-undo']) {
            document.getElementById(id)?.addEventListener('click', () => this._undoLast());
        }

        // --- sidebar tabs ---
        [this.el.tabNotes, this.el.tabQueue, this.el.tabKb].forEach(tab => {
            tab?.addEventListener('click', () => {
                const target = tab.dataset.panel;
                document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(target)?.classList.add('active');
                if (target === 'panel-queue') this._renderQueue();
                if (target === 'panel-kb') this._renderKb();
            });
        });

        this.el.feedList.addEventListener('scroll', () => {
            const { scrollTop, scrollHeight, clientHeight } = this.el.feedList;
            if (scrollTop + clientHeight >= scrollHeight - 200) this._renderMoreCards();
        });
    }

    _copyDoi() {
        if (!this.currentArticle?.doi) return;
        navigator.clipboard.writeText(this.currentArticle.doi).then(() => this._toast('DOI copied'));
    }

    _syncNotesFields(source) {
        const value = source.value;
        for (const el of [this.el.sidebarNotes, this.el.detailNotesDesktop, document.getElementById('detail-notes')]) {
            if (el && el !== source) el.value = value;
        }
    }

    // -- keyboard -----------------------------------------------------------

    _bindKeyboard() {
        document.addEventListener('keydown', (e) => {
            const tag = e.target.tagName;
            const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
            // Enter and Delete must not trigger triage from a text field the user
            // is deliberately typing into.
            const isTextField = ['search-input', 'settings-pat', 'settings-gh-owner',
                                 'settings-gh-repo', 'settings-gh-path'].includes(e.target.id);

            if (e.key === 'Escape') {
                if (!this.el.settingsPanel.classList.contains('hidden')) {
                    this._closeSettings();
                } else if (!this.el.filterPanel.classList.contains('hidden')) {
                    this._closeFilterPanel();
                } else if (isInput) {
                    e.target.blur();
                } else if (!this.el.detailView.classList.contains('hidden') && window.innerWidth < 1200) {
                    this.closeDetail();
                }
                return;
            }

            // Enter and Delete work from the notes textarea, so a decision does
            // not require reaching for the mouse mid-note.
            if (this.currentArticle && !isTextField) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this._commitCurrent();
                    return;
                }
                if ((e.key === 'Delete' || e.key === 'Backspace') && !isInput) {
                    e.preventDefault();
                    this._skipCurrent();
                    return;
                }
            }

            if (isInput) return;

            if (e.key === 'j' || e.key === 'ArrowDown') {
                e.preventDefault();
                if (this.currentIndex < 0 && this.filteredArticles.length > 0) this.openDetail(0);
                else this._navigate(1);
                return;
            }
            if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); this._navigate(-1); return; }
            if (e.key === 'ArrowLeft') { this._navigate(-1); return; }
            if (e.key === 'ArrowRight') { this._navigate(1); return; }

            // Undo works with nothing selected, because keeping or skipping
            // advances past the very entry you may want back.
            if (e.key === 'u') { e.preventDefault(); this._undoLast(); return; }

            if (!this.currentArticle) return;

            if (e.key === 'd') { e.preventDefault(); this._skipCurrent(); return; }

            if (e.key >= '1' && e.key <= '9') {
                const idx = parseInt(e.key, 10) - 1;
                const names = tagNames();
                if (idx < Math.min(names.length, TAG_HOTKEY_COUNT)) this._toggleTag(names[idx]);
                return;
            }

            const byLetter = letterHotkeys()[e.key];
            if (byLetter) { this._toggleTag(byLetter); return; }

            if (e.key === 'p') { this._cyclePriority(); return; }
            if (e.key === 'x') { this._toggleExclude(); return; }
            if (e.key === 'n') {
                e.preventDefault();
                if (this.el.detailNotesDesktop && window.innerWidth >= 1200) this.el.detailNotesDesktop.focus();
                else if (this.el.sidebarNotes) this.el.sidebarNotes.focus();
                else document.getElementById('detail-notes')?.focus();
            }
        });
    }

    _toggleTag(tag) {
        if (!this.currentArticle || !tag) return;
        const draft = this.store.getDraft(this.currentArticle.id);
        const tags = draft.tags.includes(tag)
            ? draft.tags.filter(t => t !== tag)
            : [...draft.tags, tag];
        this.store.setDraft(this.currentArticle.id, { tags });
        this._updateSidebarState();
    }

    _cyclePriority() {
        if (!this.currentArticle) return;
        const draft = this.store.getDraft(this.currentArticle.id);
        const cycle = { normal: 'high', high: 'low', low: 'normal' };
        this.store.setDraft(this.currentArticle.id, { priority: cycle[draft.priority] || 'normal' });
        this._updateSidebarState();
    }

    _toggleExclude() {
        if (!this.currentArticle) return;
        const draft = this.store.getDraft(this.currentArticle.id);
        this.store.setDraft(this.currentArticle.id, { exclude: !draft.exclude });
        this._updateSidebarState();
    }

    // -- keep / skip --------------------------------------------------------

    _advanceAfterDecision(index) {
        this._reRenderCurrentView();
        if (index < this.filteredArticles.length) this.openDetail(index);
        else if (this.filteredArticles.length > 0) this.openDetail(this.filteredArticles.length - 1);
        else this.closeDetail();
    }

    async _commitCurrent() {
        if (!this.currentArticle) return;

        const art = this.currentArticle;
        const draft = this.store.getDraft(art.id);
        const prevDraft = JSON.parse(JSON.stringify(draft));
        const nextIndex = this.currentIndex;

        // Blur first, or a focused notes field carries its value to the next
        // article's textarea.
        document.activeElement?.blur();

        if (!this.sync.hasToken()) {
            // No token: keep locally. Useful for trying the app out, and the
            // export button in Settings gets the file out by hand.
            this.store.committed[art.id] = {
                ...draft, committedAt: new Date().toISOString(),
                title: art.title, authors: art.authors, journal: art.journal,
                year: art.year, doi: art.doi, score: art.score,
            };
            this.store.removeDraft(art.id);
            this._recordAction('commit', art.id, prevDraft);
            this._toast('Kept locally (no sync configured)');
            this._advanceAfterDecision(nextIndex);
            return;
        }

        this._setSyncDot('syncing');
        try {
            const result = await this.sync.commitArticle(art, draft);
            this._recordAction('commit', art.id, prevDraft);
            this._setSyncDot('ok');
            this._updateSyncStatus();
            this._toast(result.pushed
                ? (result.pushedCount === 1 ? 'Kept' : `Synced ${result.pushedCount} entries`)
                : `Queued locally (${result.pendingCount}/${result.batchSize})`);
            this._advanceAfterDecision(nextIndex);
        } catch (err) {
            this._setSyncDot('error');
            this._updateSyncStatus();
            if (this.store.committed[art.id]) {
                // The decision is recorded locally and queued; only the push failed.
                this._recordAction('commit', art.id, prevDraft);
                this._toast(`Saved locally, sync failed: ${err.message}`);
                this._advanceAfterDecision(nextIndex);
            } else {
                this._toast(`Keep failed: ${err.message}`);
            }
        }
    }

    async _skipCurrent() {
        if (!this.currentArticle) return;
        document.activeElement?.blur();

        const skipId = this.currentArticle.id;
        const prevDraft = JSON.parse(JSON.stringify(this.store.getDraft(skipId)));
        const nextIndex = this.currentIndex;

        if (this.sync.hasToken()) {
            this._setSyncDot('syncing');
            try {
                const result = await this.sync.skipArticle(skipId);
                this._setSyncDot('ok');
                this._updateSyncStatus();
                this._toast(result.pushed
                    ? (result.pushedCount === 1 ? 'Skipped' : `Synced ${result.pushedCount} entries`)
                    : `Skipped locally (${result.pendingCount}/${result.batchSize})`);
            } catch (err) {
                this._setSyncDot('error');
                // skipArticles already applied the change locally and queued it.
                this._updateSyncStatus();
                this._toast(`Saved locally, sync failed: ${err.message}`);
            }
        } else {
            if (!this.store.skippedIds.includes(skipId)) this.store.skippedIds.push(skipId);
            this.store.removeDraft(skipId);
            this._toast('Skipped');
        }

        this._recordAction('skip', skipId, prevDraft);
        this._advanceAfterDecision(nextIndex);
    }

    // One-click dismiss for a whole TOC issue or journal, as a single undoable
    // action — the difference between browsing a TOC and dreading it.
    async _dismissGroup(ids) {
        ids = ids.filter(id => this.store.isInReviewList(id));
        if (!ids.length) return;

        const prevDrafts = {};
        for (const id of ids) prevDrafts[id] = JSON.parse(JSON.stringify(this.store.getDraft(id)));
        if (this.currentArticle && ids.includes(this.currentArticle.id)) this.closeDetail();

        if (this.sync.hasToken()) {
            this._setSyncDot('syncing');
            try {
                const result = await this.sync.skipArticles(ids);
                this._setSyncDot('ok');
                this._toast(result.pushed
                    ? `Dismissed ${ids.length} — synced (u to undo)`
                    : `Dismissed ${ids.length} (${result.pendingCount}/${result.batchSize} queued · u to undo)`);
            } catch (err) {
                this._setSyncDot('error');
                this._toast(`Dismissed ${ids.length} locally, sync failed: ${err.message}`);
            }
            this._updateSyncStatus();
        } else {
            for (const id of ids) {
                if (!this.store.skippedIds.includes(id)) this.store.skippedIds.push(id);
                this.store.removeDraft(id);
            }
            this._toast(`Dismissed ${ids.length} (u to undo)`);
        }

        this._lastAction = { type: 'skip-bulk', ids, prevDrafts };
        this._sessionCount += ids.length;
        this._reRenderCurrentView();
        this._updateStatusBar();
    }

    // -- feed loading -------------------------------------------------------

    async loadFeed(forceRefresh = false) {
        const refreshBtn = document.getElementById('btn-refresh');
        refreshBtn.querySelector('svg').classList.add('spinning');
        this.el.statusText.textContent = 'Loading feed...';

        try {
            await this.store.fetchFeed();
            this._populateFilterOptions();
            this.renderList();
            this._updateStatusBar();
            if (forceRefresh) this._toast('Feed refreshed');
        } catch {
            this.el.statusText.textContent = 'Failed to load feed';
            this.el.feedList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">⚠️</div>
                    <h3>No feed yet</h3>
                    <p>Run <code>python generate_feed.py</code> to create <code>docs/feed.json</code>.</p>
                </div>`;
        } finally {
            refreshBtn.querySelector('svg').classList.remove('spinning');
        }
    }

    _updateStatusBar() {
        const kept = Object.keys(this.store.committed).length;
        const review = this.store.getReviewArticles().length;
        const session = this._sessionCount ? ` · ${this._sessionCount} triaged this session` : '';
        this.el.statusText.textContent = `Kept: ${kept} · Review: ${review} remaining${session}`;
    }

    _recordAction(type, articleId, prevDraft) {
        this._lastAction = { type, articleId, prevDraft };
        this._sessionCount += 1;
    }

    async _undoLast() {
        const act = this._lastAction;
        if (!act) { this._toast('Nothing to undo'); return; }
        this._lastAction = null; // single-step undo — consume it

        const ids = act.type === 'skip-bulk' ? act.ids : [act.articleId];
        for (const id of ids) {
            if (act.type === 'commit') {
                delete this.store.committed[id];
                delete this.sync._pending.committed[id];
            } else {
                this.store.skippedIds = this.store.skippedIds.filter(x => x !== id);
                this.sync._pending.skipped = this.sync._pending.skipped.filter(x => x !== id);
            }
            const prev = act.type === 'skip-bulk' ? act.prevDrafts?.[id] : act.prevDraft;
            if (prev) this.store.setDraft(id, prev);
        }
        this.sync._savePending();
        this._sessionCount = Math.max(0, this._sessionCount - ids.length);

        // The reversal has to reach the remote if the original may already be
        // there. canPush() stays false until a successful pull, so this can
        // never overwrite the remote with an unsynced store.
        if (this.sync.hasToken() && this.sync.canPush()) {
            this._setSyncDot('syncing');
            try {
                await this.sync.flushPending();
                this._setSyncDot('ok');
            } catch (err) {
                this._setSyncDot('error');
                this._toast(`Undone locally, sync failed: ${err.message}`);
            }
            this._updateSyncStatus();
        }

        this._reRenderCurrentView();
        if (act.type === 'skip-bulk') {
            this._updateStatusBar();
            this._toast(`Restored ${ids.length} dismissed articles`);
            return;
        }
        const idx = this.filteredArticles.findIndex(a => a.id === act.articleId);
        if (idx >= 0) this.openDetail(idx);
        else this._updateStatusBar();
        this._toast(act.type === 'commit' ? 'Keep undone' : 'Skip undone');
    }

    _reRenderCurrentView() {
        if (this._currentView === 'toc') this.renderToc();
        else if (this._currentView === 'board') this.renderBoard();
        else this.renderList();
    }

    // -- list rendering -----------------------------------------------------

    renderList() {
        this.filteredArticles = this._applyFilters();
        this._updateFilterBadge();
        this._updateStatusBar();
        this.renderedCount = 0;

        if (this.filteredArticles.length === 0) {
            this.el.feedList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📭</div>
                    <h3>Nothing matches</h3>
                    <p>Try adjusting your filters</p>
                </div>`;
            return;
        }

        const review = this.filteredArticles.filter(a => this.store.isInReviewList(a.id));
        const kept = this.filteredArticles.filter(a => !this.store.isInReviewList(a.id));
        this.filteredArticles = this.filters.quickFilter === 'committed' ? kept : review;

        const count = this.filteredArticles.length;
        let html = this.filters.quickFilter === 'committed'
            ? `<div class="section-header">Kept <span class="section-count">${count}</span></div>`
            : `<div class="section-header">Review <span class="section-count">${count}</span></div>`;
        html += '<div id="card-container"></div>';

        if (this.filters.quickFilter === 'all' && kept.length > 0) {
            html += `<div class="section-header section-collapsible" id="kept-toggle">Kept <span class="section-count">${kept.length}</span> <span class="section-chevron">▸</span></div>`;
            html += '<div id="kept-section" class="section-collapsed">';
            html += kept.slice(0, 20).map(art => this._renderCard(art, true)).join('');
            if (kept.length > 20) {
                html += `<div class="empty-state" style="padding:16px"><p>${kept.length - 20} more kept</p></div>`;
            }
            html += '</div>';
        }

        this.el.feedList.innerHTML = html;
        this._renderMoreCards();

        const toggle = document.getElementById('kept-toggle');
        if (toggle) {
            toggle.addEventListener('click', () => {
                const section = document.getElementById('kept-section');
                const chevron = toggle.querySelector('.section-chevron');
                section.classList.toggle('section-collapsed');
                chevron.textContent = section.classList.contains('section-collapsed') ? '▸' : '▾';
            });
        }
    }

    _renderMoreCards() {
        const container = document.getElementById('card-container');
        if (!container) return;

        const end = Math.min(this.renderedCount + this.RENDER_BATCH, this.filteredArticles.length);
        if (this.renderedCount >= end) return;

        const fragment = document.createDocumentFragment();
        for (let i = this.renderedCount; i < end; i++) {
            const div = document.createElement('div');
            div.innerHTML = this._renderCard(this.filteredArticles[i], false);
            const card = div.firstElementChild;
            card.addEventListener('click', () => {
                const idx = this.filteredArticles.findIndex(a => a.id === card.dataset.id);
                if (idx >= 0) this.openDetail(idx);
            });
            fragment.appendChild(card);
        }
        container.appendChild(fragment);
        this.renderedCount = end;
    }

    _renderCard(art, isKept = false) {
        const scoreClass = art.score >= 70 ? 'score-high' : art.score >= 40 ? 'score-mid' : 'score-low';
        const committed = this.store.committed[art.id];
        const state = committed || this.store.getDraft(art.id);
        const tags = state.tags || [];
        const priority = state.priority;

        const tagHtml = tags.map(t => `<span class="card-tag-chip">${this._esc(t)}</span>`).join('');
        const priorityHtml = priority === 'high' ? '<span class="card-priority-badge high">⚡</span>'
            : priority === 'low' ? '<span class="card-priority-badge low">↓</span>' : '';

        // researcherVerified === false means OpenAlex does not list the tracked
        // researcher's ORCID on this paper, so it may be a namesake. null means
        // unchecked, which is a different claim and must not be marked.
        const researcherTag = art.trackedResearcher
            ? `<span class="card-researcher-tag${art.researcherVerified === false ? ' unverified' : ''}"
                     title="${art.researcherVerified === false
                        ? 'ORCID not confirmed on this paper — may be a different author with the same name'
                        : this._esc(art.trackedResearcher)}">${
                this._esc(art.trackedResearcher.split(' ').pop())
              }${art.researcherVerified === false ? ' ?' : ''}</span>`
            : '';

        const libStatus = this._libraryStatus(art);
        const libHtml = libStatus === 'have'
            ? '<span class="card-lib-badge have" title="Full text already in your library">📄 PDF</span>'
            : libStatus === 'unobtainable'
                ? '<span class="card-lib-badge unobtainable" title="No full text — accepted as lost">⛔ No PDF</span>'
                : '';

        const selectedClass = this.currentArticle?.id === art.id ? 'selected' : '';

        return `
            <div class="article-card ${isKept ? 'committed' : ''} ${selectedClass}" data-id="${art.id}">
                <div class="card-score ${scoreClass}">${art.score}</div>
                <div class="card-content">
                    <div class="card-title">${this._esc(art.title)}</div>
                    <div class="card-meta">
                        <span>${this._esc(art.journal)}</span>
                        ${art.year ? `<span>· ${art.year}</span>` : ''}
                        ${researcherTag}
                        ${libHtml}
                        ${priorityHtml}
                    </div>
                    ${tagHtml ? `<div class="card-tags">${tagHtml}</div>` : ''}
                </div>
            </div>`;
    }

    // Your own notes and tags, lowercased — so search reaches your annotations
    // and not only the article metadata.
    _triageText(articleId) {
        const src = this.store.committed[articleId] || this.store.getDraft(articleId);
        if (!src) return '';
        return `${src.notes || ''} ${(src.tags || []).join(' ')}`.toLowerCase();
    }

    _applyFilters() {
        let articles = [...this.store.articles];
        const qf = this.filters.quickFilter;

        if (qf === 'unread') {
            articles = articles.filter(a => this.store.isInReviewList(a.id));
        } else if (qf === 'committed') {
            articles = articles.filter(a => !this.store.isInReviewList(a.id));
        } else if (qf === 'researcher') {
            articles = articles.filter(a => a.trackedResearcher);
        } else if (qf.startsWith('watch:')) {
            const label = qf.slice(6);
            articles = articles.filter(a => (a.source || '').includes(label));
        }

        if (this.filters.status !== 'all') {
            const sf = this.filters.status;
            if (sf === 'unread') articles = articles.filter(a => this.store.isInReviewList(a.id));
            else if (sf === 'committed') articles = articles.filter(a => !this.store.isInReviewList(a.id));
        }

        if (this.filters.researchers.length > 0) {
            articles = articles.filter(a =>
                a.trackedResearcher && this.filters.researchers.includes(a.trackedResearcher));
        }
        if (this.filters.minScore > 0) {
            articles = articles.filter(a => a.score >= this.filters.minScore);
        }
        if (this.filters.journal) {
            articles = articles.filter(a => a.journal === this.filters.journal);
        }
        if (this.filters.search) {
            const q = this.filters.search;
            articles = articles.filter(a =>
                (a.title || '').toLowerCase().includes(q) ||
                (a.authors || '').toLowerCase().includes(q) ||
                (a.abstract || '').toLowerCase().includes(q) ||
                this._triageText(a.id).includes(q));
        }

        if (this.filters.sort === 'score') articles.sort((a, b) => b.score - a.score);
        else if (this.filters.sort === 'date') articles.sort((a, b) => (b.fetchDate || '').localeCompare(a.fetchDate || ''));
        else if (this.filters.sort === 'journal') articles.sort((a, b) => (a.journal || '').localeCompare(b.journal || ''));

        return articles;
    }

    // -- detail view --------------------------------------------------------

    openDetail(index) {
        if (index < 0 || index >= this.filteredArticles.length) return;
        this.currentIndex = index;
        const article = this.filteredArticles[index];
        this.currentArticle = article;

        const scoreClass = article.score >= 70 ? 'score-high' : article.score >= 40 ? 'score-mid' : 'score-low';
        this.el.detailScore.className = `score-badge ${scoreClass}`;
        this.el.detailScore.textContent = `Score: ${article.score}`;

        this.el.detailTitle.textContent = article.title;
        this.el.detailTitleShort.textContent = article.title;
        this.el.detailAuthors.textContent = article.authors;
        this.el.detailJournal.textContent = `${article.journal}${article.year ? ` · ${article.year}` : ''}`;

        if (article.trackedResearcher) {
            const unverified = article.researcherVerified === false;
            this.el.detailResearcher.textContent = unverified
                ? `Tracked: ${article.trackedResearcher} — ORCID not confirmed, check the author`
                : `Tracked: ${article.trackedResearcher}`;
            this.el.detailResearcher.classList.toggle('unverified', unverified);
            this.el.detailResearcher.classList.remove('hidden');
        } else {
            this.el.detailResearcher.classList.add('hidden');
        }

        this._renderLibraryBadge(article);

        const matches = this._computeKeywordMatches(article);
        this.el.detailAbstract.innerHTML = article.abstract
            ? this._highlightKeywords(this._esc(article.abstract), matches.map(m => m.keyword))
            : 'No abstract available.';

        this._renderScoreBreakdown(matches, article);
        this._renderRelatedArticles(article);

        this.el.btnPubmed.href = `https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`;
        this.el.btnCopyDoi.style.display = article.doi ? '' : 'none';
        if (this.el.sidebarPubmed) {
            this.el.sidebarPubmed.href = `https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`;
        }

        this._updateNav();
        this._updateSidebarState();

        this.el.detailView.classList.remove('hidden');
        this.el.detailView.scrollTop = 0;
        this.el.feedList.querySelectorAll('.article-card').forEach(c => {
            c.classList.toggle('selected', c.dataset.id === article.id);
        });
    }

    _renderLibraryBadge(article) {
        const el = this.el.detailLibrary;
        if (!el) return;
        const status = this._libraryStatus(article);
        if (status === 'have') {
            el.textContent = '📄 Full text already in your library';
            el.className = 'library-badge have';
        } else if (status === 'unobtainable') {
            el.textContent = '⛔ No full text — accepted as lost';
            el.className = 'library-badge unobtainable';
        } else {
            el.className = 'library-badge hidden';
        }
    }

    _computeKeywordMatches(article) {
        const text = `${article.title || ''} ${article.abstract || ''}`.toLowerCase();
        const matches = [];
        for (const [keyword, weight] of Object.entries(CONFIG.scoreKeywords)) {
            const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const count = Math.min((text.match(new RegExp(escaped, 'gi')) || []).length, CONFIG.scoreMaxCount);
            if (count > 0) matches.push({ keyword, weight, count, points: weight * count });
        }
        matches.sort((a, b) => b.points - a.points);
        return matches;
    }

    _highlightKeywords(escapedText, keywords) {
        if (!keywords.length) return escapedText;
        // Longest first, so a phrase is highlighted whole rather than being
        // chopped up by one of its own words.
        const sorted = [...keywords].sort((a, b) => b.length - a.length);
        const pattern = sorted.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        return escapedText.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
    }

    _renderScoreBreakdown(matches, article) {
        const el = document.getElementById('detail-score-breakdown');
        if (!el) return;
        if (!matches.length) {
            el.innerHTML = '<p class="meta">No keyword matches</p>';
            return;
        }

        const bonuses = CONFIG.scoreBonuses || {};
        let bonusHtml = '';
        if ((article.abstract || '').length > (bonuses.abstract_min_chars || 200)) {
            bonusHtml += `<span class="kw-chip kw-bonus">+${bonuses.has_abstract || 0} abstract</span>`;
        }
        const titleLower = (article.title || '').toLowerCase();
        if ((bonuses.title_terms || []).some(t => titleLower.includes(String(t).toLowerCase()))) {
            bonusHtml += `<span class="kw-chip kw-bonus">+${bonuses.title_term_points || 0} title term</span>`;
        }

        el.innerHTML = matches.map(m => {
            const intensity = m.weight >= 10 ? 'kw-high' : m.weight >= 6 ? 'kw-med' : 'kw-low';
            const countLabel = m.count > 1 ? ` ×${m.count}` : '';
            return `<span class="kw-chip ${intensity}" title="${this._esc(m.keyword)}: ${m.weight}pts × ${m.count}">${this._esc(m.keyword)}${countLabel} <small>+${m.points}</small></span>`;
        }).join('') + bonusHtml;
    }

    _renderRelatedArticles(article) {
        const el = document.getElementById('detail-related');
        if (!el) return;
        const ids = Object.keys(this.store.committed);
        if (!ids.length) { el.innerHTML = ''; return; }

        const STOPWORDS = ['study', 'based', 'among', 'about', 'their', 'using', 'after',
                           'between', 'during', 'through', 'which', 'these', 'those', 'other'];
        const words = new Set(
            (article.title || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '')
                .split(/\s+/).filter(w => w.length > 4 && !STOPWORDS.includes(w))
        );

        const scored = ids.map(id => {
            if (String(id) === String(article.id)) return null;
            const c = this.store.committed[id];
            const overlap = (c.title || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '')
                .split(/\s+/).filter(w => words.has(w)).length;
            return overlap >= 2 ? { ...c, pmid: id, overlap } : null;
        }).filter(Boolean).sort((a, b) => b.overlap - a.overlap).slice(0, 5);

        if (!scored.length) {
            el.innerHTML = '<p class="meta">Nothing related kept yet</p>';
            return;
        }
        el.innerHTML = scored.map(r => `
            <div class="related-item">
                <span class="related-title">${this._esc((r.title || '').substring(0, 100))}</span>
                <span class="related-meta">${this._esc(r.journal || '')} · ${r.year || ''}</span>
                ${(r.tags || []).map(t => `<span class="card-tag-chip">${this._esc(t)}</span>`).join('')}
            </div>`).join('');
    }

    closeDetail() {
        if (window.innerWidth < 1200) this.el.detailView.classList.add('hidden');
        this.currentArticle = null;
        this.currentIndex = -1;
        this.el.feedList.querySelectorAll('.article-card.selected').forEach(c => c.classList.remove('selected'));
    }

    _navigate(direction) {
        const newIndex = this.currentIndex + direction;
        if (newIndex < 0 || newIndex >= this.filteredArticles.length) return;
        this.openDetail(newIndex);
    }

    _updateNav() {
        this.el.navCounter.textContent = `${this.currentIndex + 1} / ${this.filteredArticles.length}`;
        this.el.btnPrev.disabled = this.currentIndex <= 0;
        this.el.btnNext.disabled = this.currentIndex >= this.filteredArticles.length - 1;
    }

    // -- triage panes -------------------------------------------------------

    _updateSidebarState() {
        if (!this.currentArticle) return;
        const draft = this.store.getDraft(this.currentArticle.id);
        const isKept = !!this.store.committed[this.currentArticle.id];
        const labels = { normal: 'Normal', high: '⚡ High', low: '↓ Low' };
        const priorityLabel = labels[draft.priority] || 'Normal';

        for (const el of [this.el.sidebarTags, this.el.detailTags, document.getElementById('mobile-tags')]) {
            if (el) el.innerHTML = CONFIG.tags.map((t, i) =>
                this._tagChip(t, i, draft.tags.includes(t.name) ? 'active' : '')).join('');
        }
        for (const el of [this.el.sidebarPriority, this.el.detailPriority, document.getElementById('mobile-priority')]) {
            if (el) {
                el.textContent = priorityLabel;
                el.className = `priority-btn priority-${draft.priority || 'normal'}`;
            }
        }
        for (const el of [this.el.sidebarExclude, this.el.detailExclude, document.getElementById('mobile-exclude')]) {
            el?.classList.toggle('active', !!draft.exclude);
        }
        for (const el of [this.el.sidebarNotes, this.el.detailNotesDesktop, document.getElementById('detail-notes')]) {
            if (el) el.value = draft.notes || '';
        }

        const options = draft.options || {};
        for (const id of ['detail-queue-options', 'mobile-queue-options']) {
            document.getElementById(id)?.querySelectorAll('.queue-option-group').forEach(group => {
                const current = options[group.dataset.option] || '';
                group.querySelectorAll('.queue-opt').forEach(b =>
                    b.classList.toggle('active', b.dataset.value === current));
            });
        }

        for (const el of [this.el.btnCommit, this.el.detailCommit, document.getElementById('mobile-commit')]) {
            if (el) {
                el.disabled = isKept;
                el.textContent = isKept ? 'Already kept' : 'Keep (Enter)';
            }
        }
        for (const el of [this.el.btnSkip, this.el.detailSkip, document.getElementById('mobile-skip')]) {
            if (el) el.disabled = isKept;
        }
    }

    // Tags past the hotkey range get no number badge — showing "10" would
    // advertise a shortcut that does not exist. Pipeline tags are marked, since
    // an external script depends on their exact spelling.
    _tagChip(tag, i, active) {
        const badge = i < TAG_HOTKEY_COUNT
            ? `<span class="tag-num">${i + 1}</span>`
            : tag.hotkey
                ? `<span class="tag-num">${this._esc(tag.hotkey)}</span>`
                : '<span class="tag-num tag-num-none">→</span>';
        const pipeline = tag.pipeline ? ' tag-pipeline' : '';
        return `<button class="tag-chip${pipeline} ${active}" data-tag="${this._esc(tag.name)}">${badge} ${this._esc(tag.name)}</button>`;
    }

    // -- queue tab ----------------------------------------------------------

    _renderQueue() {
        if (!this.el.queueList) return;
        const order = { high: 0, normal: 1, low: 2 };
        const kept = Object.entries(this.store.committed)
            .filter(([, v]) => !v.exclude)
            .map(([pmid, v]) => ({ pmid, ...v }))
            .sort((a, b) => (order[a.priority] ?? 1) - (order[b.priority] ?? 1));

        if (!kept.length) {
            this.el.queueList.innerHTML = '<div class="empty-state" style="padding:24px"><p>Queue is empty</p></div>';
            return;
        }

        this.el.queueList.innerHTML = kept.map(art => {
            const badge = art.priority === 'high' ? '<span class="card-priority-badge high">⚡</span>'
                : art.priority === 'low' ? '<span class="card-priority-badge low">↓</span>' : '';
            return `
                <div class="queue-item" data-pmid="${this._esc(art.pmid)}">
                    <div class="card-content">
                        <div class="card-title">${this._esc(art.title)}</div>
                        <div class="card-meta"><span>${this._esc(art.journal || '')}</span> ${badge}</div>
                    </div>
                </div>`;
        }).join('');
    }

    // -- notes / knowledge tab ---------------------------------------------

    _renderKb() {
        if (!this.el.kbContent) return;
        if (this._kbText !== undefined) {
            this.el.kbContent.innerHTML = this._kbText
                ? `<pre class="kb-text">${this._esc(this._kbText)}</pre>`
                : `<div class="empty-state" style="padding:24px"><p>No ${this._esc(CONFIG.knowledgeFile)} in docs/</p></div>`;
            return;
        }
        fetch(CONFIG.knowledgeFile)
            .then(r => (r.ok ? r.text() : ''))
            .then(text => { this._kbText = text; this._renderKb(); })
            .catch(() => { this._kbText = ''; this._renderKb(); });
    }

    // -- TOC view -----------------------------------------------------------

    async loadToc() {
        try {
            const resp = await fetch('toc.json');
            this.toc = resp.ok ? await resp.json() : null;
        } catch {
            this.toc = null;
        }
    }

    // Flatten toc.json into feed-shaped articles grouped by journal and issue,
    // dropping anything the main feed already surfaces (reviewable there) or
    // that you already rejected.
    _buildTocArticles() {
        const feedIds = new Set(this.store.articles.map(a => String(a.id)));
        const skipped = new Set(this.store.skippedIds.map(String));
        const groups = [];
        const flat = [];
        let dedupCount = 0;

        for (const journal of this.toc.journals || []) {
            const kept = [];
            const issueMap = new Map();
            for (const art of journal.articles || []) {
                const id = String(art.id ?? art.pmid);
                if (feedIds.has(id) || skipped.has(id)) { dedupCount++; continue; }
                const article = {
                    ...art, id,
                    journal: art.journal || journal.name,
                    score: typeof art.score === 'number' ? art.score : 0,
                    source: 'toc',
                };
                kept.push(article);

                const label = article.volume
                    ? `Vol ${article.volume}${article.issue ? ` · No ${article.issue}` : ''}`
                    : 'Online first';
                if (!issueMap.has(label)) issueMap.set(label, []);
                issueMap.get(label).push(article);
            }
            if (kept.length) {
                const issues = [...issueMap].map(([label, articles]) => ({ label, articles }));
                // flat drives j/k navigation and auto-advance, so it must match
                // the rendered order (issue groups), not the raw fetch order.
                for (const iss of issues) flat.push(...iss.articles);
                groups.push({ name: journal.name, articles: kept, issues });
            }
        }
        return { groups, flat, dedupCount };
    }

    renderToc() {
        if (!this.toc || !this.toc.journals) {
            this.el.feedList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📚</div>
                    <h3>No TOC data</h3>
                    <p>Run <code>python fetch_toc.py</code>, with journals listed in config.yaml</p>
                </div>`;
            this.filteredArticles = [];
            return;
        }

        const { groups, flat, dedupCount } = this._buildTocArticles();
        // Nav, detail, keep and skip all read filteredArticles, so pointing it at
        // the flat TOC list makes these papers triage exactly like the feed.
        this.filteredArticles = flat;

        const date = new Date(this.toc.generated).toLocaleDateString();
        const windowLabel = this.toc.reldate ? `last ${this.toc.reldate} days` : 'recent';

        if (flat.length === 0) {
            this.el.feedList.innerHTML = `
                <div class="section-header">Journal tables of contents <span class="section-count">${date}</span></div>
                <div class="empty-state">
                    <div class="empty-state-icon">✓</div>
                    <h3>Nothing new to browse</h3>
                    <p>All ${dedupCount} ${windowLabel} articles are already in your feed or reviewed.</p>
                </div>`;
            return;
        }

        const dedupNote = dedupCount > 0 ? ` · ${dedupCount} already in feed or reviewed, hidden` : '';
        let html = `<div class="section-header">Journal tables of contents ` +
            `<span class="section-count">${flat.length} new · ${date}${dedupNote}</span></div>`;

        // Each dismiss button bulk-skips its group. The id lists live here,
        // keyed by index, rather than being serialised into the DOM.
        this._dismissGroups = [];
        const dismissBtn = (articles) => {
            const ids = articles.filter(a => this.store.isInReviewList(a.id)).map(a => a.id);
            if (!ids.length) return '';
            const key = this._dismissGroups.push(ids) - 1;
            return `<button class="toc-dismiss" data-key="${key}">Dismiss ${ids.length}</button>`;
        };

        for (const group of groups) {
            const soleLabel = group.issues.length === 1 && group.issues[0].label !== 'Online first'
                ? ` <span class="toc-issue-label">${this._esc(group.issues[0].label)}</span>` : '';
            html += `<div class="toc-journal-header"><span>${this._esc(group.name)}${soleLabel}</span>` +
                `<span class="toc-journal-actions">${dismissBtn(group.articles)}` +
                `<span class="toc-journal-count">${group.articles.length}</span></span></div>`;
            for (const iss of group.issues) {
                if (group.issues.length > 1) {
                    html += `<div class="toc-issue-header"><span>${this._esc(iss.label)}</span>` +
                        `<span class="toc-journal-actions">${dismissBtn(iss.articles)}` +
                        `<span class="toc-journal-count">${iss.articles.length}</span></span></div>`;
                }
                html += iss.articles.map(art => this._renderCard(art, !this.store.isInReviewList(art.id))).join('');
            }
        }

        this.el.feedList.innerHTML = html;

        this.el.feedList.querySelectorAll('.article-card').forEach(card => {
            card.addEventListener('click', () => {
                const idx = this.filteredArticles.findIndex(a => a.id === card.dataset.id);
                if (idx >= 0) this.openDetail(idx);
            });
        });
        this.el.feedList.querySelectorAll('.toc-dismiss').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._dismissGroup(this._dismissGroups[Number(btn.dataset.key)] || []);
            });
        });
    }

    // -- board view ---------------------------------------------------------

    // done.json is written by whatever you do downstream — a writing pipeline, a
    // reading log, an export script. Shape: {"idToLabel": {"12345678": "Ep 12"}}.
    // Absent, the Done column is simply always empty.
    async loadBoardData() {
        this._doneIds = {};
        this._todos = {};
        try {
            const resp = await fetch('done.json');
            if (resp.ok) this._doneIds = (await resp.json()).idToLabel || {};
        } catch { /* optional */ }
        try {
            const resp = await fetch('todos.json');
            if (resp.ok) {
                for (const t of (await resp.json()).todos || []) {
                    if (t.pmid) this._todos[String(t.pmid)] = t;
                }
            }
        } catch { /* optional */ }
    }

    renderBoard() {
        const done = this._doneIds || {};
        const todos = this._todos || {};
        const columns = { queue: [], needsText: [], done: [], excluded: [], untagged: [] };

        for (const [pmid, art] of Object.entries(this.store.committed)) {
            const entry = { pmid, ...art };
            if (done[pmid]) columns.done.push({ ...entry, doneLabel: done[pmid] });
            else if (art.exclude) columns.excluded.push(entry);
            else if (todos[pmid] && !todos[pmid].done) columns.needsText.push(entry);
            else if (!(art.tags || []).length) columns.untagged.push(entry);
            else columns.queue.push(entry);
        }

        const order = { high: 0, normal: 1, low: 2 };
        columns.queue.sort((a, b) => (order[a.priority] ?? 1) - (order[b.priority] ?? 1));

        const renderCol = (title, icon, items, extraClass) => {
            let html = `<div class="pipeline-column ${extraClass || ''}">`;
            html += `<div class="pipeline-header">${icon} ${title} <span class="pipeline-count">${items.length}</span></div>`;
            if (!items.length) {
                html += '<div class="pipeline-empty">None</div>';
            } else {
                for (const art of items) {
                    const tags = (art.tags || []).map(t => `<span class="card-tag-chip">${this._esc(t)}</span>`).join('');
                    const doneBadge = art.doneLabel ? `<span class="pipeline-ep-badge">${this._esc(art.doneLabel)}</span>` : '';
                    const pBadge = art.priority === 'high' ? '<span class="card-priority-badge high">⚡</span>' : '';
                    const notes = art.notes
                        ? `<div class="pipeline-notes">${this._esc(art.notes.slice(0, 80))}${art.notes.length > 80 ? '…' : ''}</div>`
                        : '';
                    html += `<div class="pipeline-card">
                        <div class="card-title">${this._esc((art.title || '').slice(0, 90))}${(art.title || '').length > 90 ? '…' : ''}</div>
                        <div class="card-meta"><span>${this._esc((art.authors || '').split(',')[0])}</span> ${doneBadge} ${pBadge}</div>
                        ${tags ? `<div class="card-tags">${tags}</div>` : ''}
                        ${notes}
                    </div>`;
                }
            }
            return html + '</div>';
        };

        let html = '<div class="pipeline-summary">';
        html += `<span>Feed: ${this.store.articles.length}</span>`;
        html += `<span>Skipped: ${this.store.skippedIds.length}</span>`;
        html += `<span>Review: ${this.store.getReviewArticles().length}</span>`;
        html += `<span>Kept: ${Object.keys(this.store.committed).length}</span>`;
        html += '</div><div class="pipeline-board">';
        html += renderCol('Queue', '📋', columns.queue, 'col-queue');
        html += renderCol('Full text needed', '📥', columns.needsText, 'col-pdf');
        html += renderCol('Done', '✅', columns.done, 'col-done');
        html += renderCol('Excluded', '🔇', columns.excluded, 'col-excluded');
        if (columns.untagged.length) html += renderCol('Untagged', '❓', columns.untagged, 'col-notags');
        html += '</div>';

        this.el.feedList.innerHTML = html;
    }

    // -- filter panel -------------------------------------------------------

    _openFilterPanel() {
        this.el.filterStatus.querySelectorAll('.chip').forEach(c =>
            c.classList.toggle('active', c.dataset.value === this.filters.status));
        this.el.filterSort.querySelectorAll('.chip').forEach(c =>
            c.classList.toggle('active', c.dataset.value === this.filters.sort));
        this.el.filterMinScore.value = this.filters.minScore;
        this.el.minScoreValue.textContent = this.filters.minScore;
        this.el.filterJournal.value = this.filters.journal;
        this.el.filterPanel.classList.remove('hidden');
    }

    _closeFilterPanel() {
        this.filters.researchers = [];
        this.el.filterResearchers.querySelectorAll('.chip.active').forEach(c =>
            this.filters.researchers.push(c.dataset.value));
        this.el.filterPanel.classList.add('hidden');
        this._reRenderCurrentView();
    }

    _populateFilterOptions() {
        const researchers = [...new Set(
            this.store.articles.filter(a => a.trackedResearcher).map(a => a.trackedResearcher))];
        this.el.filterResearchers.innerHTML = researchers.map(name =>
            `<button class="chip" data-value="${this._esc(name)}">${this._esc(name.split(' ').pop())}</button>`
        ).join('');
        this.el.filterResearchers.querySelectorAll('.chip').forEach(chip =>
            chip.addEventListener('click', () => chip.classList.toggle('active')));

        const journals = [...new Set(this.store.articles.map(a => a.journal).filter(Boolean))].sort();
        this.el.filterJournal.innerHTML = '<option value="">All journals</option>' +
            journals.map(j => `<option value="${this._esc(j)}">${this._esc(j)}</option>`).join('');
    }

    _updateFilterBadge() {
        let count = 0;
        if (this.filters.status !== 'all') count++;
        if (this.filters.researchers.length > 0) count++;
        if (this.filters.minScore > 0) count++;
        if (this.filters.journal) count++;
        if (this.filters.sort !== 'score') count++;

        this.el.filterBadge.textContent = count;
        this.el.filterBadge.classList.toggle('hidden', count === 0);
    }

    // -- sync ---------------------------------------------------------------

    async _autoPull() {
        if (!this.sync.hasToken() || !this.sync.isConfigured()) return;
        try {
            this._setSyncDot('syncing');
            const count = await this.sync.pull();
            this._setSyncDot('ok');
            this._updateSyncStatus();
            if (count > 0) {
                this._toast(`Loaded ${count} kept articles`);
                this._reRenderCurrentView();
            }
        } catch (err) {
            // Never swallow this. A failed pull blocks pushing, and silence here
            // is what lets an empty store masquerade as "nothing kept yet".
            this._setSyncDot('error');
            this._toast(`Sync offline: ${err.message}`);
        }
    }

    async _doPull() {
        if (!this.sync.hasToken()) { this._toast('Set a GitHub token in Settings first'); return; }
        try {
            this._setSyncDot('syncing');
            const count = await this.sync.pull();
            this._setSyncDot('ok');
            this._toast(`Pulled ${count} kept articles`);
            this._reRenderCurrentView();
            this._updateSyncStatus();
        } catch (err) {
            this._setSyncDot('error');
            this._toast(`Pull failed: ${err.message}`);
        }
    }

    async _doSync() {
        if (!this.sync.hasToken()) {
            this._toast('Set a GitHub token in Settings first');
            this.el.settingsPat.value = '';
            this._updateTokenSummary();
            this.el.settingsPanel.classList.remove('hidden');
            return;
        }
        this._setSyncDot('syncing');
        try {
            const result = await this.sync.flushPending();
            this._setSyncDot('ok');
            this._updateSyncStatus();
            this._toast(result.pushedCount > 0
                ? `Synced ${result.pushedCount} queued ${result.pushedCount === 1 ? 'entry' : 'entries'}`
                : 'Synced');
        } catch (err) {
            this._setSyncDot('error');
            this._toast(`Sync failed: ${err.message}`);
        }
    }

    // A way out that does not depend on GitHub: download the same triage.json
    // the app would push. Also the answer to "how do I get my data out".
    _exportTriage() {
        const blob = new Blob([JSON.stringify(this.sync.triageDocument(), null, 2)],
            { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'triage.json';
        a.click();
        URL.revokeObjectURL(a.href);
        this._toast('Exported triage.json');
    }

    _closeSettings() {
        this._saveRepoFromFields();
        this._saveTokenFromField();
        this.el.settingsPanel.classList.add('hidden');
    }

    _saveRepoFromFields() {
        this.sync.setRepo({
            owner: this.el.settingsGhOwner?.value,
            repo: this.el.settingsGhRepo?.value,
            path: this.el.settingsGhPath?.value,
        });
        this._updateRepoFields();
    }

    _updateRepoFields() {
        const r = this.sync.repo();
        if (this.el.settingsGhOwner) this.el.settingsGhOwner.value = r.owner;
        if (this.el.settingsGhRepo) this.el.settingsGhRepo.value = r.repo;
        if (this.el.settingsGhPath) this.el.settingsGhPath.value = r.path;
        const summary = document.getElementById('repo-summary');
        if (summary) {
            summary.textContent = this.sync.isConfigured()
                ? `Syncing to ${this.sync.repoLabel()}/${r.path}`
                : 'No repository set — decisions stay in this browser until you set one.';
        }
    }

    // Persist only a deliberately entered token; an empty field means "leave the
    // saved one alone", not "delete it".
    _saveTokenFromField() {
        const entered = this.el.settingsPat.value.trim();
        if (entered) this.sync.setToken(entered);
        this.el.settingsPat.value = '';
        this._updateTokenSummary();
    }

    _updateTokenSummary() {
        const el = document.getElementById('token-summary');
        if (el) el.textContent = this.sync.tokenSummary();
    }

    _updateSyncStatus() {
        const parts = [`Push size: ${this.sync.getBatchSize()}`];
        const lastSync = this.sync.getLastSync();
        const lastPull = this.sync.getLastPull();
        if (lastSync) {
            const d = new Date(lastSync);
            parts.push(`Last push: ${d.toLocaleDateString()} ${d.toLocaleTimeString()}`);
        }
        if (lastPull) {
            const d = new Date(lastPull);
            parts.push(`Last pull: ${d.toLocaleDateString()} ${d.toLocaleTimeString()}`);
        }
        const pending = this.sync.getPendingCount();
        if (pending > 0) parts.push(`Pending: ${pending}`);
        this.el.syncStatus.textContent = parts.join(' · ');

        if (this.el.settingsBatchStatus) {
            const batchSize = this.sync.getBatchSize();
            this.el.settingsBatchStatus.textContent = pending > 0
                ? `${pending} decision${pending === 1 ? '' : 's'} queued. Push happens at ${batchSize}.`
                : `Pushes to GitHub after every ${batchSize} decision${batchSize === 1 ? '' : 's'}.`;
        }
    }

    _updateBatchSizeButtons() {
        const batchSize = this.sync.getBatchSize();
        this.el.settingsBatchSize?.querySelectorAll('.chip').forEach(chip =>
            chip.classList.toggle('active', parseInt(chip.dataset.value, 10) === batchSize));
    }

    _setSyncDot(state) {
        if (this.el.syncDot) this.el.syncDot.className = `sync-dot sync-${state}`;
    }

    // -- utilities ----------------------------------------------------------

    _esc(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        // Re-allow the inline markup PubMed leaves in titles and abstracts;
        // without this, "CO<sub>2</sub>" renders as literal tags.
        return div.innerHTML.replace(/&lt;(\/?(?:sup|sub|i|b))&gt;/gi, '<$1>');
    }

    _toast(message) {
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
    }

    _registerSW() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js').catch(() => {});
        }
    }
}

// ---------------------------------------------------------------------------
// Boot — config first, so nothing renders against empty defaults
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
    await loadAppConfig();
    new App();
});
