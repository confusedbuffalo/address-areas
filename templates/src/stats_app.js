/**
 * @file stats_app.js
 * @description Application logic for Statistics & Trends dashboard page.
 */

let statsData = null;
let activeArea = 'uk';
let activeRange = 'all'; // 'month', 'year', 'all'

const charts = {};

document.addEventListener('DOMContentLoaded', async () => {
    await loadStatsData();
    initControls();
    updateDashboard();
});

async function loadStatsData() {
    try {
        const response = await fetch('./data.json');
        if (!response.ok) {
            throw new Error(`Failed to fetch stats data: ${response.statusText}`);
        }
        statsData = await response.json();
        populateAreaSelect();
    } catch (err) {
        console.error('Error loading stats data:', err);
    }
}

function populateAreaSelect() {
    const select = document.getElementById('area-select');
    if (!select || !statsData) return;

    const areaSet = new Set();
    Object.values(statsData.snapshots || {}).forEach(snapshot => {
        Object.keys(snapshot || {}).forEach(k => {
            if (k !== 'uk') areaSet.add(k);
        });
    });

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

function initControls() {
    const rangeBtns = {
        month: document.getElementById('range-month-btn'),
        year: document.getElementById('range-year-btn'),
        all: document.getElementById('range-all-btn')
    };

    Object.entries(rangeBtns).forEach(([rangeKey, btn]) => {
        if (btn) {
            btn.addEventListener('click', () => {
                activeRange = rangeKey;
                Object.values(rangeBtns).forEach(b => {
                    if (b) {
                        b.classList.remove('bg-blue-600', 'text-white', 'shadow-sm');
                        b.classList.add('text-gray-700', 'hover:bg-gray-200');
                    }
                });
                btn.classList.remove('text-gray-700', 'hover:bg-gray-200');
                btn.classList.add('bg-blue-600', 'text-white', 'shadow-sm');
                updateDashboard();
            });
        }
    });

    const select = document.getElementById('area-select');
    if (select) {
        select.addEventListener('change', (e) => {
            activeArea = e.target.value;
            updateDashboard();
        });
    }
}

function filterDatesByRange(dates) {
    if (!dates || dates.length === 0) return [];
    if (activeRange === 'month') {
        return dates.slice(-4);
    } else if (activeRange === 'year') {
        return dates.slice(-52);
    }
    return dates;
}

function updateDashboard() {
    if (!statsData || !statsData.dates) return;

    const filteredDates = filterDatesByRange(statsData.dates);

    const totalObjectsData = [];
    const postcodeCountData = [];
    const addressedPercData = [];
    const addressedCountData = [];
    const distinctPostcodesData = [];
    const citiesData = [];
    const suburbsData = [];
    const streetsData = [];

    filteredDates.forEach(date => {
        const snapshot = statsData.snapshots[date] || {};
        const areaStats = snapshot[activeArea] || {
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

    const labels = filteredDates.map(d => {
        const parts = d.split('-');
        if (parts.length === 3) {
            const dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
            return dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        }
        return d;
    });

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
