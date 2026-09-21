// ==========================================
// UTILITIES
// ==========================================

let _globalSnapshotIdxMap = null;
let _cachedSnapshotDatesRef = null;

const MONEY_REGEX = /[^0-9.-]+/g;
const moneyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const hourlyMoneyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatMoney = (amount) => {
    if (!amount && amount !== 0) return '-';
    const num = parseFloat(amount.toString().replace(MONEY_REGEX, ''));
    if (isNaN(num)) return amount;
    return moneyFormatter.format(num);
};

const formatHourlyMoney = (amount) => {
    if (!amount && amount !== 0) return '-';
    const num = parseFloat(amount.toString().replace(MONEY_REGEX, ''));
    if (isNaN(num)) return amount;
    return hourlyMoneyFormatter.format(num);
};

const cleanMoney = (val) => {
    if (!val) return 0;
    if (typeof val === 'number') return val;
    const cleanStr = val.toString().replace(MONEY_REGEX, '');
    return parseFloat(cleanStr) || 0;
};

const MS_PER_YEAR = 1000 * 60 * 60 * 24 * 365.25;
const MIN_TREND_YEARS = 3;

const COLA_EVENTS = []; // UO events require source verification.

// Both series use the unchanged OSU index, worker, aggregate, and history contracts.
const PAY_MEASURE = new URLSearchParams(location.search).get('measure') === 'fiscal_year_pay' ? 'fiscal_year_pay' : 'salary_rate';
const DATA_ROOT = PAY_MEASURE === 'fiscal_year_pay' ? 'data/fiscal_year_pay' : 'data';
const DATA_INDEX_URL = `${DATA_ROOT}/index.json?v=20260921-uo-copy1`;
const DATA_AGG_URL = `${DATA_ROOT}/aggregates.json?v=20260921-uo-copy1`;
const DATA_SEARCH_URL = `${DATA_ROOT}/search-index.json?v=20260921-uo-copy1`;
const DATA_PEER_MEDIANS_URL = `${DATA_ROOT}/peer-medians.json`;
const DATA_BUCKET_DIR = `${DATA_ROOT}/people`;
const payMeasureSelect = document.getElementById('pay-measure');
payMeasureSelect.value = PAY_MEASURE;
payMeasureSelect.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('measure', payMeasureSelect.value);
    location.assign(url);
});
if (PAY_MEASURE === 'fiscal_year_pay') {
    document.querySelector('#stat-median').previousElementSibling.textContent = 'Median Actual Pay';
    document.querySelector('#stat-median').previousElementSibling.dataset.tooltip = 'Median reported fiscal-year actual pay among visible name groups with positive totals. FTE is not supplied.';
    const fte = document.getElementById('fte-toggle');
    fte.disabled = true;
    fte.parentElement.dataset.tooltip = 'Appointment percent is not supplied in actual-pay reports.';
}
const SEARCH_ANALYTICS_MAX_QUERY_LEN = 120;
const SEARCH_EVENT_MIN_INTERVAL_MS = 1200;
const WORKER_HEALTH_CHECK_MIN_INTERVAL_MS = 1200;
const ANALYTICS_EVENT_VERSION = 2;
const TRANSITION_BUCKET_LOAD_CONCURRENCY = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

const getInflationMap = () => window.INFLATION_INDEX_BY_MONTH || {};
const getInflationBaseMonth = () => window.INFLATION_BASE_MONTH || '';

const hasInflationData = () => {
    const map = getInflationMap();
    const base = getInflationBaseMonth();
    return !!(base && map[base] && Object.keys(map).length > 0);
};

const formatDate = (dateStr) => {
    if (!dateStr || dateStr === "Unknown Date") return dateStr;
    const parts = dateStr.split('-');
    if (parts.length === 3) {
        if (parts[0].length === 4) return `${parts[1]}/${parts[2]}/${parts[0]}`;
        return dateStr;
    }
    return dateStr;
};

const escapeForSingleQuote = (value) => {
    if (value === null || value === undefined) return '';
    return value.toString().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
};

const escapeHtmlAttr = (value) => {
    if (value === null || value === undefined) return '';
    return value.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

const escapeHtml = (value) => {
    if (value === null || value === undefined) return '';
    return value.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalizeText = (value) => (value || '').toString().normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
let editDistancePrev = new Uint32Array(0);
let editDistanceCur = new Uint32Array(0);
let editDistanceExactPrev = new Uint32Array(0);
let editDistanceExactCur = new Uint32Array(0);

let _lastHighlightTerms = null;
let _lastHighlightRegex = null;

const highlightText = (text, terms) => {
    const raw = (text || '').toString();
    if (terms !== _lastHighlightTerms) {
        _lastHighlightTerms = terms;
        const safeTerms = [];
        if (terms) {
            for (let i = 0; i < terms.length; i++) {
                if (safeTerms.length >= 12) break;
                const t = (terms[i] || '').toString().trim();
                if (t && t.length > 1) {
                    safeTerms.push(t);
                }
            }
        }
        if (!safeTerms.length) {
            _lastHighlightRegex = null;
        } else {
            const pattern = safeTerms.map(escapeRegex).join('|');
            if (!pattern) {
                _lastHighlightRegex = null;
            } else {
                _lastHighlightRegex = new RegExp(`(${pattern})`, 'ig');
            }
        }
    }
    if (!_lastHighlightRegex) return escapeHtml(raw);
    return raw.split(_lastHighlightRegex).map((part, idx) => {
        if (idx % 2 === 1) return `<mark class="search-hit">${escapeHtml(part)}</mark>`;
        return escapeHtml(part);
    }).join('');
};

const calculateSnapshotPay = (snapshot) => {
    if (!snapshot || !snapshot.Jobs) return 0;
    if (snapshot.Jobs.some(job => job['Pay Review Reason'])) return 0;
    if (snapshot.PayMeasure === 'fiscal_year_pay') return snapshot.Jobs.reduce((sum, job) => sum + cleanMoney(job['Reported Pay']), 0);
    let total = 0;
    const jobs = snapshot.Jobs;
    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        // Cache parsed fallback values so repeated pay calculations avoid reparsing.
        const rate = job._rate ?? (job._rate = (parseFloat(job['Annual Salary Rate']) || 0));
        const pct = job._pct ?? (job._pct = (parseFloat(job['Appt Percent']) || 0));

        if (rate > 0) total += rate * (pct / 100);
    }
    return total;
};

const bucketForName = (name) => {
    if (!name) return '_';
    const ch = name.trim().charAt(0).toLowerCase();
    return (ch >= 'a' && ch <= 'z') ? ch : '_';
};

const getUniqueBuckets = (keys) => {
    const buckets = [];
    let seen = 0; // bitmask for a-z (26 bits)
    let hasUnderscore = false;

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (!key) {
            if (!hasUnderscore) { hasUnderscore = true; buckets.push('_'); }
            continue;
        }

        let ch = key.charCodeAt(0);
        if (ch <= 32) ch = key.trim().charCodeAt(0);
        if (ch >= 65 && ch <= 90) ch += 32; // to lowercase

        if (ch >= 97 && ch <= 122) {
            const bit = 1 << (ch - 97);
            if ((seen & bit) === 0) {
                seen |= bit;
                buckets.push(String.fromCharCode(ch));
                if (seen === 0x3FFFFFF && hasUnderscore) return buckets;
            }
        } else {
            if (!hasUnderscore) { hasUnderscore = true; buckets.push('_'); }
            if (seen === 0x3FFFFFF && hasUnderscore) return buckets;
        }
    }
    return buckets;
};

const getBucketUrl = (bucket) => `${DATA_BUCKET_DIR}/${bucket}.json?v=20260921-uo-copy1`;

// ⚡ Bolt Optimization: Cache Date parsing across dataset initialization
// Timeline dates are repeated across thousands of records. Caching the parsed timestamp
// avoids expensive new Date() calls in the hot path.
const _globalDateTsCache = new Map();

const loadBucket = (bucket) => {
    if (state.bucketCache[bucket]) return Promise.resolve(state.bucketCache[bucket]);
    if (state.bucketPromises[bucket]) return state.bucketPromises[bucket];
    const url = getBucketUrl(bucket);
    state.bucketPromises[bucket] = fetch(url)
        .then(res => {
            if (!res.ok) throw new Error(`Failed to load ${url}`);
            return res.json();
        })
        .then(data => {
            state.bucketCache[bucket] = data;
            return data;
        })
        .finally(() => {
            delete state.bucketPromises[bucket];
        });
    return state.bucketPromises[bucket];
};

const loadPeerMedians = () => {
    if (state.peerMedianMap) return Promise.resolve(state.peerMedianMap);
    if (state.peerMedianPromise) return state.peerMedianPromise;
    const url = state.peerMedianUrl || DATA_PEER_MEDIANS_URL;
    state.peerMedianPromise = fetch(url)
        .then(res => {
            if (!res.ok) throw new Error(`Failed to load ${url}`);
            return res.json();
        })
        .then(data => {
            state.peerMedianMap = data || {};
            state.peerMedianLoadFailed = false;
            return state.peerMedianMap;
        })
        .catch(err => {
            console.error('Failed to load peer medians', err);
            state.peerMedianMap = {};
            state.peerMedianLoadFailed = true;
            return state.peerMedianMap;
        })
        .finally(() => {
            state.peerMedianPromise = null;
        });
    return state.peerMedianPromise;
};

const forEachWithConcurrency = (items, concurrency, iteratee) => {
    if (!Array.isArray(items) || items.length === 0) return Promise.resolve();
    const safeConcurrency = Math.max(1, Math.floor(concurrency) || 1);
    const workerCount = Math.min(safeConcurrency, items.length);
    let nextIndex = 0;

    const runWorker = () => {
        const currentIndex = nextIndex++;
        if (currentIndex >= items.length) return Promise.resolve();
        return Promise.resolve(iteratee(items[currentIndex], currentIndex)).then(runWorker);
    };

    return Promise.all(Array.from({ length: workerCount }, runWorker)).then(() => undefined);
};

const hydratePersonDetail = (person) => {
    if (!person || person._hydrated) return;
    if (!person.Timeline || person.Timeline.length === 0) {
        person._hydrated = true;
        return;
    }

    person._snapByDate = {};
    person.Timeline.sort((a, b) => (a.Date || "").localeCompare(b.Date || ""));

    for (let i = 0; i < person.Timeline.length; i++) {
        const snap = person.Timeline[i];
        if (snap.Date) person._snapByDate[snap.Date] = snap;
        if (snap.Jobs) {
            for (let j = 0; j < snap.Jobs.length; j++) {
                const job = snap.Jobs[j];
                const rawRate = job['Annual Salary Rate'];
                const rateNum = parseFloat(rawRate);
                const term = (job['Salary Term'] || '').trim();
                if (job['Pay Review Reason']) {
                    job._missingRate = true;
                    job._rate = 0;
                } else if (term === 'mo' && !isNaN(rateNum) && rateNum > 0 && rateNum <= 12) {
                    job._missingRate = true;
                    job._rate = 0;
                    job['Salary Term'] = `${rateNum} mo`;
                    job['Annual Salary Rate'] = '';
                } else {
                    job._missingRate = false;
                    if (job._rate === undefined) {
                        job._rate = rateNum || 0;
                    }
                }

                if (job._pct === undefined) {
                    job._pct = parseFloat(job['Appt Percent']);
                    if (isNaN(job._pct)) job._pct = 0;
                }
            }
        }

        snap._pay = calculateSnapshotPay(snap);
        const dateStr = snap.Date;
        let ts = _globalDateTsCache.get(dateStr);
        if (ts === undefined) {
            ts = new Date(dateStr).getTime();
            if (isNaN(ts)) ts = 0;
            _globalDateTsCache.set(dateStr, ts);
        }
        snap._ts = ts;
    }

    const lastIdx = person.Timeline.length - 1;
    const lastSnap = person.Timeline[lastIdx];
    const lastJob = (lastSnap.Jobs && lastSnap.Jobs.length > 0) ? lastSnap.Jobs[0] : {};
    person._lastSnapshot = lastSnap;
    person._lastJob = lastJob;
    person._totalPay = lastSnap._pay !== undefined ? lastSnap._pay : calculateSnapshotPay(lastSnap);
    person._payMissing = (lastSnap.Jobs || []).some(j => j._missingRate);
    person._lastDate = lastSnap.Date;
    person._isUnclass = (lastSnap.Source || "").toLowerCase().includes('unclass');
    person._isFullTime = false;
    if (lastSnap.Jobs && lastSnap.Jobs.length > 0) {
        person._isFullTime = lastSnap.Jobs.some(job => (job._pct !== undefined ? job._pct : parseFloat(job['Appt Percent'])) >= 100);
    }

    person._hydrated = true;
};

// Compute the first classified -> unclassified transition timestamp for a person, if any.
const getExclusionTransitionTs = (person) => {
    if (!person || !person._wasExcluded || !person.Timeline || person.Timeline.length < 2) return null;
    // Ensure timeline is sorted by date ascending (hydratePersonDetail already sorts)
    const timeline = person.Timeline;
    let sawClassified = false;
    for (let i = 0; i < timeline.length; i++) {
        const snap = timeline[i];
        const src = (snap.Source || '').toLowerCase();
        const isUnclass = src.includes('unclass');
        const isClassified = src.includes('class') && !isUnclass;
        if (isClassified) sawClassified = true;
        if (isUnclass && sawClassified) {
            const ts = new Date(snap.Date).getTime();
            return isNaN(ts) ? null : ts;
        }
    }
    return null;
};

// Load exclusion transition timestamps for all excluded people (uses detail buckets lazily).
const computeExclusionTransitions = () => {
    if (state.exclusionTransitionsReady) return Promise.resolve();

    const tasks = [];
    for (let i = 0; i < state.masterKeys.length; i++) {
        const name = state.masterKeys[i];
        const p = state.masterData[name];
        if (p && p._wasExcluded) {
            tasks.push(
                loadPersonDetail(name).then(person => {
                    if (!person) return;
                    if (person._exclusionDate) {
                        const tsPre = new Date(person._exclusionDate).getTime();
                        if (!isNaN(tsPre)) {
                            state.exclusionTransitionMap[name] = tsPre;
                            return;
                        }
                    }
                    const ts = getExclusionTransitionTs(person);
                    if (ts) state.exclusionTransitionMap[name] = ts;
                })
            );
        }
    }

    return Promise.all(tasks).then(() => {
        state.exclusionTransitionsReady = true;
    });
};

const loadPersonDetail = (name) => {
    if (state.detailCache[name]) return Promise.resolve(state.detailCache[name]);
    const bucket = bucketForName(name);
    return loadBucket(bucket).then(bucketData => {
        const person = bucketData[name];
        if (!person) {
            state.detailCache[name] = null;
            return null;
        }
        // Bring over flags that are stored in masterData but absent in bucket files.
        const masterPerson = state.masterData[name];
        if (masterPerson && masterPerson._wasExcluded !== undefined) {
            person._wasExcluded = masterPerson._wasExcluded;
        }
        if (masterPerson && masterPerson._exclusionDate !== undefined) {
            person._exclusionDate = masterPerson._exclusionDate;
        }
        hydratePersonDetail(person);
        state.detailCache[name] = person;
        return person;
    });
};

const buildSearchIndex = (names, roles) => {
    const seen = new Set();
    const index = [];
    const addItem = (value, type) => {
        if (!value) return;
        const key = value.toLowerCase();
        if (seen.has(`${type}:${key}`)) return;
        seen.add(`${type}:${key}`);
        const tokens = key.match(/[a-z0-9]+/g) || [];
        index.push({ value, key, type, tokens });
    };
    names.forEach(name => addItem(name, 'name'));
    roles.forEach(role => addItem(role, 'role'));
    index.sort((a, b) => a.key < b.key ? -1 : (a.key > b.key ? 1 : 0));
    return index;
};

const boundedEditDistance = (a, b, maxDist) => {
    const alen = a.length;
    const blen = b.length;
    if (Math.abs(alen - blen) > maxDist) return maxDist + 1;

    const rowSize = blen + 1;
    if (editDistancePrev.length < rowSize) {
        editDistancePrev = new Uint32Array(rowSize);
        editDistanceCur = new Uint32Array(rowSize);
    }

    let prev = editDistancePrev;
    let cur = editDistanceCur;
    for (let j = 0; j <= blen; j++) prev[j] = j;

    for (let i = 1; i <= alen; i++) {
        cur[0] = i;
        let rowMin = i;
        for (let j = 1; j <= blen; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            const next = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            cur[j] = next;
            if (next < rowMin) rowMin = next;
        }
        if (rowMin > maxDist) return maxDist + 1;
        const swap = prev;
        prev = cur;
        cur = swap;
    }
    return prev[blen];
};

const editDistanceExact = (a, b) => {
    const alen = a.length;
    const blen = b.length;

    const rowSize = blen + 1;
    if (editDistanceExactPrev.length < rowSize) {
        editDistanceExactPrev = new Uint32Array(rowSize);
        editDistanceExactCur = new Uint32Array(rowSize);
    }

    let prev = editDistanceExactPrev;
    let cur = editDistanceExactCur;
    for (let j = 0; j <= blen; j++) prev[j] = j;

    for (let i = 1; i <= alen; i++) {
        cur[0] = i;
        for (let j = 1; j <= blen; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        const swap = prev;
        prev = cur;
        cur = swap;
    }
    return prev[blen];
};

const insertSuggestionBkTree = (root, term) => {
    if (!term) return root;
    if (!root) return { term, children: new Map() };

    let node = root;
    while (node) {
        if (term === node.term) return root;
        const dist = editDistanceExact(term, node.term);
        const next = node.children.get(dist);
        if (next) {
            node = next;
            continue;
        }
        node.children.set(dist, { term, children: new Map() });
        break;
    }
    return root;
};

const searchSuggestionBkTree = (root, query, maxDist, out) => {
    if (!root) return out;

    const stack = [root];
    while (stack.length) {
        const node = stack.pop();
        const dist = editDistanceExact(query, node.term);
        if (dist <= maxDist) out.push(node.term);

        const minEdge = dist - maxDist;
        const maxEdge = dist + maxDist;
        node.children.forEach((child, edgeDist) => {
            if (edgeDist >= minEdge && edgeDist <= maxEdge) {
                stack.push(child);
            }
        });
    }
    return out;
};

const markSearchSuggestionCandidate = (marks, list, itemIndex, excludeStart, excludeEnd) => {
    if (excludeStart !== -1 && itemIndex >= excludeStart && itemIndex < excludeEnd) return;
    if (marks[itemIndex]) return;
    marks[itemIndex] = 1;
    list.push(itemIndex);
};

const resetSearchSuggestionCandidates = (marks, list) => {
    for (let i = 0; i < list.length; i++) {
        marks[list[i]] = 0;
    }
    list.length = 0;
};

const buildSearchSuggestionAux = (index) => {
    const trigramBuckets = new Map();
    const tokenBuckets = new Map();

    for (let i = 0; i < index.length; i++) {
        const item = index[i];
        if (!item) continue;

        const key = item.key || '';
        if (key.length >= 3) {
            const seenTrigrams = new Set();
            for (let j = 0; j <= key.length - 3; j++) {
                const trigram = key.slice(j, j + 3);
                if (seenTrigrams.has(trigram)) continue;
                seenTrigrams.add(trigram);
                let refs = trigramBuckets.get(trigram);
                if (!refs) {
                    refs = [];
                    trigramBuckets.set(trigram, refs);
                }
                refs.push(i);
            }
        }

        const seenTokens = new Set();
        for (const token of (item.tokens || [])) {
            if (!token || token.length < 3) continue;
            if (seenTokens.has(token)) continue;
            seenTokens.add(token);
            let refs = tokenBuckets.get(token);
            if (!refs) {
                refs = [];
                tokenBuckets.set(token, refs);
            }
            refs.push(i);
        }
    }

    let fuzzyTokenBkTree = null;
    tokenBuckets.forEach((_, token) => {
        fuzzyTokenBkTree = insertSuggestionBkTree(fuzzyTokenBkTree, token);
    });

    const toTypedMap = (src) => {
        const out = new Map();
        src.forEach((refs, key) => {
            out.set(key, Uint32Array.from(refs));
        });
        return out;
    };

    return {
        keyTrigramToItems: toTypedMap(trigramBuckets),
        tokenToItems: toTypedMap(tokenBuckets),
        fuzzyTokenBkTree,
        itemCount: index.length
    };
};

const findPrefixRange = (index, prefix) => {
    let low = 0;
    let high = index.length - 1;
    let start = -1;

    while (low <= high) {
        const mid = (low + high) >>> 1;
        if (index[mid].key >= prefix) {
            start = mid;
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }

    if (start === -1 || !index[start].key.startsWith(prefix)) {
        return { start: -1 };
    }
    return { start };
};

const getSearchSuggestions = (term, limit = 6) => {
    const query = term.trim().toLowerCase();
    if (!query || query.length < 3) return [];
    const maxDist = query.length <= 4 ? 1 : (query.length <= 6 ? 2 : 3);
    const scored = [];

    // 1. Prefix matches (Score 0) using Binary Search
    const { start } = findPrefixRange(state.searchIndex, query);
    let prefixEnd = -1;

    if (start !== -1) {
        for (let i = start; i < state.searchIndex.length; i++) {
            const item = state.searchIndex[i];
            if (!item.key.startsWith(query)) {
                prefixEnd = i;
                break;
            }
            scored.push({ score: 0, value: item.value, type: item.type });
        }
        if (prefixEnd === -1) prefixEnd = state.searchIndex.length;
    }

    // Optimization: If enough prefix matches, return early
    if (scored.length >= limit) {
        // Sort by length (shortest first)
        scored.sort((a, b) => a.value.length - b.value.length);

        const results = [];
        const seen = new Set();
        for (const item of scored) {
            const key = item.value.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            results.push(item);
            if (results.length >= limit) break;
        }
        return results;
    }

    // 2. Substring & Fuzzy matches (Score 1 & 2+)
    // Fallback path scans everything OUTSIDE the prefix range.
    const searchRest = (startIndex, endIndex) => {
        for (let i = startIndex; i < endIndex; i++) {
            const item = state.searchIndex[i];
            const key = item.key;
            let score = null;

            if (key.includes(query)) {
                score = 1;
            } else {
                let bestDist = maxDist + 1;
                for (const token of item.tokens) {
                    if (token.length < 3) continue;
                    const dist = boundedEditDistance(query, token, maxDist);
                    if (dist < bestDist) bestDist = dist;
                    if (bestDist === 0) break;
                }
                if (bestDist <= maxDist) score = 2 + bestDist;
            }
            if (score !== null) scored.push({ score, value: item.value, type: item.type });
        }
    };

    const aux = state.searchSuggestionAux;
    const marks = state.searchSuggestionCandidateMarks;
    const candidateList = state.searchSuggestionCandidateList;
    const canUseAux = !!(
        aux &&
        aux.itemCount === state.searchIndex.length &&
        aux.keyTrigramToItems instanceof Map &&
        aux.tokenToItems instanceof Map &&
        marks &&
        marks.length >= state.searchIndex.length &&
        Array.isArray(candidateList)
    );

    let usedAux = false;
    if (canUseAux) {
        const excludeStart = start;
        const excludeEnd = start === -1 ? -1 : prefixEnd;
        const scoredStart = scored.length;
        try {
            const keyRefs = aux.keyTrigramToItems.get(query.slice(0, 3));
            if (keyRefs) {
                for (let i = 0; i < keyRefs.length; i++) {
                    markSearchSuggestionCandidate(marks, candidateList, keyRefs[i], excludeStart, excludeEnd);
                }
            }

            const fuzzyTokens = [];
            searchSuggestionBkTree(aux.fuzzyTokenBkTree, query, maxDist, fuzzyTokens);
            for (let i = 0; i < fuzzyTokens.length; i++) {
                const tokenRefs = aux.tokenToItems.get(fuzzyTokens[i]);
                if (!tokenRefs) continue;
                for (let j = 0; j < tokenRefs.length; j++) {
                    markSearchSuggestionCandidate(marks, candidateList, tokenRefs[j], excludeStart, excludeEnd);
                }
            }

            candidateList.sort((a, b) => a - b);
            for (let i = 0; i < candidateList.length; i++) {
                const idx = candidateList[i];
                const item = state.searchIndex[idx];
                const key = item.key;
                let score = null;

                if (key.includes(query)) {
                    score = 1;
                } else {
                    let bestDist = maxDist + 1;
                    for (const token of item.tokens) {
                        if (token.length < 3) continue;
                        const dist = boundedEditDistance(query, token, maxDist);
                        if (dist < bestDist) bestDist = dist;
                        if (bestDist === 0) break;
                    }
                    if (bestDist <= maxDist) score = 2 + bestDist;
                }
                if (score !== null) scored.push({ score, value: item.value, type: item.type });
            }
            usedAux = true;
        } catch (err) {
            scored.length = scoredStart;
        } finally {
            resetSearchSuggestionCandidates(marks, candidateList);
        }
    }

    if (!usedAux) {
        if (start === -1) {
            searchRest(0, state.searchIndex.length);
        } else {
            searchRest(0, start);
            searchRest(prefixEnd, state.searchIndex.length);
        }
    }

    scored.sort((a, b) => (a.score - b.score) || (a.value.length - b.value.length));
    const results = [];
    const seen = new Set();
    for (const item of scored) {
        const key = item.value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(item);
        if (results.length >= limit) break;
    }
    return results;
};

const buildWorkerBaseKey = (names) => {
    if (!Array.isArray(names) || names.length === 0) return 'empty';
    return `${names.length}:${names[0]}:${names[names.length - 1]}`;
};

const rejectAllPendingSearches = (reason) => {
    const err = reason instanceof Error ? reason : new Error(reason || 'Search worker reset');
    state.searchPending.forEach((pending) => {
        pending.reject(err);
    });
    state.searchPending.clear();
    state.searchPingPending.forEach((pending) => {
        pending.reject(err);
    });
    state.searchPingPending.clear();
};

const teardownSearchWorker = (reason = 'teardown') => {
    if (state.searchWorker) {
        try {
            state.searchWorker.terminate();
        } catch (err) { /* no-op */ }
    }
    state.searchWorker = null;
    state.searchWorkerReady = false;
    state.searchWorkerErrored = false;
    state.searchWorkerInitInFlight = false;
    rejectAllPendingSearches(`Search worker ${reason}`);
};

const createSearchWorker = () => {
    const worker = new Worker('js/search-worker.js?v=20260921-uo-copy1');
    state.searchWorker = worker;
    state.searchWorkerReady = false;
    state.searchWorkerErrored = false;
    state.searchWorkerInitInFlight = false;

    worker.onmessage = (event) => {
        const msg = event.data || {};
        const id = msg.id;
        if (msg.type === 'ready') {
            state.searchWorkerReady = true;
            state.searchWorkerInitInFlight = false;
            state.searchRecoveryAttempts = 0;
            if (state.searchWorkerRecovering) {
                state.searchWorkerRecovering = false;
            }
            runSearch();
            return;
        }
        if (msg.type === 'pong' && id && state.searchPingPending.has(id)) {
            const pending = state.searchPingPending.get(id);
            state.searchPingPending.delete(id);
            pending.resolve(!!msg.ready);
            return;
        }
        if (msg.type === 'error') {
            state.searchWorkerErrored = true;
            state.searchWorkerReady = false;
            state.searchWorkerInitInFlight = false;
            state.searchWorkerRecovering = false;
            if (id && state.searchPending.has(id)) {
                const pending = state.searchPending.get(id);
                state.searchPending.delete(id);
                pending.reject(new Error(msg.message || 'Search worker error'));
            }
            if (id && state.searchPingPending.has(id)) {
                const pending = state.searchPingPending.get(id);
                state.searchPingPending.delete(id);
                pending.reject(new Error(msg.message || 'Search worker error'));
            }
            return;
        }
        if (msg.type === 'result' && id && state.searchPending.has(id)) {
            const pending = state.searchPending.get(id);
            state.searchPending.delete(id);
            pending.resolve(msg.payload || {});
        }
    };

    worker.onerror = () => {
        state.searchWorkerErrored = true;
        state.searchWorkerReady = false;
        state.searchWorkerInitInFlight = false;
        state.searchWorkerRecovering = false;
    };

    return worker;
};

const initSearchWorker = (force = false) => {
    if (typeof Worker === 'undefined') return false;
    if (state.searchWorkerInitInFlight) return true;
    if (!force && state.searchWorker && !state.searchWorkerErrored) return true;
    if (force) teardownSearchWorker('reinit');
    try {
        const worker = createSearchWorker();
        state.searchWorkerInitInFlight = true;
        const initId = `init:${Date.now()}:${++state.searchRequestSeq}`;
        const searchIndexUrl = new URL(DATA_SEARCH_URL, window.location.href).toString();
        worker.postMessage({ type: 'init', id: initId, payload: { url: searchIndexUrl } });
        return true;
    } catch (err) {
        state.searchWorkerErrored = true;
        state.searchWorkerReady = false;
        state.searchWorkerInitInFlight = false;
        state.searchWorkerRecovering = false;
        return false;
    }
};

const recoverSearchWorker = (reason = 'recovery') => {
    if (typeof Worker === 'undefined') return Promise.resolve(false);
    if (state.searchWorkerRecovering) return Promise.resolve(true);
    state.searchWorkerRecovering = true;
    state.searchRecoveryAttempts += 1;
    teardownSearchWorker(reason);
    const started = initSearchWorker(true);
    if (!started) {
        state.searchWorkerRecovering = false;
        return Promise.resolve(false);
    }
    return Promise.resolve(true);
};

const sendSearchToWorker = (payload) => {
    if (!state.searchWorker || !state.searchWorkerReady) {
        return Promise.reject(new Error('Search worker unavailable'));
    }
    state.lastSearchPayload = payload;
    const id = `search:${++state.searchRequestSeq}`;
    return new Promise((resolve, reject) => {
        state.searchPending.set(id, { resolve, reject });
        state.searchWorker.postMessage({ type: 'search', id, payload });
        setTimeout(() => {
            if (!state.searchPending.has(id)) return;
            state.searchPending.delete(id);
            const err = new Error('Search worker timeout');
            err.code = 'WORKER_TIMEOUT';
            reject(err);
        }, 5000);
    });
};

const pingSearchWorker = (timeoutMs = 1200) => {
    if (!state.searchWorker || state.searchWorkerErrored) {
        return Promise.resolve(false);
    }
    const id = `ping:${++state.searchRequestSeq}`;
    return new Promise((resolve, reject) => {
        state.searchPingPending.set(id, { resolve, reject });
        state.searchWorker.postMessage({ type: 'ping', id, payload: {} });
        setTimeout(() => {
            if (!state.searchPingPending.has(id)) return;
            state.searchPingPending.delete(id);
            resolve(false);
        }, timeoutMs);
    });
};

const medianOf = (arr) => {
    if (!arr || arr.length === 0) return 0;
    const sorted = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const formatPct = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;

const getMonthKey = (dateStr) => {
    if (!dateStr || dateStr.length < 7) return null;
    return dateStr.slice(0, 7);
};

const getInflationIndex = (dateStr) => {
    const map = getInflationMap();
    const monthKey = getMonthKey(dateStr);
    if (!monthKey) return null;
    if (map[monthKey]) return map[monthKey];

    let [year, month] = monthKey.split('-').map(Number);
    for (let i = 0; i < 24; i++) {
        month -= 1;
        if (month === 0) {
            month = 12;
            year -= 1;
        }
        const key = `${year}-${String(month).padStart(2, '0')}`;
        if (map[key]) return map[key];
    }
    return null;
};

const adjustForInflation = (amount, dateStr) => {
    const map = getInflationMap();
    const base = map[getInflationBaseMonth()];
    const idx = getInflationIndex(dateStr);
    if (!base || !idx) return null; // No invented inflation factor for uncovered UO dates.
    return amount * (base / idx);
};

const isPersonActive = (person) => {
    if (!person || !person._lastDate) return false;

    // Optimized: Use cached classification to avoid redundant string parsing
    const targetDate = person._isUnclass ? state.latestUnclassDate : state.latestClassDate;
    return !targetDate || person._lastDate === targetDate;
};

const getTimelineYears = (timeline) => {
    if (!timeline || timeline.length === 0) return 0;
    const startTime = timeline[0]._ts;
    const endTime = timeline[timeline.length - 1]._ts;
    if (!startTime || !endTime) return 0;
    return (endTime - startTime) / MS_PER_YEAR;
};

const calculateMovingAverage = (data, windowSize, accessor = (d) => d) => {
    const length = data.length;
    if (length === 0) return [];

    const maxWindow = Math.ceil(windowSize);
    if (maxWindow <= 0) return new Array(length).fill(NaN);

    const ma = new Array(length);
    if (maxWindow === 1) {
        for (let i = 0; i < length; i++) {
            ma[i] = accessor(data[i]);
        }
        return ma;
    }

    const bufferSize = Math.min(maxWindow, length);
    // ⚡ Bolt Optimization: Use Float64Array for numeric ring buffer instead of generic Array.
    // Performance impact: ~15% faster execution time for moving average calculations.
    const buffer = new Float64Array(bufferSize);
    let head = 0;
    let count = 0;
    let sum = 0;

    for (let i = 0; i < length; i++) {
        const val = accessor(data[i]);
        sum += val;

        if (count === bufferSize) {
            sum -= buffer[head];
        } else {
            count += 1;
        }

        buffer[head] = val;
        head += 1;
        if (head === bufferSize) head = 0;

        ma[i] = sum / count;
    }

    return ma;
};

const getChartOptions = ({ yTickCallback, legend = true, animation = true, xTickLimit } = {}) => {
    const xTicks = { color: '#888' };
    if (xTickLimit) xTicks.maxTicksLimit = xTickLimit;

    const yTicks = { color: '#888' };
    if (yTickCallback) yTicks.callback = yTickCallback;

    return {
        responsive: true,
        maintainAspectRatio: false,
        animation,
        plugins: {
            legend: { display: legend, labels: { color: '#ccc' } },
            tooltip: { mode: 'index', intersect: false }
        },
        scales: {
            x: { ticks: xTicks, grid: { color: '#333' } },
            y: { ticks: yTicks, grid: { color: '#333' } }
        }
    };
};

function hexToRgba(hex, alpha = 1) {
    const stripped = hex.replace('#', '');
    if (stripped.length !== 6) return hex;
    const r = parseInt(stripped.slice(0, 2), 16);
    const g = parseInt(stripped.slice(2, 4), 16);
    const b = parseInt(stripped.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const buildPersonTrendContent = (timeline, chartId) => {
    if (!timeline || timeline.length === 0) return null;

    const yearsDiff = getTimelineYears(timeline);
    if (yearsDiff < MIN_TREND_YEARS) {
        const empty = document.createElement('div');
        empty.className = 'trend-empty';
        empty.textContent = `⚠️ History covers less than ${MIN_TREND_YEARS} years. Trend chart available for longer tenures only.`;
        return empty;
    }

    const fragment = document.createDocumentFragment();
    const inflationReady = hasInflationData();

    const trendHeader = document.createElement('div');
    trendHeader.className = 'trend-header';

    const statLabel = document.createElement('div');
    statLabel.className = 'stat-label';
    statLabel.textContent = 'Total Compensation Trend';
    trendHeader.appendChild(statLabel);

    const trendControls = document.createElement('div');
    trendControls.className = 'trend-controls';

    const inflationSelect = document.createElement('select');
    inflationSelect.className = 'trend-mode';
    inflationSelect.dataset.chartId = chartId;

    const addSelectOption = (value, text, selected = false) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        if (selected) option.selected = true;
        inflationSelect.appendChild(option);
    };

    if (inflationReady) {
        inflationSelect.dataset.ready = 'true';
        addSelectOption('off', 'Inflation: Off', true);
        addSelectOption('adjusted', 'Inflation: Adjusted (graph wide)');
        addSelectOption('compare', 'Inflation: Adjusted (separate line)');
    } else {
        inflationSelect.disabled = true;
        inflationSelect.dataset.tooltip = 'Inflation data not loaded yet.';
        addSelectOption('off', 'Inflation: Off (data missing)', true);
    }
    trendControls.appendChild(inflationSelect);

    const trendToggle = document.createElement('label');
    trendToggle.className = 'trend-toggle';

    const gapToggleInput = document.createElement('input');
    gapToggleInput.type = 'checkbox';
    gapToggleInput.className = 'gap-toggle-input';
    gapToggleInput.dataset.chartId = chartId;
    trendToggle.appendChild(gapToggleInput);
    trendToggle.appendChild(document.createTextNode(' Missing data'));
    trendControls.appendChild(trendToggle);

    trendHeader.appendChild(trendControls);
    fragment.appendChild(trendHeader);

    const chartWrap = document.createElement('div');
    chartWrap.className = 'person-chart-wrap';

    const canvas = document.createElement('canvas');
    canvas.id = chartId;
    canvas.dataset.personChart = 'true';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Total compensation trend');
    chartWrap.appendChild(canvas);

    const trendLegend = document.createElement('div');
    trendLegend.className = 'trend-legend hidden';

    const legendItem = document.createElement('span');
    legendItem.className = 'legend-item';
    const legendLine = document.createElement('span');
    legendLine.className = 'legend-line missing';
    legendItem.appendChild(legendLine);
    legendItem.appendChild(document.createTextNode(' Missing data'));
    trendLegend.appendChild(legendItem);

    chartWrap.appendChild(trendLegend);
    fragment.appendChild(chartWrap);

    return fragment;
};

// ==========================================
// GLOBAL STATE
// ==========================================
const state = {
    masterData: {},
    masterKeys: [],
    filteredKeys: [],
    visibleCount: 50,
    batchSize: 50,
    historyStats: [],
    classTransitions: [],
    latestClassDate: "",
    latestUnclassDate: "",
    snapshotDates: [],
    pairedHistoryStats: [],
    peerMedianMap: null,
    peerMedianUrl: DATA_PEER_MEDIANS_URL,
    peerMedianPromise: null,
    peerMedianLoadFailed: false,
    keyBuckets: {},
    personCharts: {},
    detailCache: {},
    bucketCache: {},
    bucketPromises: {},
    searchIndex: [],
    searchSuggestionAux: null,
    searchSuggestionCandidateMarks: null,
    searchSuggestionCandidateList: [],
    focusIndex: -1,
    historicalChartsRendered: false,
    exclusionTransitionMap: {},
    exclusionTransitionsReady: false,
    transitionChart: null,
    transitionMemberIndex: null,
    transitionIndexPromise: null,
    searchWorker: null,
    searchWorkerReady: false,
    searchWorkerErrored: false,
    searchWorkerInitInFlight: false,
    searchWorkerRecovering: false,
    searchRecoveryAttempts: 0,
    searchRequestSeq: 0,
    searchRunToken: 0,
    searchPending: new Map(),
    searchPingPending: new Map(),
    lastSearchPayload: null,
    lastWorkerHealthCheckTs: 0,
    lastSearchSuggestions: [],
    lastHighlightTerms: [],
    regexMode: false,
    searchWarning: '',
    autocompleteItems: [],
    autocompleteFocus: -1,
    historicalCharts: {},
    historicalAdvancedRendered: false,
    historicalFullscreenEventsBound: false,
    historicalPseudoFullscreenCard: null,
    roleGroupConcentration: null,
    payConcentrationMetrics: null,
    payDistributionMetrics: null,
    tenureMixMetrics: null,
    analytics: {
        nextSearchSource: 'unknown',
        lastSearchSignature: '',
        lastSearchTs: 0
    },
    filters: {
        text: '',
        type: 'all',
        role: '',
        minSalary: null,
        maxSalary: null,
        showInactive: false,
        sort: 'name-asc',   // Default sort: A-Z
        fullTimeOnly: false, // Default: Show all FTEs
        dataFlagsOnly: false,
        exclusionsMode: 'off', // off | all | recent
        transition: null // { year, direction } where direction is toUnclassified | toClassified
    }
};

const els = {
    searchInput: document.getElementById('search'),
    clearBtn: document.getElementById('clear-search'),
    regexPill: document.getElementById('regex-pill'),
    autocomplete: document.getElementById('search-autocomplete'),
    typeSelect: document.getElementById('type-filter'),
    roleInput: document.getElementById('role-filter'),
    salaryMin: document.getElementById('salary-min'),
    salaryMax: document.getElementById('salary-max'),
    inactiveToggle: document.getElementById('show-inactive'),
    sortSelect: document.getElementById('sort-order'),
    fteToggle: document.getElementById('fte-toggle'),
    dataFlagsToggle: document.getElementById('data-flags-toggle'),
    advancedToggle: document.getElementById('advanced-toggle'),
    advancedSearch: document.getElementById('advanced-search'),
    exclusionsMode: document.getElementById('exclusions-mode'),
    suggestedSearches: document.getElementById('suggested-searches'),
    results: document.getElementById('results'),
    scrollSentinel: null,
    stats: document.getElementById('stats-bar'),
    roleDatalist: document.getElementById('role-list'),
    dashboard: document.getElementById('stats-dashboard'),
    statTotal: document.getElementById('stat-total'),
    statMedian: document.getElementById('stat-median'),
    barClassified: document.getElementById('bar-classified'),
    barUnclassified: document.getElementById('bar-unclassified'),
    countClassified: document.getElementById('count-classified'),
    countUnclassified: document.getElementById('count-unclassified'),
    orgLeaderboard: document.getElementById('org-leaderboard'),
    tenureChart: document.getElementById('tenure-chart'),
    roleDonut: document.getElementById('role-donut'),
    roleLegend: document.getElementById('role-legend')
};

function captureAnalyticsEvent(eventName, properties = {}) {
    if (window.__DISABLE_ANALYTICS__) return;
    if (!window.posthog || typeof window.posthog.capture !== 'function') return;
    const query = (state.filters.text || '').trim();
    const payload = {
        event_version: ANALYTICS_EVENT_VERSION,
        page: window.location.pathname || '/',
        query: query.slice(0, SEARCH_ANALYTICS_MAX_QUERY_LEN),
        query_length: query.length,
        result_count: state.filteredKeys.length,
        source: state.analytics.nextSearchSource || 'unknown',
        dataset_latest_class_date: state.latestClassDate || '',
        dataset_latest_unclass_date: state.latestUnclassDate || '',
        has_active_filters: hasActiveSearchFilters(),
        regex_mode: !!state.regexMode,
        ...properties
    };
    try {
        window.posthog.capture(eventName, payload);
    } catch (err) {
        // Analytics must never break UI interactions.
    }
}

function registerAnalyticsContext() {
    if (window.__DISABLE_ANALYTICS__) return;
    if (!window.posthog || typeof window.posthog.register !== 'function') return;
    try {
        window.posthog.register({
            event_version: ANALYTICS_EVENT_VERSION,
            dataset_latest_class_date: state.latestClassDate || '',
            dataset_latest_unclass_date: state.latestUnclassDate || ''
        });
    } catch (err) {
        // Analytics context registration should be best effort only.
    }
}

function setSearchSource(source) {
    state.analytics.nextSearchSource = source || 'unknown';
}

function consumeSearchSource() {
    const source = state.analytics.nextSearchSource || 'unknown';
    state.analytics.nextSearchSource = 'unknown';
    return source;
}

function hasActiveSearchFilters() {
    const filters = state.filters;
    return !!(
        (filters.text && filters.text.trim()) ||
        filters.type !== 'all' ||
        (filters.role && filters.role.trim()) ||
        filters.minSalary !== null ||
        filters.maxSalary !== null ||
        filters.showInactive ||
        filters.sort !== 'name-asc' ||
        filters.fullTimeOnly ||
        filters.dataFlagsOnly ||
        filters.exclusionsMode !== 'off' ||
        !!filters.transition
    );
}

function isUserInitiatedSearchSource(source) {
    return source !== 'initial_load';
}

function getResultBucket(resultCount) {
    if (resultCount <= 0) return '0';
    if (resultCount <= 5) return '1-5';
    if (resultCount <= 25) return '6-25';
    if (resultCount <= 100) return '26-100';
    return '100+';
}

function trackFilterChanged(filterName, newValue) {
    captureAnalyticsEvent('filter_changed', {
        source: 'filter_change',
        filter_name: filterName,
        new_value: newValue
    });
}

function trackSearchEvent(resultCount, meta = {}) {
    const source = consumeSearchSource();
    if (!isUserInitiatedSearchSource(source)) return;

    const query = (state.filters.text || '').trim();
    const payload = {
        source,
        query: query.slice(0, SEARCH_ANALYTICS_MAX_QUERY_LEN),
        query_length: query.length,
        result_count: resultCount,
        latency_ms: meta.latencyMs || 0,
        used_worker: !!meta.usedWorker,
        result_bucket: getResultBucket(resultCount),
        regex_mode: !!state.regexMode,
        type_filter: state.filters.type,
        show_inactive: !!state.filters.showInactive,
        full_time_only: !!state.filters.fullTimeOnly,
        data_flags_only: !!state.filters.dataFlagsOnly,
        exclusions_mode: state.filters.exclusionsMode || 'off',
        sort_order: state.filters.sort || 'name-asc',
        has_transition_filter: !!state.filters.transition
    };

    const signature = JSON.stringify({
        source: payload.source,
        query: payload.query,
        query_length: payload.query_length,
        result_count: payload.result_count,
        used_worker: payload.used_worker,
        result_bucket: payload.result_bucket,
        regex_mode: payload.regex_mode,
        type_filter: payload.type_filter,
        show_inactive: payload.show_inactive,
        full_time_only: payload.full_time_only,
        data_flags_only: payload.data_flags_only,
        exclusions_mode: payload.exclusions_mode,
        sort_order: payload.sort_order,
        has_transition_filter: payload.has_transition_filter
    });
    const now = Date.now();
    if (signature === state.analytics.lastSearchSignature && (now - state.analytics.lastSearchTs) < SEARCH_EVENT_MIN_INTERVAL_MS) {
        return;
    }

    state.analytics.lastSearchSignature = signature;
    state.analytics.lastSearchTs = now;
    captureAnalyticsEvent('search_executed', payload);
    captureAnalyticsEvent('search_performed', payload);
    if (resultCount === 0) {
        captureAnalyticsEvent('search_zero_results', payload);
    }
}

// ==========================================
// INITIALIZATION
// ==========================================
const inflationReady = window.loadInflationData ? window.loadInflationData() : Promise.resolve();

Promise.all([
    fetch(DATA_INDEX_URL).then(res => res.json()),
    fetch(DATA_AGG_URL).then(res => res.json())
])
    .then(([indexData, aggregates]) => {
        state.masterData = indexData;
        state.masterKeys = Object.keys(indexData).sort();
        state.latestClassDate = aggregates.latestClassDate || "";
        state.latestUnclassDate = aggregates.latestUnclassDate || "";
        state.snapshotDates = aggregates.snapshotDates || [];
        state.historyStats = aggregates.historyStats || [];
        state.pairedHistoryStats = aggregates.pairedHistoryStats || [];
        state.classTransitions = aggregates.classTransitions || [];
        state.peerMedianMap = aggregates.peerMedianMap || null;
        state.peerMedianUrl = `${aggregates.peerMedianUrl || DATA_PEER_MEDIANS_URL}?v=20260921-uo-copy1`;
        state.payConcentrationMetrics = aggregates.payConcentration || null;
        state.payDistributionMetrics = aggregates.payDistribution || null;
        state.tenureMixMetrics = aggregates.tenureMix || null;
        state.roleGroupConcentration = aggregates.roleGroupConcentration || null;
        const captureNotice = document.getElementById('capture-import-notice');
        if (captureNotice && aggregates.captureImport) {
            const imported = aggregates.captureImport;
            captureNotice.hidden = false;
            captureNotice.textContent = `Updated with ${imported.sourceRows.toLocaleString()} UO source rows captured ${imported.latestDate}. ` +
                `This is a capture date, not a confirmed payroll effective date. ${imported.payReviewRows.toLocaleString()} zero or uncertain salary rates are flagged and excluded from pay calculations. ` +
                `Uncertain historical matches remain separate. Historical overview charts stop at ${imported.historicalChartsThrough}; the new report format is not yet comparable. ` +
                `Original reports are available in the Records Archive.`;
        }

        // Preload exclusion transition map when dates are already present in index.
        state.exclusionTransitionMap = {};
        for (let i = 0; i < state.masterKeys.length; i++) {
            const name = state.masterKeys[i];
            const p = indexData[name];
            if (p && p._exclusionDate) {
                const ts = new Date(p._exclusionDate).getTime();
                if (!isNaN(ts)) state.exclusionTransitionMap[name] = ts;
            }
        }
        if (Object.keys(state.exclusionTransitionMap).length) {
            state.exclusionTransitionsReady = true;
        }

        // ⚡ Bolt Optimization: Cache Date parsing for hire dates.
        // Many employees share the same start date. A local map avoids redundant parsing.
        const hiredCache = new Map();
        for (let i = 0; i < state.masterKeys.length; i++) {
            const name = state.masterKeys[i];
            const p = state.masterData[name];
            const hiredStr = p?.Meta?.['First Hired'];
            p._hiredDateTs = 0;
            if (hiredStr) {
                let ts = hiredCache.get(hiredStr);
                if (ts === undefined) {
                    const d = new Date(hiredStr);
                    ts = isNaN(d) ? 0 : d.getTime();
                    hiredCache.set(hiredStr, ts);
                }
                p._hiredDateTs = ts;
            }
        }

        buildKeyBucketsAndCola();
        registerAnalyticsContext();

        // Populate Roles
        const roles = aggregates.allRoles || [];
        els.roleDatalist.innerHTML = roles.map(r => `<option value="${escapeHtmlAttr(r)}">`).join('');
        state.searchIndex = buildSearchIndex(state.masterKeys, roles);
        try {
            state.searchSuggestionAux = buildSearchSuggestionAux(state.searchIndex);
            state.searchSuggestionCandidateMarks = new Uint8Array(state.searchSuggestionAux.itemCount || 0);
            state.searchSuggestionCandidateList = [];
        } catch (err) {
            state.searchSuggestionAux = null;
            state.searchSuggestionCandidateMarks = null;
            state.searchSuggestionCandidateList = [];
        }
        initSearchWorker();

        renderSuggestedSearches();

        const targetName = parseUrlParams();
        setSearchSource(state.filters.text ? 'url_param' : 'initial_load');
        runSearch();
        updateStats();
        setupInfiniteScroll();

        setupHistoricalChartsToggle();

        inflationReady.then(() => {
            refreshInflationControls();
            document.querySelectorAll('.card.expanded').forEach(card => rebuildPersonChart(card));
        });

        if (targetName) {
            autoExpandTarget(targetName);
        }

        setupTooltips();
        setupAdvancedSearchToggle();
    })
    .catch(err => {
        els.stats.innerHTML = "Error loading data files.";
        console.error(err);
    });


// ==========================================
// INTERACTIVE CHARTS
// ==========================================
function destroyHistoricalCharts() {
    const charts = state.historicalCharts || {};
    for (const key in charts) {
        const chart = charts[key];
        if (!chart) continue;
        try { chart.destroy(); } catch (e) { /* no-op */ }
    }
    state.historicalCharts = {};
    state.transitionChart = null;
}

function registerHistoricalChart(key, chart) {
    if (!chart) return;
    state.historicalCharts[key] = chart;
}

// HISTORICAL_QUANTILE_START
function quantileValue(values, p) {
    if (!Array.isArray(values) || values.length < 2) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const idx = (sorted.length - 1) * p;
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return sorted[idx];
    const weight = idx - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
// HISTORICAL_QUANTILE_END

// HISTORICAL_TENURE_HELPERS_START
function computeTenureShares(counts, total) {
    const safeDiv = (num, den) => (den > 0 ? (num / den) * 100 : null);
    return {
        lt3: safeDiv(counts.lt3 || 0, total),
        threeTo7: safeDiv(counts.threeTo7 || 0, total),
        sevenTo15: safeDiv(counts.sevenTo15 || 0, total),
        fifteenPlus: safeDiv(counts.fifteenPlus || 0, total)
    };
}
// HISTORICAL_TENURE_HELPERS_END

function loadUpperMiddleManagementMetrics() {
    const metrics = state.roleGroupConcentration || { points: [], methodology: {} };
    return Promise.resolve(metrics);
}

function loadPayDistributionMetrics() {
    return Promise.resolve(state.payDistributionMetrics || { points: [] });
}

function loadTenureMixMetrics() {
    return Promise.resolve(state.tenureMixMetrics || { points: [] });
}

function resizeHistoricalCharts() {
    const charts = state.historicalCharts || {};
    for (const key in charts) {
        const chart = charts[key];
        if (!chart) continue;
        try { chart.resize(); } catch (e) { /* no-op */ }
    }
}

function getHistoricalChartByCanvasId(canvasId) {
    if (!canvasId) return null;
    const charts = Object.values(state.historicalCharts || {});
    for (let i = 0; i < charts.length; i++) {
        const chart = charts[i];
        if (chart && chart.canvas && chart.canvas.id === canvasId) return chart;
    }
    return null;
}

function clearPseudoHistoricalFullscreen() {
    if (!state.historicalPseudoFullscreenCard) return;
    state.historicalPseudoFullscreenCard.classList.remove('pseudo-fullscreen');
    state.historicalPseudoFullscreenCard = null;
    document.body.classList.remove('historical-no-scroll');
    resizeHistoricalCharts();
}

function enterPseudoHistoricalFullscreen(cardEl) {
    if (!cardEl) return;
    clearPseudoHistoricalFullscreen();
    cardEl.classList.add('pseudo-fullscreen');
    state.historicalPseudoFullscreenCard = cardEl;
    document.body.classList.add('historical-no-scroll');
    resizeHistoricalCharts();
}

function setupHistoricalChartFullscreen(container) {
    if (!container || container.dataset.fullscreenBound === 'true') return;
    container.dataset.fullscreenBound = 'true';

    container.addEventListener('click', (event) => {
        const button = event.target.closest('.chart-fullscreen-btn');
        if (!button) return;
        const cardEl = button.closest('.historical-card');
        if (!cardEl) return;
        const canvasId = button.getAttribute('data-canvas-id') || '';
        const fullscreenEl = document.fullscreenElement;

        if (state.historicalPseudoFullscreenCard === cardEl) {
            clearPseudoHistoricalFullscreen();
            return;
        }

        if (fullscreenEl === cardEl && document.exitFullscreen) {
            document.exitFullscreen().finally(() => {
                const chart = getHistoricalChartByCanvasId(canvasId);
                if (chart) chart.resize();
            });
            return;
        }

        if (cardEl.requestFullscreen) {
            cardEl.requestFullscreen()
                .then(() => {
                    const chart = getHistoricalChartByCanvasId(canvasId);
                    if (chart) chart.resize();
                })
                .catch(() => {
                    enterPseudoHistoricalFullscreen(cardEl);
                });
            return;
        }

        enterPseudoHistoricalFullscreen(cardEl);
    });

    if (!state.historicalFullscreenEventsBound) {
        state.historicalFullscreenEventsBound = true;
        document.addEventListener('fullscreenchange', () => {
            setTimeout(resizeHistoricalCharts, 40);
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && state.historicalPseudoFullscreenCard) {
                clearPseudoHistoricalFullscreen();
            }
        });
    }
}

// HISTORICAL_METRICS_START
function buildHistoricalLaborMetrics(history, transitions) {
    const safeDiv = (num, den) => (den > 0 ? num / den : null);
    const toYear = (date) => {
        if (!date || date.length < 4) return null;
        const yearNum = Number.parseInt(date.slice(0, 4), 10);
        return Number.isNaN(yearNum) ? null : yearNum;
    };
    const toPct = (part, total) => {
        if (!total || total <= 0) return null;
        return (part / total) * 100;
    };

    const historyLen = history ? history.length : 0;
    const sortedHistory = new Array(historyLen);
    let hCount = 0;
    for (let i = 0; i < historyLen; i++) {
        const item = history[i];
        if (item) {
            sortedHistory[hCount++] = item;
        }
    }
    sortedHistory.length = hCount;
    sortedHistory.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const points = new Array(hCount);
    const yearEndHeadcount = {};
    const inflationAvailable = hasInflationData();

    let baseComparable = null;
    let baseClassified = null;
    let baseUnclassified = null;

    for (let i = 0; i < hCount; i++) {
        const item = sortedHistory[i];
        const classified = Number(item.classified) || 0;
        const unclassified = Number(item.unclassified) || 0;
        const payrollClassified = Number(item.payrollClassified) || 0;
        const payrollUnclassified = Number(item.payrollUnclassified) || 0;
        const payrollTotal = Number(item.payroll) || (payrollClassified + payrollUnclassified);
        const totalHeadcount = classified + unclassified;
        const perCapitaClassified = safeDiv(payrollClassified, classified);
        const perCapitaUnclassified = safeDiv(payrollUnclassified, unclassified);
        const perCapitaAll = safeDiv(payrollTotal, totalHeadcount);
        const payGapDollar = (perCapitaUnclassified !== null && perCapitaClassified !== null)
            ? perCapitaUnclassified - perCapitaClassified
            : null;
        const payGapRatio = perCapitaClassified && perCapitaClassified > 0
            ? safeDiv(perCapitaUnclassified, perCapitaClassified)
            : null;

        const dateStr = item.date || '';
        const year = toYear(dateStr);

        const point = {
            date: dateStr,
            year: year,
            classified,
            unclassified,
            totalHeadcount,
            payrollClassified,
            payrollUnclassified,
            payrollTotal,
            perCapitaClassified,
            perCapitaUnclassified,
            perCapitaAll,
            headcountShareClassifiedPct: toPct(classified, totalHeadcount),
            headcountShareUnclassifiedPct: toPct(unclassified, totalHeadcount),
            payrollShareClassifiedPct: toPct(payrollClassified, payrollTotal),
            payrollShareUnclassifiedPct: toPct(payrollUnclassified, payrollTotal),
            payGapDollar,
            payGapRatio,
            perCapitaClassifiedReal: null,
            perCapitaUnclassifiedReal: null,
            classifiedIndexedReal: null,
            unclassifiedIndexedReal: null
        };
        points[i] = point;

        if (year !== null) {
            yearEndHeadcount[year] = totalHeadcount;
        }

        point.perCapitaClassifiedReal = (point.perCapitaClassified !== null && point.perCapitaClassified > 0)
            ? (inflationAvailable ? adjustForInflation(point.perCapitaClassified, point.date) : point.perCapitaClassified)
            : null;
        point.perCapitaUnclassifiedReal = (point.perCapitaUnclassified !== null && point.perCapitaUnclassified > 0)
            ? (inflationAvailable ? adjustForInflation(point.perCapitaUnclassified, point.date) : point.perCapitaUnclassified)
            : null;

        if (!baseComparable && point.perCapitaClassifiedReal !== null && point.perCapitaUnclassifiedReal !== null && point.perCapitaClassifiedReal > 0 && point.perCapitaUnclassifiedReal > 0) {
            baseComparable = point;
            baseClassified = point.perCapitaClassifiedReal;
            baseUnclassified = point.perCapitaUnclassifiedReal;
        }
    }

    for (let i = 0; i < hCount; i++) {
        const point = points[i];
        if (baseClassified && baseClassified > 0 && point.perCapitaClassifiedReal !== null) {
            point.classifiedIndexedReal = (point.perCapitaClassifiedReal / baseClassified) * 100;
        }
        if (baseUnclassified && baseUnclassified > 0 && point.perCapitaUnclassifiedReal !== null) {
            point.unclassifiedIndexedReal = (point.perCapitaUnclassifiedReal / baseUnclassified) * 100;
        }
    }

    const tLen = transitions ? transitions.length : 0;
    const transitionPoints = new Array(tLen);
    let trCount = 0;
    for (let i = 0; i < tLen; i++) {
        const item = transitions[i];
        if (!item) continue;
        const year = Number.parseInt(item.year, 10);
        if (Number.isNaN(year)) continue;

        const toUnclassified = Number(item.toUnclassified) || 0;
        const toClassified = Number(item.toClassified) || 0;
        const totalMoves = toUnclassified + toClassified;
        const endingHeadcount = yearEndHeadcount[year] || 0;

        transitionPoints[trCount++] = {
            year: year,
            toUnclassified,
            toClassified,
            netToUnclassified: toUnclassified - toClassified,
            yearEndHeadcount: endingHeadcount,
            transitionRatePer1000: safeDiv(totalMoves * 1000, endingHeadcount)
        };
    }
    transitionPoints.length = trCount;
    transitionPoints.sort((a, b) => a.year - b.year);

    const latest = points.length ? points[points.length - 1] : null;
    const kpis = {
        latestDate: latest ? latest.date : '',
        classifiedHeadcountSharePct: latest ? latest.headcountShareClassifiedPct : null,
        classifiedPayrollSharePct: latest ? latest.payrollShareClassifiedPct : null,
        payGapDollar: latest ? latest.payGapDollar : null,
        payGapRatio: latest ? latest.payGapRatio : null
    };

    return {
        points,
        latest,
        transitionPoints,
        kpis,
        inflationAvailable,
        indexBaseDate: baseComparable ? baseComparable.date : null
    };
}
// HISTORICAL_METRICS_END

if (typeof window !== 'undefined') {
    window.__historicalLaborMetrics = { buildHistoricalLaborMetrics };
}

function renderInteractiveCharts(history) {
    if (typeof Chart === 'undefined') return;

    let container = document.getElementById('historical-charts-container');
    if (!container) return;

    try {
        destroyHistoricalCharts();

        const comparisonHistory = (state.pairedHistoryStats && state.pairedHistoryStats.length)
            ? state.pairedHistoryStats
            : history;
        const metrics = buildHistoricalLaborMetrics(comparisonHistory, state.classTransitions || []);
        const exactMetrics = comparisonHistory === history
            ? metrics
            : buildHistoricalLaborMetrics(history, []);
        const exactByDate = new Map((exactMetrics.points || []).map(point => [point.date, point]));
        const points = metrics.points || [];
        const latest = metrics.latest || null;
        const kpis = metrics.kpis || {};

        const fmtPct = (value) => (value === null || value === undefined ? 'n/a' : `${value.toFixed(1)}%`);
        const perCapitaGapLabel = (kpis.payGapDollar === null || kpis.payGapDollar === undefined)
            ? 'n/a'
            : `${formatMoney(kpis.payGapDollar)} (${kpis.payGapRatio ? `${kpis.payGapRatio.toFixed(2)}x` : 'n/a'})`;

        const latestDateLabel = kpis.latestDate ? formatDate(kpis.latestDate) : 'n/a';

        const len = points.length;
        const labels = new Array(len);
        const classifiedHeadcounts = new Array(len);
        const unclassifiedHeadcounts = new Array(len);
        const totalHeadcounts = new Array(len);
        const classifiedPayroll = new Array(len);
        const unclassifiedPayroll = new Array(len);
        const totalPayroll = new Array(len);
        const perCapitaClassified = new Array(len);
        const perCapitaUnclassified = new Array(len);
        const perCapitaAll = new Array(len);

        for (let i = 0; i < len; i++) {
            const point = points[i];
            const exactPoint = exactByDate.get(point.date);
            labels[i] = point.date;
            classifiedHeadcounts[i] = point.classified;
            unclassifiedHeadcounts[i] = point.unclassified;
            totalHeadcounts[i] = exactPoint ? exactPoint.totalHeadcount : point.totalHeadcount;
            classifiedPayroll[i] = point.payrollClassified;
            unclassifiedPayroll[i] = point.payrollUnclassified;
            totalPayroll[i] = exactPoint ? exactPoint.payrollTotal : point.payrollTotal;
            perCapitaClassified[i] = point.perCapitaClassified;
            perCapitaUnclassified[i] = point.perCapitaUnclassified;
            perCapitaAll[i] = exactPoint ? exactPoint.perCapitaAll : point.perCapitaAll;
        }

        container.innerHTML = `
        <div class="historical-warning">
            <span class="historical-warning-icon">⚠️</span>
            <span><strong>Data Incomplete:</strong> Cross-classification comparisons use nearest prior paired reports within 120 days; exact snapshot totals can still reflect missing same-day reports.</span>
        </div>
        <div id="historical-kpi-strip" class="historical-kpi-strip">
            <div class="historical-kpi">
                <div class="historical-kpi-label">Latest Snapshot</div>
                <div class="historical-kpi-value">${escapeHtml(latestDateLabel)}</div>
            </div>
            <div class="historical-kpi">
                <div class="historical-kpi-label">Classified Headcount Share</div>
                <div class="historical-kpi-value">${escapeHtml(fmtPct(kpis.classifiedHeadcountSharePct))}</div>
            </div>
            <div class="historical-kpi">
                <div class="historical-kpi-label">Classified Payroll Share</div>
                <div class="historical-kpi-value">${escapeHtml(fmtPct(kpis.classifiedPayrollSharePct))}</div>
            </div>
            <div class="historical-kpi">
                <div class="historical-kpi-label">Per-Capita Gap (Unclass - Class)</div>
                <div class="historical-kpi-value">${escapeHtml(perCapitaGapLabel)}</div>
            </div>
        </div>
        <div id="historical-core-grid" class="historical-core-grid">
            <div class="stat-card historical-card historical-hero-card">
                <div class="chart-title-row">
                    <div class="stat-label">Headcount by Classification</div>
                    <span class="chart-info-icon help-cursor" data-tooltip="Shows workforce counts across snapshots for Classified and Unclassified employees, plus a Total line. Use this to see whether labor composition is shifting over time, not just at the latest snapshot." aria-label="Chart explainer: Headcount by Classification" tabindex="0">i</span>
                </div>
                <button type="button" class="chart-fullscreen-btn" data-canvas-id="chart-headcount" aria-label="View Headcount by Classification in fullscreen">⛶</button>
                <div class="historical-canvas-wrap"><canvas id="chart-headcount"></canvas></div>
                <div class="stat-sub">Classified and Unclassified trends, with total headcount overlay.</div>
            </div>
            <div class="historical-primary-grid">
            <div class="stat-card historical-card">
                <div class="chart-title-row">
                    <div class="stat-label">Total Payroll by Classification</div>
                    <span class="chart-info-icon help-cursor" data-tooltip="Displays total payroll trend by classification. Payroll is computed as Annual Salary Rate × Appt Percent for each record, then summed by snapshot. Compare lines to understand where compensation dollars are concentrated over time." aria-label="Chart explainer: Total Payroll by Classification" tabindex="0">i</span>
                </div>
                <button type="button" class="chart-fullscreen-btn" data-canvas-id="chart-payroll" aria-label="View Total Payroll by Classification in fullscreen">⛶</button>
                <div class="historical-canvas-wrap"><canvas id="chart-payroll"></canvas></div>
                <div class="stat-sub">Payroll totals are computed as Salary Rate × Appointment Percent.</div>
            </div>
            <div class="stat-card historical-card">
                <div class="chart-title-row">
                    <div class="stat-label">Latest Headcount Split</div>
                    <span class="chart-info-icon help-cursor" data-tooltip="Pie of the most recent snapshot only. It shows the current share of Classified vs Unclassified workers and does not indicate trend direction by itself." aria-label="Chart explainer: Latest Headcount Split" tabindex="0">i</span>
                </div>
                <button type="button" class="chart-fullscreen-btn" data-canvas-id="chart-headcount-split" aria-label="View Latest Headcount Split in fullscreen">⛶</button>
                <div class="historical-canvas-wrap short"><canvas id="chart-headcount-split"></canvas></div>
                <div class="stat-sub">Current workforce composition by classification.</div>
            </div>
            <div class="stat-card historical-card">
                <div class="chart-title-row">
                    <div class="stat-label">Per-Capita Pay Trend</div>
                    <span class="chart-info-icon help-cursor" data-tooltip="Tracks average payroll per person for All, Classified, and Unclassified groups by snapshot. Divergence between lines indicates changes in relative compensation levels, mix, or both." aria-label="Chart explainer: Per-Capita Pay Trend" tabindex="0">i</span>
                </div>
                <button type="button" class="chart-fullscreen-btn" data-canvas-id="chart-per-capita" aria-label="View Per-Capita Pay Trend in fullscreen">⛶</button>
                <div class="historical-canvas-wrap"><canvas id="chart-per-capita"></canvas></div>
                <div class="stat-sub">Average pay per person over time for each classification.</div>
            </div>
            <div class="stat-card historical-card">
                <div class="chart-title-row">
                    <div class="stat-label">Latest Payroll Share</div>
                    <span class="chart-info-icon help-cursor" data-tooltip="Pie of current payroll distribution between Classified and Unclassified groups in the latest snapshot. Useful for comparing spending share to headcount share." aria-label="Chart explainer: Latest Payroll Share" tabindex="0">i</span>
                </div>
                <button type="button" class="chart-fullscreen-btn" data-canvas-id="chart-payroll-share" aria-label="View Latest Payroll Share in fullscreen">⛶</button>
                <div class="historical-canvas-wrap short"><canvas id="chart-payroll-share"></canvas></div>
                <div class="stat-sub">Current compensation distribution by classification.</div>
            </div>
            </div>
        </div>
        <div class="historical-expand-row">
            <button type="button" id="historical-advanced-toggle" class="section-toggle historical-more-btn" aria-expanded="false">
                More labor charts
            </button>
        </div>
        <div id="historical-advanced-panel" class="historical-advanced-panel hidden" aria-hidden="true"></div>
    `;
        setupHistoricalChartFullscreen(container);

        registerHistoricalChart('headcount', new Chart(document.getElementById('chart-headcount').getContext('2d'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Classified',
                    data: classifiedHeadcounts,
                    borderColor: '#2aad69',
                    backgroundColor: 'rgba(42, 173, 105, 0.22)',
                    fill: true,
                    tension: 0.25
                },
                {
                    label: 'Unclassified',
                    data: unclassifiedHeadcounts,
                    borderColor: '#fee11a',
                    backgroundColor: 'rgba(254, 225, 26, 0.2)',
                    fill: true,
                    tension: 0.25
                },
                {
                    label: 'Total',
                    data: totalHeadcounts,
                    borderColor: '#60a5fa',
                    borderDash: [6, 4],
                    fill: false,
                    tension: 0.2,
                    pointRadius: 1
                }
            ]
        },
        options: getChartOptions({
            yTickCallback: (value) => Number(value).toLocaleString(),
            animation: false,
            xTickLimit: 8
        })
    }));

        registerHistoricalChart('payroll', new Chart(document.getElementById('chart-payroll').getContext('2d'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Classified Payroll',
                    data: classifiedPayroll,
                    borderColor: '#2aad69',
                    backgroundColor: 'rgba(42, 173, 105, 0.2)',
                    fill: true,
                    tension: 0.25
                },
                {
                    label: 'Unclassified Payroll',
                    data: unclassifiedPayroll,
                    borderColor: '#fee11a',
                    backgroundColor: 'rgba(254, 225, 26, 0.2)',
                    fill: true,
                    tension: 0.25
                },
                {
                    label: 'Total Payroll',
                    data: totalPayroll,
                    borderColor: '#22c55e',
                    borderDash: [6, 4],
                    fill: false,
                    tension: 0.2,
                    pointRadius: 1
                }
            ]
        },
        options: getChartOptions({
            yTickCallback: (value) => formatMoney(value),
            animation: false,
            xTickLimit: 8
        })
    }));

        const latestHeadcountSplit = latest
            ? [latest.classified || 0, latest.unclassified || 0]
            : [0, 0];
        registerHistoricalChart('headcountSplit', new Chart(document.getElementById('chart-headcount-split').getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: ['Classified', 'Unclassified'],
            datasets: [{
                data: latestHeadcountSplit,
                backgroundColor: ['#2aad69', '#fee11a'],
                borderColor: '#2c2c2c',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { color: '#ccc' } }
            }
        }
    }));

        const latestPayrollSplit = latest
            ? [latest.payrollClassified || 0, latest.payrollUnclassified || 0]
            : [0, 0];
        registerHistoricalChart('payrollShare', new Chart(document.getElementById('chart-payroll-share').getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: ['Classified Payroll', 'Unclassified Payroll'],
                datasets: [{
                    data: latestPayrollSplit,
                    backgroundColor: ['#2aad69', '#fee11a'],
                    borderColor: '#2c2c2c',
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#ccc' } }
                }
            }
        }));

        registerHistoricalChart('perCapita', new Chart(document.getElementById('chart-per-capita').getContext('2d'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'All',
                    data: perCapitaAll,
                    borderColor: '#60a5fa',
                    backgroundColor: 'rgba(96, 165, 250, 0.12)',
                    fill: true,
                    tension: 0.3
                },
                {
                    label: 'Classified',
                    data: perCapitaClassified,
                    borderColor: '#2aad69',
                    backgroundColor: 'rgba(42, 173, 105, 0.08)',
                    fill: false,
                    tension: 0.3
                },
                {
                    label: 'Unclassified',
                    data: perCapitaUnclassified,
                    borderColor: '#fee11a',
                    backgroundColor: 'rgba(254, 225, 26, 0.08)',
                    fill: false,
                    tension: 0.3
                }
            ]
        },
        options: getChartOptions({
            yTickCallback: (value) => formatMoney(value),
            animation: false,
            xTickLimit: 8
        })
    }));

        state.historicalAdvancedRendered = false;
        const advancedPanel = document.getElementById('historical-advanced-panel');
        const advancedToggle = document.getElementById('historical-advanced-toggle');
        if (!advancedPanel || !advancedToggle) return;

        const renderAdvancedHistoricalCharts = () => {
        if (state.historicalAdvancedRendered) return;
        state.historicalAdvancedRendered = true;

        const transitionPoints = metrics.transitionPoints || [];
        const transitionLen = transitionPoints.length;
        const transitionLabels = new Array(transitionLen);
        const transitionOut = new Array(transitionLen);
        const transitionIn = new Array(transitionLen);
        const transitionNet = new Array(transitionLen);
        const transitionRate = new Array(transitionLen);

        for (let i = 0; i < transitionLen; i++) {
            const point = transitionPoints[i];
            transitionLabels[i] = String(point.year);
            transitionOut[i] = point.toUnclassified;
            transitionIn[i] = point.toClassified;
            transitionNet[i] = point.netToUnclassified;
            transitionRate[i] = point.transitionRatePer1000;
        }

        const pointsLen = points.length;
        const payGapDollar = new Array(pointsLen);
        const payGapRatio = new Array(pointsLen);

        for (let i = 0; i < pointsLen; i++) {
            const point = points[i];
            payGapDollar[i] = point.payGapDollar;
            payGapRatio[i] = point.payGapRatio;
        }

        advancedPanel.innerHTML = `
            <div class="historical-advanced-grid">
                <div class="stat-card historical-card">
                    <div class="chart-title-row">
                        <div class="stat-label">Classification Transitions</div>
                        <span class="chart-info-icon help-cursor" data-tooltip="Counts classification switches between consecutive snapshots. Bars show gross flows (Classified→Unclassified and reverse); the line shows net movement to Unclassified. Click either bar to apply the transition filter." aria-label="Chart explainer: Classification Transitions" tabindex="0">i</span>
                    </div>
                    <button type="button" class="chart-fullscreen-btn" data-canvas-id="chart-transitions" aria-label="View Classification Transitions in fullscreen">⛶</button>
                    <div class="historical-canvas-wrap"><canvas id="chart-transitions"></canvas></div>
                    <div class="stat-sub">Bar: gross moves. Line: net movement to unclassified.</div>
                </div>
                <div class="stat-card historical-card">
                    <div class="chart-title-row">
                        <div class="stat-label">Transition Intensity</div>
                        <span class="chart-info-icon help-cursor" data-tooltip="Normalizes transition volume by workforce size using: (toUnclassified + toClassified) / yearEndHeadcount × 1000. Higher values indicate more classification churn per 1,000 workers." aria-label="Chart explainer: Transition Intensity" tabindex="0">i</span>
                    </div>
                    <button type="button" class="chart-fullscreen-btn" data-canvas-id="chart-transition-intensity" aria-label="View Transition Intensity in fullscreen">⛶</button>
                    <div class="historical-canvas-wrap"><canvas id="chart-transition-intensity"></canvas></div>
                    <div class="stat-sub">Annual transitions per 1,000 workers (using same-year ending headcount).</div>
                </div>
                <div class="stat-card historical-card">
                    <div class="chart-title-row">
                        <div class="stat-label">Indexed Per-Capita Pay (Base 100)</div>
                        <span class="chart-info-icon help-cursor" data-tooltip="Indexes classified and unclassified per-capita pay to the first comparable snapshot (base=100). Values above 100 are higher than baseline; below 100 are lower. Uses CPI-adjusted values when inflation data is available, otherwise nominal fallback." aria-label="Chart explainer: Indexed Per-Capita Pay" tabindex="0">i</span>
                    </div>
                    <button type="button" class="chart-fullscreen-btn" data-canvas-id="chart-indexed-pay" aria-label="View Indexed Per-Capita Pay in fullscreen">⛶</button>
                    <div class="historical-canvas-wrap"><canvas id="chart-indexed-pay"></canvas></div>
                    <div class="stat-sub">${metrics.indexBaseDate ? `Base snapshot: ${escapeHtml(formatDate(metrics.indexBaseDate))}.` : 'Insufficient baseline data.'} ${metrics.inflationAvailable ? 'CPI-adjusted.' : 'Nominal fallback (inflation data unavailable).'}</div>
                </div>
                <div class="stat-card historical-card">
                    <div class="chart-title-row">
                        <div class="stat-label">Per-Head Cost Gap</div>
                        <span class="chart-info-icon help-cursor" data-tooltip="Compares unclassified vs classified cost per person over time. Dollar gap is Unclassified per-head minus Classified per-head. Ratio is Unclassified divided by Classified; values above 1.0 indicate higher unclassified cost per head." aria-label="Chart explainer: Per-Head Cost Gap" tabindex="0">i</span>
                    </div>
                    <button type="button" class="chart-fullscreen-btn" data-canvas-id="chart-per-head-gap" aria-label="View Per-Head Cost Gap in fullscreen">⛶</button>
                    <div class="historical-canvas-wrap"><canvas id="chart-per-head-gap"></canvas></div>
                    <div class="stat-sub">Dollar and ratio view of the unclassified vs classified per-head cost spread.</div>
                </div>
                <div class="stat-card historical-card">
                    <div class="chart-title-row">
                        <div class="stat-label">Pay Concentration</div>
                        <span class="chart-info-icon help-cursor" data-tooltip="Tracks how much total payroll sits in the top 1%, 5%, and 10% of paid records per snapshot. Ratios compare P90/P50 and P50/P10 pay levels." aria-label="Chart explainer: Pay Concentration" tabindex="0">i</span>
                    </div>
                    <button type="button" class="chart-fullscreen-btn" data-canvas-id="chart-pay-concentration" aria-label="View Pay Concentration in fullscreen">⛶</button>
                    <div class="historical-canvas-wrap"><canvas id="chart-pay-concentration"></canvas></div>
                    <div class="stat-sub" id="pay-concentration-status">Payroll share held by top-paid records.</div>
                </div>
                <div class="stat-card historical-card">
                    <div class="chart-title-row">
                        <div class="stat-label">Role Group Concentration</div>
                        <span class="chart-info-icon help-cursor" data-tooltip="Tracks the number and share of roles matching a transparent title heuristic: includes director/manager/head/chair terms and excludes vice president/provost/chancellor/president/chief/dean terms." aria-label="Chart explainer: Role Group Concentration" tabindex="0">i</span>
                    </div>
                    <button type="button" class="chart-fullscreen-btn" data-canvas-id="chart-role-group" aria-label="View Role Group Concentration in fullscreen">⛶</button>
                    <div class="historical-canvas-wrap"><canvas id="chart-role-group"></canvas></div>
                    <div class="stat-sub" id="role-group-status">Title heuristic trend from generated aggregates.</div>
                </div>
                <div class="stat-card historical-card">
                    <div class="chart-title-row">
                        <div class="stat-label">Role Group Payroll vs Headcount Share</div>
                        <span class="chart-info-icon help-cursor" data-tooltip="Compares this role group's share of total headcount versus its share of payroll using the same title heuristic. Spread line shows payroll share minus headcount share." aria-label="Chart explainer: Role Group Payroll vs Headcount Share" tabindex="0">i</span>
                    </div>
                    <button type="button" class="chart-fullscreen-btn" data-canvas-id="chart-role-group-share" aria-label="View Role Group Payroll vs Headcount Share in fullscreen">⛶</button>
                    <div class="historical-canvas-wrap"><canvas id="chart-role-group-share"></canvas></div>
                    <div class="stat-sub" id="role-group-share-status">Headcount vs payroll share with spread line.</div>
                </div>
                <div class="stat-card historical-card">
                    <div class="chart-title-row">
                        <div class="stat-label">Pay Distribution Percentiles</div>
                        <span class="chart-info-icon help-cursor" data-tooltip="Shows P10/P50/P90 pay levels (nominal dollars) for Classified and Unclassified employees per snapshot. Solid lines = Classified; dashed = Unclassified. Useful for seeing shifts in typical and tail pay." aria-label="Chart explainer: Pay Distribution Percentiles" tabindex="0">i</span>
                    </div>
                    <button type="button" class="chart-fullscreen-btn" data-canvas-id="chart-pay-percentiles" aria-label="View Pay Distribution Percentiles in fullscreen">⛶</button>
                    <div class="historical-canvas-wrap"><canvas id="chart-pay-percentiles"></canvas></div>
                    <div class="stat-sub" id="pay-percentiles-status">Loading percentile curves...</div>
                </div>
                <div class="stat-card historical-card">
                    <div class="chart-title-row">
                        <div class="stat-label">Tenure Mix by Classification</div>
                        <span class="chart-info-icon help-cursor" data-tooltip="100% stacked bars for each snapshot, grouped by classification. Bands: <3y, 3-7y, 7-15y, 15y+. Each bar is percent of that classification’s headcount." aria-label="Chart explainer: Tenure Mix by Classification" tabindex="0">i</span>
                    </div>
                    <button type="button" class="chart-fullscreen-btn" data-canvas-id="chart-tenure-mix" aria-label="View Tenure Mix by Classification in fullscreen">⛶</button>
                    <div class="historical-canvas-wrap"><canvas id="chart-tenure-mix"></canvas></div>
                    <div class="stat-sub" id="tenure-mix-status">Loading tenure mix breakdown...</div>
                </div>
            </div>
        `;

        const transitionChart = new Chart(document.getElementById('chart-transitions').getContext('2d'), {
            type: 'bar',
            data: {
                labels: transitionLabels,
                datasets: [
                    {
                        label: 'Classified → Unclassified',
                        data: transitionOut,
                        backgroundColor: '#fee11a'
                    },
                    {
                        label: 'Unclassified → Classified',
                        data: transitionIn,
                        backgroundColor: '#2aad69'
                    },
                    {
                        type: 'line',
                        label: 'Net to Unclassified',
                        data: transitionNet,
                        borderColor: '#60a5fa',
                        pointBackgroundColor: '#60a5fa',
                        fill: false,
                        tension: 0.2
                    }
                ]
            },
            options: {
                ...getChartOptions({
                    yTickCallback: (value) => Number(value).toLocaleString(),
                    animation: false,
                    xTickLimit: 8
                }),
                onClick: (_, activeElements) => {
                    if (!activeElements || !activeElements.length) return;
                    const { index, datasetIndex } = activeElements[0];
                    if (datasetIndex > 1) return;
                    const point = transitionPoints[index];
                    if (!point) return;
                    const direction = datasetIndex === 0 ? 'toUnclassified' : 'toClassified';
                    applyTransitionFilter(point.year, direction);
                },
                onHover: (event, activeElements) => {
                    const canvas = event?.native?.target;
                    if (!canvas) return;
                    const active = activeElements && activeElements.length && activeElements[0].datasetIndex <= 1;
                    canvas.style.cursor = active ? 'pointer' : 'default';
                }
            }
        });
        registerHistoricalChart('transitions', transitionChart);
        state.transitionChart = transitionChart;

        registerHistoricalChart('transitionIntensity', new Chart(document.getElementById('chart-transition-intensity').getContext('2d'), {
            type: 'line',
            data: {
                labels: transitionLabels,
                datasets: [
                    {
                        label: 'Transitions per 1,000 workers',
                        data: transitionRate,
                        borderColor: '#22c55e',
                        backgroundColor: 'rgba(34, 197, 94, 0.12)',
                        fill: true,
                        tension: 0.25
                    }
                ]
            },
            options: getChartOptions({
                yTickCallback: (value) => (value === null || value === undefined ? 'n/a' : Number(value).toFixed(1)),
                animation: false,
                xTickLimit: 8
            })
        }));

        registerHistoricalChart('indexedPay', new Chart(document.getElementById('chart-indexed-pay').getContext('2d'), {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Classified',
                        data: points.map(point => point.classifiedIndexedReal),
                        borderColor: '#2aad69',
                        backgroundColor: 'rgba(42, 173, 105, 0.12)',
                        fill: false,
                        tension: 0.2
                    },
                    {
                        label: 'Unclassified',
                        data: points.map(point => point.unclassifiedIndexedReal),
                        borderColor: '#fee11a',
                        backgroundColor: 'rgba(254, 225, 26, 0.12)',
                        fill: false,
                        tension: 0.2
                    }
                ]
            },
            options: getChartOptions({
                yTickCallback: (value) => (value === null || value === undefined ? 'n/a' : `${Number(value).toFixed(1)}`),
                animation: false,
                xTickLimit: 8
            })
        }));

        registerHistoricalChart('perHeadGap', new Chart(document.getElementById('chart-per-head-gap').getContext('2d'), {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Dollar Gap (Unclass - Class)',
                        data: payGapDollar,
                        borderColor: '#fbbf24',
                        backgroundColor: 'rgba(251, 191, 36, 0.12)',
                        fill: true,
                        tension: 0.25,
                        yAxisID: 'y'
                    },
                    {
                        label: 'Per-Head Ratio (Unclass / Class)',
                        data: payGapRatio,
                        borderColor: '#60a5fa',
                        fill: false,
                        tension: 0.2,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                ...getChartOptions({
                    yTickCallback: (value) => formatMoney(value),
                    animation: false,
                    xTickLimit: 8
                }),
                scales: {
                    x: { ticks: { color: '#888' }, grid: { color: '#333' } },
                    y: {
                        ticks: { color: '#888', callback: (value) => formatMoney(value) },
                        grid: { color: '#333' }
                    },
                    y1: {
                        position: 'right',
                        ticks: { color: '#888', callback: (value) => `${Number(value).toFixed(2)}x` },
                        grid: { drawOnChartArea: false, color: '#333' }
                    }
                }
            }
        }));

        const concentrationMetrics = state.payConcentrationMetrics || { points: [] };
        const concentrationPoints = concentrationMetrics.points || [];
        const concentrationLabels = concentrationPoints.map(point => point.date);
        const concentrationStatus = document.getElementById('pay-concentration-status');
        if (concentrationStatus) {
            concentrationStatus.textContent = concentrationPoints.length
                ? 'Top payroll shares and spread ratios from generated aggregates.'
                : 'No pay concentration data.';
        }
        registerHistoricalChart('payConcentration', new Chart(document.getElementById('chart-pay-concentration').getContext('2d'), {
            type: 'line',
            data: {
                labels: concentrationLabels,
                datasets: [
                    {
                        label: 'Top 1% Payroll Share',
                        data: concentrationPoints.map(p => p.top1SharePct),
                        borderColor: '#fee11a',
                        backgroundColor: 'rgba(254, 225, 26, 0.12)',
                        fill: false,
                        tension: 0.2,
                        yAxisID: 'y'
                    },
                    {
                        label: 'Top 5% Payroll Share',
                        data: concentrationPoints.map(p => p.top5SharePct),
                        borderColor: '#fbbf24',
                        backgroundColor: 'rgba(251, 191, 36, 0.12)',
                        fill: false,
                        tension: 0.2,
                        yAxisID: 'y'
                    },
                    {
                        label: 'Top 10% Payroll Share',
                        data: concentrationPoints.map(p => p.top10SharePct),
                        borderColor: '#22c55e',
                        backgroundColor: 'rgba(34, 197, 94, 0.12)',
                        fill: false,
                        tension: 0.2,
                        yAxisID: 'y'
                    },
                    {
                        label: 'P90 / P50',
                        data: concentrationPoints.map(p => p.p90P50Ratio),
                        borderColor: '#60a5fa',
                        borderDash: [6, 4],
                        fill: false,
                        tension: 0.2,
                        yAxisID: 'y1'
                    },
                    {
                        label: 'P50 / P10',
                        data: concentrationPoints.map(p => p.p50P10Ratio),
                        borderColor: '#98d4aa',
                        borderDash: [2, 4],
                        fill: false,
                        tension: 0.2,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                ...getChartOptions({
                    yTickCallback: (value) => `${Number(value).toFixed(0)}%`,
                    animation: false,
                    xTickLimit: 8,
                    legend: true
                }),
                scales: {
                    x: { ticks: { color: '#888' }, grid: { color: '#333' } },
                    y: {
                        ticks: { color: '#888', callback: (value) => `${Number(value).toFixed(0)}%` },
                        grid: { color: '#333' }
                    },
                    y1: {
                        position: 'right',
                        ticks: { color: '#888', callback: (value) => `${Number(value).toFixed(2)}x` },
                        grid: { drawOnChartArea: false, color: '#333' }
                    }
                }
            }
        }));

        loadUpperMiddleManagementMetrics()
            .then((roleMetrics) => {
                const rolePoints = (roleMetrics && roleMetrics.points) ? roleMetrics.points : [];
                const roleLabels = [];
                const roleCount = [];
                const roleShare = [];
                const rolePayrollShare = [];
                const roleSpread = [];

                for (let i = 0; i < rolePoints.length; i++) {
                    const point = rolePoints[i];
                    roleLabels.push(point.date);
                    roleCount.push(point.roleGroup ?? point.upper ?? 0);
                    roleShare.push(point.headcountSharePct);
                    rolePayrollShare.push(point.payrollSharePct);
                    if (point.payrollSharePct === null || point.headcountSharePct === null) {
                        roleSpread.push(null);
                    } else {
                        roleSpread.push(point.payrollSharePct - point.headcountSharePct);
                    }
                }
                const methodology = (roleMetrics && roleMetrics.methodology) ? roleMetrics.methodology : {};
                const statusEl = document.getElementById('role-group-status');
                if (statusEl) {
                    const includes = (methodology.includeTerms || []).join(', ');
                    const excludes = (methodology.excludeTerms || []).join(', ');
                    statusEl.textContent = includes || excludes
                        ? `Title heuristic includes: ${includes}; excludes: ${excludes}.`
                        : 'Title heuristic trend from generated aggregates.';
                }

                registerHistoricalChart('roleGroup', new Chart(document.getElementById('chart-role-group').getContext('2d'), {
                    type: 'line',
                    data: {
                        labels: roleLabels,
                        datasets: [
                            {
                                label: 'Role Group Headcount',
                                data: roleCount,
                                borderColor: '#34d399',
                                backgroundColor: 'rgba(52, 211, 153, 0.14)',
                                fill: true,
                                tension: 0.2,
                                yAxisID: 'y'
                            },
                            {
                                label: 'Share of Headcount',
                                data: roleShare,
                                borderColor: '#98d4aa',
                                fill: false,
                                tension: 0.2,
                                yAxisID: 'y1'
                            }
                        ]
                    },
                    options: {
                        ...getChartOptions({
                            yTickCallback: (value) => Number(value).toLocaleString(),
                            animation: false,
                            xTickLimit: 8
                        }),
                        scales: {
                            x: { ticks: { color: '#888' }, grid: { color: '#333' } },
                            y: {
                                ticks: { color: '#888', callback: (value) => Number(value).toLocaleString() },
                                grid: { color: '#333' }
                            },
                            y1: {
                                position: 'right',
                                ticks: { color: '#888', callback: (value) => `${Number(value).toFixed(1)}%` },
                                grid: { drawOnChartArea: false, color: '#333' }
                            }
                        }
                    }
                }));

                const shareStatus = document.getElementById('role-group-share-status');
                if (shareStatus) shareStatus.textContent = 'Headcount vs payroll share with spread line.';

                registerHistoricalChart('roleGroupShare', new Chart(document.getElementById('chart-role-group-share').getContext('2d'), {
                    type: 'line',
                    data: {
                        labels: roleLabels,
                        datasets: [
                            {
                                label: 'Headcount Share',
                                data: roleShare,
                                borderColor: '#60a5fa',
                                backgroundColor: 'rgba(96, 165, 250, 0.12)',
                                fill: false,
                                tension: 0.2,
                                yAxisID: 'y'
                            },
                            {
                                label: 'Payroll Share',
                                data: rolePayrollShare,
                                borderColor: '#f59e0b',
                                backgroundColor: 'rgba(245, 158, 11, 0.12)',
                                fill: false,
                                tension: 0.2,
                                yAxisID: 'y'
                            },
                            {
                                label: 'Spread (Payroll - Headcount)',
                                data: roleSpread,
                                borderColor: '#98d4aa',
                                borderDash: [6, 4],
                                fill: false,
                                tension: 0.2,
                                yAxisID: 'y'
                            }
                        ]
                    },
                    options: {
                        ...getChartOptions({
                            yTickCallback: (value) => (value === null || value === undefined ? 'n/a' : `${Number(value).toFixed(1)}%`),
                            animation: false,
                            xTickLimit: 8
                        })
                    }
                }));
            })
            .catch((err) => {
                const statusEl = document.getElementById('role-group-status');
                if (statusEl) {
                    statusEl.textContent = 'Could not load role group trend from generated aggregates.';
                    statusEl.classList.add('status-error');
                }
                console.error('Role group chart failed', err);
            });

        loadPayDistributionMetrics()
            .then(dist => {
                const points = (dist && dist.points) ? dist.points : [];
                const labels = points.map(p => p.date);
                const statusEl = document.getElementById('pay-percentiles-status');
                if (statusEl) statusEl.textContent = points.length ? 'Percentile curves (nominal dollars).' : 'No pay distribution data.';

                registerHistoricalChart('payPercentiles', new Chart(document.getElementById('chart-pay-percentiles').getContext('2d'), {
                    type: 'line',
                    data: {
                        labels,
                        datasets: [
                            {
                                label: 'Classified P90',
                                data: points.map(p => p.pct90Class),
                                borderColor: '#2aad69',
                                backgroundColor: 'rgba(42, 173, 105, 0.05)',
                                fill: false,
                                tension: 0.25
                            },
                            {
                                label: 'Classified P50',
                                data: points.map(p => p.pct50Class),
                                borderColor: '#6ee7b7',
                                backgroundColor: 'rgba(110, 231, 183, 0.05)',
                                fill: false,
                                tension: 0.25
                            },
                            {
                                label: 'Classified P10',
                                data: points.map(p => p.pct10Class),
                                borderColor: '#22c55e',
                                backgroundColor: 'rgba(34, 197, 94, 0.05)',
                                fill: false,
                                tension: 0.25
                            },
                            {
                                label: 'Unclassified P90',
                                data: points.map(p => p.pct90Unclass),
                                borderColor: '#fee11a',
                                borderDash: [8, 4],
                                fill: false,
                                tension: 0.25
                            },
                            {
                                label: 'Unclassified P50',
                                data: points.map(p => p.pct50Unclass),
                                borderColor: '#fbbf24',
                                borderDash: [8, 4],
                                fill: false,
                                tension: 0.25
                            },
                            {
                                label: 'Unclassified P10',
                                data: points.map(p => p.pct10Unclass),
                                borderColor: '#fde68a',
                                borderDash: [8, 4],
                                fill: false,
                                tension: 0.25
                            }
                        ]
                    },
                    options: getChartOptions({
                        yTickCallback: (value) => formatMoney(value),
                        animation: false,
                        xTickLimit: 8,
                        legend: true
                    })
                }));
            })
            .catch(err => {
                console.error('Failed to load pay distribution metrics', err);
                const statusEl = document.getElementById('pay-percentiles-status');
                if (statusEl) {
                    statusEl.textContent = 'Unable to load pay distribution percentiles.';
                    statusEl.classList.add('status-error');
                }
            });

        loadTenureMixMetrics()
            .then(res => {
                const points = (res && res.points) ? res.points : [];
                const labels = points.map(p => p.date);
                const statusEl = document.getElementById('tenure-mix-status');
                if (statusEl) statusEl.textContent = points.length ? 'Percent of each classification by tenure band.' : 'No tenure data.';

                const bandColors = {
                    lt3: '#4ade80',
                    threeTo7: '#60a5fa',
                    sevenTo15: '#98d4aa',
                    fifteenPlus: '#fee11a'
                };

                const makeDataset = (bandKey, label, stack, color) => ({
                    label: `${label} (${stack === 'class' ? 'Classified' : 'Unclassified'})`,
                    data: points.map(p => {
                        const bucket = stack === 'class' ? p.classified : p.unclassified;
                        const share = bucket && bucket.shares ? bucket.shares[bandKey] : null;
                        return share;
                    }),
                    backgroundColor: color,
                    borderColor: color,
                    stack,
                    borderWidth: 1
                });

                registerHistoricalChart('tenureMix', new Chart(document.getElementById('chart-tenure-mix').getContext('2d'), {
                    type: 'bar',
                    data: {
                        labels,
                        datasets: [
                            makeDataset('lt3', '<3y', 'class', bandColors.lt3),
                            makeDataset('threeTo7', '3-7y', 'class', bandColors.threeTo7),
                            makeDataset('sevenTo15', '7-15y', 'class', bandColors.sevenTo15),
                            makeDataset('fifteenPlus', '15y+', 'class', bandColors.fifteenPlus),
                            makeDataset('lt3', '<3y', 'unclass', hexToRgba(bandColors.lt3, 0.55)),
                            makeDataset('threeTo7', '3-7y', 'unclass', hexToRgba(bandColors.threeTo7, 0.55)),
                            makeDataset('sevenTo15', '7-15y', 'unclass', hexToRgba(bandColors.sevenTo15, 0.55)),
                            makeDataset('fifteenPlus', '15y+', 'unclass', hexToRgba(bandColors.fifteenPlus, 0.55))
                        ]
                    },
                    options: {
                        ...getChartOptions({
                            yTickCallback: (value) => (value === null || value === undefined ? 'n/a' : `${Number(value).toFixed(0)}%`),
                            animation: false,
                            xTickLimit: 8,
                            legend: true
                        }),
                        scales: {
                            x: { stacked: true, ticks: { color: '#888' }, grid: { color: '#333' } },
                            y: { stacked: true, ticks: { color: '#888', callback: (value) => `${Number(value).toFixed(0)}%` }, grid: { color: '#333' }, suggestedMax: 100 }
                        }
                    }
                }));
            })
            .catch(err => {
                console.error('Failed to load tenure mix metrics', err);
                const statusEl = document.getElementById('tenure-mix-status');
                if (statusEl) {
                    statusEl.textContent = 'Unable to load tenure mix data.';
                    statusEl.classList.add('status-error');
                }
            });
        };

        advancedToggle.addEventListener('click', () => {
        const expanded = advancedToggle.getAttribute('aria-expanded') === 'true';
        const nextExpanded = !expanded;
        advancedToggle.setAttribute('aria-expanded', String(nextExpanded));
        advancedToggle.textContent = nextExpanded ? 'Hide labor charts' : 'More labor charts';
        advancedPanel.classList.toggle('hidden', !nextExpanded);
        advancedPanel.setAttribute('aria-hidden', String(!nextExpanded));
        captureAnalyticsEvent('historical_labor_advanced_toggled', {
            source: 'historical_advanced_toggle',
            expanded: nextExpanded
        });
        if (nextExpanded) renderAdvancedHistoricalCharts();
        });
    } catch (err) {
        console.error('Historical charts failed to render', err);
    }
}

// ==========================================
// BUCKETING
// ==========================================
function buildKeyBucketsAndCola() {
    const buckets = {
        all: state.masterKeys,
        classified: [],
        unclassified: [],
        active_all: [],
        active_classified: [],
        active_unclassified: [],
        fulltime_all: [],
        fulltime_classified: [],
        fulltime_unclassified: [],
        fulltime_active_all: [],
        fulltime_active_classified: [],
        fulltime_active_unclassified: []
    };

    for (let i = 0; i < state.masterKeys.length; i++) {
        const name = state.masterKeys[i];
        const person = state.masterData[name];
        const isClassified = !person._isUnclass;
        const isActive = isPersonActive(person);
        person._isActive = isActive;
        const isFullTime = !!person._isFullTime;

        if (isClassified) buckets.classified.push(name);
        else buckets.unclassified.push(name);

        if (isActive) {
            buckets.active_all.push(name);
            if (isClassified) buckets.active_classified.push(name);
            else buckets.active_unclassified.push(name);
        }

        if (isFullTime) {
            buckets.fulltime_all.push(name);
            if (isClassified) buckets.fulltime_classified.push(name);
            else buckets.fulltime_unclassified.push(name);

            if (isActive) {
                buckets.fulltime_active_all.push(name);
                if (isClassified) buckets.fulltime_active_classified.push(name);
                else buckets.fulltime_active_unclassified.push(name);
            }
        }
    }

    state.keyBuckets = buckets;
}

function getBaseKeys() {
    const { type, showInactive, fullTimeOnly } = state.filters;
    const buckets = state.keyBuckets;

    if (fullTimeOnly) {
        if (showInactive) {
            if (type === 'classified') return buckets.fulltime_classified;
            if (type === 'unclassified') return buckets.fulltime_unclassified;
            return buckets.fulltime_all;
        }
        if (type === 'classified') return buckets.fulltime_active_classified;
        if (type === 'unclassified') return buckets.fulltime_active_unclassified;
        return buckets.fulltime_active_all;
    }

    if (showInactive) {
        if (type === 'classified') return buckets.classified;
        if (type === 'unclassified') return buckets.unclassified;
        return buckets.all;
    }

    if (type === 'classified') return buckets.active_classified;
    if (type === 'unclassified') return buckets.active_unclassified;
    return buckets.active_all;
}

function hasInactiveSearchMatch(term) {
    const query = (term || '').trim().toLowerCase();
    if (!query) return false;
    return state.keyBuckets.all.some(name => {
        const person = state.masterData[name];
        return !!(person && person._isActive === false && person._searchStr && person._searchStr.includes(query));
    });
}

window.showFormerEmployeesInSearch = function() {
    state.filters.showInactive = true;
    if (els.inactiveToggle) els.inactiveToggle.checked = true;
    setSearchSource('show_former_suggestion');
    runSearch();
};

// ==========================================
// PERSON CHARTS
// ==========================================
function destroyPersonCharts() {
    const charts = state.personCharts || {};
    for (const key in charts) {
        const chart = charts[key];
        if (!chart) continue;
        try { chart.destroy(); } catch (e) { /* no-op */ }
        if (chart._gapPulseTimer) {
            clearInterval(chart._gapPulseTimer);
        }
    }
    state.personCharts = {};
}

function ensurePersonChart(cardEl) {
    if (!cardEl || typeof Chart === 'undefined') return;
    const canvas = cardEl.querySelector('canvas[data-person-chart="true"]');
    if (!canvas) return;

    const chartId = canvas.id;
    if (state.personCharts[chartId]) return;

    const name = cardEl.getAttribute('data-name');
    const person = state.detailCache[name];
    if (!person || !person.Timeline || person.Timeline.length === 0) return;

    const yearsDiff = getTimelineYears(person.Timeline);
    if (yearsDiff < MIN_TREND_YEARS) return;

    if (!state.peerMedianMap) {
        loadPeerMedians().then(() => ensurePersonChart(cardEl));
        return;
    }

    const inflationSelect = cardEl.querySelector('.trend-mode');
    const gapToggle = cardEl.querySelector('.gap-toggle-input');
    const inflationReady = hasInflationData();
    let mode = inflationSelect ? inflationSelect.value : 'off';
    if (!inflationReady) mode = 'off';
    const showGaps = !!(gapToggle && gapToggle.checked);

    const labels = person.Timeline.map(s => s.Date);
    const tsList = person.Timeline.map(s => s._ts || 0);
    const lastIdx = labels.length - 1;
    const rawSeries = person.Timeline.map(s => s.Jobs.some(j => j['Pay Review Reason']) ? null : s._pay);
    const adjustedSeries = person.Timeline.map((s, i) => rawSeries[i] === null ? null : adjustForInflation(s._pay, s.Date));
    const primarySeries = (mode === 'adjusted') ? adjustedSeries : rawSeries;

    const peerSeries = person.Timeline.map(s => {
        const primaryJob = (s.Jobs && s.Jobs.length > 0) ? s.Jobs[0] : null;
        if (!primaryJob) return null;
        const org = primaryJob['Job Orgn'] || 'Unknown';
        const role = primaryJob['Job Title'] || 'Unknown';
        const key = `${org}||${role}`;
        const median = state.peerMedianMap?.[s.Date]?.[key];
        if (!median) return null;
        return (mode === 'adjusted') ? adjustForInflation(median, s.Date) : median;
    });

    const jobChangePoints = [];
    let roleStartIdx = 0;
    let prevTitle = null;
    person.Timeline.forEach((s, idx) => {
        const primaryJob = (s.Jobs && s.Jobs.length > 0) ? s.Jobs[0] : null;
        const title = primaryJob ? (primaryJob['Job Title'] || '') : '';
        if (idx === 0) {
            jobChangePoints.push(null);
            prevTitle = title;
            return;
        }
        if (title && prevTitle && title !== prevTitle) {
            jobChangePoints.push(primarySeries[idx]);
            roleStartIdx = idx;
        } else {
            jobChangePoints.push(null);
        }
        prevTitle = title || prevTitle;
    });
    const hasJobChanges = jobChangePoints.some(val => val !== null);

    const roleStartDate = labels[roleStartIdx] || labels[0];
    const roleTenureYears = (tsList[lastIdx] - tsList[roleStartIdx]) / MS_PER_YEAR;

    let peerPercentile = null;
    const summary = state.masterData[name];
    if (summary && summary._peerPercentile !== null && summary._peerPercentile !== undefined) {
        peerPercentile = summary._peerPercentile;
    }

    const yoyMarkers = [];
    for (let i = 1; i < tsList.length; i++) {
        const targetTs = tsList[i] - MS_PER_YEAR;
        let j = i - 1;
        while (j >= 0 && tsList[j] > targetTs) j--;
        if (j >= 0 && primarySeries[j] > 0 && primarySeries[i] !== null) {
            const pct = ((primarySeries[i] - primarySeries[j]) / primarySeries[j]) * 100;
            yoyMarkers.push({ index: i, pct });
        }
    }

    const colaBands = (!person._isUnclass) ? COLA_EVENTS.map(event => {
        let beforeIdx = null;
        let afterIdx = null;
        for (let i = 0; i < labels.length; i++) {
            const d = labels[i];
            if (d <= event.effective) beforeIdx = i;
            if (afterIdx === null && d >= event.effective) afterIdx = i;
        }
        if (beforeIdx === null || afterIdx === null) return null;
        return { label: event.label, beforeIdx, afterIdx };
    }).filter(Boolean) : [];

    if (state.snapshotDates && _cachedSnapshotDatesRef !== state.snapshotDates) {
        _globalSnapshotIdxMap = new Map();
        for (let i = 0; i < state.snapshotDates.length; i++) {
            _globalSnapshotIdxMap.set(state.snapshotDates[i], i);
        }
        _cachedSnapshotDatesRef = state.snapshotDates;
    }

    const gapSegments = [];
    if (showGaps && _globalSnapshotIdxMap) {
        for (let i = 0; i < labels.length - 1; i++) {
            const idxA = _globalSnapshotIdxMap.get(labels[i]);
            const idxB = _globalSnapshotIdxMap.get(labels[i + 1]);
            if (idxA === undefined || idxB === undefined) continue;
            if (idxB - idxA > 1) {
                gapSegments.push({ leftIdx: i, rightIdx: i + 1, missingCount: idxB - idxA - 1 });
            }
        }
    }

    const overlayPlugin = {
        id: `overlay-${chartId}`,
        afterDatasetsDraw(chart) {
            const ctx = chart.ctx;
            const xScale = chart.scales.x;
            const yScale = chart.scales.y;

            gapSegments.forEach(seg => {
                const xLeft = xScale.getPixelForValue(labels[seg.leftIdx]);
                const xRight = xScale.getPixelForValue(labels[seg.rightIdx]);
                const xMid = (xLeft + xRight) / 2;
                ctx.save();
                const left = Math.min(xLeft, xRight);
                const width = Math.max(1, Math.abs(xRight - xLeft));
                ctx.fillStyle = 'rgba(250, 204, 21, 0.12)';
                ctx.fillRect(left, yScale.top, width, yScale.bottom - yScale.top);
                ctx.strokeStyle = 'rgba(250, 204, 21, 0.85)';
                ctx.setLineDash([6, 6]);
                ctx.lineWidth = 1.5;

                const drawLine = (x) => {
                    ctx.beginPath();
                    ctx.moveTo(x, yScale.top);
                    ctx.lineTo(x, yScale.bottom);
                    ctx.stroke();
                };

                drawLine(xMid);
                if (seg.missingCount >= 3) {
                    drawLine(xMid - 5);
                    drawLine(xMid + 5);
                }

                ctx.restore();
            });

            colaBands.forEach(band => {
                const xStart = xScale.getPixelForValue(labels[band.beforeIdx]);
                const xEnd = xScale.getPixelForValue(labels[band.afterIdx]);
                const left = Math.min(xStart, xEnd);
                const width = Math.max(1, Math.abs(xEnd - xStart));
                ctx.save();
                ctx.fillStyle = 'rgba(42, 173, 105, 0.08)';
                ctx.fillRect(left, yScale.top, width, yScale.bottom - yScale.top);
                ctx.restore();
            });
        }
    };

    const ctx = canvas.getContext('2d');
    const chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Total Compensation',
                    data: primarySeries,
                    borderColor: '#22c55e',
                    backgroundColor: 'rgba(34, 197, 94, 0.1)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 2,
                    order: 2
                },
                {
                    label: 'Peer Median (Org + Role)',
                    data: peerSeries,
                    borderColor: '#60a5fa',
                    borderDash: [4, 4],
                    fill: false,
                    pointRadius: 0,
                    borderWidth: 2,
                    order: 0
                }
            ].concat((mode === 'compare' && inflationReady) ? [{
                label: 'Inflation-Adjusted (CPI-U)',
                data: adjustedSeries,
                borderColor: '#2aad69',
                borderDash: [2, 4],
                fill: false,
                pointRadius: 0,
                borderWidth: 2,
                order: 1
            }] : []).concat(hasJobChanges ? [{
                label: 'Job Title Change',
                data: jobChangePoints,
                showLine: false,
                pointRadius: 4,
                pointStyle: 'triangle',
                borderColor: '#fee11a',
                backgroundColor: '#fee11a',
                order: 3
            }] : [])
        },
        options: getChartOptions({
            yTickCallback: (value) => formatMoney(value),
            animation: false,
            xTickLimit: 6
        }),
        plugins: [overlayPlugin]
    });
    state.personCharts[chartId] = chart;

    const legendEl = cardEl.querySelector('.trend-legend');
    if (legendEl) legendEl.classList.toggle('hidden', !showGaps);

    // Static rendering; no pulsing redraw

    const insightsEl = cardEl.querySelector(`.trend-insights-section[data-chart-insights="${chartId}"] .trend-insights`);
    if (insightsEl) {
        const insights = buildTrendInsights({
            labels,
            rawSeries,
            adjustedSeries,
            peerSeries,
            tsList,
            inflationReady,
            mode,
            hasJobChanges,
            jobChangePoints,
            roleStartDate,
            roleTenureYears,
            peerPercentile
        });
        insightsEl.innerHTML = insights;
    }
}

function buildTrendInsights({
    labels,
    rawSeries,
    adjustedSeries,
    peerSeries,
    tsList,
    inflationReady,
    mode,
    hasJobChanges,
    jobChangePoints,
    roleStartDate,
    roleTenureYears,
    peerPercentile
}) {
    const items = [];
    const lastIdx = labels.length - 1;

    if (labels.length >= 2) {
        let peakIdx = 0;
        for (let i = 1; i < rawSeries.length; i++) {
            if (rawSeries[i] > rawSeries[peakIdx]) peakIdx = i;
        }
        const peakVal = rawSeries[peakIdx];
        const currentVal = rawSeries[lastIdx];
        if (peakVal > 0 && currentVal > 0) {
            if (peakIdx === lastIdx) {
                items.push(`Current pay is at peak (${formatDate(labels[peakIdx])}).`);
            } else {
                const diff = currentVal - peakVal;
                const pct = Math.abs(diff / peakVal) * 100;
                items.push(`Current pay is ${formatMoney(Math.abs(diff))} (${pct.toFixed(1)}%) below peak (${formatDate(labels[peakIdx])}).`);
            }
        }
    }
    if (labels.length >= 2 && rawSeries[0] > 0 && rawSeries[lastIdx] > 0) {
        const nominalPct = ((rawSeries[lastIdx] - rawSeries[0]) / rawSeries[0]) * 100;
        items.push(`Nominal change since ${labels[0]}: ${formatPct(nominalPct)}`);
    }

    if (inflationReady && adjustedSeries[0] > 0 && adjustedSeries[lastIdx] > 0) {
        const realPct = ((adjustedSeries[lastIdx] - adjustedSeries[0]) / adjustedSeries[0]) * 100;
        const inflationNote = realPct >= 0 ? 'outpaced inflation' : 'behind inflation';
        items.push(`Inflation-adjusted change since ${labels[0]}: ${formatPct(realPct)} (${inflationNote})`);
    }

    if (tsList.length > 1) {
        const targetTs = tsList[lastIdx] - MS_PER_YEAR;
        let j = lastIdx - 1;
        while (j >= 0 && tsList[j] > targetTs) j--;
        if (j >= 0 && rawSeries[j] > 0 && rawSeries[lastIdx] !== null) {
            const yoyPct = ((rawSeries[lastIdx] - rawSeries[j]) / rawSeries[j]) * 100;
            items.push(`YoY change: ${formatPct(yoyPct)} (vs ${labels[j]})`);
        }
    }

    const peerVal = peerSeries[lastIdx];
    if (peerVal && rawSeries[lastIdx]) {
        const diff = rawSeries[lastIdx] - peerVal;
        const diffPct = (diff / peerVal) * 100;
        const label = diff >= 0 ? 'above' : 'below';
        items.push(`Current vs peer median: ${formatMoney(diff)} (${formatPct(diffPct)} ${label})`);
    }

    if (peerPercentile !== null) {
        items.push(`Peer percentile (org + role): ${peerPercentile.toFixed(0)}th`);
    }

    if (roleStartDate && roleTenureYears >= 0) {
        items.push(`Current role tenure: ${roleTenureYears.toFixed(1)} years (since ${formatDate(roleStartDate)})`);
    }

    if (labels.length >= 2) {
        let maxChangeIdx = -1;
        let maxChangeVal = 0;
        for (let i = 1; i < rawSeries.length; i++) {
            if (rawSeries[i] === null || rawSeries[i - 1] === null) continue;
            const diff = rawSeries[i] - rawSeries[i - 1];
            const abs = Math.abs(diff);
            if (abs > maxChangeVal) {
                maxChangeVal = abs;
                maxChangeIdx = i;
            }
        }
        if (maxChangeIdx > 0 && rawSeries[maxChangeIdx - 1] > 0) {
            const diff = rawSeries[maxChangeIdx] - rawSeries[maxChangeIdx - 1];
            const pct = (diff / rawSeries[maxChangeIdx - 1]) * 100;
            items.push(`Largest single change: ${formatMoney(diff)} (${formatPct(pct)}) on ${formatDate(labels[maxChangeIdx])}`);
        }
    }

    if (hasJobChanges) {
        const changes = jobChangePoints.filter(v => v !== null).length;
        items.push(`Job title changes detected: ${changes}`);
    }

    if (items.length === 0) {
        return '<div class="insight-item">No insights available for this timeline.</div>';
    }

    return items.map(text => `<div class="insight-item">${escapeHtml(text)}</div>`).join('');
}

// ==========================================
// SEARCH & FILTER LOGIC
// ==========================================
window.applySearch = function(term, source = 'search_apply') {
    els.searchInput.value = term;
    state.filters.text = term;
    els.clearBtn.classList.toggle('hidden', !term);
    hideAutocomplete();
    setSearchSource(source);
    runSearch();
};

function buildWorkerPayload(baseKeys, transitionSet) {
    return {
        query: state.filters.text || '',
        roleFilter: (state.filters.role || '').trim().toLowerCase(),
        minSalary: state.filters.minSalary,
        maxSalary: state.filters.maxSalary,
        dataFlagsOnly: !!state.filters.dataFlagsOnly,
        exclusionsMode: state.filters.exclusionsMode || 'off',
        sort: state.filters.sort || 'name-asc',
        transitionNames: transitionSet ? Array.from(transitionSet) : null,
        transitionKey: state.filters.transition ? `${state.filters.transition.year}|${state.filters.transition.direction}` : '',
        baseKey: buildWorkerBaseKey(baseKeys),
        baseNames: baseKeys,
        nowTs: Date.now()
    };
}

function applySearchResults(results, searchMeta = {}) {
    state.filteredKeys = results;
    state.visibleCount = state.batchSize;
    state.focusIndex = -1;
    renderInitial();
    updateStats();
    updateDashboard(calculateStats(state.filteredKeys));
    updateSearchSuggestions();
    trackSearchEvent(results.length, searchMeta);
}

function runSearchLegacy(baseKeys = null, transitionSet = null, searchStartedAt = Date.now()) {
    // If user asked for recent exclusions but transition map not ready, compute then rerun.
    if (state.filters.exclusionsMode === 'recent' && !state.exclusionTransitionsReady) {
        computeExclusionTransitions().then(() => runSearch());
        return;
    }

    const term = state.filters.text.toLowerCase();
    const roleFilter = normalizeText(state.filters.role);
    const { minSalary, maxSalary, sort, dataFlagsOnly, exclusionsMode, transition } = state.filters;
    const localTransitionSet = transitionSet || (transition && state.transitionMemberIndex ? state.transitionMemberIndex[`${transition.year}|${transition.direction}`] : null);

    // 1. FILTERING
    const keys = baseKeys || getBaseKeys();
    let results = keys.filter(name => {
        const person = state.masterData[name];

        // Search Text
        if (term && person._searchStr && !person._searchStr.includes(term)) return false;

        // Role Filter
        if (roleFilter) {
            if (!person._roleStr || !person._roleStr.includes(roleFilter)) return false;
        }

        // Salary Range (Optimized)
        if (minSalary !== null || maxSalary !== null) {
            if (person._payMissing) return false;
            const salary = person._totalPay;
            if (minSalary !== null && salary < minSalary) return false;
            if (maxSalary !== null && salary > maxSalary) return false;
        }

        // Data Flags filter
        if (dataFlagsOnly) {
            const hasFlags = !!(person._payMissing || person._colaMissing);
            if (!hasFlags) return false;
        }

        // Exclusions filter (classified -> unclassified at any point)
        if (exclusionsMode !== 'off') {
            if (!person._wasExcluded) return false;
            if (exclusionsMode === 'recent') {
                const nowTs = Date.now();
                const utcDayKey = Math.floor(nowTs / DAY_MS);
                const cutoff = (utcDayKey - 365) * DAY_MS;
                let ts = null;
                if (person._exclusionDate) {
                    ts = new Date(person._exclusionDate).getTime();
                } else if (state.exclusionTransitionMap[name]) {
                    ts = state.exclusionTransitionMap[name];
                }
                if (!ts || ts < cutoff) return false;
            }
        }

        // Transition filter from "Classification Transitions" chart.
        if (transition) {
            if (!localTransitionSet || !localTransitionSet.has(name)) return false;
        }
        return true;
    });

    // 2. SORTING
    results.sort((keyA, keyB) => {
        const pA = state.masterData[keyA];
        const pB = state.masterData[keyB];

        switch (sort) {
            case 'salary-desc':
                return pB._totalPay - pA._totalPay;
            case 'salary-asc':
                return pA._totalPay - pB._totalPay;
            case 'tenure-desc':
                return pA._hiredDateTs - pB._hiredDateTs; // Older date = Higher Tenure
            case 'tenure-asc':
                return pB._hiredDateTs - pA._hiredDateTs; // Newer date = Lower Tenure
            case 'name-desc':
                return keyB.localeCompare(keyA);
            case 'name-asc':
            default:
                return keyA.localeCompare(keyB);
        }
    });

    applySearchResults(results, {
        usedWorker: false,
        latencyMs: Date.now() - searchStartedAt
    });
}

function runSearch(allowRecovery = true) {
    // If user asked for recent exclusions but transition map not ready, compute then rerun.
    if (state.filters.exclusionsMode === 'recent' && !state.exclusionTransitionsReady) {
        computeExclusionTransitions().then(() => runSearch());
        return;
    }

    const transition = state.filters.transition;
    const transitionKey = transition ? `${transition.year}|${transition.direction}` : null;
    const transitionSet = transitionKey && state.transitionMemberIndex ? state.transitionMemberIndex[transitionKey] : null;
    const baseKeys = getBaseKeys();
    const searchStartedAt = Date.now();
    const token = ++state.searchRunToken;

    updateSearchUrl();

    if (!state.searchWorker || !state.searchWorkerReady || state.searchWorkerErrored) {
        if (allowRecovery) {
            recoverSearchWorker('worker_unavailable').then((recovered) => {
                if (token !== state.searchRunToken) return;
                if (recovered) {
                    runSearch(false);
                    return;
                }
                hideAutocomplete();
                runSearchLegacy(baseKeys, transitionSet, searchStartedAt);
                updateRegexPill(false, '');
            });
            return;
        }
        hideAutocomplete();
        runSearchLegacy(baseKeys, transitionSet, searchStartedAt);
        updateRegexPill(false, '');
        return;
    }

    sendSearchToWorker(buildWorkerPayload(baseKeys, transitionSet))
        .then(payload => {
            if (token !== state.searchRunToken) return;
            if ((payload.warning || '') === 'Search worker not ready.' && allowRecovery) {
                state.searchWorkerReady = false;
                recoverSearchWorker('worker_not_ready_result').then((recovered) => {
                    if (token !== state.searchRunToken) return;
                    if (recovered) {
                        runSearch(false);
                        return;
                    }
                    hideAutocomplete();
                    runSearchLegacy(baseKeys, transitionSet, searchStartedAt);
                    updateRegexPill(false, '');
                });
                return;
            }
            const names = (payload.names || []).filter(name => !!state.masterData[name]);
            state.lastSearchSuggestions = payload.suggestions || [];
            state.lastHighlightTerms = payload.highlightTerms || [];
            state.searchWarning = payload.warning || '';
            state.regexMode = !!payload.regexMode;
            updateRegexPill(!!payload.regexMode, payload.warning || '');
            renderAutocomplete(state.lastSearchSuggestions);
            applySearchResults(names, {
                usedWorker: true,
                latencyMs: Date.now() - searchStartedAt
            });
        })
        .catch((err) => {
            if (token !== state.searchRunToken) return;
            state.searchWorkerErrored = true;
            if (allowRecovery) {
                recoverSearchWorker(err && err.code === 'WORKER_TIMEOUT' ? 'worker_timeout' : 'worker_error').then((recovered) => {
                    if (token !== state.searchRunToken) return;
                    if (recovered) {
                        runSearch(false);
                        return;
                    }
                    hideAutocomplete();
                    runSearchLegacy(baseKeys, transitionSet, searchStartedAt);
                    updateRegexPill(false, '');
                });
                return;
            }
            hideAutocomplete();
            runSearchLegacy(baseKeys, transitionSet, searchStartedAt);
            updateRegexPill(false, '');
        });
}

function checkSearchWorkerHealth(trigger = 'unknown') {
    if (!state.masterKeys.length || !state.keyBuckets || !state.keyBuckets.all) return;
    const now = Date.now();
    if ((now - state.lastWorkerHealthCheckTs) < WORKER_HEALTH_CHECK_MIN_INTERVAL_MS) {
        return;
    }
    state.lastWorkerHealthCheckTs = now;

    if (!state.searchWorker || state.searchWorkerErrored || state.searchWorkerInitInFlight) {
        recoverSearchWorker(`resume_${trigger}`).then((recovered) => {
            if (recovered) runSearch(false);
        });
        return;
    }

    pingSearchWorker().then((ready) => {
        if (ready) return;
        state.searchWorkerReady = false;
        recoverSearchWorker(`ping_failed_${trigger}`).then((recovered) => {
            if (recovered) runSearch(false);
        });
    }).catch(() => {
        state.searchWorkerReady = false;
        recoverSearchWorker(`ping_error_${trigger}`).then((recovered) => {
            if (recovered) runSearch(false);
        });
    });
}

function updateSearchSuggestions() {
    const container = document.getElementById('search-suggestions');
    if (!container) return;
    const term = state.filters.text.trim();
    if (!term || state.filteredKeys.length > 0) {
        container.classList.add('hidden');
        return;
    }
    const suggestFormer = !state.filters.showInactive && hasInactiveSearchMatch(term);
    const suggestions = state.lastSearchSuggestions && state.lastSearchSuggestions.length
        ? state.lastSearchSuggestions
        : getSearchSuggestions(term);
    if (!suggestions.length && !suggestFormer) {
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');
    container.innerHTML = `
        <div class="suggestions-title">No exact matches. Try:</div>
        <div class="suggestion-chips">
            ${suggestFormer ? `
                <button class="suggestion-chip" data-tooltip="Include former/inactive employees in results" onclick="showFormerEmployeesInSearch()">
                    Show former employees
                </button>
            ` : ''}
            ${suggestions.map(item => `
                <button class="suggestion-chip" data-tooltip="Suggested ${escapeHtmlAttr(item.type)}" onclick="applySearch('${escapeHtmlAttr(escapeForSingleQuote(item.value))}', 'search_suggestion')">
                    ${escapeHtml(item.value)}
                </button>
            `).join('')}
        </div>
    `;
}

function updateRegexPill(isRegex, warningText) {
    if (!els.regexPill) return;
    if (!isRegex) {
        els.regexPill.classList.add('hidden');
        els.regexPill.removeAttribute('data-tooltip');
        return;
    }
    els.regexPill.classList.remove('hidden');
    if (warningText) {
        els.regexPill.setAttribute('data-tooltip', warningText);
    } else {
        els.regexPill.setAttribute('data-tooltip', 'Regex mode enabled. Use /pattern/flags syntax.');
    }
}

function hideAutocomplete() {
    state.autocompleteItems = [];
    state.autocompleteFocus = -1;
    if (!els.autocomplete) return;
    els.autocomplete.classList.add('hidden');
    els.autocomplete.innerHTML = '';
}

function renderAutocomplete(items) {
    if (!els.autocomplete) return;
    const term = (state.filters.text || '').trim();
    if (!term || !items || items.length === 0) {
        hideAutocomplete();
        return;
    }
    state.autocompleteItems = items.slice(0, 8);
    state.autocompleteFocus = -1;
    els.autocomplete.classList.remove('hidden');
    els.autocomplete.innerHTML = state.autocompleteItems.map((item, idx) => `
        <button class="autocomplete-item" data-idx="${idx}" data-value="${escapeHtmlAttr(item.value || '')}" role="option" aria-selected="false">
            <span>${escapeHtml(item.value || '')}</span>
            <span class="autocomplete-type">${escapeHtml(item.type || 'suggestion')}</span>
        </button>
    `).join('');
}

function applyAutocompleteIndex(idx) {
    if (idx < 0 || idx >= state.autocompleteItems.length) return;
    const item = state.autocompleteItems[idx];
    if (!item) return;
    captureAnalyticsEvent('search_autocomplete_selected', {
        source: 'autocomplete',
        selected_value: (item.value || '').slice(0, SEARCH_ANALYTICS_MAX_QUERY_LEN),
        selected_rank: idx + 1,
        suggestion_type: item.type || 'suggestion',
        typed_query: (state.filters.text || '').trim().slice(0, SEARCH_ANALYTICS_MAX_QUERY_LEN)
    });
    window.applySearch(item.value || '', 'autocomplete');
    hideAutocomplete();
}

function stepAutocomplete(delta) {
    if (!state.autocompleteItems.length) return;
    const len = state.autocompleteItems.length;
    state.autocompleteFocus = (state.autocompleteFocus + delta + len) % len;
    if (!els.autocomplete) return;
    els.autocomplete.querySelectorAll('.autocomplete-item').forEach((node, idx) => {
        const isActive = idx === state.autocompleteFocus;
        node.classList.toggle('active', isActive);
        node.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
}

function updateSearchUrl() {
    const query = (state.filters.text || '').trim();
    const url = new URL(window.location.href);
    if (query) {
        url.searchParams.set('q', query);
    } else {
        url.searchParams.delete('q');
    }
    if (url.searchParams.has('name')) url.searchParams.delete('name');
    window.history.replaceState({ path: url.href }, '', url.href);
}

// ==========================================
// STATISTICS & DASHBOARD
// ==========================================
function medianOfThreeIndex(arr, a, b, c) {
    const av = arr[a];
    const bv = arr[b];
    const cv = arr[c];
    if (av < bv) {
        if (bv < cv) return b;
        return av < cv ? c : a;
    }
    if (av < cv) return a;
    return bv < cv ? c : b;
}

function partitionRange(arr, left, right, pivotIndex) {
    const pivotValue = arr[pivotIndex];
    [arr[pivotIndex], arr[right]] = [arr[right], arr[pivotIndex]];

    let ltEnd = left;
    for (let i = left; i < right; i++) {
        if (arr[i] < pivotValue) {
            [arr[ltEnd], arr[i]] = [arr[i], arr[ltEnd]];
            ltEnd++;
        }
    }

    let eqEnd = ltEnd;
    for (let i = ltEnd; i < right; i++) {
        if (arr[i] === pivotValue) {
            [arr[eqEnd], arr[i]] = [arr[i], arr[eqEnd]];
            eqEnd++;
        }
    }

    [arr[right], arr[eqEnd]] = [arr[eqEnd], arr[right]];
    return [ltEnd, eqEnd];
}

function quickselectInPlace(arr, k) {
    let left = 0;
    let right = arr.length - 1;

    while (left <= right) {
        if (left === right) return arr[k];

        const mid = left + ((right - left) >> 1);
        const pivotIndex = medianOfThreeIndex(arr, left, mid, right);
        const [eqStart, eqEnd] = partitionRange(arr, left, right, pivotIndex);

        if (k < eqStart) {
            right = eqStart - 1;
        } else if (k > eqEnd) {
            left = eqEnd + 1;
        } else {
            return arr[k];
        }
    }

    return arr[k];
}

function medianFromUnsorted(values) {
    const len = values.length;
    if (len === 0) return 0;

    const mid = Math.floor(len / 2);
    const upper = quickselectInPlace(values, mid);
    if (len % 2 !== 0) return upper;

    let lower = values[0];
    for (let i = 1; i < mid; i++) {
        if (values[i] > lower) lower = values[i];
    }
    return (lower + upper) / 2;
}

function calculateStats(keys) {
    let count = 0, classified = 0, unclassified = 0, salaries = [];
    let orgs = new Map(), roles = new Map();
    let tenure = { t0_2: 0, t2_5: 0, t5_10: 0, t10_plus: 0 };
    const now = new Date().getTime();

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const p = state.masterData[key];
        // Calculate stats based on VISIBLE records (matching user filters)
        // Note: If you want stats to ALWAYS be "active only" regardless of view, use isPersonActive(p).
        // Current logic: Stats reflect exactly what is in the filtered list.

        if (!p._hasTimeline) continue;

        count++;
        // Optimization: Use cached pay and status
        const salary = p._totalPay;
        if (salary > 0) salaries.push(salary);
        if (p._isUnclass) unclassified++; else classified++;

        let org = p._cachedOrg;
        if (org === undefined) {
            org = personOrg(p) || 'Unknown';
            p._cachedOrg = org;
        }
        orgs.set(org, (orgs.get(org) || 0) + 1);

        let role = p._cachedRole;
        if (role === undefined) {
            const lastJob = p._lastJob || {};
            role = lastJob['Job Title'] || 'Unknown';
            p._cachedRole = role;
        }
        roles.set(role, (roles.get(role) || 0) + 1);

        // Optimization: Use pre-parsed _hiredDateTs
        const hiredTs = p._hiredDateTs;
        if (hiredTs) {
            const years = (now - hiredTs) / MS_PER_YEAR;
            if (years < 2) tenure.t0_2++;
            else if (years < 5) tenure.t2_5++;
            else if (years < 10) tenure.t5_10++;
            else tenure.t10_plus++;
        }
    }

    const median = medianFromUnsorted(salaries);

    // ⚡ Bolt Optimization: Replace full array conversion and O(N log N) sorting with O(N) top-K linear scan.
    const getTopK = (map, k) => {
        let top = [];
        for (const [key, value] of map) {
            if (top.length < k) {
                top.push([key, value]);
                if (top.length === k) top.sort((a, b) => a[1] - b[1]);
            } else if (value > top[0][1]) {
                top[0] = [key, value];
                for (let j = 0; j < k - 1; j++) {
                    if (top[j][1] > top[j + 1][1]) {
                        const temp = top[j];
                        top[j] = top[j + 1];
                        top[j + 1] = temp;
                    } else {
                        break;
                    }
                }
            }
        }
        if (top.length < k) top.sort((a, b) => a[1] - b[1]);
        return top.reverse();
    };

    const topOrgs = getTopK(orgs, 5);
    const topRoles = getTopK(roles, 4);

    return {
        count,
        medianSalary: median,
        classified,
        unclassified,
        topOrgs,
        topRoles,
        tenure
    };
}

function updateDashboard(stats) {
    els.dashboard.classList.remove('hidden');
    els.statTotal.textContent = stats.count.toLocaleString();
    els.statMedian.textContent = formatMoney(stats.medianSalary);

    const totalTypes = stats.classified + stats.unclassified;
    const classPct = totalTypes ? (stats.classified / totalTypes) * 100 : 0;
    const unclassPct = totalTypes ? (stats.unclassified / totalTypes) * 100 : 0;
    els.barClassified.style.width = `${classPct}%`;
    els.barUnclassified.style.width = `${unclassPct}%`;
    els.countClassified.textContent = stats.classified.toLocaleString();
    els.countUnclassified.textContent = stats.unclassified.toLocaleString();

    const tTotal = stats.tenure.t0_2 + stats.tenure.t2_5 + stats.tenure.t5_10 + stats.tenure.t10_plus || 1;
    els.tenureChart.innerHTML = `
        <div class="tenure-seg t1" style="width:${(stats.tenure.t0_2 / tTotal) * 100}%" data-tooltip="&lt; 2 Years: ${escapeHtmlAttr(stats.tenure.t0_2)}"></div>
        <div class="tenure-seg t2" style="width:${(stats.tenure.t2_5 / tTotal) * 100}%" data-tooltip="2-5 Years: ${escapeHtmlAttr(stats.tenure.t2_5)}"></div>
        <div class="tenure-seg t3" style="width:${(stats.tenure.t5_10 / tTotal) * 100}%" data-tooltip="5-10 Years: ${escapeHtmlAttr(stats.tenure.t5_10)}"></div>
        <div class="tenure-seg t4" style="width:${(stats.tenure.t10_plus / tTotal) * 100}%" data-tooltip="10+ Years: ${escapeHtmlAttr(stats.tenure.t10_plus)}"></div>
    `;

    if (!Object.values(stats.tenure).some(Boolean)) {
        els.tenureChart.textContent = 'Hire dates not supplied';
        els.tenureChart.dataset.unavailable = 'true';
    } else delete els.tenureChart.dataset.unavailable;

    const maxCount = stats.topOrgs[0] ? stats.topOrgs[0][1] : 1;
    els.orgLeaderboard.innerHTML = stats.topOrgs.map(([name, count]) => `
        <div class="lb-row"><div class="lb-label" data-tooltip="${escapeHtmlAttr(name)}">${escapeHtml(name)}</div>
        <div class="lb-bar-container"><div class="lb-bar" style="width: ${(count/maxCount)*100}%"></div><div class="lb-val">${escapeHtml(count)}</div></div></div>
    `).join('');

    updateDonut(stats.topRoles, stats.count);
}

function updateDonut(roles, total) {
    if (!roles.length) return;
    const colors = ['#FEE11A', '#d8bd13', '#008c45', '#007030', '#444444'];
    let currentDeg = 0, otherCount = total;
    let gradientPartsStr = '';

    for (let idx = 0; idx < roles.length; idx++) {
        const roleData = roles[idx];
        const count = roleData[1];
        const deg = (count / total) * 360;
        if (gradientPartsStr) gradientPartsStr += ', ';
        gradientPartsStr += `${colors[idx]} ${currentDeg}deg ${currentDeg + deg}deg`;
        currentDeg += deg;
        otherCount -= count;
    }
    if (otherCount > 0) {
        if (gradientPartsStr) gradientPartsStr += ', ';
        gradientPartsStr += `${colors[4]} ${currentDeg}deg 360deg`;
    }

    els.roleDonut.style.background = `conic-gradient(${gradientPartsStr})`;

    let legendHTML = '';
    for (let idx = 0; idx < roles.length; idx++) {
        const roleData = roles[idx];
        const role = roleData[0];
        const count = roleData[1];
        legendHTML += `<div class="legend-item"><span class="dot" style="background:${colors[idx]}"></span> ${escapeHtml(role)} (${Math.round(count/total*100)}%)</div>`;
    }
    if (otherCount > 0) {
        legendHTML += `<div class="legend-item"><span class="dot" style="background:${colors[4]}"></span> Other (${Math.round(otherCount/total*100)}%)</div>`;
    }
    els.roleLegend.innerHTML = legendHTML;
}

function personOrg(p) {
    if (p.Meta['Home Orgn']) return p.Meta['Home Orgn'];
    if (p._lastJob && p._lastJob['Job Orgn']) return p._lastJob['Job Orgn'];
    if (p.Timeline && p.Timeline.length > 0) {
        const lastSnap = p.Timeline[p.Timeline.length - 1];
        if (lastSnap.Jobs && lastSnap.Jobs.length > 0) return lastSnap.Jobs[0]['Job Orgn'];
    }
    return null;
}

// ==========================================
// CARD GENERATION
// ==========================================
function buildHistoryHTML(person, chartId, name) {
    if (!person || !person.Timeline || person.Timeline.length === 0) {
        return `<div class="history-loading">No detailed history available.</div>`;
    }

    let reportHistoryHTML = '';
    for (let i = 0; i < person.Timeline.length; i++) {
        reportHistoryHTML += `<span class="badge badge-source" style="margin-right:4px; margin-bottom:4px;">${escapeHtml(person.Timeline[i].Date)}</span>`;
    }
    const recordGaps = getRecordGaps(person);
    let recordGapHTML = '';
    for (let i = 0; i < recordGaps.length; i++) {
        recordGapHTML += `<div class="record-gap">No data between ${escapeHtml(formatDate(recordGaps[i].start))} and ${escapeHtml(formatDate(recordGaps[i].end))}</div>`;
    }
    const summary = name ? (state.masterData[name] || {}) : {};
    const dataFlags = [];
    if (summary._payMissing) dataFlags.push('Missing, repeated, or uncertain source pay in one or more appointments.');
    if (summary._captureDate) {
        dataFlags.push(`Latest record captured ${summary._captureDate}; payroll effective date is not supplied by UO.`);
        if (summary._identityMatch !== 'matched_name_and_hire_date') dataFlags.push('Historical identity is unconfirmed; this source record is kept separate.');
    }
    if (summary._colaMissing) {
        const labels = summary._colaMissedLabels && summary._colaMissedLabels.length
            ? ` (${summary._colaMissedLabels.join(', ')})`
            : '';
        dataFlags.push(`Possible COLA not received${labels}.`);
    }
    if (recordGaps.length) dataFlags.push(`Missing ${recordGaps.length} snapshot gap${recordGaps.length === 1 ? '' : 's'} in timeline.`);
    let dataQualityHTML = '';
    if (dataFlags.length) {
        dataQualityHTML = `<div class="data-quality"><strong>Data quality flags:</strong>`;
        for (let i = 0; i < dataFlags.length; i++) {
            dataQualityHTML += `<div>${escapeHtml(dataFlags[i])}</div>`;
        }
        dataQualityHTML += `</div>`;
    }

    let tbodyHTML = '';
    for (let i = person.Timeline.length - 1; i >= 0; i--) {
        const snap = person.Timeline[i];
        const prevSnap = i > 0 ? person.Timeline[i - 1] : null;
        let prevJobsMap = null;
        if (prevSnap && prevSnap.Jobs) {
            prevJobsMap = new Map();
            for (let j = 0; j < prevSnap.Jobs.length; j++) {
                const pj = prevSnap.Jobs[j];
                if (pj['Posn-Suff']) prevJobsMap.set(pj['Posn-Suff'], pj);
            }
        }
        const jobs = snap.Jobs || [];
        for (let j = 0; j < jobs.length; j++) {
            const job = jobs[j];
            let diffHTML = '';
            if (prevJobsMap && !job._missingRate) {
                const prevJob = prevJobsMap.get(job['Posn-Suff']);
                if (prevJob && !prevJob._missingRate) {
                    // Optimization: Use pre-parsed _rate
                    const currRate = job._rate !== undefined ? job._rate : cleanMoney(job['Annual Salary Rate']);
                    const prevRate = prevJob._rate !== undefined ? prevJob._rate : cleanMoney(prevJob['Annual Salary Rate']);
                    const diff = currRate - prevRate;
                    if (diff !== 0 && prevRate > 0) {
                        const pct = (diff / prevRate) * 100;
                        diffHTML = `<span class="diff-val ${diff > 0 ? 'diff-positive' : 'diff-negative'}">${diff > 0 ? '+' : ''}${formatMoney(diff)} (${diff > 0 ? '+' : ''}${pct.toFixed(1)}%)</span>`;
                    }
                }
            }
            const termBadge = job['Salary Term'] ? ` <span class="term-badge">${escapeHtml(job['Salary Term'])}</span>` : '';
            const hourlyRate = cleanMoney(job['Hourly Rate']);
            const hourlyRateText = hourlyRate > 0
                ? `<div class="hourly-rate">Hourly: ${formatHourlyMoney(hourlyRate)}/hr</div>`
                : '';
            const salaryText = job._missingRate
                ? `<span class="missing-pay" data-tooltip="${escapeHtmlAttr(job['Pay Review Reason'] || 'No usable salary rate was provided.')}">Pay unavailable</span>${termBadge}`
                : `${formatMoney(job['Pay Measure'] === 'fiscal_year_pay' ? job['Reported Pay'] : job['Annual Salary Rate'])}${termBadge}`;
            const reportedValue = job['Pay Review Reason']
                ? `<div>Source value: ${escapeHtml(job['Reported Salary Rate'])} (as reported)</div>` : '';
            const sourceLink = (job['Source Url'] || snap.SourceUrl)
                ? `<a class="source-report-link" href="${escapeHtmlAttr(job['Source Url'] || snap.SourceUrl)}" target="_blank" rel="noopener noreferrer">Saved source report</a>`
                : `<div class="badge badge-source">${escapeHtml((snap.Source || '').substring(0, 15))}...</div>`;
            tbodyHTML += `<tr><td class="date-cell"><div>${snap.DateBasis === 'capture' ? 'Captured ' : ''}${escapeHtml(formatDate(snap.Date))}</div>${sourceLink}</td>
                <td><div style="font-weight:600;">${escapeHtml(job['Job Title'] || '')}</div><div style="font-size:0.85rem; color:#64748b;">${escapeHtml(job['Job Orgn'] || (job['Home Orgn'] ? `Home: ${job['Home Orgn']}` : ''))}</div></td>
                <td><span class="badge badge-type">${escapeHtml(job['Job Type'] || '?')}</span></td>
                <td class="money-cell">${salaryText}${reportedValue}${hourlyRateText}${diffHTML}<div class="hourly-rate">${job['Appt Percent'] == null ? 'FTE not supplied' : `${escapeHtml(job['Appt Percent'])}% appointment`}</div><details><summary>Source fields</summary>${Object.entries(job['Source Fields'] || {}).map(([key, value]) => `<div>${escapeHtml(key)}: ${escapeHtml(value)}</div>`).join('')}</details></td></tr>`;
        }
    }

    return `
            <div class="history-meta" style="margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid #444; font-size: 0.9rem; color: #a0a0a0;">
                <strong>Hired:</strong> ${escapeHtml(formatDate(person.Meta["First Hired"]) || "Not supplied")} &nbsp;&bull;&nbsp;
                <strong>Adj Service:</strong> ${escapeHtml(formatDate(person.Meta["Adj Service Date"]) || "Not supplied")}
            </div>
            ${dataQualityHTML}

            <div class="personal-trend-section" data-chart-id="${chartId}"></div>

            <div class="collapsible-section trend-insights-section" data-chart-insights="${chartId}">
                <button class="section-toggle" type="button" aria-expanded="false">Key Insights</button>
                <div class="collapsible-body hidden">
                    <div class="trend-insights">
                        <div class="insight-item">Insights will appear once the chart loads.</div>
                    </div>
                </div>
            </div>

            <div class="collapsible-section record-appearances">
                <button class="section-toggle" type="button" aria-expanded="false">Record appearances</button>
                <div class="collapsible-body hidden">
                    <div style="display: flex; flex-wrap: wrap;">${reportHistoryHTML}</div>
                    ${recordGapHTML}
                </div>
            </div>

            <div class="collapsible-section">
                <button class="section-toggle" type="button" aria-expanded="false">Date & Source / Job Details / Type / Salary</button>
                <div class="collapsible-body hidden">
                    <div class="table-wrap" tabindex="0" aria-label="Job history table">
                    <table>
                        <thead><tr><th>Date & Source</th><th>Job Details</th><th>Type</th><th>Salary</th></tr></thead>
                        <tbody>
                            ${tbodyHTML}
                        </tbody>
                    </table>
                    </div>
                </div>
            </div>
    `;
}

function generateCardHTML(name, idx) {
    const person = state.masterData[name];
    if (!person._hasTimeline) return '';

    const lastJob = person._lastJob || {};
    const highlightedName = highlightText(name, state.lastHighlightTerms);
    const highlightedHomeOrg = highlightText(person.Meta["Home Orgn"] || 'N/A', state.lastHighlightTerms);
    const highlightedRole = highlightText(lastJob['Job Title'] || 'Unknown', state.lastHighlightTerms);

    const cardId = `card-${idx}`;
    const historyId = `history-${idx}`;
    const chartId = `person-trend-${idx}`;
    const attrName = escapeHtmlAttr(name);
    const totalPay = person._totalPay || 0;
    const totalPayLabel = person._payMissing
        ? (totalPay > 0 ? `${formatMoney(totalPay)}*` : 'Pay unavailable')
        : formatMoney(totalPay);
    const totalPayTooltip = person._payMissing
        ? 'One or more source rows has missing, repeated, or uncertain pay. Check the source record details.'
        : (PAY_MEASURE === 'fiscal_year_pay' ? 'Total actual fiscal-year pay as reported; no FTE adjustment' : 'Reported term salary rate × appointment percent, summed across source jobs; not actual earnings');
    const isLatest = isPersonActive(person);

    const badgeHTML = !isLatest ? `<span class="badge" style="background:#ef4444; color:white; margin-left:10px;">NOT IN LATEST REPORT</span>` : '';
    const colaTooltip = (person._colaMissedLabels && person._colaMissedLabels.length > 0)
        ? `Possible COLA not received (${person._colaMissedLabels.join(', ')})`
        : 'Possible COLA not received for listed events.';
    const colaWarningHTML = (!person._isUnclass && person._colaMissing)
        ? `<span class="cola-warning" data-tooltip="${escapeHtmlAttr(colaTooltip)}">!</span>`
        : '';
    const exclusionTooltip = 'Printed name changes from classified to unclassified; identity and union status are not verified.';
    const exclusionWarningHTML = person._wasExcluded
        ? `<span class="exclusion-warning" data-tooltip="${exclusionTooltip}">E</span>`
        : '';
    const dataFlags = [];
    if (person._payMissing) dataFlags.push('Missing, repeated, or uncertain source pay in one or more appointments.');
    if (person._captureDate && person._identityMatch !== 'matched_name_and_hire_date') dataFlags.push('Historical identity unconfirmed; kept as a separate source record.');
    if (person._colaMissing) {
        const labels = person._colaMissedLabels && person._colaMissedLabels.length
            ? ` (${person._colaMissedLabels.join(', ')})`
            : '';
        dataFlags.push(`Possible COLA not received${labels}.`);
    }
    if (person._wasExcluded) dataFlags.push('Printed name changes from classified to unclassified; identity and union status are not verified.');
    const dataFlagHTML = dataFlags.length
        ? `<div class="data-flag" data-tooltip="${escapeHtmlAttr(dataFlags.join(' '))}">Data flags</div>`
        : '';

    return `
    <div class="card" id="${cardId}" data-name="${attrName}" data-index="${idx}" data-chart-id="${chartId}" style="${!isLatest ? 'opacity: 0.8;' : ''}">
        <div class="card-header" onclick="toggleCard('${cardId}')" onkeydown="handleCardKey(event, '${cardId}')" tabindex="0" role="button" aria-expanded="false" aria-controls="${historyId}">
            <div class="person-info">
                <div class="name-header">
                    <h2>${highlightedName} ${badgeHTML} ${colaWarningHTML} ${exclusionWarningHTML}</h2>
                    <button class="link-btn-card" data-linkname="${attrName}" onclick="copyLink(event, this.dataset.linkname)" aria-label="Copy link">🔗</button>
                    <button class="link-btn-card report-btn" data-report-name="${escapeHtmlAttr(name)}" data-tooltip="Report a data issue" aria-label="Report a data issue">!</button>
                </div>
                <p>Home Org: ${highlightedHomeOrg}</p>
            </div>
            <div class="latest-stat">
                <div class="latest-salary" data-tooltip="${totalPayTooltip}">${totalPayLabel}</div>
                <div class="latest-role">${highlightedRole}</div>
                ${dataFlagHTML}
            </div>
        </div>

        <div id="${historyId}" class="history" role="region" aria-label="Job History" data-loaded="false">
            <div class="history-loading">Expand to load details...</div>
        </div>
    </div>`;
}

function loadAndRenderPersonDetails(cardEl) {
    if (!cardEl) return Promise.resolve(null);
    const historyEl = cardEl.querySelector('.history');
    if (!historyEl) return Promise.resolve(null);
    if (historyEl.dataset.loaded === 'true') {
        const name = cardEl.getAttribute('data-name');
        return Promise.resolve(state.detailCache[name] || null);
    }
    historyEl.innerHTML = `<div class="history-loading">Loading details...</div>`;

    const name = cardEl.getAttribute('data-name');
    return loadPersonDetail(name)
        .then(person => {
            if (!person) {
                historyEl.innerHTML = `<div class="history-loading">No details available.</div>`;
                historyEl.dataset.loaded = 'true';
                return null;
            }
            const chartId = cardEl.dataset.chartId;
            historyEl.innerHTML = buildHistoryHTML(person, chartId, name);
            const trendSection = historyEl.querySelector('.personal-trend-section');
            if (trendSection) {
                const trendContent = buildPersonTrendContent(person.Timeline, chartId);
                if (trendContent) trendSection.appendChild(trendContent);
            }
            historyEl.dataset.loaded = 'true';
            if (hasInflationData()) refreshInflationControls();
            return person;
        })
        .catch(err => {
            historyEl.innerHTML = `<div class="history-loading">Error loading details.</div>`;
            console.error(err);
            return null;
        });
}

// ==========================================
// RENDERING & HELPERS
// ==========================================
function renderInitial() {
    destroyPersonCharts();
    const keys = state.filteredKeys.slice(0, state.visibleCount);
    if (keys.length === 0) {
        const suggestFormer = !state.filters.showInactive && hasInactiveSearchMatch(state.filters.text || '');
        const quickSuggestions = (state.lastSearchSuggestions || []).slice(0, 4);
        const formerBtn = suggestFormer
            ? `<button class="suggestion-chip" onclick="showFormerEmployeesInSearch()">Show former employees</button>`
            : '';
        const suggestionBtns = quickSuggestions.map(item => `
            <button class="suggestion-chip" onclick="applySearch('${escapeHtmlAttr(escapeForSingleQuote(item.value || ''))}', 'search_suggestion')">${escapeHtml(item.value || '')}</button>
        `).join('');
        const warning = state.searchWarning ? `<div class="suggestions-title">${escapeHtml(state.searchWarning)}</div>` : '';
        els.results.innerHTML = `
            <div class="no-results-panel">
                <div class="no-results-title">No matching records found.</div>
                ${warning}
                <div>Try broader terms or field syntax such as <code>org:engineering</code> and <code>pay:60k-90k</code>.</div>
                <div class="no-results-actions">${formerBtn}${suggestionBtns}</div>
            </div>
        `;
        els.scrollSentinel = null;
        return;
    }
    els.results.innerHTML = keys.map((name, idx) => generateCardHTML(name, idx)).join('') + getSentinel();
    els.scrollSentinel = els.results.lastElementChild;
    observeSentinel();
}

function focusCardByIndex(idx) {
    if (idx < 0 || idx >= state.filteredKeys.length) return;
    while (idx >= state.visibleCount) appendNextBatch();
    const card = document.getElementById(`card-${idx}`);
    if (!card) return;
    const header = card.querySelector('.card-header');
    if (header) {
        header.focus();
        state.focusIndex = idx;
    }
}

function appendNextBatch() {
    const startIdx = state.visibleCount;
    const endIdx = Math.min(startIdx + state.batchSize, state.filteredKeys.length);
    if (startIdx >= state.filteredKeys.length) return;
    const html = state.filteredKeys.slice(startIdx, endIdx).map((name, idx) => generateCardHTML(name, startIdx + idx)).join('');
    els.scrollSentinel?.remove();
    els.results.insertAdjacentHTML('beforeend', html + getSentinel());
    els.scrollSentinel = els.results.lastElementChild;
    state.visibleCount = endIdx;
    captureAnalyticsEvent('results_batch_loaded', {
        source: 'infinite_scroll',
        start_idx: startIdx,
        end_idx: endIdx,
        total_results: state.filteredKeys.length
    });
    observeSentinel();
}

const getSentinel = () => `<div id="scroll-sentinel" class="loader-sentinel">${state.visibleCount < state.filteredKeys.length ? 'Loading more...' : 'End of results'}</div>`;
function getTransitionFilterLabel() {
    const transition = state.filters.transition;
    if (!transition) return '';
    const directionLabel = transition.direction === 'toUnclassified'
        ? 'Classified -> Unclassified'
        : 'Unclassified -> Classified';
    return `${directionLabel} in ${transition.year}`;
}
function updateStats() {
    const transitionLabel = getTransitionFilterLabel();
    const transitionText = transitionLabel ? ` (Transition filter: ${escapeHtml(transitionLabel)})` : '';
    const warning = state.searchWarning ? ` ${escapeHtml(state.searchWarning)}` : '';
    els.stats.innerHTML = `Found ${state.filteredKeys.length} matching personnel records.${transitionText}${warning}`;
}

function getClassStateFromSource(source) {
    const src = (source || '').toLowerCase();
    const isUnclass = src.includes('unclass');
    const isClassified = src.includes('class') && !isUnclass;
    if (isUnclass) return 'unclassified';
    if (isClassified) return 'classified';
    return null;
}

function computeTransitionMemberIndex() {
    if (state.transitionMemberIndex) return Promise.resolve(state.transitionMemberIndex);
    if (state.transitionIndexPromise) return state.transitionIndexPromise;

    const buckets = getUniqueBuckets(state.masterKeys);
    const index = {};

    const add = (year, direction, name) => {
        if (!year || !direction || !name) return;
        const key = `${year}|${direction}`;
        if (!index[key]) index[key] = new Set();
        index[key].add(name);
    };

    const processBucketData = (bucketData) => {
        const keys = Object.keys(bucketData);
        for (let j = 0; j < keys.length; j++) {
            const name = keys[j];
            const person = bucketData[name];
            if (!person || !person.Timeline || person.Timeline.length < 2) continue;
            hydratePersonDetail(person);

            let prevState = null;
            for (let i = 0; i < person.Timeline.length; i++) {
                const snap = person.Timeline[i];
                const currentState = getClassStateFromSource(snap.Source);
                if (!currentState) continue;
                if (prevState && prevState !== currentState) {
                    const year = new Date(snap.Date).getFullYear();
                    if (!isNaN(year)) {
                        const direction = currentState === 'unclassified' ? 'toUnclassified' : 'toClassified';
                        add(year, direction, name);
                    }
                }
                prevState = currentState;
            }
        }
    };

    state.transitionIndexPromise = forEachWithConcurrency(
        buckets,
        TRANSITION_BUCKET_LOAD_CONCURRENCY,
        (bucket) => loadBucket(bucket).then(processBucketData)
    )
        .then(() => {
            state.transitionMemberIndex = index;
            return index;
        })
        .catch(err => {
            console.error('Failed to build transition member index', err);
            throw err;
        })
        .finally(() => {
            state.transitionIndexPromise = null;
        });

    return state.transitionIndexPromise;
}

function applyTransitionFilter(year, direction) {
    const current = state.filters.transition;
    const isSame = current && current.year === year && current.direction === direction;
    if (isSame) {
        state.filters.transition = null;
        captureAnalyticsEvent('transition_filter_applied', {
            source: 'transition_filter',
            year,
            direction,
            enabled: false
        });
        setSearchSource('transition_filter');
        runSearch();
        return;
    }

    els.stats.innerHTML = 'Loading transition worker list...';
    computeTransitionMemberIndex()
        .then(() => {
            state.filters.transition = { year, direction };
            captureAnalyticsEvent('transition_filter_applied', {
                source: 'transition_filter',
                year,
                direction,
                enabled: true
            });
            setSearchSource('transition_filter');
            runSearch();
        })
        .catch(() => {
            state.filters.transition = null;
            captureAnalyticsEvent('transition_filter_applied', {
                source: 'transition_filter',
                year,
                direction,
                enabled: false
            });
            setSearchSource('transition_filter');
            runSearch();
        });
}
function toggleCard(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('expanded');
    const expanded = el.classList.contains('expanded');
    el.querySelector('.card-header')?.setAttribute('aria-expanded', expanded);
    if (expanded) {
        const name = el.getAttribute('data-name') || '';
        const parsedIdx = parseInt(el.getAttribute('data-index'), 10);
        const resultIndex = Number.isNaN(parsedIdx) ? -1 : parsedIdx;
        captureAnalyticsEvent('person_card_opened', {
            source: 'result_card',
            person_name: name,
            result_index: resultIndex,
            visible_count: state.visibleCount
        });
        loadAndRenderPersonDetails(el).then(() => ensurePersonChart(el));
    }
}

function rebuildPersonChart(cardEl) {
    if (!cardEl) return;
    const name = cardEl.getAttribute('data-name');
    if (!state.detailCache[name]) {
        loadAndRenderPersonDetails(cardEl).then(() => ensurePersonChart(cardEl));
        return;
    }
    const canvas = cardEl.querySelector('canvas[data-person-chart="true"]');
    if (!canvas) return;
    const chartId = canvas.id;
    if (state.personCharts[chartId]) {
        try { state.personCharts[chartId].destroy(); } catch (e) { /* no-op */ }
        delete state.personCharts[chartId];
    }
    ensurePersonChart(cardEl);
}

function getRecordGaps(person) {
    if (!person || !person.Timeline || person.Timeline.length < 2) return [];
    if (!state.snapshotDates || state.snapshotDates.length < 2) return [];

    if (state.snapshotDates && _cachedSnapshotDatesRef !== state.snapshotDates) {
        _globalSnapshotIdxMap = new Map();
        for (let i = 0; i < state.snapshotDates.length; i++) {
            _globalSnapshotIdxMap.set(state.snapshotDates[i], i);
        }
        _cachedSnapshotDatesRef = state.snapshotDates;
    }

    const tLen = person.Timeline.length;
    const dates = new Array(tLen);
    let dCount = 0;
    for (let i = 0; i < tLen; i++) {
        const d = person.Timeline[i].Date;
        if (d) {
            dates[dCount++] = d;
        }
    }
    dates.length = dCount;
    dates.sort();

    const gaps = [];

    for (let i = 0; i < dCount - 1; i++) {
        const idxA = _globalSnapshotIdxMap.get(dates[i]);
        const idxB = _globalSnapshotIdxMap.get(dates[i + 1]);
        if (idxA === undefined || idxB === undefined) continue;
        if (idxB - idxA > 1) {
            const start = state.snapshotDates[idxA + 1];
            const end = state.snapshotDates[idxB - 1];
            if (start && end) gaps.push({ start, end });
        }
    }
    return gaps;
}

function refreshInflationControls() {
    if (!hasInflationData()) return;
    document.querySelectorAll('.trend-mode').forEach(select => {
        if (select.dataset.ready === 'true') return;
        select.dataset.ready = 'true';
        select.disabled = false;
        select.innerHTML = `
            <option value="off" selected>Inflation: Off</option>
            <option value="adjusted">Inflation: Adjusted (graph wide)</option>
            <option value="compare">Inflation: Adjusted (separate line)</option>
        `;
    });
}
window.handleCardKey = function(e, id) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCard(id); } };

let observer;
function setupInfiniteScroll() {
    observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => { if (entry.isIntersecting && state.visibleCount < state.filteredKeys.length) appendNextBatch(); });
    }, { root: null, rootMargin: '100px', threshold: 0.1 });
}
function observeSentinel() {
    let s = els.scrollSentinel;
    if (!s) {
        s = document.getElementById('scroll-sentinel');
        els.scrollSentinel = s;
    }
    if (s && observer) observer.observe(s);
}

function debounce(func, wait) { let timeout; return function(...args) { clearTimeout(timeout); timeout = setTimeout(() => func.apply(this, args), wait); }; }
const handleSearch = debounce(() => {
    state.filters.text = els.searchInput.value;
    setSearchSource('search_input');
    runSearch();
}, 250);

els.searchInput.addEventListener('input', (e) => {
    els.clearBtn.classList.toggle('hidden', !e.target.value);
    handleSearch();
});
els.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && state.autocompleteItems.length) {
        e.preventDefault();
        stepAutocomplete(1);
        return;
    }
    if (e.key === 'ArrowUp' && state.autocompleteItems.length) {
        e.preventDefault();
        stepAutocomplete(-1);
        return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && state.autocompleteItems.length && state.autocompleteFocus >= 0) {
        e.preventDefault();
        applyAutocompleteIndex(state.autocompleteFocus);
        return;
    }
    if (e.key === 'Escape') {
        hideAutocomplete();
    }
});

if (els.autocomplete) {
    els.autocomplete.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.autocomplete-item');
        if (!item) return;
        e.preventDefault();
        const idx = parseInt(item.dataset.idx || '-1', 10);
        applyAutocompleteIndex(idx);
    });
}

document.addEventListener('click', (e) => {
    if (!els.autocomplete || els.autocomplete.classList.contains('hidden')) return;
    if (e.target === els.searchInput || e.target.closest('#search-autocomplete')) return;
    hideAutocomplete();
});

els.clearBtn.addEventListener('click', () => {
    const previousQuery = (state.filters.text || '').trim();
    captureAnalyticsEvent('search_cleared', {
        source: 'clear_search',
        query: previousQuery.slice(0, SEARCH_ANALYTICS_MAX_QUERY_LEN),
        query_length: previousQuery.length
    });
    els.searchInput.value = '';
    els.clearBtn.classList.add('hidden');
    state.filters.text = '';
    state.lastHighlightTerms = [];
    state.searchWarning = '';
    updateRegexPill(false, '');
    hideAutocomplete();
    setSearchSource('clear_search');
    runSearch();
    els.searchInput.focus();
});
els.typeSelect.addEventListener('change', (e) => {
    state.filters.type = e.target.value;
    trackFilterChanged('type', e.target.value);
    setSearchSource('filter_change');
    runSearch();
});
els.roleInput.addEventListener('input', debounce((e) => {
    state.filters.role = e.target.value;
    trackFilterChanged('role', (e.target.value || '').trim().slice(0, SEARCH_ANALYTICS_MAX_QUERY_LEN));
    setSearchSource('filter_change');
    runSearch();
}, 300));
els.salaryMin.addEventListener('input', debounce((e) => {
    state.filters.minSalary = parseFloat(e.target.value) || null;
    trackFilterChanged('salary_min', state.filters.minSalary);
    setSearchSource('filter_change');
    runSearch();
}, 300));
els.salaryMax.addEventListener('input', debounce((e) => {
    state.filters.maxSalary = parseFloat(e.target.value) || null;
    trackFilterChanged('salary_max', state.filters.maxSalary);
    setSearchSource('filter_change');
    runSearch();
}, 300));
els.inactiveToggle.addEventListener('change', (e) => {
    state.filters.showInactive = e.target.checked;
    trackFilterChanged('show_inactive', e.target.checked);
    setSearchSource('filter_change');
    runSearch();
});
els.sortSelect.addEventListener('change', (e) => {
    state.filters.sort = e.target.value;
    trackFilterChanged('sort_order', e.target.value);
    setSearchSource('filter_change');
    runSearch();
});
els.fteToggle.addEventListener('change', (e) => {
    state.filters.fullTimeOnly = e.target.checked;
    trackFilterChanged('full_time_only', e.target.checked);
    setSearchSource('filter_change');
    runSearch();
});
els.dataFlagsToggle.addEventListener('change', (e) => {
    state.filters.dataFlagsOnly = e.target.checked;
    trackFilterChanged('data_flags_only', e.target.checked);
    setSearchSource('filter_change');
    runSearch();
});
if (els.exclusionsMode) {
    els.exclusionsMode.addEventListener('change', (e) => {
        state.filters.exclusionsMode = e.target.value;
        trackFilterChanged('exclusions_mode', e.target.value);
        setSearchSource('filter_change');
        runSearch();
    });
}

function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName ? target.tagName.toLowerCase() : '';
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function setupTooltips() {
    const tooltipEl = document.getElementById('custom-tooltip');
    const showTooltipFor = (target) => {
        if (!target || !tooltipEl) return;
        tooltipEl.textContent = target.getAttribute('data-tooltip');
        tooltipEl.classList.remove('hidden');
    };
    const hideTooltip = () => {
        if (!tooltipEl) return;
        tooltipEl.classList.add('hidden');
    };
    document.addEventListener('mouseover', (e) => {
        const target = e.target.closest('[data-tooltip]');
        if (target) showTooltipFor(target);
    });
    document.addEventListener('mousemove', (e) => {
        if (!tooltipEl.classList.contains('hidden')) {
            tooltipEl.style.left = `${Math.min(e.clientX + 10, window.innerWidth - tooltipEl.offsetWidth - 20)}px`;
            tooltipEl.style.top = `${Math.min(e.clientY + 10, window.innerHeight - tooltipEl.offsetHeight - 20)}px`;
        }
    });
    document.addEventListener('mouseout', (e) => { if (e.target.closest('[data-tooltip]')) hideTooltip(); });
    document.addEventListener('focusin', (e) => {
        const target = e.target.closest('[data-tooltip]');
        if (target) showTooltipFor(target);
    });
    document.addEventListener('focusout', (e) => {
        if (e.target.closest('[data-tooltip]')) hideTooltip();
    });
}

function setupAdvancedSearchToggle() {
    if (!els.advancedToggle || !els.advancedSearch) return;
    els.advancedToggle.addEventListener('click', () => {
        const isHidden = els.advancedSearch.classList.contains('hidden');
        els.advancedSearch.classList.toggle('hidden', !isHidden);
        els.advancedToggle.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
    });
}

function setupHistoricalChartsToggle() {
    const toggle = document.getElementById('historical-toggle');
    const wrapper = document.getElementById('historical-charts');
    if (!toggle || !wrapper) return;

    toggle.addEventListener('click', () => {
        const isExpanded = toggle.getAttribute('aria-expanded') === 'true';
        const nextExpanded = !isExpanded;
        toggle.setAttribute('aria-expanded', String(nextExpanded));
        wrapper.classList.toggle('hidden', !nextExpanded ? true : false);
        wrapper.setAttribute('aria-hidden', String(!nextExpanded));
        toggle.textContent = nextExpanded ? 'Hide historical charts' : 'Show historical charts';
        captureAnalyticsEvent('historical_charts_toggled', {
            source: 'historical_toggle',
            expanded: nextExpanded
        });

        if (nextExpanded && !state.historicalChartsRendered) {
            renderInteractiveCharts(state.historyStats);
            state.historicalChartsRendered = true;
        }
    });
}

function setupHotkeys() {
    document.addEventListener('focusin', (e) => {
        const card = e.target.closest('.card');
        if (!card || !card.id) return;
        const match = card.id.match(/^card-(\d+)$/);
        if (match) state.focusIndex = parseInt(match[1], 10);
    });

    document.addEventListener('keydown', (e) => {
        const modal = document.getElementById('info-modal');
        const isModalOpen = modal && !modal.classList.contains('hidden');

        if (e.key === 'Escape') {
            if (isModalOpen) {
                modal.classList.add('hidden');
                return;
            }
            hideAutocomplete();
            if (els.searchInput.value) {
                els.searchInput.value = '';
                els.clearBtn.classList.add('hidden');
                state.filters.text = '';
                setSearchSource('clear_search');
                runSearch();
            }
            return;
        }

        if (isModalOpen) return;

        if (isTypingTarget(e.target)) return;

        if (e.key === '?' ) {
            if (modal) {
                modal.classList.remove('hidden');
                captureAnalyticsEvent('info_modal_opened', { source: 'hotkey' });
                const hotkeys = document.getElementById('hotkeys-section');
                if (hotkeys) hotkeys.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            return;
        }

        if (e.key === '/' || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
            e.preventDefault();
            els.searchInput.focus();
            return;
        }

        if (e.key === 'j' || e.key === 'ArrowDown') {
            e.preventDefault();
            const next = state.focusIndex >= 0 ? state.focusIndex + 1 : 0;
            focusCardByIndex(Math.min(next, state.filteredKeys.length - 1));
            return;
        }

        if (e.key === 'k' || e.key === 'ArrowUp') {
            if (e.ctrlKey || e.metaKey) return;
            e.preventDefault();
            const prev = state.focusIndex > 0 ? state.focusIndex - 1 : 0;
            focusCardByIndex(prev);
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('info-modal');
    if (modal) {
        document.getElementById('info-btn').addEventListener('click', () => {
            modal.classList.remove('hidden');
            captureAnalyticsEvent('info_modal_opened', { source: 'info_button' });
        });
        document.getElementById('close-modal').addEventListener('click', () => modal.classList.add('hidden'));
        window.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.classList.add('hidden'); });
        document.querySelectorAll('.collapsible-btn').forEach(btn => btn.addEventListener('click', () => {
            btn.setAttribute('aria-expanded', !(btn.getAttribute('aria-expanded') === 'true'));
            btn.nextElementSibling.classList.toggle('hidden');
        }));
    }

    document.body.addEventListener('change', (e) => {
        const target = e.target;
        if (target && (target.classList.contains('trend-mode') || target.classList.contains('gap-toggle-input'))) {
            const cardEl = target.closest('.card');
            if (cardEl) rebuildPersonChart(cardEl);
        }
    });

    setupHotkeys();

    document.body.addEventListener('click', (e) => {
        const reportBtn = e.target.closest('.report-btn');
        if (reportBtn) {
            const name = reportBtn.getAttribute('data-report-name') || '';
            openCorrectionIssue(name);
            return;
        }
        const btn = e.target.closest('.section-toggle');
        if (!btn) return;
        const body = btn.nextElementSibling;
        if (!body) return;
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', (!expanded).toString());
        body.classList.toggle('hidden', expanded);
    });
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        checkSearchWorkerHealth('visibilitychange');
    }
});

window.addEventListener('pageshow', () => {
    checkSearchWorkerHealth('pageshow');
});

window.addEventListener('focus', () => {
    checkSearchWorkerHealth('focus');
});

function parseUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const query = params.get('q');
    const name = params.get('name');
    const target = query || name;
    if (target) {
        state.filters.text = target;
        els.searchInput.value = target;
        els.clearBtn.classList.remove('hidden');
    }
    if (query) return null;
    if (name) return name;
    return null;
}
function autoExpandTarget(name) {
    const card = document.querySelector(`.card[data-name="${name.replace(/"/g, '\\"')}"]`);
    if (card) {
        card.classList.add('expanded');
        loadAndRenderPersonDetails(card).then(() => ensurePersonChart(card));
        setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }
}
function copyLink(e, name) {
    e.stopPropagation();
    const url = new URL(window.location.href); url.searchParams.set('name', name);
    window.history.pushState({ path: url.href }, '', url.href);
    captureAnalyticsEvent('person_link_copied', {
        source: 'person_link',
        person_name: name
    });
    navigator.clipboard.writeText(url.href).then(() => showToast(`Link copied for ${name}`)).catch(console.error);
}

function openCorrectionIssue(name) {
    captureAnalyticsEvent('correction_issue_opened', {
        source: 'correction_button',
        person_name: name || 'Unknown'
    });
    const base = 'https://github.com/jaxsnjohnson/uo-sal-report-data-and-site/issues/new';
    const safeName = name || 'Unknown';
    const title = `Data correction request: ${safeName}`;
    const body = [
        `Person: ${safeName}`,
        'Report date:',
        'Field:',
        'Observed value:',
        'Expected value:',
        'Source link or notes:'
    ].join('\\n');
    const params = new URLSearchParams({ title, body });
    window.open(`${base}?${params.toString()}`, '_blank', 'noopener');
}
function showToast(msg) {
    let t = document.getElementById('toast-notification');
    if (!t) { t = document.createElement('div'); t.id = 'toast-notification'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3000);
}

function renderSuggestedSearches() {
    if (!els.suggestedSearches) return;
    els.suggestedSearches.innerHTML = ['Professor', 'Athletics', 'Physics', 'Coach', 'Dean'].map(term =>
        `<button class="chip" onclick="applySearch('${term}', 'suggested_chip')">${term}</button>`
    ).join('');
}
