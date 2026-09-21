let records = [];
let recordMap = new Map();
let isReady = false;
let regexPrefilterEnabled = true;
let regexSearchAux = null;

const resultCache = new Map();
const CACHE_LIMIT = 80;
const REGEX_MAX_MATCHES = 3000;
const REGEX_PREFILTER_MIN_LITERAL_LEN = 3;
const REGEX_PREFILTER_BROAD_CANDIDATE_RATIO = 0.98;
const SUGGESTION_LIMIT = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
let editDistancePrev = new Uint32Array(0);
let editDistanceCur = new Uint32Array(0);
const EMPTY_UINT32 = new Uint32Array(0);

const INVALID_REGEX_CHARS = /[()\\.*+?\[\]{}]/;

const normalizeText = (value) => (value || '').toString().normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const tokenize = (value) => normalizeText(value).split(' ').filter(Boolean);
const tokenizeLongUnique = (value) => {
    const text = (value || '').toString().toLowerCase();
    const out = [];
    const seen = new Set();
    let tokenStart = -1;

    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        const isAlphaNum = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);

        if (isAlphaNum) {
            if (tokenStart === -1) tokenStart = i;
        } else if (tokenStart !== -1) {
            if (i - tokenStart >= 3) {
                const token = text.slice(tokenStart, i);
                if (!seen.has(token)) {
                    seen.add(token);
                    out.push(token);
                }
            }
            tokenStart = -1;
        }
    }

    if (tokenStart !== -1 && text.length - tokenStart >= 3) {
        const token = text.slice(tokenStart);
        if (!seen.has(token)) {
            seen.add(token);
            out.push(token);
        }
    }
    return out;
};
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const collectUniqueTrigrams = (value) => {
    const text = (value || '').toString();
    if (text.length < 3) return [];
    const seen = new Set();
    for (let i = 0; i <= (text.length - 3); i++) {
        seen.add(text.slice(i, i + 3));
    }
    return Array.from(seen);
};

const intersectSortedIds = (a, b) => {
    if (!a || !b || !a.length || !b.length) return EMPTY_UINT32;
    const out = new Uint32Array(Math.min(a.length, b.length));
    let i = 0;
    let j = 0;
    let count = 0;
    while (i < a.length && j < b.length) {
        const av = a[i];
        const bv = b[j];
        if (av === bv) {
            out[count++] = av;
            i++;
            j++;
            continue;
        }
        if (av < bv) i++;
        else j++;
    }
    return count === out.length ? out : out.subarray(0, count);
};

const unionSortedIds = (a, b) => {
    if (!a || !a.length) return b || EMPTY_UINT32;
    if (!b || !b.length) return a;

    const out = new Uint32Array(a.length + b.length);
    let i = 0;
    let j = 0;
    let count = 0;
    while (i < a.length && j < b.length) {
        const av = a[i];
        const bv = b[j];
        if (av === bv) {
            out[count++] = av;
            i++;
            j++;
            continue;
        }
        if (av < bv) {
            out[count++] = av;
            i++;
        } else {
            out[count++] = bv;
            j++;
        }
    }
    while (i < a.length) out[count++] = a[i++];
    while (j < b.length) out[count++] = b[j++];
    return count === out.length ? out : out.subarray(0, count);
};

const intersectManyPostings = (postings) => {
    if (!postings || !postings.length) return EMPTY_UINT32;
    if (postings.length === 1) return postings[0];

    const ordered = postings.slice().sort((a, b) => a.length - b.length);
    let current = ordered[0];
    for (let i = 1; i < ordered.length; i++) {
        current = intersectSortedIds(current, ordered[i]);
        if (!current.length) return EMPTY_UINT32;
    }
    return current;
};

const buildRegexSearchAux = (nextRecords) => {
    const postingLists = new Map();
    for (let idx = 0; idx < nextRecords.length; idx++) {
        const rec = nextRecords[idx];
        const grams = collectUniqueTrigrams(rec && rec.searchText ? rec.searchText : '');
        for (const gram of grams) {
            let ids = postingLists.get(gram);
            if (!ids) {
                ids = [];
                postingLists.set(gram, ids);
            }
            ids.push(idx);
        }
    }

    const gramPostings = new Map();
    for (const [gram, ids] of postingLists.entries()) {
        gramPostings.set(gram, Uint32Array.from(ids));
    }

    return {
        recordsRef: nextRecords,
        recordCount: nextRecords.length,
        gramPostings
    };
};

const ensureRegexSearchAux = () => {
    if (!regexSearchAux || regexSearchAux.recordsRef !== records || regexSearchAux.recordCount !== records.length) {
        regexSearchAux = buildRegexSearchAux(records);
    }
    return regexSearchAux;
};

const extractRegexLiteralBranches = (pattern) => {
    if (!pattern) return null;

    let body = pattern;
    if (body.startsWith('^')) body = body.slice(1);
    if (body.endsWith('$')) body = body.slice(0, -1);
    if (!body) return null;

    let alternationBody = body;
    if (alternationBody.startsWith('(') || alternationBody.endsWith(')')) {
        if (!(alternationBody.startsWith('(') && alternationBody.endsWith(')'))) return null;
        alternationBody = alternationBody.slice(1, -1);
        if (!alternationBody) return null;
    }

    if (INVALID_REGEX_CHARS.test(alternationBody)) return null;

    const rawBranches = alternationBody.split('|');
    if (!rawBranches.length) return null;

    const literals = [];
    const seen = new Set();
    for (let i = 0; i < rawBranches.length; i++) {
        const branch = rawBranches[i];
        if (!branch) return null;

        const literalNorm = normalizeText(branch);
        if (!literalNorm || literalNorm.length < REGEX_PREFILTER_MIN_LITERAL_LEN) continue;
        if (seen.has(literalNorm)) continue;
        seen.add(literalNorm);
        literals.push(literalNorm);
    }

    return literals.length ? literals : null;
};

const getRegexPrefilterCandidateIds = (parsed) => {
    if (!regexPrefilterEnabled || !parsed || !parsed.regex || !records.length) return null;

    const literals = extractRegexLiteralBranches(parsed.regex);
    if (!literals || !literals.length) return null;

    const aux = ensureRegexSearchAux();
    if (!aux || !aux.gramPostings) return null;

    let unionIds = null;
    for (const literal of literals) {
        const grams = collectUniqueTrigrams(literal);
        if (!grams.length) return null;

        const postings = [];
        for (const gram of grams) {
            const ids = aux.gramPostings.get(gram);
            if (!ids || !ids.length) {
                postings.length = 0;
                break;
            }
            postings.push(ids);
        }

        let branchIds = EMPTY_UINT32;
        if (postings.length) {
            branchIds = intersectManyPostings(postings);
        }

        unionIds = unionIds ? unionSortedIds(unionIds, branchIds) : branchIds;
        if (unionIds && unionIds.length >= (aux.recordCount * REGEX_PREFILTER_BROAD_CANDIDATE_RATIO)) {
            return null;
        }
    }

    return unionIds || EMPTY_UINT32;
};

const setRegexPrefilterEnabled = (value) => {
    regexPrefilterEnabled = value !== false;
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

const parseAmount = (value) => {
    if (!value) return null;
    const str = value.toString().trim().toLowerCase().replace(/[$,]/g, '');
    const mult = str.endsWith('m') ? 1000000 : (str.endsWith('k') ? 1000 : 1);
    const num = parseFloat(mult === 1 ? str : str.slice(0, -1));
    if (Number.isNaN(num)) return null;
    return num * mult;
};

const buildOrgAliases = (orgValue) => {
    const text = (orgValue || '').toString();
    const aliases = [];
    const base = normalizeText(text);
    if (base) aliases.push(base);

    if (text.indexOf('-') === -1) return aliases;

    const parts = text.split('-').map(s => s.trim()).filter(Boolean);
    if (parts.length > 0) {
        const code = normalizeText(parts[0]);
        const tail = normalizeText(parts.slice(1).join(' '));
        if (code) aliases.push(code);
        if (tail) {
            aliases.push(tail);
            const tailTokens = tail.split(' ');
            for (let j = 0; j < tailTokens.length; j++) {
                if (tailTokens[j]) aliases.push(tailTokens[j]);
            }
        }
    }
    return Array.from(new Set(aliases));
};

const tokenizeQuery = (query) => {
    const text = (query || '').toString();
    const tokens = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
            inQuotes = !inQuotes;
            current += char;
            continue;
        }
        if (!inQuotes && /\s/.test(char)) {
            if (current) tokens.push(current);
            current = '';
            continue;
        }
        current += char;
    }

    if (current) tokens.push(current);
    return tokens;
};

const splitFieldTerms = (value) => {
    const raw = (value || '').toString().trim();
    if (!raw) return [];
    const unwrapped = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1)
        : raw;
    return tokenize(unwrapped);
};

const _regexCache = new Map();
const REGEX_CACHE_LIMIT = 500;

const parseQuery = (query) => {
    const raw = (query || '').trim();
    const parsed = {
        raw,
        regex: null,
        regexFlags: '',
        regexError: null,
        terms: [],
        negativeTerms: [],
        nameTerms: [],
        orgTerms: [],
        roleTerms: [],
        type: null,
        status: null,
        payMin: null,
        payMax: null,
        sort: null,
        highlightTerms: []
    };

    const regexMatch = raw.match(/^\/(.*)\/([a-z]*)$/i);
    if (regexMatch) {
        parsed.regex = regexMatch[1];
        parsed.regexFlags = regexMatch[2] || '';

        const cacheKey = raw;
        const cached = _regexCache.get(cacheKey);

        if (cached) {
            if (cached.error) {
                parsed.regexError = cached.error;
            } else {
                parsed.regexCompiled = cached.regex;
                if (parsed.regexCompiled.global || parsed.regexCompiled.sticky) {
                    parsed.regexCompiled.lastIndex = 0;
                }
            }
        } else {
            try {
                parsed.regexCompiled = new RegExp(parsed.regex, parsed.regexFlags);
                if (_regexCache.size >= REGEX_CACHE_LIMIT) {
                    _regexCache.clear();
                }
                _regexCache.set(cacheKey, { regex: parsed.regexCompiled, error: null });
            } catch (err) {
                parsed.regexError = err && err.message ? err.message : 'Invalid regex';
                if (_regexCache.size >= REGEX_CACHE_LIMIT) {
                    _regexCache.clear();
                }
                _regexCache.set(cacheKey, { regex: null, error: parsed.regexError });
            }
        }
        return parsed;
    }

    const tokens = tokenizeQuery(raw);
    for (const token of tokens) {
        if (!token) continue;
        let current = token;
        let negative = false;
        if (current.startsWith('-') && current.length > 1) {
            negative = true;
            current = current.slice(1);
        }

        const fieldIdx = current.indexOf(':');
        if (fieldIdx > 0) {
            const field = current.slice(0, fieldIdx).toLowerCase();
            const value = current.slice(fieldIdx + 1).trim();
            if (!value) continue;

            if (field === 'name') {
                const parts = splitFieldTerms(value);
                for (let j = 0; j < parts.length; j++) parsed.nameTerms.push(parts[j]);
                continue;
            }
            if (field === 'org') {
                const parts = splitFieldTerms(value);
                for (let j = 0; j < parts.length; j++) parsed.orgTerms.push(parts[j]);
                continue;
            }
            if (field === 'role') {
                const parts = splitFieldTerms(value);
                for (let j = 0; j < parts.length; j++) parsed.roleTerms.push(parts[j]);
                continue;
            }
            if (field === 'type') {
                const v = value.toLowerCase();
                if (v === 'classified' || v === 'unclassified') parsed.type = v;
                continue;
            }
            if (field === 'status') {
                const v = value.toLowerCase();
                if (v === 'active' || v === 'inactive') parsed.status = v;
                continue;
            }
            if (field === 'sort') {
                const v = value.toLowerCase();
                if (v === 'name' || v === 'salary' || v === 'tenure' || v === 'recent') parsed.sort = v;
                continue;
            }
            if (field === 'pay') {
                const payVal = value.replace(/\s+/g, '').toLowerCase();
                if (payVal.includes('-')) {
                    const [low, high] = payVal.split('-');
                    const lowNum = parseAmount(low);
                    const highNum = parseAmount(high);
                    if (lowNum !== null) parsed.payMin = lowNum;
                    if (highNum !== null) parsed.payMax = highNum;
                } else if (payVal.startsWith('>')) {
                    const min = parseAmount(payVal.slice(1));
                    if (min !== null) parsed.payMin = min;
                } else if (payVal.startsWith('<')) {
                    const max = parseAmount(payVal.slice(1));
                    if (max !== null) parsed.payMax = max;
                }
                continue;
            }
        }

        const normalized = normalizeText(current);
        if (!normalized) continue;
        if (negative) parsed.negativeTerms.push(normalized);
        else parsed.terms.push(normalized);
    }

    const highlights = [];
    const pushParts = (arr) => {
        for (let i = 0; i < arr.length; i++) {
            const toks = tokenize(arr[i]);
            for (let j = 0; j < toks.length; j++) {
                if (toks[j].length > 1) highlights.push(toks[j]);
            }
        }
    };
    pushParts(parsed.terms);
    pushParts(parsed.nameTerms);
    pushParts(parsed.orgTerms);
    pushParts(parsed.roleTerms);
    parsed.highlightTerms = Array.from(new Set(highlights));
    return parsed;
};

const getSortKey = (sortFromFilters, sortFromDsl) => {
    if (sortFromDsl === 'salary') return 'salary-desc';
    if (sortFromDsl === 'tenure') return 'tenure-desc';
    if (sortFromDsl === 'recent') return 'recent-desc';
    if (sortFromDsl === 'name') return 'name-asc';
    return sortFromFilters || 'name-asc';
};

const scoreTokenInText = (term, text, preTokens) => {
    if (!term || !text) return null;
    if (text === term) return 0;
    if (text.startsWith(term)) return 0;
    if (text.includes(term)) return 1;
    const maxDist = term.length <= 4 ? 1 : (term.length <= 6 ? 2 : 3);
    let best = maxDist + 1;
    const tokens = preTokens || tokenize(text);
    for (const token of tokens) {
        if (token.length < 3) continue;
        const dist = boundedEditDistance(term, token, maxDist);
        if (dist < best) best = dist;
        if (best === 0) break;
    }
    if (best <= maxDist) return 2 + best;
    return null;
};

const matchesFieldTerm = (term, values, preTokens) => {
    if (!term) return false;
    for (const value of values) {
        if (!value) continue;
        if (value.includes(term)) return true;
    }

    const maxDist = term.length <= 5 ? 1 : 2;
    const tokensToSearch = preTokens || tokenize(values.join(' '));
    for (const token of tokensToSearch) {
        if (token.length < 3) continue;
        if (boundedEditDistance(term, token, maxDist) <= maxDist) return true;
    }
    return false;
};

const appliesCommonFilters = (rec, payload, parsed, transitionSet, cutoffTs) => {
    if (payload.baseSet && !payload.baseSet.has(rec.name)) return false;
    const roleFilter = payload.roleFilterNorm || payload.roleFilter;
    if (roleFilter && !rec.roleSearch.includes(roleFilter)) return false;

    if (rec.payMissing && (payload.minSalary !== null || payload.maxSalary !== null || parsed.payMin !== null || parsed.payMax !== null)) return false;
    if (payload.minSalary !== null && rec.totalPay < payload.minSalary) return false;
    if (payload.maxSalary !== null && rec.totalPay > payload.maxSalary) return false;

    if (payload.dataFlagsOnly && !rec.hasFlags) return false;

    if (payload.exclusionsMode !== 'off') {
        if (!rec.wasExcluded) return false;
        if (payload.exclusionsMode === 'recent') {
            if (!rec.exclusionTs || rec.exclusionTs < cutoffTs) return false;
        }
    }

    if (transitionSet && !transitionSet.has(rec.name)) return false;

    if (parsed.type) {
        if (parsed.type === 'classified' && rec.isUnclass) return false;
        if (parsed.type === 'unclassified' && !rec.isUnclass) return false;
    }

    if (parsed.status) {
        if (parsed.status === 'active' && !rec.isActive) return false;
        if (parsed.status === 'inactive' && rec.isActive) return false;
    }

    if (parsed.payMin !== null && rec.totalPay < parsed.payMin) return false;
    if (parsed.payMax !== null && rec.totalPay > parsed.payMax) return false;

    return true;
};

const scoreRecord = (rec, parsed) => {
    let score = 0;

    for (const term of parsed.negativeTerms) {
        if (rec.searchText.includes(term)) return null;
    }

    for (const term of parsed.nameTerms) {
        const fieldScore = scoreTokenInText(term, rec.nameNorm, rec.nameTokens);
        if (fieldScore === null) return null;
        score += fieldScore;
    }

    for (const term of parsed.orgTerms) {
        const orgValues = rec.orgMatchValues || [rec.homeOrgNorm, rec.lastOrgNorm, ...(rec.orgAliases || [])];
        const matches = matchesFieldTerm(term, orgValues, rec.orgSearchTokens);
        if (!matches) return null;
        score += 1;
    }

    for (const term of parsed.roleTerms) {
        const roleValues = rec.roleMatchValues || [rec.roleSearch, ...(rec.rolesNorm || []), ...(rec.roleAliases || [])];
        const matches = matchesFieldTerm(term, roleValues, rec.roleSearchTokens);
        if (!matches) return null;
        score += 1;
    }

    for (const term of parsed.terms) {
        const nameScore = scoreTokenInText(term, rec.nameNorm, rec.nameTokens);
        const roleScore = scoreTokenInText(term, rec.roleSearch, rec.roleSearchTokens);
        const orgScore = scoreTokenInText(term, rec.orgSearch, rec.orgSearchTokens);
        const searchScore = scoreTokenInText(term, rec.searchText, rec.searchTextTokens);

        let best = Infinity;
        if (nameScore !== null && nameScore < best) best = nameScore;
        if (roleScore !== null && (roleScore + 1) < best) best = roleScore + 1;
        if (orgScore !== null && (orgScore + 1) < best) best = orgScore + 1;
        if (searchScore !== null && (searchScore + 2) < best) best = searchScore + 2;

        if (!Number.isFinite(best)) return null;
        score += best;
    }

    if (rec.isActive) score -= 0.1;
    return score;
};

const sortResults = (items, sortKey) => {
    const sorted = items.slice();

    if (sortKey === 'salary-desc') {
        sorted.sort((a, b) => (b.totalPay - a.totalPay) || (a.score - b.score) || a.name.localeCompare(b.name));
        return sorted;
    }
    if (sortKey === 'salary-asc') {
        sorted.sort((a, b) => (a.totalPay - b.totalPay) || (a.score - b.score) || a.name.localeCompare(b.name));
        return sorted;
    }
    if (sortKey === 'tenure-desc') {
        sorted.sort((a, b) => (a.firstHiredYear - b.firstHiredYear) || (a.score - b.score) || a.name.localeCompare(b.name));
        return sorted;
    }
    if (sortKey === 'tenure-asc') {
        sorted.sort((a, b) => (b.firstHiredYear - a.firstHiredYear) || (a.score - b.score) || a.name.localeCompare(b.name));
        return sorted;
    }
    if (sortKey === 'recent-desc') {
        sorted.sort((a, b) => b.lastDate.localeCompare(a.lastDate) || (a.score - b.score) || a.name.localeCompare(b.name));
        return sorted;
    }
    if (sortKey === 'name-desc') {
        sorted.sort((a, b) => b.name.localeCompare(a.name) || (a.score - b.score));
        return sorted;
    }

    sorted.sort((a, b) => (a.score - b.score) || a.name.localeCompare(b.name));
    return sorted;
};

const buildSuggestions = (queryNorm, parsed, payload, transitionSet, cutoffTs) => {
    if (!queryNorm || parsed.regex) return [];

    const suggestions = [];
    const seen = new Set();
    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    for (const rec of records) {
        if (suggestions.length >= SUGGESTION_LIMIT) break;
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if ((now - start) > 20) break;
        if (!appliesCommonFilters(rec, payload, parsed, transitionSet, cutoffTs)) continue;

        if (rec.nameNorm.startsWith(queryNorm) || rec.nameNorm.includes(queryNorm)) {
            const key = `name:${rec.nameNorm}`;
            if (!seen.has(key)) {
                seen.add(key);
                suggestions.push({ type: 'name', value: rec.name });
                if (suggestions.length >= SUGGESTION_LIMIT) break;
            }
        }

        for (const role of rec.roles) {
            const roleNorm = normalizeText(role);
            if (!roleNorm || (!roleNorm.startsWith(queryNorm) && !roleNorm.includes(queryNorm))) continue;
            const key = `role:${roleNorm}`;
            if (!seen.has(key)) {
                seen.add(key);
                suggestions.push({ type: 'role', value: role });
                if (suggestions.length >= SUGGESTION_LIMIT) break;
            }
        }

        const orgCandidates = [rec.homeOrg, rec.lastOrg];
        for (const org of orgCandidates) {
            const orgNorm = normalizeText(org);
            if (!orgNorm || (!orgNorm.startsWith(queryNorm) && !orgNorm.includes(queryNorm))) continue;
            const key = `org:${orgNorm}`;
            if (!seen.has(key)) {
                seen.add(key);
                suggestions.push({ type: 'org', value: org });
                if (suggestions.length >= SUGGESTION_LIMIT) break;
            }
        }
    }

    return suggestions;
};

const buildCacheKey = (payload, parsed) => {
    const recentCutoffKey = payload.exclusionsMode === 'recent'
        ? Math.floor((payload.nowTs || Date.now()) / DAY_MS)
        : '';
    const parts = [
        parsed.raw,
        payload.roleFilter || '',
        payload.minSalary === null ? '' : payload.minSalary,
        payload.maxSalary === null ? '' : payload.maxSalary,
        payload.dataFlagsOnly ? '1' : '0',
        payload.exclusionsMode || 'off',
        payload.transitionKey || '',
        payload.baseKey || '',
        parsed.type || '',
        parsed.status || '',
        parsed.payMin === null ? '' : parsed.payMin,
        parsed.payMax === null ? '' : parsed.payMax,
        parsed.sort || '',
        recentCutoffKey
    ];
    return parts.join('|');
};

const parseAndSearch = (payload) => {
    const queryText = payload.query || '';
    const parsed = parseQuery(queryText);
    if (parsed.regexError) {
        return {
            names: [],
            suggestions: [],
            regexMode: true,
            regexTooBroad: false,
            warning: `Regex error: ${parsed.regexError}`,
            highlightTerms: [],
            queryUsedSort: null
        };
    }

    const transitionSet = payload.transitionNames ? new Set(payload.transitionNames) : null;
    const baseSet = payload.baseNames ? new Set(payload.baseNames) : null;
    const roleFilterNorm = payload.roleFilter ? normalizeText(payload.roleFilter) : '';
    const payloadWithSets = {
        ...payload,
        baseSet,
        roleFilterNorm
    };
    const nowTs = payload.nowTs || Date.now();
    const utcDayKey = Math.floor(nowTs / DAY_MS);
    const cutoffTs = (utcDayKey - 365) * DAY_MS;
    const queryNorm = normalizeText(parsed.raw);
    const sortKey = getSortKey(payload.sort, parsed.sort);

    const cacheKey = buildCacheKey(payload, parsed);
    const cached = resultCache.get(cacheKey);
    if (cached) {
        const sorted = sortResults(cached.items, sortKey);
        return {
            names: sorted.map(item => item.name),
            suggestions: cached.suggestions,
            regexMode: !!parsed.regex,
            regexTooBroad: !!cached.regexTooBroad,
            warning: cached.warning || '',
            highlightTerms: parsed.highlightTerms,
            queryUsedSort: parsed.sort || null
        };
    }

    const items = [];
    let regexTooBroad = false;
    let warning = '';
    let suggestions = [];

    if (parsed.regex) {
        const regex = parsed.regexCompiled;
        const candidateIds = getRegexPrefilterCandidateIds(parsed);
        const searchRegexRecord = (rec) => {
            if (!rec) return false;
            if (!appliesCommonFilters(rec, payloadWithSets, parsed, transitionSet, cutoffTs)) return false;
            regex.lastIndex = 0;
            if (!regex.test(rec.regexText)) return false;
            items.push({
                name: rec.name,
                score: 0,
                totalPay: rec.totalPay,
                firstHiredYear: rec.firstHiredYear,
                lastDate: rec.lastDate
            });
            if (items.length > REGEX_MAX_MATCHES) {
                regexTooBroad = true;
                warning = 'Regex is too broad. Add anchors or more specific terms.';
                return true;
            }
            return false;
        };

        if (candidateIds !== null) {
            for (let i = 0; i < candidateIds.length; i++) {
                const rec = records[candidateIds[i]];
                if (searchRegexRecord(rec)) break;
            }
        } else {
            for (const rec of records) {
                if (searchRegexRecord(rec)) break;
            }
        }
    } else {
        const seen = new Set();
        const suggestionStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const suggestionBudgetMs = 20;
        const hasQueryNorm = !!queryNorm;

        const pushSuggestion = (key, entry) => {
            if (seen.has(key)) return false;
            seen.add(key);
            suggestions.push(entry);
            return suggestions.length >= SUGGESTION_LIMIT;
        };

        for (const rec of records) {
            if (!appliesCommonFilters(rec, payloadWithSets, parsed, transitionSet, cutoffTs)) continue;

            if (hasQueryNorm && suggestions.length < SUGGESTION_LIMIT) {
                const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
                if ((now - suggestionStart) <= suggestionBudgetMs) {
                    if (rec.nameNorm && (rec.nameNorm.startsWith(queryNorm) || rec.nameNorm.includes(queryNorm))) {
                        pushSuggestion(`name:${rec.nameNorm}`, { type: 'name', value: rec.name });
                    }

                    if (suggestions.length < SUGGESTION_LIMIT) {
                        for (const role of rec.roles) {
                            const roleNorm = normalizeText(role);
                            if (!roleNorm || (!roleNorm.startsWith(queryNorm) && !roleNorm.includes(queryNorm))) continue;
                            if (pushSuggestion(`role:${roleNorm}`, { type: 'role', value: role })) break;
                        }
                    }

                    if (suggestions.length < SUGGESTION_LIMIT) {
                        const orgCandidates = [rec.homeOrg, rec.lastOrg];
                        for (const org of orgCandidates) {
                            const orgNorm = normalizeText(org);
                            if (!orgNorm || (!orgNorm.startsWith(queryNorm) && !orgNorm.includes(queryNorm))) continue;
                            if (pushSuggestion(`org:${orgNorm}`, { type: 'org', value: org })) break;
                        }
                    }
                }
            }

            const score = scoreRecord(rec, parsed);
            if (score === null) continue;
            items.push({
                name: rec.name,
                score,
                totalPay: rec.totalPay,
                firstHiredYear: rec.firstHiredYear,
                lastDate: rec.lastDate
            });
        }
    }

    const sorted = sortResults(items, sortKey);

    resultCache.set(cacheKey, { items, suggestions, regexTooBroad, warning });
    if (resultCache.size > CACHE_LIMIT) {
        const first = resultCache.keys().next();
        if (!first.done) resultCache.delete(first.value);
    }

    return {
        names: sorted.map(item => item.name),
        suggestions,
        regexMode: !!parsed.regex,
        regexTooBroad,
        warning,
        highlightTerms: parsed.highlightTerms,
        queryUsedSort: parsed.sort || null
    };
};

const prepareRecords = (rawRecords) => {
    const out = new Array(rawRecords.length);
    for (let i = 0; i < rawRecords.length; i++) {
        const rec = rawRecords[i];
    const homeOrgNorm = normalizeText(rec.homeOrgNorm || rec.homeOrg || '');
    const lastOrgNorm = normalizeText(rec.lastOrgNorm || rec.lastOrg || '');

        const recRolesNorm = rec.rolesNorm || [];
        const rolesNorm = [];
        for (let j = 0; j < recRolesNorm.length; j++) {
            const norm = normalizeText(recRolesNorm[j]);
            if (norm) rolesNorm.push(norm);
        }
    const roles = rec.roles || [];
    const orgAliases = [];
    const orgAliasSeen = new Set();
    if (rec.orgAliases && rec.orgAliases.length) {
        for (const alias of rec.orgAliases) {
            const norm = normalizeText(alias);
            if (!norm || orgAliasSeen.has(norm)) continue;
            orgAliasSeen.add(norm);
            orgAliases.push(norm);
        }
    } else {
        for (const alias of buildOrgAliases(rec.homeOrg)) {
            if (orgAliasSeen.has(alias)) continue;
            orgAliasSeen.add(alias);
            orgAliases.push(alias);
        }
        for (const alias of buildOrgAliases(rec.lastOrg)) {
            if (orgAliasSeen.has(alias)) continue;
            orgAliasSeen.add(alias);
            orgAliases.push(alias);
        }
    }
    const roleAliases = [];
    const roleAliasSeen = new Set();
    if (rec.roleAliases && rec.roleAliases.length) {
        for (const alias of rec.roleAliases) {
            const norm = normalizeText(alias);
            if (!norm || roleAliasSeen.has(norm)) continue;
            roleAliasSeen.add(norm);
            roleAliases.push(norm);
        }
    } else {
        for (const role of roles) {
            for (const token of tokenize(role)) {
                if (roleAliasSeen.has(token)) continue;
                roleAliasSeen.add(token);
                roleAliases.push(token);
            }
        }
    }
    const exclusionTs = rec.exclusionDate ? new Date(rec.exclusionDate).getTime() : 0;
    const nameNorm = normalizeText(rec.nameNorm || rec.name || '');
    const roleSearch = normalizeText((roles || []).join(' ') + ' ' + roleAliases.join(' '));
    const orgSearch = normalizeText(`${homeOrgNorm} ${lastOrgNorm} ${orgAliases.join(' ')}`);
    const searchText = normalizeText(rec.searchText || `${rec.name || ''} ${rec.homeOrg || ''} ${rec.lastOrg || ''} ${(roles || []).join(' ')}`);

        const orgMatchValues = [];
        if (homeOrgNorm) orgMatchValues.push(homeOrgNorm);
        if (lastOrgNorm) orgMatchValues.push(lastOrgNorm);
        for (let j = 0; j < orgAliases.length; j++) {
            if (orgAliases[j]) orgMatchValues.push(orgAliases[j]);
        }


        const roleMatchValues = [];
        if (roleSearch) roleMatchValues.push(roleSearch);
        for (let j = 0; j < rolesNorm.length; j++) roleMatchValues.push(rolesNorm[j]);
        for (let j = 0; j < roleAliases.length; j++) {
            if (roleAliases[j]) roleMatchValues.push(roleAliases[j]);
        }

        out[i] = {
            name: rec.name,
        nameNorm,
        nameTokens: tokenizeLongUnique(nameNorm),
        homeOrg: rec.homeOrg || '',
        homeOrgNorm,
        lastOrg: rec.lastOrg || '',
        lastOrgNorm,
        roles,
        rolesNorm,
        orgAliases,
        roleAliases,
        roleSearch,
        roleSearchTokens: tokenizeLongUnique(roleSearch),
        orgSearch,
        orgSearchTokens: tokenizeLongUnique(orgSearch),
        orgMatchValues,
        roleMatchValues,
        isUnclass: !!rec.isUnclass,
        isActive: !!rec.isActive,
        isFullTime: !!rec.isFullTime,
        totalPay: Number(rec.totalPay) || 0,
        payMissing: !!rec.payMissing,
        firstHiredYear: Number(rec.firstHiredYear) || 9999,
        lastDate: rec.lastDate || '',
        hasFlags: !!rec.hasFlags,
        wasExcluded: !!rec.wasExcluded,
        exclusionTs: Number.isFinite(exclusionTs) ? exclusionTs : 0,
        regexText: (rec.searchText || `${rec.name || ''} ${rec.homeOrg || ''} ${rec.lastOrg || ''} ${(roles || []).join(' ')}`).toLowerCase(),
        searchText,
            searchTextTokens: tokenizeLongUnique(searchText)
        };
    }
    return out;
};

const initWorker = async (id, payload) => {
    try {
        const response = await fetch(payload.url, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`Failed to load search index: ${response.status}`);
        const data = await response.json();
        records = prepareRecords(data.records || []);
        recordMap = new Map();
        for (let i = 0; i < records.length; i++) {
            recordMap.set(records[i].name, records[i]);
        }
        regexSearchAux = null;
        resultCache.clear();
        isReady = true;
        postMessage({ type: 'ready', id, count: records.length });
    } catch (err) {
        postMessage({ type: 'error', id, message: err && err.message ? err.message : 'Worker init failed' });
    }
};

self.onmessage = (event) => {
    const msg = event.data || {};
    const type = msg.type;
    const id = msg.id;
    const payload = msg.payload || {};

    if (type === 'init') {
        initWorker(id, payload);
        return;
    }

    if (type === 'search') {
        if (!isReady) {
            postMessage({ type: 'result', id, payload: { names: [], suggestions: [], warning: 'Search worker not ready.' } });
            return;
        }
        try {
            const result = parseAndSearch(payload);
            postMessage({ type: 'result', id, payload: result });
        } catch (err) {
            postMessage({ type: 'error', id, message: err && err.message ? err.message : 'Search failed' });
        }
        return;
    }

    if (type === 'ping') {
        postMessage({ type: 'pong', id, ready: !!isReady });
    }
};
