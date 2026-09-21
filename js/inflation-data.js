(() => {
    const SERIES_ID = 'CUUR0400SA0';
    const LOCAL_DATA_URL = 'inflation.json';

    window.INFLATION_SOURCE_URL = 'https://data.bls.gov/timeseries/CUUR0400SA0?output_view=data';
    window.INFLATION_SERIES_ID = SERIES_ID;
    window.INFLATION_INDEX_BY_MONTH = window.INFLATION_INDEX_BY_MONTH || {};
    window.INFLATION_BASE_MONTH = window.INFLATION_BASE_MONTH || '';

    window.loadInflationData = function loadInflationData() {
        if (window.__inflationLoadPromise) return window.__inflationLoadPromise;

        window.__inflationLoadPromise = fetch(LOCAL_DATA_URL)
            .then(res => {
                if (!res.ok) throw new Error(`Failed to fetch CPI data: ${res.status}`);
                return res.json();
            })
            .then(payload => {
                const map = payload.values || {};
                window.INFLATION_INDEX_BY_MONTH = map;
                window.INFLATION_BASE_MONTH = payload.base_month || '';
                window.INFLATION_SERIES_ID = payload.series_id || SERIES_ID;
                return map;
            })
            .catch(err => {
                console.warn('[Inflation] Failed to load CPI data.', err);
                return window.INFLATION_INDEX_BY_MONTH || {};
            });

        return window.__inflationLoadPromise;
    };
})();
