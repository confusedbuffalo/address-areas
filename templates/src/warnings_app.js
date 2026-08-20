/**
 * @file warnings_app.js
 * @description Frontend logic for combined QA Warnings and Duplicates page (/warnings/index.html).
 */

import { updateDataDateElement, compareNames, getOsmUrl } from './utils.js';
import { sendIdsToJosm } from './josm.js';

const CATEGORY_ORDER = [
    'unusual_city',
    'unusual_suburb',
    'unusual_street',
    'unusual_housenumber',
    'unusual_housename',
    'duplicates'
];

const CATEGORY_TITLES = {
    'unusual_city': 'Unusual City',
    'unusual_suburb': 'Unusual Suburb',
    'unusual_street': 'Unusual Street',
    'unusual_housenumber': 'Unusual Housenumber',
    'unusual_housename': 'Unusual Housename',
    'duplicates': 'Duplicates'
};

// Store sort state per table category ID: Map<catId, { column: string, direction: 'asc' | 'desc' }>
const tableSortState = new Map();

function el(tag, attrs = {}, children = []) {
    const elem = document.createElement(tag);
    for (const [key, val] of Object.entries(attrs)) {
        if (key === 'className') {
            elem.className = val;
        } else if (key === 'onclick') {
            elem.onclick = val;
        } else if (key.startsWith('data-')) {
            elem.setAttribute(key, val);
        } else if (key === 'disabled') {
            elem.disabled = Boolean(val);
        } else if (key === 'title') {
            elem.title = val;
        } else {
            elem.setAttribute(key, val);
        }
    }
    const childList = Array.isArray(children) ? children : [children];
    for (const child of childList) {
        if (child === null || child === undefined) continue;
        if (typeof child === 'string' || typeof child === 'number') {
            elem.appendChild(document.createTextNode(String(child)));
        } else if (child instanceof Node) {
            elem.appendChild(child);
        }
    }
    return elem;
}


function createOsmLinks(osmIds) {
    const fragment = document.createDocumentFragment();
    osmIds.forEach((id, idx) => {
        if (idx > 0) {
            fragment.appendChild(document.createTextNode(', '));
        }
        const link = el('a', {
            href: getOsmUrl(id),
            target: '_blank',
            rel: 'noopener noreferrer',
            className: 'text-blue-600 hover:underline font-mono font-semibold'
        }, id);
        fragment.appendChild(link);
    });
    return fragment;
}

function buildRowGroups(catKey, rawItems) {
    if (catKey === 'duplicates') {
        // rawItems schema: [ [title, [osm_ids]], ... ]
        return rawItems.map(item => ({
            value: item[0] || 'Unknown Address',
            reason: '',
            osm_ids: item[1] || []
        }));
    }

    const isGroupedCategory = catKey === 'unusual_city' || catKey === 'unusual_suburb' || catKey === 'unusual_street';
    if (isGroupedCategory) {
        // Group items by unusual value
        const groupedMap = new Map();
        rawItems.forEach(item => {
            // rawItem schema: [value, reason, osm_id]
            const val = item[0];
            if (!groupedMap.has(val)) {
                groupedMap.set(val, {
                    value: val,
                    reason: item[1] || '',
                    osm_ids: []
                });
            }
            groupedMap.get(val).osm_ids.push(item[2]);
        });
        return Array.from(groupedMap.values());
    }

    // Individual rows for housenumber and housename
    return rawItems.map(item => ({
        value: item[0],
        reason: item[1] || '',
        osm_ids: [item[2]]
    }));
}

function sortRowGroups(rowGroups, sortCol, sortDir) {
    const isAsc = sortDir === 'asc';
    const sorted = [...rowGroups];

    sorted.sort((a, b) => {
        let comp = 0;
        if (sortCol === 'value') {
            comp = compareNames(a.value, b.value);
        } else if (sortCol === 'reason') {
            comp = compareNames(a.reason, b.reason);
        } else if (sortCol === 'elements') {
            comp = a.osm_ids.length - b.osm_ids.length;
        }
        if (comp !== 0) {
            return isAsc ? comp : -comp;
        }
        return compareNames(a.value, b.value);
    });

    return sorted;
}

function renderTableRows(catKey, rowGroups, tbody) {
    tbody.innerHTML = '';
    const isDuplicates = catKey === 'duplicates';

    rowGroups.forEach(group => {
        const tr = el('tr', { className: 'hover:bg-gray-50/80 transition-colors' });

        if (isDuplicates) {
            const tdAddress = el('td', { className: 'px-4 py-2.5 font-semibold text-slate-900' }, group.value);
            const tdElements = el('td', { className: 'px-4 py-2.5 text-slate-700' }, [createOsmLinks(group.osm_ids)]);
            const editBtn = el('button', {
                className: 'text-blue-600 hover:text-blue-800 hover:underline font-semibold cursor-pointer',
                onclick: () => sendIdsToJosm(group.osm_ids)
            }, 'Edit');
            const tdEdit = el('td', { className: 'px-4 py-2.5 text-right font-medium' }, [editBtn]);

            tr.appendChild(tdAddress);
            tr.appendChild(tdElements);
            tr.appendChild(tdEdit);
        } else {
            const valSpan = el('span', { className: 'font-mono text-red-600 font-semibold bg-red-50/50 rounded px-1.5 py-0.5 inline-block my-1' }, group.value);
            const tdValue = el('td', { className: 'px-4 py-2.5' }, [valSpan]);
            const tdReason = el('td', { className: 'px-4 py-2.5 text-gray-600 font-medium' }, group.reason);
            const tdElements = el('td', { className: 'px-4 py-2.5 font-medium text-slate-700' }, [createOsmLinks(group.osm_ids)]);

            const editBtn = el('button', {
                className: 'text-blue-600 hover:text-blue-800 hover:underline font-semibold cursor-pointer',
                onclick: () => sendIdsToJosm(group.osm_ids)
            }, 'Edit');
            const tdEdit = el('td', { className: 'px-4 py-2.5 text-right font-medium' }, [editBtn]);

            tr.appendChild(tdValue);
            tr.appendChild(tdReason);
            tr.appendChild(tdElements);
            tr.appendChild(tdEdit);
        }

        tbody.appendChild(tr);
    });
}

function renderCategorySection(paId, catKey, catIdx, rawItems) {
    const catId = `${paId}-cat-${catIdx}`;
    const catTitle = CATEGORY_TITLES[catKey];
    const isDuplicates = catKey === 'duplicates';

    // Calculate total OSM elements
    let totalElements = 0;
    if (isDuplicates) {
        totalElements = rawItems.reduce((sum, item) => sum + (item[1] ? item[1].length : 0), 0);
    } else {
        totalElements = rawItems.length;
    }

    const canEditAll = totalElements <= 400;

    let rowGroups = buildRowGroups(catKey, rawItems);

    // Accordion caret
    const caretSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    caretSvg.setAttribute('id', `caret-${catId}`);
    caretSvg.setAttribute('class', 'h-4 w-4 text-gray-400 group-hover:text-gray-600 transition-transform duration-200 shrink-0');
    caretSvg.setAttribute('fill', 'none');
    caretSvg.setAttribute('viewBox', '0 0 24 24');
    caretSvg.setAttribute('stroke', 'currentColor');
    const caretPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    caretPath.setAttribute('stroke-linecap', 'round');
    caretPath.setAttribute('stroke-linejoin', 'round');
    caretPath.setAttribute('stroke-width', '2');
    caretPath.setAttribute('d', 'M9 5l7 7-7 7');
    caretSvg.appendChild(caretPath);

    const titleSpan = el('span', { className: 'text-sm font-bold text-slate-800' }, catTitle);
    const countSpan = el('span', { className: 'text-xs text-gray-500 font-medium' }, `(${isDuplicates ? rawItems.length : totalElements})`);

    const accordionBtn = el('button', {
        id: `header-${catId}`,
        className: 'flex items-center gap-2 text-left cursor-pointer select-none group grow',
        onclick: () => toggleAccordion(catId)
    }, [caretSvg, titleSpan, countSpan]);

    // Edit all button
    const editAllBtn = el('button', {
        id: `edit-all-${catId}`,
        className: `${canEditAll ? 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer' : 'bg-gray-300 text-gray-500 cursor-not-allowed'} text-xs font-bold px-3 py-1.5 rounded transition shadow-xs`,
        disabled: !canEditAll,
        title: canEditAll ? '' : 'Too many elements',
        onclick: (e) => {
            e.stopPropagation();
            if (!canEditAll) return;
            editAllBtn.innerText = "Loading...";
            editAllBtn.disabled = true;

            const allIds = [];
            if (isDuplicates) {
                rawItems.forEach(item => { if (item[1]) allIds.push(...item[1]); });
            } else {
                rawItems.forEach(item => { if (item[2]) allIds.push(item[2]); });
            }
            const uniqueIds = Array.from(new Set(allIds));

            sendIdsToJosm(uniqueIds).finally(() => {
                editAllBtn.innerText = "Edit all";
                editAllBtn.disabled = false;
            });
        }
    }, 'Edit all');

    const catHeaderDiv = el('div', {
        className: 'px-4 py-3 bg-white flex items-center justify-between border-b border-gray-200'
    }, [accordionBtn, el('div', {}, [editAllBtn])]);

    // Build Table Header with sorting
    const theadTr = el('tr', { className: 'bg-gray-50 text-gray-500 uppercase font-semibold border-b border-gray-200' });
    const tbody = el('tbody', { className: 'divide-y divide-gray-100' });

    // Header definition according to category
    const columnsDef = isDuplicates ? [
        { key: 'value', label: 'Address', class: 'px-4 py-2.5 cursor-pointer hover:text-slate-800 select-none' },
        { key: 'elements', label: 'Duplicate Objects', class: 'px-4 py-2.5 select-none' },
        { key: 'edit', label: 'Edit', class: 'px-4 py-2.5 w-24 text-right select-none' }
    ] : [
        { key: 'value', label: 'Unusual Value', class: 'px-4 py-2.5 cursor-pointer hover:text-slate-800 select-none' },
        { key: 'reason', label: 'Reason', class: 'px-4 py-2.5 cursor-pointer hover:text-slate-800 select-none' },
        { key: 'elements', label: 'Elements', class: 'px-4 py-2.5 select-none' },
        { key: 'edit', label: 'JOSM', class: 'px-4 py-2.5 w-24 text-right select-none' }
    ];

    const updateHeaderArrows = () => {
        theadTr.innerHTML = '';
        const currentSort = tableSortState.get(catId) || { column: 'value', direction: 'asc' };

        columnsDef.forEach(col => {
            if (col.key === 'edit' || col.key === 'elements') {
                theadTr.appendChild(el('th', { className: col.class }, col.label));
                return;
            }

            const arrow = currentSort.column === col.key ? (currentSort.direction === 'asc' ? ' ▲' : ' ▼') : '';
            const th = el('th', {
                className: col.class,
                onclick: () => {
                    let newDir = 'asc';
                    if (currentSort.column === col.key) {
                        newDir = currentSort.direction === 'asc' ? 'desc' : 'asc';
                    }
                    tableSortState.set(catId, { column: col.key, direction: newDir });
                    updateHeaderArrows();
                    const sorted = sortRowGroups(rowGroups, col.key, newDir);
                    renderTableRows(catKey, sorted, tbody);
                }
            }, `${col.label}${arrow}`);

            theadTr.appendChild(th);
        });
    };

    updateHeaderArrows();

    // Initial table render with default sort
    const initialSort = tableSortState.get(catId) || { column: 'value', direction: 'asc' };
    const sortedRowGroups = sortRowGroups(rowGroups, initialSort.column, initialSort.direction);
    renderTableRows(catKey, sortedRowGroups, tbody);

    const table = el('table', { className: 'w-full text-left text-xs border-collapse' }, [
        el('thead', {}, [theadTr]),
        tbody
    ]);

    const contentDiv = el('div', {
        id: `content-${catId}`,
        className: 'hidden overflow-x-auto'
    }, [table]);

    return el('div', {
        className: 'bg-white rounded-lg border border-gray-200 overflow-hidden shadow-xs'
    }, [catHeaderDiv, contentDiv]);
}

function renderWarnings(warningsData) {
    const container = document.getElementById('warnings-container');
    if (!container) return;

    container.innerHTML = '';

    const paKeys = Object.keys(warningsData).sort((a, b) => {
        if (a === 'No postcode') return 1;
        if (b === 'No postcode') return -1;
        return compareNames(a, b);
    });

    if (paKeys.length === 0) {
        container.appendChild(el('div', {
            className: 'bg-white p-8 rounded-xl shadow-sm border border-gray-200 text-center text-gray-500 text-sm'
        }, 'No warnings or duplicates found! All address fields match standard format checks.'));
        return;
    }

    const fragment = document.createDocumentFragment();

    paKeys.forEach((paKey, paIdx) => {
        const paCategories = warningsData[paKey];
        let paTotalCount = 0;

        CATEGORY_ORDER.forEach(cat => {
            if (paCategories[cat]) {
                paTotalCount += paCategories[cat].length;
            }
        });

        if (paTotalCount === 0) return;

        const paId = `pa-${paIdx}`;

        // Postcode Area Caret SVG
        const paCaretSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        paCaretSvg.setAttribute('id', `caret-${paId}`);
        paCaretSvg.setAttribute('class', 'h-5 w-5 text-gray-500 transition-transform duration-200 shrink-0');
        paCaretSvg.setAttribute('fill', 'none');
        paCaretSvg.setAttribute('viewBox', '0 0 24 24');
        paCaretSvg.setAttribute('stroke', 'currentColor');
        const paCaretPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        paCaretPath.setAttribute('stroke-linecap', 'round');
        paCaretPath.setAttribute('stroke-linejoin', 'round');
        paCaretPath.setAttribute('stroke-width', '2');
        paCaretPath.setAttribute('d', 'M9 5l7 7-7 7');
        paCaretSvg.appendChild(paCaretPath);

        const paTitle = el('h3', { className: 'text-base font-bold text-slate-900' }, paKey);
        const paBadge = el('span', {
            className: 'bg-amber-100 text-amber-800 text-xs font-bold px-2.5 py-1 rounded-full border border-amber-200'
        }, `${paTotalCount} ${paTotalCount === 1 ? 'issue' : 'issues'}`);

        const paHeaderBtn = el('button', {
            id: `header-${paId}`,
            className: 'w-full px-5 py-4 bg-gray-50 hover:bg-gray-100 flex items-center justify-between border-b border-gray-200 text-left transition-colors cursor-pointer select-none',
            onclick: () => toggleAccordion(paId)
        }, [
            el('div', { className: 'flex items-center gap-3' }, [paCaretSvg, paTitle]),
            paBadge
        ]);

        const paContentDiv = el('div', {
            id: `content-${paId}`,
            className: 'hidden p-4 space-y-4 bg-gray-50/50'
        });

        CATEGORY_ORDER.forEach((catKey, catIdx) => {
            const rawItems = paCategories[catKey] || [];
            if (rawItems.length === 0) return;
            const catSection = renderCategorySection(paId, catKey, catIdx, rawItems);
            paContentDiv.appendChild(catSection);
        });

        const paCard = el('div', {
            className: 'bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden'
        }, [paHeaderBtn, paContentDiv]);

        fragment.appendChild(paCard);
    });

    container.appendChild(fragment);
}

window.toggleAccordion = function(id) {
    const content = document.getElementById(`content-${id}`);
    const caret = document.getElementById(`caret-${id}`);
    if (content && caret) {
        content.classList.toggle('hidden');
        caret.classList.toggle('rotate-90');
    }
};

document.addEventListener('DOMContentLoaded', () => {
    updateDataDateElement();
    fetch('../data/warnings.json')
        .then(res => {
            if (!res.ok) throw new Error(`HTTP error ${res.status}`);
            return res.json();
        })
        .then(data => renderWarnings(data))
        .catch(err => {
            console.error("Failed to load warnings data:", err);
            const container = document.getElementById('warnings-container');
            if (container) {
                container.innerHTML = '';
                container.appendChild(el('div', {
                    className: 'bg-white p-8 rounded-xl shadow-sm border border-gray-200 text-center text-red-600 text-sm'
                }, 'Failed to load address warnings & duplicates data.'));
            }
        });
});
