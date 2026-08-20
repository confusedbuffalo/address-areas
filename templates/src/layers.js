/**
 * @file layers.js
 * @description Layer data fetching, breadcrumb rendering and hierarchy trail resolution.
 */

import { state, sectorPointsCache } from './config.js';
import { getUrlParams, getFeaturesArray, getDisplayName, isMissingValue, isStreetId, getSuburbIdForStreet, decodeHierarchyData, decodePointsData, getCityLetterKey, showToast } from './utils.js';
import { map, popup, getLayerBounds, getFeatureBounds, updateMapFilters, updateUrlParams, updateEditButton } from './map.js';
import { populateSidebar, updateSearchAreaCheckboxState, executeSearch, fetchRootSearchIndex, fetchPostcodeSearchIndex, renderSidebarLoadingSkeleton, renderHeaders, getSidebarLevelName } from './sidebar.js';
import { updateSidebarEditAllButton } from './josm.js';

/**
 * Tracks current active load request sequence number to ignore stale async responses.
 * @type {number}
 */
let loadRequestId = 0;

/**
 * Cache for root JSON hierarchy data.
 * @type {Array<Object>|null}
 */
let rootDataCache = null;

/**
 * Cache for postcode area JSON data (`{ paId: data }`).
 * @type {Object<string, Array<Object>>}
 */
const paDataCache = {};

/**
 * Fetches and caches root hierarchy JSON data.
 *
 * @returns {Promise<Array<Object>>} Root data JSON promise.
 */
export async function fetchRootData() {
    if (rootDataCache) {
        return rootDataCache;
    }
    const res = await fetch('data/root.json');
    if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
    }
    const rawData = await res.json();
    rootDataCache = decodeHierarchyData(rawData);
    return rootDataCache;
}

/**
 * Fetches and caches postcode area JSON data.
 *
 * @param {string} paId - Postcode area identifier string.
 * @returns {Promise<Array<Object>>} Postcode area data JSON promise.
 */
export async function fetchPaData(paId) {
    if (paDataCache[paId]) {
        return paDataCache[paId];
    }
    const res = await fetch(`data/${paId}.json`);
    if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
    }
    const rawData = await res.json();
    const data = decodeHierarchyData(rawData);
    paDataCache[paId] = data;
    return data;
}

/**
 * Fetches and caches sector points JSON data mapping street IDs to point arrays.
 *
 * @param {string} sectorId - Postcode sector identifier string.
 * @returns {Promise<Object<string, Array<Object>>>} Sector points dictionary JSON promise.
 */
export async function fetchSectorPointsData(sectorId) {
    if (sectorPointsCache[sectorId]) {
        return sectorPointsCache[sectorId];
    }
    try {
        const res = await fetch(`data/${sectorId}_points.json`);
        if (!res.ok) {
            throw new Error(`HTTP error! status: ${res.status}`);
        }
        const rawData = await res.json();
        const data = decodePointsData(rawData);
        sectorPointsCache[sectorId] = data;
        return data;
    } catch (err) {
        console.warn(`Failed loading sector points for ${sectorId}:`, err);
        sectorPointsCache[sectorId] = {};
        return {};
    }
}

/**
 * Fetches address points for a specific street by querying its sector points files.
 *
 * @param {string} paId - Postcode area ID.
 * @param {string} streetId - Street ID.
 * @returns {Promise<Array<Object>>} Array of decoded point objects.
 */
/**
 * Cache for No Postcode letter hierarchy files (`{ "paId_letterKey": { cityId: suburbsData } }`).
 * @type {Object<string, Object<string, Array<Object>>>}
 */
const noPostcodeLetterCache = {};

/**
 * Ensures that the suburb/street hierarchy for a city under No Postcode is fetched and attached to cityObj.
 *
 * @param {string} paId - Postcode area ID (e.g. 'no-postcode-xxxx').
 * @param {Object} cityObj - City feature or properties object.
 * @returns {Promise<void>}
 */
export async function ensureNoPostcodeCityLoaded(paId, cityObj) {
    if (!paId || !paId.startsWith('no-postcode') || !cityObj) return;
    if (cityObj.suburbs) return;

    const cityName = cityObj.raw_name || cityObj.name || '';
    const letterKey = getCityLetterKey(cityName);
    const cacheKey = `${paId}_${letterKey}`;

    if (!noPostcodeLetterCache[cacheKey]) {
        try {
            const res = await fetch(`data/${paId}_${letterKey}.json`);
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            const rawData = await res.json();
            const decodedDict = {};
            for (const [cId, suburbsTuples] of Object.entries(rawData)) {
                decodedDict[cId] = decodeHierarchyData(suburbsTuples);
            }
            noPostcodeLetterCache[cacheKey] = decodedDict;
        } catch (err) {
            console.error(`Failed to load No Postcode letter file ${cacheKey}:`, err);
            noPostcodeLetterCache[cacheKey] = {};
        }
    }

    const letterData = noPostcodeLetterCache[cacheKey];
    if (letterData && letterData[cityObj.child_id]) {
        cityObj.suburbs = letterData[cityObj.child_id];
    } else {
        cityObj.suburbs = [];
    }
}

/**
 * Fetches address points for a specific street by querying its sector points files.
 *
 * @param {string} paId - Postcode area ID.
 * @param {string} streetId - Street ID.
 * @returns {Promise<Array<Object>>} Array of decoded point objects.
 */
export async function fetchStreetPointsData(paId, streetId) {
    const paData = await fetchPaData(paId);
    const isNoPostcode = paId.startsWith('no-postcode');
    let targetStreetObj = null;

    for (const city of getFeaturesArray(paData)) {
        const cityProps = city.properties || city;
        if (isNoPostcode && !cityProps.suburbs) {
            if (streetId.startsWith(cityProps.child_id + '_')) {
                await ensureNoPostcodeCityLoaded(paId, cityProps);
            }
        }
        const suburbs = cityProps.suburbs || [];
        for (const suburb of suburbs) {
            const subProps = suburb.properties || suburb;
            const streets = subProps.streets || [];
            const found = streets.find(s => (s.properties || s).child_id === streetId);
            if (found) {
                targetStreetObj = found.properties || found;
                break;
            }
        }
        if (targetStreetObj) break;
    }

    if (!targetStreetObj || !targetStreetObj.sector_ids) {
        return [];
    }

    const sectorIds = targetStreetObj.sector_ids;
    const sectorPromises = sectorIds.map(sectorId => fetchSectorPointsData(sectorId));
    const sectorDataArray = await Promise.all(sectorPromises);

    const points = [];
    for (const sectorData of sectorDataArray) {
        if (sectorData[streetId]) {
            points.push(...sectorData[streetId]);
        }
    }
    return points;
}

const initialParams = getUrlParams();

/**
 * Creates a breadcrumb button DOM element.
 *
 * @param {{id: string, name: string}} item - Breadcrumb trail item.
 * @param {number} index - Index of item in state.trail.
 * @param {string} [extraClasses=''] - Optional CSS class overrides.
 * @returns {HTMLButtonElement} Created button element.
 */
function createBreadcrumbButton(item, index, extraClasses = '') {
    const btn = document.createElement('button');
    btn.className = `bg-slate-700 hover:bg-slate-600 text-white px-2 py-0.5 sm:px-2.5 sm:py-1 rounded text-[11px] sm:text-xs font-sans font-semibold transition shadow-sm hover:shadow active:scale-95 duration-100 ease-in-out cursor-pointer ${extraClasses}`;
    btn.innerText = item.name;
    btn.title = item.name;
    btn.onclick = () => {
        if (index === state.trail.length - 1) {
            if (window.lastLoadedData) {
                const bounds = getLayerBounds(window.lastLoadedData);
                if (!bounds.isEmpty()) {
                    map.fitBounds(bounds, { padding: 40 });
                }
            }
        } else {
            loadLayer(item.id, item.name);
        }
    };
    return btn;
}

/**
 * Creates a breadcrumb separator DOM element (`>`).
 *
 * @returns {HTMLSpanElement} Separator element.
 */
function createSeparator() {
    const separator = document.createElement('span');
    separator.className = 'text-slate-400 font-sans font-bold text-[11px] sm:text-xs shrink-0 mx-0.5 sm:mx-1 select-none';
    separator.innerText = '>';
    return separator;
}

/**
 * Renders the breadcrumbs UI container based on state.trail.
 */
export function renderBreadcrumbs() {
    const container = document.getElementById('breadcrumbs');
    if (!container) return;

    container.innerHTML = '';

    // Line 1: Items 0, 1, 2 (UK, Postcode, City)
    const line1Div = document.createElement('div');
    line1Div.className = 'flex flex-row items-center justify-center gap-0.5 sm:gap-1 max-w-full min-w-0 shrink-0 sm:shrink';

    state.trail.slice(0, 3).forEach((item, index) => {
        if (index > 0) {
            line1Div.appendChild(createSeparator());
        }

        let extraClasses = 'shrink-0';
        if (index === 2) {
            extraClasses = 'truncate min-w-0 max-w-[120px] xs:max-w-[150px] sm:max-w-[180px] md:max-w-none';
        }

        line1Div.appendChild(createBreadcrumbButton(item, index, extraClasses));
    });

    container.appendChild(line1Div);

    // Line 2: Items 3+ (Suburb, Street) if present
    if (state.trail.length > 3) {
        const line2Div = document.createElement('div');
        line2Div.className = 'flex flex-row items-center justify-center gap-0.5 sm:gap-1 max-w-full min-w-0 shrink-0 sm:shrink';

        line2Div.appendChild(createSeparator());

        state.trail.slice(3).forEach((item, relIndex) => {
            const index = relIndex + 3;
            if (relIndex > 0) {
                line2Div.appendChild(createSeparator());
            }

            const extraClasses = 'truncate min-w-0 flex-1 max-w-[120px] xs:max-w-[150px] sm:max-w-[180px] md:max-w-none text-center';
            line2Div.appendChild(createBreadcrumbButton(item, index, extraClasses));
        });

        container.appendChild(line2Div);
    }
}

/**
 * Resolves full hierarchy trail array (`[{id, name}, ...]`) starting from root for a target ID.
 *
 * @param {string|null} targetId - Target area/street level identifier.
 * @returns {Promise<Array<{id: string, name: string}>>} Resolved trail items list.
 */
export async function resolveTrailForId(targetId) {
    const resolvedTrail = [{ id: 'root', name: 'UK' }];

    if (!targetId || targetId === 'root') {
        return resolvedTrail;
    }

    const parts = targetId.split('_');

    try {
        // Step 1: Postcode Area
        if (parts.length >= 1) {
            const paId = parts[0];
            const data = await fetchRootData();
            const found = getFeaturesArray(data).find(f => (f.properties || f).child_id === paId);
            if (found) {
                resolvedTrail.push({ id: paId, name: getDisplayName(found) });
            }

            if (parts.length === 1) return resolvedTrail;
        }

        const paId = parts[0];
        const paData = await fetchPaData(paId);
        const paFeatures = getFeaturesArray(paData);

        // Step 2: City
        let currentCityObj = null;
        if (parts.length >= 2) {
            const cityId = parts.slice(0, 2).join('_');
            const found = paFeatures.find(f => (f.properties || f).child_id === cityId);
            if (found) {
                currentCityObj = found.properties || found;
                resolvedTrail.push({ id: cityId, name: getDisplayName(found) });
                if (paId.startsWith('no-postcode')) {
                    await ensureNoPostcodeCityLoaded(paId, currentCityObj);
                }
            }
        }

        // Step 3: Suburb
        let currentSuburbObj = null;
        if (parts.length >= 3 && currentCityObj) {
            const suburbId = parts.slice(0, 3).join('_');
            const suburbs = currentCityObj.suburbs || [];
            const found = suburbs.find(f => (f.properties || f).child_id === suburbId);
            if (found) {
                currentSuburbObj = found.properties || found;
                resolvedTrail.push({ id: suburbId, name: getDisplayName(found) });
            }
        }

        // Step 4: Street
        if (parts.length >= 4 && currentSuburbObj) {
            const streetId = parts.slice(0, 4).join('_');
            const streets = currentSuburbObj.streets || [];
            const found = streets.find(f => (f.properties || f).child_id === streetId);
            if (found) {
                resolvedTrail.push({ id: streetId, name: getDisplayName(found) });
            }
        }
    } catch (e) {
        console.error("Error resolving trail for target ID", e);
    }

    return resolvedTrail;
}

/**
 * Resolves the hierarchy trail based on the current URL query parameters.
 *
 * @returns {Promise<Array<{id: string, name: string}>>} Resolved trail.
 */
export async function resolveTrailFromUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const targetId = params.get('id');
    return await resolveTrailForId(targetId);
}

/**
 * Fetches layer metadata, updates map filters, renders breadcrumbs and updates the sidebar.
 *
 * @param {string} dataId - Identifier string of the level to load.
 * @param {string|null} name - Display name of the level.
 * @param {{preserveViewport?: boolean, isInitialLoad?: boolean}} [options={}] - Options object.
 * @returns {Promise<void>}
 */
export async function loadLayer(dataId, name, options = {}) {
    popup.remove();
    state.currentSelectedPoint = null;

    const currentRequestId = ++loadRequestId;
    const previousTrail = [...state.trail];
    const previousLevel = state.currentLevel;

    // 1. Update trail immediately
    if (options.trail && Array.isArray(options.trail) && options.trail.length > 0) {
        state.trail = options.trail.map((t, idx) => {
            if (typeof t === 'string') {
                return { id: idx === 0 ? 'root' : t, name: t };
            }
            return { id: t.id, name: t.name };
        });
    } else if (!options.isInitialLoad) {
        const existingIndex = state.trail.findIndex(t => t.id === dataId);
        if (existingIndex !== -1) {
            state.trail = state.trail.slice(0, existingIndex + 1);
        } else {
            const currentParent = state.trail[state.trail.length - 1];
            if (currentParent && dataId.startsWith(currentParent.id + '_') && dataId.split('_').length === currentParent.id.split('_').length + 1) {
                state.trail.push({ id: dataId, name: name || dataId });
            } else {
                state.trail = await resolveTrailForId(dataId);
                if (currentRequestId !== loadRequestId) return;
            }
        }
    }

    // 2. Update level, URL params and map filters immediately
    state.currentLevel = dataId;
    updateUrlParams();
    updateMapFilters();

    // 3. Update back button and breadcrumbs immediately
    const backBtn = document.getElementById('sidebar-back-btn');
    if (backBtn) {
        if (state.trail.length > 1) {
            backBtn.classList.remove('hidden');
            backBtn.onclick = () => {
                fetchRootSearchIndex().catch(err => console.warn("Failed pre-fetching root search index:", err));

                const parentItem = state.trail[state.trail.length - 2];
                loadLayer(parentItem.id, parentItem.name);
            };
        } else {
            backBtn.classList.add('hidden');
        }
    }
    renderBreadcrumbs();

    // 4. Update sidebar headers, title and show loading skeleton immediately
    const sidebarTitle = document.getElementById('sidebar-title');
    const sidebarMeta = document.getElementById('sidebar-meta');
    const sublevelsHeaderTitle = document.getElementById('sublevels-header-title');
    const levelTitle = getSidebarLevelName(dataId);

    if (sidebarTitle) sidebarTitle.innerText = levelTitle;
    if (sublevelsHeaderTitle) sublevelsHeaderTitle.innerText = levelTitle;
    if (sidebarMeta) sidebarMeta.innerText = 'Loading...';

    const isPointsLevel = isStreetId(dataId);
    renderHeaders(isPointsLevel);
    renderSidebarLoadingSkeleton();

    // 5. If bounds/feature is immediately available (or can be looked up from cached hierarchy data), perform fitBounds immediately
    const isMissingData = isMissingValue(name);
    let boundsToFit = null;
    if (options.feature) {
        boundsToFit = getFeatureBounds(options.feature);
    } else if (options.bbox) {
        boundsToFit = getFeatureBounds(options.bbox);
    }

    const parts = dataId.split('_');

    // Look up bounds from cached root/PA data if options didn't supply them directly
    if (!boundsToFit) {
        const paId = dataId !== 'root' ? dataId.split('_')[0] : 'root';
        if (dataId !== 'root' && dataId === paId && rootDataCache) {
            const found = getFeaturesArray(rootDataCache).find(f => (f.properties || f).child_id === paId);
            if (found) {
                boundsToFit = getFeatureBounds(found);
            }
        } else if (dataId !== 'root' && paDataCache[paId]) {
            const paFeatures = getFeaturesArray(paDataCache[paId]);
            const depth = parts.length;
            if (depth === 2) { // City level
                const found = paFeatures.find(f => (f.properties || f).child_id === dataId);
                if (found) boundsToFit = getFeatureBounds(found);
            } else if (depth === 3) { // Suburb level
                const cityId = parts.slice(0, 2).join('_');
                const city = paFeatures.find(f => (f.properties || f).child_id === cityId);
                const cityProps = city ? (city.properties || city) : null;
                const suburbs = cityProps ? (cityProps.suburbs || []) : [];
                const found = suburbs.find(f => (f.properties || f).child_id === dataId);
                if (found) boundsToFit = getFeatureBounds(found);
            } else if (depth === 4) { // Street level
                const cityId = parts.slice(0, 2).join('_');
                const suburbId = parts.slice(0, 3).join('_');
                const city = paFeatures.find(f => (f.properties || f).child_id === cityId);
                const cityProps = city ? (city.properties || city) : null;
                const suburbs = cityProps ? (cityProps.suburbs || []) : [];
                const suburb = suburbs.find(f => (f.properties || f).child_id === suburbId);
                const subProps = suburb ? (suburb.properties || suburb) : null;
                const streets = subProps ? (subProps.streets || []) : [];
                const found = streets.find(f => (f.properties || f).child_id === dataId);
                if (found) boundsToFit = getFeatureBounds(found);
            }
        }
    }

    if (!options.preserveViewport && !isMissingData && boundsToFit && !boundsToFit.isEmpty()) {
        let shouldFit = true;
        if (options.preventZoomOut) {
            const currentZoom = map.getZoom();
            const camera = map.cameraForBounds(boundsToFit, { padding: 40 });
            if (camera && camera.zoom !== undefined && camera.zoom < currentZoom) {
                shouldFit = false;
            }
        }
        if (shouldFit) {
            if (options.isInitialLoad) {
                map.fitBounds(boundsToFit, { padding: 40, animate: false });
            } else {
                map.fitBounds(boundsToFit, { padding: 40 });
            }
        }
    }

    let fetchPromise;

    if (parts.length === 4) {
        const paId = parts[0];
        fetchPromise = fetchStreetPointsData(paId, dataId);
    } else if (parts.length === 3) {
        const paId = parts[0];
        const cityId = parts.slice(0, 2).join('_');
        fetchPromise = fetchPaData(paId).then(async paData => {
            const cityObj = getFeaturesArray(paData).find(f => (f.properties || f).child_id === cityId);
            if (cityObj && paId.startsWith('no-postcode')) {
                await ensureNoPostcodeCityLoaded(paId, cityObj.properties || cityObj);
            }
            const cityProps = cityObj ? (cityObj.properties || cityObj) : null;
            const suburbs = cityProps ? (cityProps.suburbs || []) : [];
            const suburbObj = suburbs.find(f => (f.properties || f).child_id === dataId);
            const suburbProps = suburbObj ? (suburbObj.properties || suburbObj) : null;
            return suburbProps ? (suburbProps.streets || []) : [];
        });
    } else if (parts.length === 2) {
        const paId = parts[0];
        fetchPromise = fetchPaData(paId).then(async paData => {
            const cityObj = getFeaturesArray(paData).find(f => (f.properties || f).child_id === dataId);
            if (cityObj && paId.startsWith('no-postcode')) {
                await ensureNoPostcodeCityLoaded(paId, cityObj.properties || cityObj);
            }
            const cityProps = cityObj ? (cityObj.properties || cityObj) : null;
            return cityProps ? (cityProps.suburbs || []) : [];
        });
    } else if (dataId === 'root') {
        fetchPromise = fetchRootData();
    } else {
        fetchPromise = fetchPaData(dataId);
    }

    return fetchPromise
        .then(data => {
            if (currentRequestId !== loadRequestId) return;

            const features = getFeaturesArray(data);

            let pointFound = null;
            if (state.initialPointToSelect && isPointsLevel) {
                const selectedOsmId = state.initialPointToSelect;
                pointFound = features.find(f => {
                    const props = f.properties || f;
                    return props.osm_id === selectedOsmId;
                });
                state.initialPointToSelect = null;
            }

            window.lastLoadedData = data;

            // Fit bounds to full data if bounds weren't immediately fitted from feature/bbox
            if (!boundsToFit && !options.preserveViewport && !isMissingData && (!options.isInitialLoad || (initialParams.lat === null && initialParams.lng === null))) {
                const layerBounds = getLayerBounds(data);
                if (!layerBounds.isEmpty()) {
                    let shouldFit = true;
                    if (options.preventZoomOut) {
                        const currentZoom = map.getZoom();
                        const camera = map.cameraForBounds(layerBounds, { padding: 40 });
                        if (camera && camera.zoom !== undefined && camera.zoom < currentZoom) {
                            shouldFit = false;
                        }
                    }
                    if (shouldFit) {
                        if (options.isInitialLoad) {
                            map.fitBounds(layerBounds, { padding: 40, animate: false });
                        } else {
                            map.fitBounds(layerBounds, { padding: 40 });
                        }
                    }
                }
            }

            populateSidebar(data, isPointsLevel);
            updateSidebarEditAllButton(data, fetchSectorPointsData);
            updateSearchAreaCheckboxState();

            if (dataId !== 'root') {
                const paId = dataId.split('_')[0];
                fetchPostcodeSearchIndex(paId).then(() => {
                    if (state.searchActive && currentRequestId === loadRequestId) {
                        executeSearch();
                    }
                }).catch(err => console.warn("Failed fetching postcode search index:", err));
            } else if (state.searchActive) {
                executeSearch();
            }

            if (pointFound) {
                const props = pointFound.properties || pointFound;
                const coords = props.coords;
                if (coords) {
                    state.currentSelectedPoint = {
                        osm_id: props.osm_id,
                        lat: coords[1],
                        lng: coords[0]
                    };
                    updateUrlParams();
                    updateEditButton();

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
            }
        })
        .catch(err => {
            if (currentRequestId !== loadRequestId) return;
            console.error("Failed to load layer:", err);
            showToast("Failed to load area data");

            // Revert to previous stable state
            state.trail = previousTrail;
            state.currentLevel = previousLevel;
            updateUrlParams();
            updateMapFilters();
            renderBreadcrumbs();

            if (window.lastLoadedData) {
                const prevFeatures = getFeaturesArray(window.lastLoadedData);
                const prevIsPoints = prevFeatures.length > 0 && (prevFeatures[0].level === 'points' || (prevFeatures[0].properties && prevFeatures[0].properties.level === 'points'));
                populateSidebar(window.lastLoadedData, prevIsPoints);
                updateSidebarEditAllButton(window.lastLoadedData, fetchSectorPointsData);
            }
        });
}
