/**
 * @file sidebar.js
 * @description Sidebar logic, sorting, interactive search and virtualised scrolling list implementation.
 */

import { state } from './config.js';
import { getDisplayName, isMissingValue, compareNames, getFeaturesArray } from './utils.js';
import { map, updateEnvelopeCard } from './map.js';
import { loadLayer } from './layers.js';

/**
 * Adjusts sidebar CSS positioning and size based on viewport width and state.sidebarVisible.
 */
export function updateSidebarLayout() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const isMobile = window.innerWidth < 768;
    if (state.sidebarVisible) {
        if (isMobile) {
            sidebar.style.position = 'fixed';
            sidebar.style.left = '0';
            sidebar.style.top = '4rem';
            sidebar.style.right = '0';
            sidebar.style.bottom = '0';
            sidebar.style.width = '100%';
            sidebar.style.height = 'auto';
            sidebar.style.zIndex = '40';
            sidebar.classList.remove('hidden');
        } else {
            sidebar.style.position = 'relative';
            sidebar.style.left = '';
            sidebar.style.top = '';
            sidebar.style.right = '';
            sidebar.style.bottom = '';
            sidebar.style.width = '350px';
            sidebar.style.height = '';
            sidebar.style.zIndex = '';
            sidebar.classList.remove('hidden');
        }
    } else {
        sidebar.classList.add('hidden');
    }
    setTimeout(() => { map.resize(); }, 350);
}

/**
 * Displays or hides the search input clear button depending on current input value length.
 */
export function updateClearButtonVisibility() {
    const searchInput = document.getElementById('search-input');
    const searchClearBtn = document.getElementById('search-clear-btn');
    if (!searchInput || !searchClearBtn) return;
    if (searchInput.value.length > 0) {
        searchClearBtn.classList.remove('hidden');
    } else {
        searchClearBtn.classList.add('hidden');
    }
}

/**
 * Toggles accordion expanded/collapsed UI layout among sub-levels, search, and settings sections.
 *
 * @param {string|boolean} activeSection - 'sublevels', 'search', or 'settings' (or boolean for search).
 */
export function setSidebarSectionState(activeSection) {
    if (typeof activeSection === 'boolean') {
        activeSection = activeSection ? 'search' : 'sublevels';
    }
    state.activeSection = activeSection;
    state.searchActive = activeSection === 'search';

    const sublevelsHeader = document.getElementById('sublevels-header');
    const sublevelsSection = document.getElementById('sublevels-section');
    const sublevelsContent = document.getElementById('sublevels-content');
    const sublevelsCaret = document.getElementById('sublevels-caret');

    const searchHeader = document.getElementById('search-header');
    const searchSection = document.getElementById('search-section');
    const searchContent = document.getElementById('search-content');
    const searchCaret = document.getElementById('search-caret');
    const searchInput = document.getElementById('search-input');

    const settingsHeader = document.getElementById('settings-header');
    const settingsSection = document.getElementById('settings-section');
    const settingsContent = document.getElementById('settings-content');
    const settingsCaret = document.getElementById('settings-caret');

    if (!sublevelsSection || !searchSection || !settingsSection) return;

    if (activeSection === 'sublevels') {
        sublevelsSection.classList.add('grow');
        sublevelsSection.classList.remove('shrink-0');
        if (sublevelsContent) sublevelsContent.classList.remove('hidden');
        if (sublevelsCaret) sublevelsCaret.classList.add('rotate-90');
        if (sublevelsHeader) sublevelsHeader.classList.remove('hover:bg-gray-200', 'cursor-pointer');
    } else {
        sublevelsSection.classList.remove('grow');
        sublevelsSection.classList.add('shrink-0');
        if (sublevelsContent) sublevelsContent.classList.add('hidden');
        if (sublevelsCaret) sublevelsCaret.classList.remove('rotate-90');
        if (sublevelsHeader) sublevelsHeader.classList.add('hover:bg-gray-200', 'cursor-pointer');
    }

    if (activeSection === 'search') {
        searchSection.classList.add('grow', 'min-h-0');
        searchSection.classList.remove('shrink-0');
        if (searchContent) searchContent.classList.remove('hidden');
        if (searchCaret) searchCaret.classList.add('rotate-90');
        if (searchHeader) searchHeader.classList.remove('hover:bg-gray-200', 'cursor-pointer');

        if (searchInput) {
            searchInput.focus();
            searchInput.select();
            updateClearButtonVisibility();
        }
        executeSearch();
    } else {
        searchSection.classList.remove('grow', 'min-h-0');
        searchSection.classList.add('shrink-0');
        if (searchContent) searchContent.classList.add('hidden');
        if (searchCaret) searchCaret.classList.remove('rotate-90');
        if (searchHeader) searchHeader.classList.add('hover:bg-gray-200', 'cursor-pointer');

        if (searchInput) {
            searchInput.blur();
        }
    }

    if (activeSection === 'settings') {
        settingsSection.classList.add('grow');
        settingsSection.classList.remove('shrink-0');
        if (settingsContent) settingsContent.classList.remove('hidden');
        if (settingsCaret) settingsCaret.classList.add('rotate-90');
        if (settingsHeader) settingsHeader.classList.remove('hover:bg-gray-200', 'cursor-pointer');
    } else {
        settingsSection.classList.remove('grow');
        settingsSection.classList.add('shrink-0');
        if (settingsContent) settingsContent.classList.add('hidden');
        if (settingsCaret) settingsCaret.classList.remove('rotate-90');
        if (settingsHeader) settingsHeader.classList.add('hover:bg-gray-200', 'cursor-pointer');
    }
}

/**
 * Enables or disables the 'Search only in current area' checkbox depending on current hierarchy level.
 */
export function updateSearchAreaCheckboxState() {
    const checkbox = document.getElementById('search-area-only-checkbox');
    const label = document.getElementById('search-area-only-label');
    if (!checkbox) return;

    const isPointsLevel = state.currentLevel && state.currentLevel.split('_').length === 4;

    if (state.currentLevel === 'root' || isPointsLevel) {
        checkbox.disabled = true;
        if (isPointsLevel) {
            checkbox.checked = false;
            state.searchOnlyCurrentArea = false;
        }
        if (label) label.classList.add('opacity-50', 'cursor-not-allowed');
    } else {
        checkbox.disabled = false;
        if (label) label.classList.remove('opacity-50', 'cursor-not-allowed');
    }
}

/**
 * Fetches and caches the root search index containing postcode areas and cities.
 *
 * @returns {Promise<Array<Object>>} The parsed root search index list.
 */
export async function fetchRootSearchIndex() {
    if (state.rootSearchIndex) return state.rootSearchIndex;
    try {
        const res = await fetch('data/search_index_root.json');
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const rawData = await res.json();
        state.rootSearchIndex = rawData.map(item => parseSearchItem(item));
        return state.rootSearchIndex;
    } catch (err) {
        console.error("Failed to load root search index:", err);
        return [];
    }
}

/**
 * Fetches and caches the search index for a specific postcode area (suburbs and streets).
 *
 * @param {string} postcodeAreaId - Postcode area identifier (e.g. 'dh1').
 * @returns {Promise<Array<Object>>} The parsed postcode search index list.
 */
export async function fetchPostcodeSearchIndex(postcodeAreaId) {
    if (!postcodeAreaId || postcodeAreaId === 'root') return [];
    if (state.loadedPostcodeSearchIndices[postcodeAreaId]) {
        return state.loadedPostcodeSearchIndices[postcodeAreaId];
    }
    try {
        const res = await fetch(`data/search_index_${postcodeAreaId}.json`);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const rawData = await res.json();
        let prefix = [];
        let items = [];
        if (Array.isArray(rawData)) {
            items = rawData;
        } else if (rawData && typeof rawData === 'object') {
            prefix = rawData.prefix || [];
            items = rawData.items || [];
        }
        const parsed = items.map(item => parseSearchItem(item, prefix));
        state.loadedPostcodeSearchIndices[postcodeAreaId] = parsed;
        return parsed;
    } catch (err) {
        console.warn(`Postcode search index not found for ${postcodeAreaId}:`, err);
        return [];
    }
}

/**
 * Normalises array tuple format `[id, count, trail, bbox]` into an object,
 * deriving the area level from the number of underscores in the ID and pre-lowercasing the name.
 *
 * @param {Object|Array} rawItem - Search index item.
 * @param {Array<string>} [prefix=[]] - Optional trail prefix.
 * @returns {Object} Normalised search item object with pre-computed lowercase name.
 */
export function parseSearchItem(rawItem, prefix = []) {
    if (Array.isArray(rawItem)) {
        if (rawItem.length === 5) {
            const id = rawItem[0];
            const parts = id ? id.split('_') : [];
            let level = 'postcode_area';
            if (parts.length === 2) level = 'city';
            else if (parts.length === 3) level = 'suburb';
            else if (parts.length === 4) level = 'street';
            const name = rawItem[1] || '';
            return {
                id: id,
                name: name,
                nameLower: name.toLowerCase(),
                level: level,
                count: rawItem[2],
                trail: rawItem[3],
                bbox: rawItem[4]
            };
        }

        const id = rawItem[0];
        const parts = id ? id.split('_') : [];
        let level = 'postcode_area';
        if (parts.length === 2) {
            level = 'city';
        } else if (parts.length === 3) {
            level = 'suburb';
        } else if (parts.length === 4) {
            level = 'street';
        }

        const count = rawItem[1];
        const relTrail = Array.isArray(rawItem[2]) ? rawItem[2] : [];
        const fullTrail = prefix && prefix.length > 0 ? [...prefix, ...relTrail] : relTrail;
        const name = fullTrail.length > 0 ? fullTrail[fullTrail.length - 1] : '';
        const bbox = rawItem[3];

        return {
            id: id,
            name: name,
            nameLower: name.toLowerCase(),
            level: level,
            count: count,
            trail: fullTrail,
            bbox: bbox
        };
    }
    if (rawItem && !rawItem.nameLower) {
        rawItem.nameLower = (rawItem.name || '').toLowerCase();
    }
    return rawItem;
}

/**
 * Returns a dynamic empty search prompt message indicating which levels can be currently searched.
 *
 * @returns {string} Dynamic search prompt text string.
 */
export function getSearchPromptText() {
    if (state.currentLevel === 'root') {
        return 'Type a query to search cities or postcode areas.';
    }

    const currentAreaItem = state.trail && state.trail.length > 1 ? state.trail[state.trail.length - 1] : null;
    const areaName = currentAreaItem ? currentAreaItem.name : '';

    if (state.searchOnlyCurrentArea) {
        const parts = state.currentLevel.split('_');
        if (parts.length === 1) { // Postcode area
            return areaName ? `Type a query to search cities, suburbs, or streets in ${areaName}.` : 'Type a query to search cities, suburbs, or streets in current area.';
        } else if (parts.length === 2) { // City
            return areaName ? `Type a query to search suburbs or streets in ${areaName}.` : 'Type a query to search suburbs or streets in current area.';
        } else if (parts.length === 3) { // Suburb
            return areaName ? `Type a query to search streets in ${areaName}.` : 'Type a query to search streets in current area.';
        }
    }

    return 'Type a query to search streets, suburbs, cities, or postcode areas.';
}

/**
 * Executes a search query against loaded search indices and updates search results UI.
 *
 * @returns {Promise<void>}
 */
export async function executeSearch() {
    const searchResultsList = document.getElementById('search-results-list');
    if (!searchResultsList) return;

    const query = (state.searchQuery || '').trim().toLowerCase();
    if (!query) {
        searchResultsList.innerHTML = `<div class="p-4 text-xs text-gray-500 text-center">${getSearchPromptText()}</div>`;
        state.searchSelectedIndex = -1;
        return;
    }

    const currentPaId = state.currentLevel === 'root' ? null : state.currentLevel.split('_')[0];

    const rootIndex = await fetchRootSearchIndex();
    let currentPaIndex = [];
    if (currentPaId) {
        currentPaIndex = await fetchPostcodeSearchIndex(currentPaId);
    }

    let combinedIndex = [];
    if (state.currentLevel === 'root') {
        combinedIndex = rootIndex;
    } else if (state.searchOnlyCurrentArea) {
        combinedIndex = currentPaIndex;
    } else {
        const seenIds = new Set();
        combinedIndex = [];

        for (let i = 0; i < currentPaIndex.length; i++) {
            const item = currentPaIndex[i];
            seenIds.add(item.id);
            combinedIndex.push(item);
        }

        for (let i = 0; i < rootIndex.length; i++) {
            const item = rootIndex[i];
            if (!seenIds.has(item.id)) {
                seenIds.add(item.id);
                combinedIndex.push(item);
            }
        }
    }

    const isAreaOnly = state.searchOnlyCurrentArea && state.currentLevel !== 'root';
    const prefixNeedle = `${state.currentLevel}_`;

    const matches = [];
    const levelOrder = { 'city': 1, 'postcode_area': 2, 'suburb': 3, 'street': 4 };

    for (let i = 0; i < combinedIndex.length; i++) {
        const item = combinedIndex[i];

        if (isAreaOnly) {
            if (item.id !== state.currentLevel && !item.id.startsWith(prefixNeedle)) {
                continue;
            }
        }

        const nameLower = item.nameLower !== undefined ? item.nameLower : (item.name || '').toLowerCase();
        if (!nameLower.includes(query)) continue;

        let matchScore = 3; // Substring match
        if (nameLower === query) {
            matchScore = 1; // Exact match
        } else if (nameLower.startsWith(query)) {
            matchScore = 2; // Prefix match
        }

        matches.push({
            item,
            matchScore,
            levelRank: levelOrder[item.level] || 99
        });
    }

    matches.sort((a, b) => {
        if (a.matchScore !== b.matchScore) return a.matchScore - b.matchScore;
        if (a.levelRank !== b.levelRank) return a.levelRank - b.levelRank;
        return compareNames(a.item.name, b.item.name);
    });

    renderSearchResults(matches.map(m => m.item));
}

/**
 * Renders the search result elements in the search results container.
 *
 * @param {Array<Object>} results - Sorted search result items.
 */
export function renderSearchResults(results) {
    const listContainer = document.getElementById('search-results-list');
    if (!listContainer) return;

    listContainer.innerHTML = '';
    state.searchSelectedIndex = -1;

    if (results.length === 0) {
        listContainer.innerHTML = '<div class="p-4 text-xs text-gray-500 text-center">No matching areas found.</div>';
        return;
    }

    const maxDisplay = 50;
    const displayedResults = results.slice(0, maxDisplay);
    window.currentSearchResults = displayedResults;

    const fragment = document.createDocumentFragment();
    displayedResults.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'px-4 py-2.5 hover:bg-gray-100 cursor-pointer text-xs transition-colors duration-150 border-b border-gray-100 flex items-center justify-between gap-2';
        row.dataset.index = index;

        const textCol = document.createElement('div');
        textCol.className = 'flex flex-col gap-0.5 grow min-w-0';

        const titleRow = document.createElement('div');
        titleRow.className = 'font-bold text-gray-800 text-sm truncate';
        titleRow.innerText = item.name;

        const subtitleRow = document.createElement('div');
        subtitleRow.className = 'text-[11px] text-gray-500 truncate';
        subtitleRow.innerText = item.trail ? item.trail.join(' > ') : item.name;

        textCol.appendChild(titleRow);
        textCol.appendChild(subtitleRow);

        const countCol = document.createElement('div');
        countCol.className = 'text-xs text-gray-500 font-semibold shrink-0 text-right';
        countCol.innerText = (item.count || 0).toLocaleString();

        row.appendChild(textCol);
        row.appendChild(countCol);

        row.onclick = () => selectSearchResult(item);

        fragment.appendChild(row);
    });

    if (results.length > maxDisplay) {
        const capNotice = document.createElement('div');
        capNotice.className = 'p-3 text-[11px] text-gray-500 text-center bg-gray-50 italic border-t border-gray-100';
        capNotice.innerText = `Showing top ${maxDisplay} results of ${results.length.toLocaleString()}. Type more characters to narrow down.`;
        fragment.appendChild(capNotice);
    }

    listContainer.appendChild(fragment);
}

/**
 * Handles selection of a search result item.
 *
 * @param {Object} item - Search result item to select.
 */
export function selectSearchResult(item) {
    setSidebarSectionState(false);
    const isMobile = window.innerWidth < 768;
    if (isMobile) {
        state.sidebarVisible = false;
        updateSidebarLayout();
    }
    if (item && item.id) {
        loadLayer(item.id, item.name, {
            bbox: item.bbox,
            trail: item.trail
        });
    }
}

/**
 * Keydown handler for navigating search results with keyboard arrows, Enter, or Escape.
 *
 * @param {KeyboardEvent} e - Keydown event object.
 */
export function handleSearchKeyDown(e) {
    if (!state.searchActive) return;

    const results = window.currentSearchResults || [];
    if (e.key === 'Escape') {
        e.preventDefault();
        setSidebarSectionState(false);
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (results.length === 0) return;
        state.searchSelectedIndex = Math.min(state.searchSelectedIndex + 1, results.length - 1);
        updateSearchSelectionHighlight();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (results.length === 0) return;
        state.searchSelectedIndex = Math.max(state.searchSelectedIndex - 1, 0);
        updateSearchSelectionHighlight();
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (results.length === 0) return;
        const targetIndex = state.searchSelectedIndex >= 0 ? state.searchSelectedIndex : 0;
        selectSearchResult(results[targetIndex]);
    }
}

/**
 * Updates UI highlight styling for keyboard navigation on search result rows.
 */
export function updateSearchSelectionHighlight() {
    const listContainer = document.getElementById('search-results-list');
    if (!listContainer) return;

    const rows = listContainer.children;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (i === state.searchSelectedIndex) {
            row.classList.add('bg-blue-50', 'border-blue-200');
            row.classList.remove('hover:bg-gray-100');
            row.scrollIntoView({ block: 'nearest' });
        } else {
            row.classList.remove('bg-blue-50', 'border-blue-200');
            row.classList.add('hover:bg-gray-100');
        }
    }
}

/**
 * Initialises sidebar event listeners and responsive resize handlers.
 */
export function initSidebar() {
    const menuBtn = document.getElementById('menu-btn');
    if (menuBtn) {
        menuBtn.onclick = (e) => {
            e.stopPropagation();
            state.sidebarVisible = !state.sidebarVisible;
            updateSidebarLayout();
        };
    }

    const sublevelsHeader = document.getElementById('sublevels-header');
    if (sublevelsHeader) {
        sublevelsHeader.onclick = () => {
            setSidebarSectionState('sublevels');
        };
    }

    const searchHeader = document.getElementById('search-header');
    const searchInput = document.getElementById('search-input');
    const searchClearBtn = document.getElementById('search-clear-btn');
    const searchCheckbox = document.getElementById('search-area-only-checkbox');

    if (searchHeader) {
        searchHeader.onclick = (e) => {
            if (e.target === searchInput || (searchClearBtn && searchClearBtn.contains(e.target))) return;
            setSidebarSectionState(state.activeSection === 'search' ? 'sublevels' : 'search');
        };
    }

    const settingsHeader = document.getElementById('settings-header');
    const envelopeToggle = document.getElementById('setting-envelopes-toggle');

    if (settingsHeader) {
        settingsHeader.onclick = () => {
            setSidebarSectionState(state.activeSection === 'settings' ? 'sublevels' : 'settings');
        };
    }

    if (envelopeToggle) {
        envelopeToggle.checked = state.showEnvelope;
        envelopeToggle.onchange = (e) => {
            state.showEnvelope = e.target.checked;
            localStorage.setItem('showEnvelope', e.target.checked ? 'true' : 'false');
            updateEnvelopeCard();
        };
    }

    if (searchInput) {
        searchInput.onfocus = () => {
            if (!state.searchActive) {
                setSidebarSectionState(true);
            } else {
                searchInput.select();
            }
        };

        searchInput.oninput = (e) => {
            state.searchQuery = e.target.value;
            updateClearButtonVisibility();
            if (state.searchDebounceTimer) {
                clearTimeout(state.searchDebounceTimer);
            }
            state.searchDebounceTimer = setTimeout(() => {
                executeSearch();
            }, 150);
        };

        searchInput.onkeydown = handleSearchKeyDown;
    }

    if (searchClearBtn) {
        searchClearBtn.onclick = (e) => {
            e.stopPropagation();
            if (searchInput) {
                searchInput.value = '';
                state.searchQuery = '';
                updateClearButtonVisibility();
                searchInput.focus();
                executeSearch();
            }
        };
    }

    if (searchCheckbox) {
        searchCheckbox.onchange = (e) => {
            state.searchOnlyCurrentArea = e.target.checked;
            executeSearch();
        };
    }

    let lastWindowWidth = window.innerWidth;
    window.addEventListener('resize', () => {
        const currentWidth = window.innerWidth;
        if (currentWidth !== lastWindowWidth) {
            lastWindowWidth = currentWidth;
            const isMobile = currentWidth < 768;
            state.sidebarVisible = !isMobile;
            updateSidebarLayout();
        }
    });

    updateSidebarLayout();
    updateSearchAreaCheckboxState();
}

/**
 * Renders column headers for sidebar list (Name, Elements, Addressed).
 *
 * @param {boolean} isPointsLevel - True if current level represents address points.
 */
export function renderHeaders(isPointsLevel) {
    const headersContainer = document.getElementById('sidebar-headers');
    if (!headersContainer) return;

    headersContainer.innerHTML = '';

    if (isPointsLevel) {
        const nameHeader = document.createElement('div');
        nameHeader.className = 'col-span-6 font-bold text-gray-500 uppercase tracking-wider';
        nameHeader.innerText = 'Name';

        const postcodeHeader = document.createElement('div');
        postcodeHeader.className = 'col-span-6 text-right font-bold text-gray-500 uppercase tracking-wider';
        postcodeHeader.innerText = 'Postcode';

        headersContainer.appendChild(nameHeader);
        headersContainer.appendChild(postcodeHeader);
    } else {
        const nameHeader = document.createElement('div');
        nameHeader.className = 'col-span-6 flex items-center gap-1 cursor-pointer hover:text-gray-700 transition-colors duration-150 font-bold text-gray-500 uppercase tracking-wider';
        nameHeader.innerHTML = 'Name' + (state.currentSortColumn === 'name' ? (state.currentSortDirection === 'asc' ? ' ▲' : ' ▼') : '');
        nameHeader.onclick = () => handleHeaderClick('name');

        const countHeader = document.createElement('div');
        countHeader.className = 'col-span-3 flex items-center justify-end gap-1 cursor-pointer hover:text-gray-700 transition-colors duration-150 font-bold text-gray-500 uppercase tracking-wider';
        countHeader.innerHTML = 'Elements' + (state.currentSortColumn === 'count' ? (state.currentSortDirection === 'asc' ? ' ▲' : ' ▼') : '');
        countHeader.onclick = () => handleHeaderClick('count');

        const pctHeader = document.createElement('div');
        pctHeader.className = 'col-span-3 flex items-center justify-end gap-1 cursor-pointer hover:text-gray-700 transition-colors duration-150 font-bold text-gray-500 uppercase tracking-wider';
        pctHeader.innerHTML = 'Addressed' + (state.currentSortColumn === 'addressed' ? (state.currentSortDirection === 'asc' ? ' ▲' : ' ▼') : '');
        pctHeader.onclick = () => handleHeaderClick('addressed');

        headersContainer.appendChild(nameHeader);
        headersContainer.appendChild(countHeader);
        headersContainer.appendChild(pctHeader);
    }
}

/**
 * Click handler for table header sorting.
 *
 * @param {string} column - Sorting column key ('name', 'count', or 'addressed').
 */
export function handleHeaderClick(column) {
    if (state.currentSortColumn === column) {
        state.currentSortDirection = state.currentSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        state.currentSortColumn = column;
        if (column === 'name') {
            state.currentSortDirection = 'asc';
        } else {
            state.currentSortDirection = 'desc';
        }
    }
    if (window.lastLoadedData) {
        const feats = getFeaturesArray(window.lastLoadedData);
        const isPointsLevel = feats.length > 0 && (feats[0].level === 'points' || (feats[0].properties && feats[0].properties.level === 'points'));
        populateSidebar(window.lastLoadedData, isPointsLevel);
    }
}

/**
 * Determines sidebar section title text based on current feature level or ID.
 *
 * @param {Array<Object>|string} featuresListOrId - List of feature objects or level ID string.
 * @returns {string} Human-readable level title.
 */
export function getSidebarLevelName(featuresListOrId) {
    if (typeof featuresListOrId === 'string') {
        const id = featuresListOrId;
        if (id === 'root') return 'Postcode Areas';
        const depth = id.split('_').length;
        switch (depth) {
            case 1: return 'Cities';
            case 2: return 'Suburbs';
            case 3: return 'Streets';
            case 4: return 'Address Points';
            default: return 'Sub-levels';
        }
    }
    const featuresList = featuresListOrId || [];
    if (featuresList.length === 0) return 'Sub-levels';
    const firstProp = featuresList[0].properties || featuresList[0];
    switch (firstProp.level) {
        case 'postcode_area': return 'Postcode Areas';
        case 'city': return 'Cities';
        case 'suburb': return 'Suburbs';
        case 'street': return 'Streets';
        case 'points': return 'Address Points';
        default: return 'Sub-levels';
    }
}

/**
 * Renders pulsing skeleton placeholders in the sidebar list during data loading.
 */
export function renderSidebarLoadingSkeleton() {
    if (state.activeRenderFrameId !== null) {
        cancelAnimationFrame(state.activeRenderFrameId);
        state.activeRenderFrameId = null;
    }

    const listContainer = document.getElementById('sidebar-list');
    if (!listContainer) return;

    listContainer.innerHTML = '';
    listContainer.scrollTop = 0;

    const fragment = document.createDocumentFragment();
    const rowCount = 8;

    for (let i = 0; i < rowCount; i++) {
        const row = document.createElement('div');
        row.className = 'grid grid-cols-12 gap-2 px-4 py-3 items-center h-[46px] border-b border-gray-100 animate-pulse';

        const col1 = document.createElement('div');
        col1.className = 'col-span-6 h-3.5 bg-gray-200 rounded w-3/4';

        const col2 = document.createElement('div');
        col2.className = 'col-span-3 h-3.5 bg-gray-200 rounded w-1/2 justify-self-end';

        const col3 = document.createElement('div');
        col3.className = 'col-span-3 h-3.5 bg-gray-200 rounded w-2/3 justify-self-end';

        row.appendChild(col1);
        row.appendChild(col2);
        row.appendChild(col3);

        fragment.appendChild(row);
    }

    listContainer.appendChild(fragment);
}

/**
 * Sorts feature items based on active sort column and direction.
 *
 * @param {Array<Object>} featuresList - Raw feature objects.
 * @param {string} currentSortColumn - Active sort column ('name', 'count', or 'addressed').
 * @param {string} currentSortDirection - Active direction ('asc' or 'desc').
 * @param {boolean} isPointsLevel - True if sorting address points.
 * @returns {Array<Object>} Sorted array copy.
 */
function sortSidebarFeatures(featuresList, currentSortColumn, currentSortDirection, isPointsLevel) {
    if (!featuresList || featuresList.length <= 1) return [...(featuresList || [])];

    // Optimisation: Decorate items once (Schwartzian transform) to avoid repeating getDisplayName,
    // lowercasing and property lookups inside the O(N log N) sorting comparator loop.
    const decorated = featuresList.map(f => {
        const prop = f.properties || f;
        const displayName = getDisplayName(prop);
        return {
            feature: f,
            displayName: displayName,
            count: prop.count || 0,
            addr_perc: prop.addr_perc ?? 0
        };
    });

    const isAsc = currentSortDirection === 'asc';

    if (!isPointsLevel) {
        decorated.sort((a, b) => {
            if (currentSortColumn === 'count') {
                if (a.count !== b.count) {
                    return isAsc ? a.count - b.count : b.count - a.count;
                }
            } else if (currentSortColumn === 'addressed') {
                if (a.addr_perc !== b.addr_perc) {
                    return isAsc ? a.addr_perc - b.addr_perc : b.addr_perc - a.addr_perc;
                }
            } else if (currentSortColumn === 'name') {
                const comp = compareNames(a.displayName, b.displayName);
                return isAsc ? comp : -comp;
            }
            return compareNames(a.displayName, b.displayName);
        });
    } else {
        decorated.sort((a, b) => compareNames(a.displayName, b.displayName));
    }

    return decorated.map(d => d.feature);
}

/**
 * Creates a single virtual scroll row DOM element for a sidebar item.
 *
 * @param {Object} f - Feature object.
 * @param {number} index - Position index of the row.
 * @param {number} rowHeight - Fixed row height in pixels.
 * @returns {HTMLElement} Formatted row DOM element.
 */
function createSidebarRowElement(f, index, rowHeight) {
    const props = f.properties || f;
    const displayName = getDisplayName(props);
    const isPoint = props.level === 'points';

    const row = document.createElement('div');
    row.className = 'grid grid-cols-12 gap-2 px-4 py-3 hover:bg-gray-50 cursor-pointer items-center text-sm transition-colors duration-150 border-b border-gray-100';
    row.style.position = 'absolute';
    row.style.top = `${index * rowHeight}px`;
    row.style.height = `${rowHeight}px`;
    row.style.left = '0';
    row.style.right = '0';
    row.style.boxSizing = 'border-box';

    const nameCol = document.createElement('div');
    nameCol.className = 'col-span-6 font-semibold truncate text-gray-800';
    nameCol.innerText = displayName;
    if (isMissingValue(displayName)) {
        nameCol.classList.add('text-red-600');
    }
    row.appendChild(nameCol);

    if (isPoint) {
        const subCol = document.createElement('div');
        const postcodeVal = props.postcode || '';
        subCol.className = `col-span-6 text-right text-xs truncate ${isMissingValue(postcodeVal) ? 'text-red-600 font-semibold' : 'text-gray-500'}`;
        subCol.innerText = postcodeVal;
        row.appendChild(subCol);

        row.onclick = () => {
            const isMobile = window.innerWidth < 768;
            if (isMobile) {
                state.sidebarVisible = false;
                updateSidebarLayout();
            }

            const coords = props.coords;
            if (coords) {
                map.flyTo({ center: coords, zoom: 19 });

                setTimeout(() => {
                    const pixel = map.project(coords);
                    map.fire('click', {
                        lngLat: new maplibregl.LngLat(coords[0], coords[1]),
                        point: pixel,
                        originalEvent: {}
                    });
                }, 400);
            }
        };
    } else {
        const countCol = document.createElement('div');
        countCol.className = 'col-span-3 text-right text-gray-600 font-medium';
        countCol.innerText = (props.count || 0).toLocaleString();
        row.appendChild(countCol);

        const pctCol = document.createElement('div');
        pctCol.className = 'col-span-3 text-right font-bold';
        const pct = props.addr_perc ?? 0;
        pctCol.innerText = `${pct}%`;
        if (pct >= 90) pctCol.className += ' text-green-600';
        else if (pct >= 50) pctCol.className += ' text-amber-500';
        else pctCol.className += ' text-red-500';
        row.appendChild(pctCol);

        row.onclick = () => {
            const isMobile = window.innerWidth < 768;
            if (isMobile) {
                state.sidebarVisible = false;
                updateSidebarLayout();
            }

            if (props.child_id) {
                loadLayer(props.child_id, displayName, { feature: f });
            }
        };
    }

    return row;
}

/**
 * Populates the sub-levels list sidebar with virtualised scrolling.
 *
 * @param {Object|Array<Object>} data - GeoJSON feature collection or feature array.
 * @param {boolean} isPointsLevel - True if displaying lowest level address points.
 */
export function populateSidebar(data, isPointsLevel) {
    if (state.activeRenderFrameId !== null) {
        cancelAnimationFrame(state.activeRenderFrameId);
        state.activeRenderFrameId = null;
    }
    window.lastLoadedData = data;

    const listContainer = document.getElementById('sidebar-list');
    const sidebarMeta = document.getElementById('sidebar-meta');
    const sidebarTitle = document.getElementById('sidebar-title');
    if (!listContainer || !sidebarMeta || !sidebarTitle) return;

    listContainer.innerHTML = '';
    listContainer.scrollTop = 0;

    const featuresList = getFeaturesArray(data);

    sidebarTitle.innerText = getSidebarLevelName(featuresList);

    let elementSum = 0;
    if (isPointsLevel) {
        elementSum = featuresList.length;
    } else {
        featuresList.forEach(f => {
            const props = f.properties || f;
            elementSum += props.count || 0;
        });
    }
    sidebarMeta.innerText = `${elementSum.toLocaleString()} elements`;

    renderHeaders(isPointsLevel);

    const features = sortSidebarFeatures(featuresList, state.currentSortColumn, state.currentSortDirection, isPointsLevel);

    const rowHeight = 46;
    const buffer = 10;

    const scrollContainer = document.createElement('div');
    scrollContainer.style.position = 'relative';
    scrollContainer.style.width = '100%';
    scrollContainer.style.height = `${features.length * rowHeight}px`;
    listContainer.appendChild(scrollContainer);

    let lastStartIndex = -1;
    let lastEndIndex = -1;

    function renderVisibleRows() {
        const scrollTop = listContainer.scrollTop;
        const containerHeight = listContainer.clientHeight;

        let startIndex = Math.floor(scrollTop / rowHeight);
        let endIndex = Math.ceil((scrollTop + containerHeight) / rowHeight);

        startIndex = Math.max(0, startIndex - buffer);
        endIndex = Math.min(features.length - 1, endIndex + buffer);

        if (startIndex === lastStartIndex && endIndex === lastEndIndex) {
            return;
        }

        lastStartIndex = startIndex;
        lastEndIndex = endIndex;

        scrollContainer.innerHTML = '';

        const fragment = document.createDocumentFragment();

        for (let i = startIndex; i <= endIndex; i++) {
            const row = createSidebarRowElement(features[i], i, rowHeight);
            fragment.appendChild(row);
        }

        scrollContainer.appendChild(fragment);
    }

    listContainer.onscroll = renderVisibleRows;
    renderVisibleRows();
}
