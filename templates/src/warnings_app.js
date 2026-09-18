/**
 * @file warnings_app.js
 * @description Frontend logic for combined QA Warnings and Duplicates page (/warnings/index.html).
 */

import { updateDataDateElement, compareNames, getOsmUrl } from './utils.js';
import { sendIdsToJosm } from './josm.js';
import { DATA_TIMESTAMP } from './config.js';

const STORAGE_KEY_PREFIX = 'warnings_clicked_links_';

export let clickedLinks = new Set();

export function getStorageKey() {
    return `${STORAGE_KEY_PREFIX}${DATA_TIMESTAMP}`;
}

export function initClickedStorage() {
    if (typeof localStorage === 'undefined') return;
    try {
        const currentKey = getStorageKey();
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && k.startsWith(STORAGE_KEY_PREFIX) && k !== currentKey) {
                localStorage.removeItem(k);
            }
        }
        const raw = localStorage.getItem(currentKey);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                clickedLinks = new Set(arr);
            } else {
                clickedLinks = new Set();
            }
        } else {
            clickedLinks = new Set();
        }
    } catch (e) {
        console.error('Error initializing clicked links storage:', e);
        clickedLinks = new Set();
    }
}

export function saveClickedLinks() {
    if (typeof localStorage === 'undefined') return;
    try {
        const currentKey = getStorageKey();
        localStorage.setItem(currentKey, JSON.stringify(Array.from(clickedLinks)));
    } catch (e) {
        console.error('Error saving clicked links storage:', e);
    }
}

export function markClicked(...keys) {
    let changed = false;
    for (const key of keys) {
        if (key && !clickedLinks.has(key)) {
            clickedLinks.add(key);
            changed = true;
        }
    }
    if (changed) {
        saveClickedLinks();
    }
}

export function isClicked(key) {
    return clickedLinks.has(key);
}

const CATEGORY_ORDER = [
    'unusual_city',
    'unusual_suburb',
    'unusual_street',
    'unusual_housenumber',
    'unusual_housename',
    'duplicates',
    'duplicate_suburb_value',
    'unusual_address_tag',
    'missing_physical_road',
    'place_with_street'
];

const CATEGORY_TITLES = {
    'unusual_city': 'Unusual City',
    'unusual_suburb': 'Unusual Suburb',
    'unusual_street': 'Unusual Street',
    'unusual_housenumber': 'Unusual Housenumber',
    'unusual_housename': 'Unusual Housename',
    'duplicates': 'Duplicate addresses',
    'duplicate_suburb_value': 'Duplicate suburb value',
    'unusual_address_tag': 'Unusual Address Tag',
    'missing_physical_road': 'Missing Physical Street',
    'place_with_street': 'Place together with street'
};

// Store sort state per table category ID: Map<catId, { column: string, direction: 'asc' | 'desc' }>
const tableSortState = new Map();

// In-memory cache for loaded per-postcode-area warnings data and pending promises
const paCache = new Map();
const paLoadingPromises = new Map();

function el(tag, attrs = {}, children = []) {
    const elem = document.createElement(tag);
    for (const [key, val] of Object.entries(attrs)) {
        if (key === 'className') {
            elem.className = val;
        } else if (key.startsWith('on')) {
            elem[key] = val;
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
        const key = `elem:${id}`;
        const clicked = isClicked(key);
        let link;
        const handleMark = () => {
            markClicked(key);
            if (link) {
                link.className = 'text-gray-400 hover:text-gray-500 hover:underline font-mono font-semibold';
            }
        };
        link = el('a', {
            href: getOsmUrl(id),
            target: '_blank',
            rel: 'noopener noreferrer',
            className: clicked
                ? 'text-gray-400 hover:text-gray-500 hover:underline font-mono font-semibold'
                : 'text-blue-600 hover:underline font-mono font-semibold',
            onclick: handleMark,
            onauxclick: (e) => {
                if (e.button === 1) {
                    handleMark();
                }
            }
        }, id);
        fragment.appendChild(link);
    });
    return fragment;
}

function parseOsmIds(osmIdVal) {
    if (Array.isArray(osmIdVal)) {
        return osmIdVal;
    }
    if (typeof osmIdVal === 'string') {
        return osmIdVal.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (osmIdVal) {
        return [String(osmIdVal)];
    }
    return [];
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

    if (catKey === 'place_with_street') {
        const groupedMap = new Map();
        rawItems.forEach(item => {
            const place = item[0] || '';
            const street = item[1] || '';
            const ids = parseOsmIds(item[2]);
            const key = `${place}|||${street}`;

            if (!groupedMap.has(key)) {
                groupedMap.set(key, {
                    place: place,
                    street: street,
                    value: `${place} / ${street}`,
                    osm_ids: []
                });
            }

            const targetIds = groupedMap.get(key).osm_ids;
            ids.forEach(id => {
                if (!targetIds.includes(id)) {
                    targetIds.push(id);
                }
            });
        });
        return Array.from(groupedMap.values());
    }

    if (catKey === 'duplicate_suburb_value') {
        const groupedMap = new Map();
        rawItems.forEach(item => {
            const val = item[0] || '';
            const reason = item[1] || '';
            const ids = parseOsmIds(item[2]);
            const groupKey = `${val}|||${reason}`;

            if (!groupedMap.has(groupKey)) {
                groupedMap.set(groupKey, {
                    value: val,
                    reason: reason,
                    osm_ids: []
                });
            }

            const targetIds = groupedMap.get(groupKey).osm_ids;
            ids.forEach(id => {
                if (!targetIds.includes(id)) {
                    targetIds.push(id);
                }
            });
        });
        return Array.from(groupedMap.values());
    }

    const isGroupedCategory = catKey === 'unusual_city' || catKey === 'unusual_suburb' || catKey === 'unusual_street' || catKey === 'unusual_address_tag' || catKey === 'missing_physical_road';
    if (isGroupedCategory) {
        // Group items by unusual value
        const groupedMap = new Map();
        rawItems.forEach(item => {
            // rawItem schema: [value, reason, osm_id]
            const val = item[0];
            const reason = item[1] || '';
            const ids = parseOsmIds(item[2]);

            if (!groupedMap.has(val)) {
                groupedMap.set(val, {
                    value: val,
                    reasonsSet: new Set(reason ? [reason] : []),
                    osm_ids: []
                });
            } else if (reason) {
                groupedMap.get(val).reasonsSet.add(reason);
            }

            const targetIds = groupedMap.get(val).osm_ids;
            ids.forEach(id => {
                if (!targetIds.includes(id)) {
                    targetIds.push(id);
                }
            });
        });
        return Array.from(groupedMap.values()).map(g => ({
            value: g.value,
            reason: Array.from(g.reasonsSet).join(', '),
            osm_ids: g.osm_ids
        }));
    }

    // Individual rows for housenumber and housename
    return rawItems.map(item => ({
        value: item[0],
        reason: item[1] || '',
        osm_ids: parseOsmIds(item[2])
    }));
}

function sortRowGroups(rowGroups, sortCol, sortDir, catKey) {
    const isAsc = sortDir === 'asc';
    const sorted = [...rowGroups];

    if (catKey === 'place_with_street') {
        sorted.sort((a, b) => {
            let comp = 0;
            if (sortCol === 'place') {
                comp = compareNames(a.place, b.place);
            } else if (sortCol === 'street') {
                comp = compareNames(a.street, b.street);
            } else if (sortCol === 'elements') {
                comp = a.osm_ids.length - b.osm_ids.length;
            }
            if (comp !== 0) {
                return isAsc ? comp : -comp;
            }
            const placeComp = compareNames(a.place, b.place);
            if (placeComp !== 0) return placeComp;
            return compareNames(a.street, b.street);
        });
        return sorted;
    }

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

function renderTableRows(catKey, rowGroups, tbody, catId) {
    tbody.innerHTML = '';
    const isDuplicates = catKey === 'duplicates';
    const isPlaceWithStreet = catKey === 'place_with_street';

    rowGroups.forEach(group => {
        const tr = el('tr', { className: 'hover:bg-gray-50/80 transition-colors' });
        const rowEditKey = isPlaceWithStreet
            ? `edit:row:${catId}:${group.place}:${group.street}`
            : (group.reason ? `edit:row:${catId}:${group.value}:${group.reason}` : `edit:row:${catId}:${group.value}`);
        const isRowClicked = isClicked(rowEditKey);

        if (isDuplicates) {
            const tdAddress = el('td', { className: 'px-4 py-2.5 font-semibold text-slate-900' }, group.value);
            const tdElements = el('td', { className: 'px-4 py-2.5 text-slate-700' }, [createOsmLinks(group.osm_ids)]);
            let editBtn;
            const handleRowEdit = () => {
                const elemKeys = group.osm_ids.map(id => `elem:${id}`);
                markClicked(rowEditKey, ...elemKeys);
                if (editBtn) {
                    editBtn.className = 'text-gray-400 hover:text-gray-500 hover:underline font-semibold cursor-pointer';
                }
                const elemLinks = tdElements.querySelectorAll('a');
                elemLinks.forEach(a => {
                    a.className = 'text-gray-400 hover:text-gray-500 hover:underline font-mono font-semibold';
                });
                sendIdsToJosm(group.osm_ids);
            };
            editBtn = el('button', {
                className: isRowClicked
                    ? 'text-gray-400 hover:text-gray-500 hover:underline font-semibold cursor-pointer'
                    : 'text-blue-600 hover:text-blue-800 hover:underline font-semibold cursor-pointer',
                onclick: handleRowEdit,
                onauxclick: (e) => {
                    if (e.button === 1) {
                        handleRowEdit();
                    }
                }
            }, 'Edit');
            const tdEdit = el('td', { className: 'px-4 py-2.5 text-right font-medium' }, [editBtn]);

            tr.appendChild(tdAddress);
            tr.appendChild(tdElements);
            tr.appendChild(tdEdit);
        } else if (isPlaceWithStreet) {
            const tdPlace = el('td', { className: 'px-4 py-2.5 font-semibold text-slate-900' }, group.place);
            const tdStreet = el('td', { className: 'px-4 py-2.5 text-slate-900 font-medium' }, group.street);
            const tdElements = el('td', { className: 'px-4 py-2.5 font-medium text-slate-700' }, [createOsmLinks(group.osm_ids)]);

            let editBtn;
            const handleRowEdit = () => {
                const elemKeys = group.osm_ids.map(id => `elem:${id}`);
                markClicked(rowEditKey, ...elemKeys);
                if (editBtn) {
                    editBtn.className = 'text-gray-400 hover:text-gray-500 hover:underline font-semibold cursor-pointer';
                }
                const elemLinks = tdElements.querySelectorAll('a');
                elemLinks.forEach(a => {
                    a.className = 'text-gray-400 hover:text-gray-500 hover:underline font-mono font-semibold';
                });
                sendIdsToJosm(group.osm_ids);
            };
            editBtn = el('button', {
                className: isRowClicked
                    ? 'text-gray-400 hover:text-gray-500 hover:underline font-semibold cursor-pointer'
                    : 'text-blue-600 hover:text-blue-800 hover:underline font-semibold cursor-pointer',
                onclick: handleRowEdit,
                onauxclick: (e) => {
                    if (e.button === 1) {
                        handleRowEdit();
                    }
                }
            }, 'Edit');
            const tdEdit = el('td', { className: 'px-4 py-2.5 text-right font-medium' }, [editBtn]);

            tr.appendChild(tdPlace);
            tr.appendChild(tdStreet);
            tr.appendChild(tdElements);
            tr.appendChild(tdEdit);
        } else {
            const valSpan = el('span', { className: 'font-mono text-red-600 font-semibold bg-red-50/50 rounded px-1.5 py-0.5 inline-block my-1' }, group.value);
            const tdValue = el('td', { className: 'px-4 py-2.5' }, [valSpan]);
            const tdReason = el('td', { className: 'px-4 py-2.5 text-gray-600 font-medium' }, group.reason);
            const tdElements = el('td', { className: 'px-4 py-2.5 font-medium text-slate-700' }, [createOsmLinks(group.osm_ids)]);

            let editBtn;
            const handleRowEdit = () => {
                const elemKeys = group.osm_ids.map(id => `elem:${id}`);
                markClicked(rowEditKey, ...elemKeys);
                if (editBtn) {
                    editBtn.className = 'text-gray-400 hover:text-gray-500 hover:underline font-semibold cursor-pointer';
                }
                const elemLinks = tdElements.querySelectorAll('a');
                elemLinks.forEach(a => {
                    a.className = 'text-gray-400 hover:text-gray-500 hover:underline font-mono font-semibold';
                });
                sendIdsToJosm(group.osm_ids);
            };
            editBtn = el('button', {
                className: isRowClicked
                    ? 'text-gray-400 hover:text-gray-500 hover:underline font-semibold cursor-pointer'
                    : 'text-blue-600 hover:text-blue-800 hover:underline font-semibold cursor-pointer',
                onclick: handleRowEdit,
                onauxclick: (e) => {
                    if (e.button === 1) {
                        handleRowEdit();
                    }
                }
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

function fetchPaData(paKey, cleanId) {
    if (paCache.has(paKey)) {
        return Promise.resolve(paCache.get(paKey));
    }
    if (paLoadingPromises.has(paKey)) {
        return paLoadingPromises.get(paKey);
    }
    const promise = fetch(`../data/warnings_${cleanId}.json`)
        .then(res => {
            if (!res.ok) throw new Error(`HTTP error ${res.status}`);
            return res.json();
        })
        .then(data => {
            paCache.set(paKey, data);
            paLoadingPromises.delete(paKey);
            return data;
        })
        .catch(err => {
            paLoadingPromises.delete(paKey);
            throw err;
        });
    paLoadingPromises.set(paKey, promise);
    return promise;
}

function populateCategoryTable(catId, catKey, rawItems) {
    const contentDiv = document.getElementById(`content-${catId}`);
    if (!contentDiv) return;

    const isDuplicates = catKey === 'duplicates';
    const isPlaceWithStreet = catKey === 'place_with_street';
    const isDuplicateSuburbValue = catKey === 'duplicate_suburb_value';
    const rowGroups = buildRowGroups(catKey, rawItems);
    const totalElements = rowGroups.reduce((sum, group) => sum + group.osm_ids.length, 0);
    const canEditAll = totalElements <= 400;

    // Update edit-all button state
    const editAllBtn = document.getElementById(`edit-all-${catId}`);
    if (editAllBtn) {
        const editAllKey = `edit:all:${catId}`;
        const isEditAllClicked = isClicked(editAllKey);
        let editAllClass = 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer';
        if (!canEditAll) {
            editAllClass = 'bg-gray-300 text-gray-500 cursor-not-allowed';
        } else if (isEditAllClicked) {
            editAllClass = 'bg-gray-400 hover:bg-gray-500 text-white cursor-pointer';
        }
        editAllBtn.className = `${editAllClass} text-xs font-bold px-3 py-1.5 rounded transition shadow-xs`;
        editAllBtn.disabled = !canEditAll;
        editAllBtn.title = canEditAll ? '' : 'Too many elements';

        const handleEditAll = (e) => {
            e.stopPropagation();
            if (!canEditAll) return;
            editAllBtn.innerText = "Loading...";
            editAllBtn.disabled = true;

            const allIds = [];
            rowGroups.forEach(group => {
                allIds.push(...group.osm_ids);
            });
            const uniqueIds = Array.from(new Set(allIds));

            const rowEditKeys = rowGroups.map(g => g.reason ? `edit:row:${catId}:${g.value}:${g.reason}` : `edit:row:${catId}:${g.value}`);
            const elemKeys = uniqueIds.map(id => `elem:${id}`);
            markClicked(editAllKey, ...rowEditKeys, ...elemKeys);

            editAllBtn.className = 'bg-gray-400 hover:bg-gray-500 text-white cursor-pointer text-xs font-bold px-3 py-1.5 rounded transition shadow-xs';
            const rowBtns = contentDiv.querySelectorAll('tbody button');
            rowBtns.forEach(btn => {
                btn.className = 'text-gray-400 hover:text-gray-500 hover:underline font-semibold cursor-pointer';
            });
            const elemLinks = contentDiv.querySelectorAll('tbody a');
            elemLinks.forEach(a => {
                a.className = 'text-gray-400 hover:text-gray-500 hover:underline font-mono font-semibold';
            });

            sendIdsToJosm(uniqueIds).finally(() => {
                editAllBtn.innerText = "Edit all";
                editAllBtn.disabled = false;
            });
        };

        editAllBtn.onclick = handleEditAll;
        editAllBtn.onauxclick = (e) => {
            if (e.button === 1) {
                handleEditAll(e);
            }
        };
    }

    // Build Table Header with sorting
    const theadTr = el('tr', { className: 'bg-gray-50 text-gray-500 uppercase font-semibold border-b border-gray-200' });
    const tbody = el('tbody', { className: 'divide-y divide-gray-100' });

    const columnsDef = isDuplicates ? [
        { key: 'value', label: 'Address', class: 'px-4 py-2.5 cursor-pointer hover:text-slate-800 select-none' },
        { key: 'elements', label: 'Duplicate Objects', class: 'px-4 py-2.5 select-none' },
        { key: 'edit', label: 'Edit', class: 'px-4 py-2.5 w-24 text-right select-none' }
    ] : (isPlaceWithStreet ? [
        { key: 'place', label: 'Place', class: 'px-4 py-2.5 cursor-pointer hover:text-slate-800 select-none' },
        { key: 'street', label: 'Street', class: 'px-4 py-2.5 cursor-pointer hover:text-slate-800 select-none' },
        { key: 'elements', label: 'Elements', class: 'px-4 py-2.5 select-none' },
        { key: 'edit', label: 'JOSM', class: 'px-4 py-2.5 w-24 text-right select-none' }
    ] : [
        { key: 'value', label: isDuplicateSuburbValue ? 'Suburb Value' : 'Unusual Value', class: 'px-4 py-2.5 cursor-pointer hover:text-slate-800 select-none' },
        { key: 'reason', label: 'Reason', class: 'px-4 py-2.5 cursor-pointer hover:text-slate-800 select-none' },
        { key: 'elements', label: 'Elements', class: 'px-4 py-2.5 select-none' },
        { key: 'edit', label: 'JOSM', class: 'px-4 py-2.5 w-24 text-right select-none' }
    ]);

    const defaultSortCol = isPlaceWithStreet ? 'place' : 'value';

    const updateHeaderArrows = () => {
        theadTr.innerHTML = '';
        const currentSort = tableSortState.get(catId) || { column: defaultSortCol, direction: 'asc' };

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
                    const sorted = sortRowGroups(rowGroups, col.key, newDir, catKey);
                    renderTableRows(catKey, sorted, tbody, catId);
                }
            }, `${col.label}${arrow}`);

            theadTr.appendChild(th);
        });
    };

    updateHeaderArrows();

    const initialSort = tableSortState.get(catId) || { column: defaultSortCol, direction: 'asc' };
    const sortedRowGroups = sortRowGroups(rowGroups, initialSort.column, initialSort.direction, catKey);
    renderTableRows(catKey, sortedRowGroups, tbody, catId);

    const table = el('table', { className: 'w-full text-left text-xs border-collapse' }, [
        el('thead', {}, [theadTr]),
        tbody
    ]);

    contentDiv.innerHTML = '';
    contentDiv.appendChild(table);
}

function renderCategorySection(paId, paKey, cleanId, catKey, catIdx, catCount) {
    const catId = `${paId}-cat-${catIdx}`;
    const catTitle = CATEGORY_TITLES[catKey];

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
    const countSpan = el('span', { className: 'text-xs text-gray-500 font-medium' }, `(${catCount})`);

    const accordionBtn = el('button', {
        id: `header-${catId}`,
        className: 'flex items-center gap-2 text-left cursor-pointer select-none group grow',
        onclick: () => {
            toggleAccordion(catId);
            ensurePaDataLoaded(paId, paKey, cleanId);
        }
    }, [caretSvg, titleSpan, countSpan]);

    const editAllBtn = el('button', {
        id: `edit-all-${catId}`,
        className: 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer text-xs font-bold px-3 py-1.5 rounded transition shadow-xs',
        disabled: false,
        onclick: (e) => {
            e.stopPropagation();
            ensurePaDataLoaded(paId, paKey, cleanId);
        },
        onauxclick: (e) => {
            if (e.button === 1) {
                e.stopPropagation();
                ensurePaDataLoaded(paId, paKey, cleanId);
            }
        }
    }, 'Edit all');

    const catHeaderDiv = el('div', {
        className: 'px-4 py-3 bg-white flex items-center justify-between border-b border-gray-200'
    }, [accordionBtn, el('div', {}, [editAllBtn])]);

    const contentDiv = el('div', {
        id: `content-${catId}`,
        className: 'hidden overflow-x-auto p-4 text-center text-gray-500 text-xs font-medium'
    }, 'Loading warnings data...');

    return el('div', {
        className: 'bg-white rounded-lg border border-gray-200 overflow-hidden shadow-xs'
    }, [catHeaderDiv, contentDiv]);
}

function populatePaCategories(paId, paKey, paData) {
    CATEGORY_ORDER.forEach((catKey, catIdx) => {
        const catId = `${paId}-cat-${catIdx}`;
        const rawItems = paData[catKey] || [];
        const contentDiv = document.getElementById(`content-${catId}`);
        if (contentDiv) {
            populateCategoryTable(catId, catKey, rawItems);
        }
    });
}

function ensurePaDataLoaded(paId, paKey, cleanId) {
    if (paCache.has(paKey)) {
        return Promise.resolve(paCache.get(paKey));
    }
    return fetchPaData(paKey, cleanId)
        .then(paData => {
            populatePaCategories(paId, paKey, paData);
            return paData;
        })
        .catch(err => {
            console.error(`Failed to load warnings data for ${paKey}:`, err);
            CATEGORY_ORDER.forEach((catKey, catIdx) => {
                const catId = `${paId}-cat-${catIdx}`;
                const contentDiv = document.getElementById(`content-${catId}`);
                if (contentDiv) {
                    contentDiv.innerHTML = '<div class="p-4 text-center text-red-600 text-xs font-medium">Failed to load warnings data.</div>';
                }
            });
        });
}

function renderWarningsSummary(summaryData) {
    const container = document.getElementById('warnings-container');
    if (!container) return;

    container.innerHTML = '';

    const paKeys = Object.keys(summaryData).sort((a, b) => {
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
        const summaryInfo = summaryData[paKey];
        const cleanId = summaryInfo.clean_id;
        const totalCount = summaryInfo.total;
        const counts = summaryInfo.counts || {};

        if (totalCount === 0) return;

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
        }, `${totalCount} ${totalCount === 1 ? 'issue' : 'issues'}`);

        const paHeaderBtn = el('button', {
            id: `header-${paId}`,
            className: 'w-full px-5 py-4 bg-gray-50 hover:bg-gray-100 flex items-center justify-between border-b border-gray-200 text-left transition-colors cursor-pointer select-none',
            onclick: () => {
                toggleAccordion(paId);
                ensurePaDataLoaded(paId, paKey, cleanId);
            }
        }, [
            el('div', { className: 'flex items-center gap-3' }, [paCaretSvg, paTitle]),
            paBadge
        ]);

        const paContentDiv = el('div', {
            id: `content-${paId}`,
            className: 'hidden p-4 space-y-4 bg-gray-50/50'
        });

        CATEGORY_ORDER.forEach((catKey, catIdx) => {
            const catCount = counts[catKey] || 0;
            if (catCount === 0) return;
            const catSection = renderCategorySection(paId, paKey, cleanId, catKey, catIdx, catCount);
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
    initClickedStorage();

    if (window.WARNINGS_SUMMARY) {
        renderWarningsSummary(window.WARNINGS_SUMMARY);
    } else {
        fetch('../data/warnings_summary.json')
            .then(res => {
                if (!res.ok) throw new Error(`HTTP error ${res.status}`);
                return res.json();
            })
            .then(data => renderWarningsSummary(data))
            .catch(err => {
                console.error("Failed to load warnings summary data:", err);
                const container = document.getElementById('warnings-container');
                if (container) {
                    container.innerHTML = '';
                    container.appendChild(el('div', {
                        className: 'bg-white p-8 rounded-xl shadow-sm border border-gray-200 text-center text-red-600 text-sm'
                    }, 'Failed to load address warnings & duplicates data.'));
                }
            });
    }
});
