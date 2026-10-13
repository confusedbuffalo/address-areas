/**
 * @file stats_app.js
 * @description Application logic for Statistics & Trends dashboard page.
 */

let statsData = null; // Holds UK stats data structure
let areaDataCache = {}; // Cache for per-area stats fetched on demand
let activeArea = 'uk';
let sliderStartIdx = 0;
let sliderEndIdx = 0;

const charts = {};

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', async () => {
        await loadStatsData();
        initControls();
        await updateDashboard();
    });
}

async function loadStatsData() {
    try {
        const response = await fetch('./data.json');
        if (!response.ok) {
            throw new Error(`Failed to fetch stats data: ${response.statusText}`);
        }
        statsData = await response.json();
        populateAreaSelect();
        initAreaFromUrl();
        initSliderDefaults();
    } catch (err) {
        console.error('Error loading stats data:', err);
    }
}

function initAreaFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const areaParam = params.get('area');
    if (!areaParam) return;

    const select = document.getElementById('area-select');
    if (!select) return;

    const paramLower = areaParam.trim().toLowerCase();
    for (const opt of select.options) {
        if (opt.value.toLowerCase() === paramLower ||
            (opt.value === 'No postcode' && paramLower === 'no-postcode')) {
            activeArea = opt.value;
            select.value = opt.value;
            break;
        }
    }
}

function updateUrlForArea(areaKey) {
    let paramVal = 'uk';
    if (areaKey === 'No postcode') {
        paramVal = 'no-postcode';
    } else if (areaKey) {
        paramVal = areaKey.toLowerCase();
    }
    const url = new URL(window.location.href);
    url.searchParams.set('area', paramVal);
    window.history.replaceState({}, '', url.toString());
}

function getDefaultStartIndex(dates) {
    if (!dates || dates.length === 0) return 0;
    const latestStr = dates[dates.length - 1];
    const latestParts = latestStr.split('-').map(Number);
    if (latestParts.length !== 3) return Math.max(0, dates.length - 52);

    const targetDate = new Date(latestParts[0] - 1, latestParts[1] - 1, latestParts[2]);
    for (let i = 0; i < dates.length; i++) {
        const parts = dates[i].split('-').map(Number);
        if (parts.length === 3) {
            const d = new Date(parts[0], parts[1] - 1, parts[2]);
            if (d >= targetDate) return i;
        }
    }
    return Math.max(0, dates.length - 52);
}

function initSliderDefaults() {
    if (!statsData || !statsData.dates || statsData.dates.length === 0) return;
    const total = statsData.dates.length;
    sliderEndIdx = total - 1;
    sliderStartIdx = getDefaultStartIndex(statsData.dates);
}

function getAreaFilename(areaKey) {
    if (areaKey === 'uk') return 'uk.json';
    if (areaKey === 'No postcode') return 'no-postcode.json';
    if (areaKey.toLowerCase() === 'unknown') return 'unknown.json';
    const clean = areaKey.trim();
    if (clean === clean.toUpperCase() && /^[A-Z0-9]+$/i.test(clean)) {
        return `${clean}.json`;
    }
    return `${clean.toLowerCase().replace(/ /g, '-')}.json`;
}

async function fetchAreaStats(areaKey) {
    if (areaKey === 'uk') return null;
    if (areaDataCache[areaKey]) return areaDataCache[areaKey];

    const filename = getAreaFilename(areaKey);
    try {
        const res = await fetch(`./data/${filename}`);
        if (!res.ok) {
            throw new Error(`Failed to fetch stats for ${areaKey}: ${res.statusText}`);
        }
        const data = await res.json();
        areaDataCache[areaKey] = data;
        return data;
    } catch (err) {
        console.error(`Error loading stats for ${areaKey}:`, err);
        return {};
    }
}

function populateAreaSelect() {
    const select = document.getElementById('area-select');
    if (!select || !statsData) return;

    const areaSet = new Set(statsData.area_keys || []);

    const sortedAreas = Array.from(areaSet).sort((a, b) => {
        if (a === 'No postcode') return -1;
        if (b === 'No postcode') return 1;
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });

    select.innerHTML = '<option value="uk">All UK</option>';

    sortedAreas.forEach(area => {
        const opt = document.createElement('option');
        opt.value = area;
        opt.textContent = area === 'No postcode' ? 'No postcode' : `${area}`;
        select.appendChild(opt);
    });
}

function formatDateStr(dStr) {
    if (!dStr) return '';
    const parts = dStr.split('-').map(Number);
    if (parts.length === 3) {
        const dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
        return dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }
    return dStr;
}

function renderSliderTicks() {
    const ticksContainer = document.getElementById('slider-ticks');
    if (!ticksContainer || !statsData || !statsData.dates || statsData.dates.length < 2) return;

    ticksContainer.innerHTML = '';
    const dates = statsData.dates;
    const total = dates.length;
    const denom = total - 1;

    const startYear = parseInt(dates[0].split('-')[0], 10);
    const endYear = parseInt(dates[denom].split('-')[0], 10);
    const spanYears = endYear - startYear;

    let step = 1;
    if (spanYears > 20) step = 4;
    else if (spanYears > 10) step = 2;

    const yearsToMark = [];
    for (let yr = startYear; yr <= endYear; yr += step) {
        yearsToMark.push(yr);
    }
    if (yearsToMark[yearsToMark.length - 1] !== endYear) {
        yearsToMark.push(endYear);
    }

    yearsToMark.forEach(yr => {
        let idx = dates.findIndex(d => d.startsWith(`${yr}-`));
        if (idx === -1) {
            if (yr === endYear) idx = denom;
            else return;
        }

        const pct = (idx / denom) * 100;

        const tickEl = document.createElement('div');
        tickEl.className = 'absolute top-0 w-0.5 h-1.5 bg-gray-300 -translate-x-1/2';
        tickEl.style.left = `${pct}%`;

        const labelEl = document.createElement('span');
        labelEl.className = 'absolute top-1.5 text-[10px] font-medium text-gray-400 -translate-x-1/2';
        labelEl.style.left = `${pct}%`;
        labelEl.textContent = yr;

        ticksContainer.appendChild(tickEl);
        ticksContainer.appendChild(labelEl);
    });
}

function updateSliderVisuals() {
    const sliderStart = document.getElementById('slider-start');
    const sliderEnd = document.getElementById('slider-end');
    const sliderHighlight = document.getElementById('slider-highlight');
    const rangeDisplay = document.getElementById('date-range-display');

    if (!statsData || !statsData.dates || statsData.dates.length === 0) return;
    const total = statsData.dates.length;
    const denom = total > 1 ? total - 1 : 1;

    const pctLeft = (sliderStartIdx / denom) * 100;
    const pctWidth = ((sliderEndIdx - sliderStartIdx) / denom) * 100;

    if (sliderHighlight) {
        sliderHighlight.style.left = `${pctLeft}%`;
        sliderHighlight.style.width = `${pctWidth}%`;
    }

    if (rangeDisplay) {
        const startLabel = formatDateStr(statsData.dates[sliderStartIdx]);
        const endLabel = formatDateStr(statsData.dates[sliderEndIdx]);
        rangeDisplay.textContent = startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`;
    }

    if (sliderStart) sliderStart.value = sliderStartIdx;
    if (sliderEnd) sliderEnd.value = sliderEndIdx;
}

function initControls() {
    const sliderStart = document.getElementById('slider-start');
    const sliderEnd = document.getElementById('slider-end');

    if (sliderStart && sliderEnd && statsData && statsData.dates) {
        const total = statsData.dates.length;
        const maxIdx = Math.max(0, total - 1);

        sliderStart.min = 0;
        sliderStart.max = maxIdx;
        sliderStart.value = sliderStartIdx;

        sliderEnd.min = 0;
        sliderEnd.max = maxIdx;
        sliderEnd.value = sliderEndIdx;

        const onSliderInput = (e) => {
            let valStart = parseInt(sliderStart.value, 10);
            let valEnd = parseInt(sliderEnd.value, 10);

            if (e.target === sliderStart && valStart > valEnd) {
                sliderStart.value = valEnd;
                valStart = valEnd;
            } else if (e.target === sliderEnd && valEnd < valStart) {
                sliderEnd.value = valStart;
                valEnd = valStart;
            }

            sliderStartIdx = valStart;
            sliderEndIdx = valEnd;

            updateSliderVisuals();
            updateDashboard();
        };

        sliderStart.addEventListener('input', onSliderInput);
        sliderEnd.addEventListener('input', onSliderInput);

        renderSliderTicks();
        updateSliderVisuals();
    }

    const select = document.getElementById('area-select');
    if (select) {
        select.addEventListener('change', async (e) => {
            activeArea = e.target.value;
            updateUrlForArea(activeArea);
            await updateDashboard();
        });
    }
}

async function updateDashboard() {
    if (!statsData || !statsData.dates || statsData.dates.length === 0) return;

    let areaStatsByDate = {};
    if (activeArea === 'uk') {
        statsData.dates.forEach(d => {
            areaStatsByDate[d] = (statsData.snapshots[d] || {}).uk || {};
        });
    } else {
        areaStatsByDate = await fetchAreaStats(activeArea);
    }

    const filteredDates = statsData.dates.slice(sliderStartIdx, sliderEndIdx + 1);

    const totalObjectsData = [];
    const postcodeCountData = [];
    const addressedPercData = [];
    const addressedCountData = [];
    const distinctPostcodesData = [];
    const citiesData = [];
    const suburbsData = [];
    const streetsData = [];

    filteredDates.forEach(date => {
        const areaStats = areaStatsByDate[date] || {
            total_objects: 0,
            postcode_count: 0,
            distinct_postcodes: 0,
            cities: 0,
            suburbs: 0,
            streets: 0,
            addressed_count: 0
        };

        const total = areaStats.total_objects || 0;
        const addressed = areaStats.addressed_count || 0;
        const perc = total > 0 ? Math.round((addressed / total) * 100) : 0;

        totalObjectsData.push(total);
        postcodeCountData.push(areaStats.postcode_count || 0);
        addressedCountData.push(addressed);
        addressedPercData.push(perc);
        distinctPostcodesData.push(areaStats.distinct_postcodes || 0);
        citiesData.push(areaStats.cities || 0);
        suburbsData.push(areaStats.suburbs || 0);
        streetsData.push(areaStats.streets || 0);
    });

    const latestIdx = filteredDates.length - 1;
    if (latestIdx >= 0) {
        const latestTotal = totalObjectsData[latestIdx] || 0;
        const latestPcCount = postcodeCountData[latestIdx] || 0;
        const latestAddressedCount = addressedCountData[latestIdx] || 0;
        const latestAddressedPerc = addressedPercData[latestIdx] || 0;
        const latestDistinctPc = distinctPostcodesData[latestIdx] || 0;
        const latestCities = citiesData[latestIdx] || 0;
        const latestSuburbs = suburbsData[latestIdx] || 0;
        const latestStreets = streetsData[latestIdx] || 0;

        document.getElementById('stat-total-objects').textContent = latestTotal.toLocaleString();
        document.getElementById('stat-postcode-count').textContent = `${latestPcCount.toLocaleString()} with postcode`;

        const statAddressedPerc = document.getElementById('stat-addressed-perc');
        if (statAddressedPerc) statAddressedPerc.textContent = `${latestAddressedPerc}%`;

        const statAddressedCount = document.getElementById('stat-addressed-count');
        if (statAddressedCount) statAddressedCount.textContent = `${latestAddressedCount.toLocaleString()} addressed`;

        document.getElementById('stat-distinct-postcodes').textContent = latestDistinctPc.toLocaleString();
        document.getElementById('stat-cities').textContent = latestCities.toLocaleString();
        document.getElementById('stat-suburbs').textContent = latestSuburbs.toLocaleString();
        document.getElementById('stat-streets').textContent = latestStreets.toLocaleString();
    }

    const labels = filteredDates.map(formatDateStr);

    // Render Chart 1: Objects with Address Tags (Triple line graph for 'uk', double line for individual area)
    const totalObjectsDatasets = [{
        label: 'Total Objects',
        data: totalObjectsData,
        borderColor: '#3b82f6',
        backgroundColor: '#3b82f620',
        borderWidth: 2.5,
        fill: true,
        tension: 0.3,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: '#3b82f6'
    }];

    if (activeArea === 'uk') {
        totalObjectsDatasets.push({
            label: 'With Postcode',
            data: postcodeCountData,
            borderColor: '#10b981',
            backgroundColor: '#10b98120',
            borderWidth: 2.5,
            fill: true,
            tension: 0.3,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBackgroundColor: '#10b981'
        });
    }

    totalObjectsDatasets.push({
        label: 'Addressed',
        data: addressedCountData,
        borderColor: '#8b5cf6',
        backgroundColor: '#8b5cf620',
        borderWidth: 2.5,
        fill: true,
        tension: 0.3,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: '#8b5cf6'
    });

    renderMultiChart('chart-total-objects', labels, totalObjectsDatasets);
    renderChart('chart-addressed-perc', 'Percentage Addressed', labels, addressedPercData, '#10b981', '%');
    renderChart('chart-distinct-postcodes', 'Distinct Postcodes', labels, distinctPostcodesData, '#3b82f6');
    renderChart('chart-cities', 'Distinct Cities', labels, citiesData, '#8b5cf6');
    renderChart('chart-suburbs', 'Distinct Suburbs', labels, suburbsData, '#f59e0b');
    renderChart('chart-streets', 'Distinct Streets', labels, streetsData, '#ec4899');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getDefaultStartIndex,
        formatDateStr,
        getAreaFilename
    };
}

function renderMultiChart(canvasId, labels, datasets) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    if (charts[canvasId]) {
        charts[canvasId].data.labels = labels;
        charts[canvasId].data.datasets = datasets;
        charts[canvasId].options.plugins.legend.display = datasets.length > 1;
        charts[canvasId].update();
        return;
    }

    const ctx = canvas.getContext('2d');
    charts[canvasId] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: datasets.length > 1,
                    position: 'top',
                    labels: { font: { size: 11, family: 'sans-serif' } }
                },
                tooltip: {
                    backgroundColor: '#1e293b',
                    padding: 10,
                    cornerRadius: 8,
                    callbacks: {
                        label: function(context) {
                            let val = context.parsed.y;
                            return ` ${context.dataset.label}: ${val.toLocaleString()}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { size: 11, family: 'sans-serif' } }
                },
                y: {
                    grid: { color: '#f1f5f9' },
                    ticks: {
                        font: { size: 11, family: 'sans-serif' },
                        callback: function(value) {
                            return value.toLocaleString();
                        }
                    }
                }
            }
        }
    });
}

function renderChart(canvasId, title, labels, data, color, unit = '') {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    if (charts[canvasId]) {
        charts[canvasId].data.labels = labels;
        charts[canvasId].data.datasets[0].data = data;
        charts[canvasId].data.datasets[0].label = title;
        charts[canvasId].update();
        return;
    }

    const ctx = canvas.getContext('2d');
    charts[canvasId] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: title,
                data: data,
                borderColor: color,
                backgroundColor: `${color}20`,
                borderWidth: 2.5,
                fill: true,
                tension: 0.3,
                pointRadius: 4,
                pointHoverRadius: 6,
                pointBackgroundColor: color
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#1e293b',
                    padding: 10,
                    cornerRadius: 8,
                    callbacks: {
                        label: function(context) {
                            let val = context.parsed.y;
                            return ` ${title}: ${val.toLocaleString()}${unit}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { size: 11, family: 'sans-serif' } }
                },
                y: {
                    grid: { color: '#f1f5f9' },
                    suggestedMin: unit === '%' ? 0 : undefined,
                    suggestedMax: unit === '%' ? 100 : undefined,
                    ticks: {
                        font: { size: 11, family: 'sans-serif' },
                        callback: function(value) {
                            return `${value.toLocaleString()}${unit}`;
                        }
                    }
                }
            }
        }
    });
}
