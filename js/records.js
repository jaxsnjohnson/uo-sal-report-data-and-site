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

document.addEventListener('DOMContentLoaded', () => {
    const listContainer = document.getElementById('records-list');
    const searchInput = document.getElementById('record-search');
    const clearBtn = document.getElementById('clear-search');
    const filterChips = document.querySelectorAll('.chip');

    let allRecords = [];
    let currentFilter = 'all';

    // 1. Fetch Data
    fetch('records.json?v=20260921-uo-copy1')
        .then(response => {
            if (!response.ok) throw new Error("Failed to load records");
            return response.json();
        })
        .then(records => {
            allRecords = records;

            // Pre-calculate search fields to avoid repetitive string operations in hot loop
            for (let i = 0; i < allRecords.length; i++) {
                const rec = allRecords[i];
                rec._lowTitle = rec.title ? rec.title.toLowerCase() : '';
                rec._lowType = rec.type ? rec.type.toLowerCase() : '';
                rec._yearStr = rec.year ? rec.year.toString() : '';
            }

            // Sort by date descending (newest first)
            allRecords.sort((a, b) => new Date(b.date) - new Date(a.date));
            renderRecords();
        })
        .catch(err => {
            console.error(err);
            listContainer.innerHTML = `<div class="error">Error loading records: ${escapeHtml(err.message)}</div>`;
        });

    // 2. Event Listeners
    searchInput.addEventListener('input', (e) => {
        toggleClearBtn(e.target.value);
        renderRecords();
    });

    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        toggleClearBtn('');
        renderRecords();
        searchInput.focus();
    });

    filterChips.forEach(chip => {
        chip.addEventListener('click', () => {
            filterChips.forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            currentFilter = chip.getAttribute('data-filter');
            renderRecords();
        });
    });

    function toggleClearBtn(val) {
        if (val.length > 0) clearBtn.classList.remove('hidden');
        else clearBtn.classList.add('hidden');
    }

    // 3. Render Logic
    function renderRecords() {
        listContainer.innerHTML = '';
        const searchTerm = searchInput.value.toLowerCase();

        // Filter first
        const filtered = allRecords.filter(record => {
            // Short-circuit: evaluate type first
            if (currentFilter !== 'all' && record.type !== currentFilter) return false;

            // Fast-path: if no search term, return true immediately
            if (!searchTerm) return true;

            return record._lowTitle.includes(searchTerm) ||
                   record._yearStr.includes(searchTerm) ||
                   record._lowType.includes(searchTerm);
        });

        if (filtered.length === 0) {
            listContainer.innerHTML = `<div class="loader-sentinel">No matching records found.</div>`;
            return;
        }

        // Group by Year
        const recordsByYear = {};
        for (let i = 0; i < filtered.length; i++) {
            const record = filtered[i];
            if (!recordsByYear[record.year]) {
                recordsByYear[record.year] = [];
            }
            recordsByYear[record.year].push(record);
        }

        // Get Years sorted descending
        const sortedYears = Object.keys(recordsByYear).sort((a, b) => b - a);

        const fragment = document.createDocumentFragment();

        for (let i = 0; i < sortedYears.length; i++) {
            const year = sortedYears[i];
            // Create Header
            const yearHeader = document.createElement('h2');
            yearHeader.className = 'year-separator';
            yearHeader.textContent = year;
            fragment.appendChild(yearHeader);

            // Create Grid for this specific year
            const grid = document.createElement('div');
            grid.className = 'records-grid';

            const records = recordsByYear[year];
            for (let j = 0; j < records.length; j++) {
                grid.appendChild(createRecordCard(records[j]));
            }

            fragment.appendChild(grid);
        }

        listContainer.appendChild(fragment);
    }

    function createRecordCard(record) {
        const card = document.createElement('article');
        card.className = 'record-card';

        const typeClass = record.type.toLowerCase() === 'classified' ? 'type-classified' : 'type-unclassified';
        const title = record.title || record.filename;
        const isHtml = record.format === 'HTML';
        const actionLabel = isHtml ? 'Open saved report' : 'Download PDF';
        const importStatus = record.explorerImported
            ? 'Included in explorer search; uncertain pay and identity matches are flagged.'
            : 'Not yet included in explorer calculations.';
        const captureDetails = record.dateBasis === 'capture'
            ? `<p>Captured source: ${escapeHtml(record.rowCount)} rows across ${escapeHtml(record.pageCount)} pages. ${importStatus}</p>`
            : '';
        const dataLink = record.dataFilename
            ? `<a href="reports/${escapeHtmlAttr(record.dataFilename)}" class="download-btn" download>Download JSON ⬇</a>`
            : '';

        card.innerHTML = `
            <div class="meta-row">
                <span>${record.dateBasis === 'capture' ? 'Captured ' : ''}${escapeHtml(record.date)}</span>
                <span>${escapeHtml(record.quarter)}</span>
            </div>
            <h3 class="record-title">${escapeHtml(title)}</h3>
            <div class="record-meta">
                <span class="tag ${escapeHtmlAttr(typeClass)}">${escapeHtml(record.type)}</span>
                <span class="tag">Auth: ${escapeHtml(record.author)}</span>
                <span class="tag">Source: ${escapeHtml(record.source || 'Unknown')}</span>
            </div>
            ${captureDetails}
            <a href="reports/${escapeHtmlAttr(record.filename)}"
               target="_blank"
               rel="noopener noreferrer"
               class="download-btn"
               aria-label="${actionLabel}: ${escapeHtmlAttr(title)}">
                ${actionLabel} ${isHtml ? '↗' : '⬇'}
            </a>
            ${dataLink}
        `;
        return card;
    }
});
