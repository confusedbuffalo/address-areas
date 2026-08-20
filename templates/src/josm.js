/**
 * @file josm.js
 * @description JOSM Remote Control Integration and batch feature download logic.
 */

import { getFeaturesArray, getFeatureProperties, showToast, decodeHierarchyData } from './utils.js';

/**
 * Recursively traverses hierarchy features to collect all leaf address point OSM identifiers.
 *
 * @param {Object|null} geojsonFeature - The parent GeoJSON feature (if any).
 * @param {Array<Object>} featuresArray - Array of features or child objects to collect IDs from.
 * @param {Function} [fetchSectorPointsFn] - Async function `(sectorId) => Promise<Object>` to fetch sector points.
 * @returns {Promise<Array<string>>} Resolved list of OSM element identifiers (e.g., ['n123', 'w456']).
 */
export function countAllDescendantsAndGetIds(geojsonFeature, featuresArray, fetchSectorPointsFn) {
    const feats = getFeaturesArray(featuresArray);
    if (feats.length === 0) return Promise.resolve([]);

    const first = feats[0];
    const isPoints = getFeatureProperties(first).level === 'points';
    if (isPoints) {
        return Promise.resolve(feats.map(f => getFeatureProperties(f).osm_id));
    }

    // Collect all street objects recursively
    const streetObjs = [];

    function collectStreets(arr) {
        arr.forEach(f => {
            const props = getFeatureProperties(f);
            if (props.level === 'street') {
                streetObjs.push(props);
            } else if (props.suburbs) {
                collectStreets(props.suburbs);
            } else if (props.streets) {
                collectStreets(props.streets);
            }
        });
    }

    collectStreets(feats);

    if (streetObjs.length > 0) {
        // Collect mapping of sector_id -> array of street_ids to fetch in batch
        const sectorToStreetsMap = {};
        streetObjs.forEach(st => {
            const streetId = st.child_id;
            const sectorIds = st.sector_ids || [];
            sectorIds.forEach(secId => {
                if (!sectorToStreetsMap[secId]) {
                    sectorToStreetsMap[secId] = new Set();
                }
                sectorToStreetsMap[secId].add(streetId);
            });
        });

        if (typeof fetchSectorPointsFn !== 'function') {
            console.warn("fetchSectorPointsFn was not provided to countAllDescendantsAndGetIds");
            return Promise.resolve([]);
        }

        const sectorPromises = Object.keys(sectorToStreetsMap).map(secId => {
            const streetIdsForSector = sectorToStreetsMap[secId];
            return fetchSectorPointsFn(secId).then(sectorData => {
                const ids = [];
                for (const streetId of streetIdsForSector) {
                    if (sectorData[streetId]) {
                        sectorData[streetId].forEach(pt => {
                            const osmId = pt.osm_id || pt[2];
                            if (osmId) ids.push(osmId);
                        });
                    }
                }
                return ids;
            });
        });

        return Promise.all(sectorPromises).then(results => results.flat());
    }

    return Promise.resolve([]);
}

/**
 * Calculates the aggregate element count across a list of features.
 *
 * @param {Array<Object>} feats - Array of feature objects.
 * @returns {number} Total number of elements.
 */
function calculateTotalElements(feats) {
    if (feats.length === 0) return 0;
    const first = feats[0];
    const isPoints = getFeatureProperties(first).level === 'points';
    if (isPoints) {
        return feats.length;
    }
    let sum = 0;
    feats.forEach(f => {
        const props = getFeatureProperties(f);
        sum += props.count || 0;
    });
    return sum;
}

/**
 * Sends a batch HTTP request to JOSM Remote Control for an array of object IDs.
 *
 * @param {Array<string>} idsChunk - List of element IDs (max 200).
 * @returns {Promise<Response>} Fetch promise for JOSM remote control endpoint.
 */
function makeJosmCall(idsChunk) {
    const objectsParam = idsChunk.join(',');
    const josmUrl = `http://127.0.0.1:8111/load_object?objects=${objectsParam}&relation_members=true`;
    return fetch(josmUrl, { mode: 'no-cors' });
}

/**
 * Sends collected element IDs to JOSM in chunks of 200.
 *
 * @param {Array<string>} ids - Complete list of element IDs to load in JOSM.
 * @returns {Promise<void>} Resolves when all chunks have been sent.
 */
export function sendIdsToJosm(ids) {
    if (!ids || ids.length === 0) {
        showToast("No elements found to edit.");
        return Promise.resolve();
    }

    const chunk1 = ids.slice(0, 200);
    const chunk2 = ids.slice(200, 400);

    return makeJosmCall(chunk1)
        .then(() => {
            if (chunk2.length > 0) {
                return new Promise(resolve => setTimeout(resolve, 500))
                    .then(() => makeJosmCall(chunk2));
            }
        })
        .then(() => {
            showToast("Sent objects to JOSM!");
        })
        .catch(err => {
            console.error("Failed to connect to JOSM", err);
            const modal = document.getElementById('josm-modal');
            if (modal) modal.classList.remove('hidden');
        });
}

/**
 * Updates the visual loading state of the 'Edit all' button.
 *
 * @param {HTMLElement} editAllBtn - The button DOM element.
 * @param {boolean} isLoading - True to set loading state, false to reset.
 * @param {string} [originalText] - Original button label text to restore.
 */
function setButtonLoadingState(editAllBtn, isLoading, originalText) {
    if (isLoading) {
        editAllBtn.setAttribute('data-submitting', 'true');
        editAllBtn.className = "hidden sm:inline-block bg-gray-300 text-gray-500 text-xs font-bold px-2 py-1 rounded transition shadow-sm cursor-not-allowed";
        editAllBtn.innerText = "Loading...";
    } else {
        editAllBtn.removeAttribute('data-submitting');
        editAllBtn.className = "hidden sm:inline-block bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold px-2 py-1 rounded transition shadow-sm cursor-pointer";
        if (originalText) {
            editAllBtn.innerText = originalText;
        }
    }
}

/**
 * Handles click execution for the 'Edit all' button.
 *
 * @param {HTMLElement} editAllBtn - The button DOM element.
 * @param {Array<Object>} feats - Array of feature objects to process.
 * @param {Function} [fetchSectorPointsFn] - Async function to fetch sector points data.
 */
function handleEditAllClick(editAllBtn, feats, fetchSectorPointsFn) {
    if (editAllBtn.getAttribute('data-submitting') === 'true') return;

    const originalText = editAllBtn.innerText;
    setButtonLoadingState(editAllBtn, true);

    countAllDescendantsAndGetIds(null, feats, fetchSectorPointsFn)
        .then(ids => sendIdsToJosm(ids))
        .catch(err => {
            console.error("Error gathering descendant IDs:", err);
            showToast("Failed to gather element IDs.");
        })
        .finally(() => {
            setButtonLoadingState(editAllBtn, false, originalText);
        });
}

/**
 * Updates state, accessibility attributes and click handlers for the 'Edit all' button in the sidebar.
 *
 * @param {Object|Array<Object>} data - GeoJSON feature collection or array of features.
 * @param {Function} [fetchSectorPointsFn] - Async function to fetch sector points data.
 */
export function updateSidebarEditAllButton(data, fetchSectorPointsFn) {
    const editAllBtn = document.getElementById('edit-all-btn');
    if (!editAllBtn) return;

    const feats = getFeaturesArray(data);
    const totalElements = calculateTotalElements(feats);

    if (totalElements > 400) {
        editAllBtn.setAttribute('title', 'Too many elements');
    } else {
        editAllBtn.removeAttribute('title');
    }

    if (totalElements > 0 && totalElements <= 400) {
        editAllBtn.removeAttribute('disabled');
        editAllBtn.className = "hidden sm:inline-block bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold px-2 py-1 rounded transition shadow-sm cursor-pointer";
        editAllBtn.onclick = () => handleEditAllClick(editAllBtn, feats, fetchSectorPointsFn);
    } else {
        editAllBtn.removeAttribute('disabled');
        editAllBtn.className = "hidden sm:inline-block bg-gray-300 text-gray-500 text-xs font-bold px-2 py-1 rounded transition shadow-sm cursor-not-allowed";
        editAllBtn.onclick = (e) => e.preventDefault();
    }
}
