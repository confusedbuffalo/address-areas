/**
 * @file map.js
 * @description MapLibre GL map instance initialisation, layer filters, popup management and edit button handler.
 */

import { isPlaceholderExpr, state } from './config.js';
import { getUrlParams, getFeaturesArray, isStreetId, decodeOsmId, buildEnvelopeAddressLines } from './utils.js';

const initialParams = getUrlParams();
let activePinnedAttrRow = null;

/**
 * In-memory cache for fetched Wikidata etymology HTML results.
 * @type {Map<string, string>}
 */
export const etymologyCache = new Map();

export function updateStreetGeomHighlight(attrKey = null, pctMap = null) {
    if (!map || !map.getLayer('street-geom-line')) return;

    if (!attrKey || !pctMap) {
        map.setPaintProperty('street-geom-line', 'line-color', '#2563eb');
        return;
    }

    const entries = Object.entries(pctMap).filter(([_, v]) => v > 0);
    entries.sort(([a], [b]) => (a === "unknown") - (b === "unknown"));

    const TAG_COLOUR_MAP = {
        lit: { 'yes': '#10b981', 'no': '#1e293b', 'unknown': '#f43f5e' }
    };
    const DEFAULT_SEGMENT_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#14b8a6', '#ec4899', '#94a3b8'];

    const matchCases = ['match', ['get', attrKey]];
    entries.forEach(([val], idx) => {
        let hexColor = TAG_COLOUR_MAP[attrKey]?.[val];
        if (!hexColor) {
            hexColor = val === 'unknown' ? '#f43f5e' : DEFAULT_SEGMENT_COLORS[idx % DEFAULT_SEGMENT_COLORS.length];
        }
        matchCases.push(val, hexColor);
    });

    // Default color for empty / unset values: greyed out
    matchCases.push('#94a3b8');

    map.setPaintProperty('street-geom-line', 'line-color', matchCases);
}

// Register the PMTiles protocol
if (typeof pmtiles !== 'undefined' && typeof maplibregl !== 'undefined') {
    let protocol = new pmtiles.Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);
}

const mapOptions = {
    container: 'map',
    style: "https://tiles.openfreemap.org/styles/positron"
};

if (initialParams.lng !== null && initialParams.lat !== null) {
    mapOptions.center = [initialParams.lng, initialParams.lat];
    mapOptions.zoom = initialParams.zoom !== null ? initialParams.zoom : 10;
} else if (typeof window !== 'undefined' && window.INITIAL_BOUNDS) {
    mapOptions.bounds = window.INITIAL_BOUNDS;
    mapOptions.fitBoundsOptions = { padding: 40 };
} else {
    mapOptions.center = [-1.57, 54.77];
    mapOptions.zoom = 10;
}

/**
 * Global MapLibre GL map instance.
 * @type {maplibregl.Map}
 */
export const map = (typeof maplibregl !== 'undefined') ? new maplibregl.Map(mapOptions) : null;

if (map) {
    map.on('load', () => {
        if (typeof window !== 'undefined' && window.PMTILES_URLS && window.PMTILES_URLS['street_geom']) {
            const sourceId = 'src-street_geom';
            if (!map.getSource(sourceId)) {
                map.addSource(sourceId, {
                    type: 'vector',
                    url: `pmtiles://${window.PMTILES_URLS['street_geom']}`
                });
            }
            if (map.getSource(sourceId) && !map.getLayer('street-geom-line')) {
                map.addLayer({
                    id: 'street-geom-line',
                    type: 'line',
                    source: sourceId,
                    'source-layer': 'street_geom',
                    layout: {
                        'line-cap': 'round',
                        'line-join': 'round',
                        'visibility': 'none'
                    },
                    paint: {
                        'line-color': '#2563eb',
                        'line-width': 4,
                        'line-opacity': 0.85
                    }
                });
            }
        }
    });
}

/**
 * Global Popup instance for map feature inspection.
 * @type {maplibregl.Popup}
 */
export const popup = (typeof maplibregl !== 'undefined') ? new maplibregl.Popup({
    closeButton: true,
    closeOnClick: false
}) : null;

/**
 * Calculates geographical LngLatBounds covering features in a dataset.
 *
 * @param {Object|Array<Object>} data - Feature collection or feature array.
 * @returns {maplibregl.LngLatBounds} Bounding box for features.
 */
export function getLayerBounds(data) {
    const bounds = new maplibregl.LngLatBounds();
    const features = getFeaturesArray(data);
    features.forEach(f => {
        const props = f.properties || f;
        if (props.bbox) {
            bounds.extend([props.bbox[0], props.bbox[1]]);
            bounds.extend([props.bbox[2], props.bbox[3]]);
        } else if (props.coords) {
            bounds.extend(props.coords);
        }
    });
    return bounds;
}

/**
 * Calculates geographical LngLatBounds covering a feature, feature properties or a bbox array [minLng, minLat, maxLng, maxLat].
 *
 * @param {Object|Array<number>} featureOrBbox - Feature object or bbox array.
 * @returns {maplibregl.LngLatBounds|null} Bounding box for feature or null.
 */
export function getFeatureBounds(featureOrBbox) {
    if (!featureOrBbox) return null;
    const bounds = new maplibregl.LngLatBounds();

    if (Array.isArray(featureOrBbox) && featureOrBbox.length === 4) {
        bounds.extend([featureOrBbox[0], featureOrBbox[1]]);
        bounds.extend([featureOrBbox[2], featureOrBbox[3]]);
        return bounds;
    }

    const props = featureOrBbox.properties || featureOrBbox;
    if (props.bbox && Array.isArray(props.bbox) && props.bbox.length === 4) {
        bounds.extend([props.bbox[0], props.bbox[1]]);
        bounds.extend([props.bbox[2], props.bbox[3]]);
        return bounds;
    }

    if (props.coords && Array.isArray(props.coords) && props.coords.length === 2) {
        bounds.extend(props.coords);
        return bounds;
    }

    return null;
}

/**
 * Updates MapLibre layer filter expressions and paint properties based on state.currentLevel and map zoom.
 */
export function updateMapFilters() {
    const hullLevels = ['postcode_area', 'city', 'suburb', 'street_area'];
    const isStreet = isStreetId(state.currentLevel);

    let activeLevel = null;
    if (!isStreet) {
        if (state.currentLevel === 'root') {
            activeLevel = 'postcode_area';
        } else {
            const depth = state.currentLevel.split('_').length;
            if (depth === 1) activeLevel = 'city';
            else if (depth === 2) activeLevel = 'suburb';
            else if (depth === 3) activeLevel = 'street_area';
        }
    }

    // --- Hull levels visibility and filters ---
    hullLevels.forEach(lvl => {
        const fillId = `${lvl}-fill`;
        const outlineId = `${lvl}-outline`;
        const labelId = `${lvl}-label`;

        if (!map.getLayer(fillId)) return;

        if (lvl === activeLevel) {
            map.setLayoutProperty(fillId, 'visibility', 'visible');
            map.setLayoutProperty(outlineId, 'visibility', 'visible');
            map.setLayoutProperty(labelId, 'visibility', 'visible');

            const isActive = ['==', ['get', 'parent_id'], state.currentLevel];

            map.setPaintProperty(fillId, 'fill-color', [
                'case',
                isActive, ['get', 'fillColour'],
                '#e2e8f0'
            ]);
            map.setPaintProperty(fillId, 'fill-opacity', [
                'case',
                isActive, 0.6,
                0.5
            ]);

            map.setPaintProperty(outlineId, 'line-color', [
                'case',
                isActive, ['get', 'labelColour'],
                '#94a3b8'
            ]);
            map.setPaintProperty(outlineId, 'line-width', [
                'case',
                isActive, 1.5,
                0.75
            ]);

            map.setLayoutProperty(labelId, 'text-size', [
                'case',
                isPlaceholderExpr, 10,
                14
            ]);
            map.setPaintProperty(labelId, 'text-color', [
                'case',
                isActive, ['get', 'labelColour'],
                '#64748b'
            ]);
            map.setPaintProperty(labelId, 'text-halo-width', [
                'case',
                isActive, ['case', isPlaceholderExpr, 1.5, 2.5],
                1.5
            ]);
            map.setPaintProperty(labelId, 'text-opacity', [
                'case',
                isActive, ['case', isPlaceholderExpr, 0.6, 1.0],
                1.0
            ]);
        } else {
            map.setLayoutProperty(fillId, 'visibility', 'none');
            map.setLayoutProperty(outlineId, 'visibility', 'none');
            map.setLayoutProperty(labelId, 'visibility', 'none');
        }
    });

    // --- Points level visibility and filters ---
    const pointLayers = ['points-circle', 'points-label', 'points-cluster-circles', 'points-cluster-counts'];
    if (!map.getLayer('points-circle')) return;

    if (isStreet) {
        pointLayers.forEach(l => map.setLayoutProperty(l, 'visibility', 'visible'));

        const currentZoom = map.getZoom();
        const showAllPoints = currentZoom >= 17;

        if (showAllPoints) {
            // At zoom >= 17 on street level, show points from all areas
            map.setFilter('points-circle', ['!=', ['get', 'is_cluster'], true]);
            map.setFilter('points-label', ['!=', ['get', 'is_cluster'], true]);

            const isActive = ['==', ['get', 'parent_id'], state.currentLevel];

            // Active points keep labelColour; out-of-area points are grey (#94a3b8)
            map.setPaintProperty('points-circle', 'circle-color', [
                'case',
                isActive, ['get', 'labelColour'],
                '#94a3b8'
            ]);

            // Active points full opacity; out-of-area points faded (0.45)
            map.setPaintProperty('points-circle', 'circle-opacity', [
                'case',
                isActive, 1.0,
                0.45
            ]);

            map.setPaintProperty('points-circle', 'circle-stroke-opacity', [
                'case',
                isActive, 1.0,
                0.45
            ]);

            map.setPaintProperty('points-label', 'text-color', [
                'case',
                isActive, ['get', 'labelColour'],
                '#64748b'
            ]);

            map.setPaintProperty('points-label', 'text-opacity', [
                'case',
                isActive, 1.0,
                0.55
            ]);
        } else {
            // Standard filtering: only points matching state.currentLevel
            map.setFilter('points-circle', [
                'all',
                ['==', ['get', 'parent_id'], state.currentLevel],
                ['!=', ['get', 'is_cluster'], true]
            ]);

            map.setFilter('points-label', [
                'all',
                ['==', ['get', 'parent_id'], state.currentLevel],
                ['!=', ['get', 'is_cluster'], true]
            ]);

            map.setPaintProperty('points-circle', 'circle-color', ['get', 'labelColour']);
            map.setPaintProperty('points-circle', 'circle-opacity', 1.0);
            map.setPaintProperty('points-circle', 'circle-stroke-opacity', 1.0);
            map.setPaintProperty('points-label', 'text-color', ['get', 'labelColour']);
            map.setPaintProperty('points-label', 'text-opacity', 1.0);
        }

        // --- Point Clusters ---
        const searchNeedle = `,${state.currentLevel},`;
        const paddedParentId = ['concat', ',', ['coalesce', ['get', 'parent_id'], ''], ','];

        const clusterFilter = [
            'all',
            ['==', ['get', 'is_cluster'], true],
            ['in', searchNeedle, paddedParentId]
        ];

        map.setFilter('points-cluster-circles', clusterFilter);
        map.setFilter('points-cluster-counts', clusterFilter);
    } else {
        pointLayers.forEach(l => map.setLayoutProperty(l, 'visibility', 'none'));
    }

    // --- Physical Street Line Highlight Layer ---
    if (map.getLayer('street-geom-line')) {
        const isStreet = isStreetId(state.currentLevel) || (state.currentLevel && state.currentLevel.split('_').length === 4);
        if (isStreet) {
            const streetId = state.currentLevel.split('_').slice(0, 4).join('_');
            map.setLayoutProperty('street-geom-line', 'visibility', 'visible');
            map.setFilter('street-geom-line', ['==', ['get', 'child_id'], streetId]);
        } else {
            map.setLayoutProperty('street-geom-line', 'visibility', 'none');
        }
    }
}

/**
 * Updates URL search query parameters with current latitude, longitude, zoom level and selected point/area ID.
 */
export function updateUrlParams() {
    if (state.isInitializing) return;
    const center = map.getCenter();
    const zoom = map.getZoom();
    const params = new URLSearchParams();
    params.set('lat', center.lat.toFixed(6));
    params.set('lng', center.lng.toFixed(6));
    params.set('zoom', zoom.toFixed(2));

    if (state.currentLevel && state.currentLevel !== 'root') {
        params.set('id', state.currentLevel);
    } else {
        params.delete('id');
    }

    if (state.currentSelectedPoint && state.currentSelectedPoint.osm_id) {
        params.set('point', state.currentSelectedPoint.osm_id);
    }
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, '', newUrl);
}

/**
 * Updates the 'Edit' button in the top header based on zoom level and selected point.
 */
export function updateEditButton() {
    const editBtn = document.getElementById('edit-btn');
    if (!editBtn) return;

    const zoom = map.getZoom();
    const center = map.getCenter();
    const lat = center.lat;
    const lng = center.lng;
    const roundedZoom = Math.round(zoom);

    let osmUrl = "";
    if (state.currentSelectedPoint && state.currentSelectedPoint.osm_id) {
        const decoded = decodeOsmId(state.currentSelectedPoint.osm_id);
        if (decoded) {
            osmUrl = `https://www.openstreetmap.org/edit?${decoded.fullType}=${decoded.id}#map=${roundedZoom}/${lat.toFixed(6)}/${lng.toFixed(6)}`;
        } else {
            osmUrl = `https://www.openstreetmap.org/edit#map=${roundedZoom}/${lat.toFixed(6)}/${lng.toFixed(6)}`;
        }
    } else {
        osmUrl = `https://www.openstreetmap.org/edit#map=${roundedZoom}/${lat.toFixed(6)}/${lng.toFixed(6)}`;
    }

    if (zoom >= 15) {
        editBtn.href = osmUrl;
        editBtn.className = "bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded text-sm font-semibold transition shadow-sm cursor-pointer";
        editBtn.style.pointerEvents = "";
        editBtn.removeAttribute('title');
    } else {
        editBtn.removeAttribute('href');
        editBtn.className = "bg-blue-600 text-white px-4 py-1.5 rounded text-sm font-semibold opacity-50 cursor-not-allowed transition shadow-sm";
        editBtn.style.pointerEvents = "";
        editBtn.setAttribute('title', 'Zoom in to edit');
    }
}

/**
 * Updates or hides the envelope info card overlay based on current state and selected point tags.
 *
 * @param {Object} [popup_tags] - Optional popup tags object for the selected point.
 * @param {string} [osm_name] - Optional feature name string.
 */
export function updateEnvelopeCard(popup_tags, osm_name) {
    const card = document.getElementById('envelope-card');
    const streetCard = document.getElementById('street-info-card');
    const container = document.getElementById('envelope-address');
    if (!card || !container) return;

    if (popup_tags !== undefined) {
        state.currentSelectedPointTags = popup_tags;
    }
    if (osm_name !== undefined) {
        state.currentSelectedPointName = osm_name;
    }

    if (!state.showEnvelope || !state.currentSelectedPoint) {
        card.classList.add('hidden');
        if (state.activeStreetInfo && streetCard) {
            streetCard.classList.remove('hidden');
        }
        return;
    }

    const lines = buildEnvelopeAddressLines(
        state.currentSelectedPointTags || {},
        state.currentSelectedPointName || ''
    );
    if (lines.length === 0) {
        container.innerHTML = '<div class="text-slate-500 italic">No address tags.</div>';
    } else {
        container.innerHTML = lines.map(line => `<div>${line}</div>`).join('');
    }

    card.classList.remove('hidden');
    if (streetCard) {
        streetCard.classList.add('hidden');
    }
}

/**
 * Renders or hides the collapsible Street Information card panel in the sidebar.
 *
 * @param {Object|null} streetInfo - Street attribute aggregation object.
 * @param {string} [streetName=''] - Street display name string.
 */
export function renderStreetInfoCard(streetInfo, streetName = '') {
    const container = document.getElementById('street-info-card');
    if (!container) return;

    if (!streetInfo || typeof streetInfo !== 'object' || streetInfo.has_physical_road === undefined) {
        container.classList.add('hidden');
        container.innerHTML = '';
        return;
    }

    container.classList.remove('hidden');

    if (streetInfo.has_physical_road === false) {
        container.innerHTML = `
            <div class="p-3 bg-amber-50 border-b border-amber-200 text-amber-900 text-xs flex items-center gap-2 font-medium">
                <span class="text-amber-600 text-base">⚠️</span>
                <span>No nearby physical road found in OpenStreetMap</span>
            </div>
        `;
        return;
    }

    state.activeStreetInfo = streetInfo;

    // Check if envelope card is currently showing
    const envelopeCard = document.getElementById('envelope-card');
    if (envelopeCard && !envelopeCard.classList.contains('hidden')) {
        container.classList.add('hidden');
        return;
    }

    const totalLen = streetInfo.total_length_m ? `${streetInfo.total_length_m.toLocaleString()} m` : '';

    const buildBar = (attrKey, label, pctMap) => {
        if (!pctMap || typeof pctMap !== 'object') return '';
        const entries = Object.entries(pctMap).filter(([_, v]) => v > 0);
        if (entries.length === 0) return '';

        // Unknown values should always show last
        entries.sort(([a], [b]) => (a === "unknown") - (b === "unknown"));

        const TAG_COLOUR_MAP = {
            lit: { 'yes': 'bg-emerald-500', 'no': 'bg-slate-800', 'unknown': 'bg-rose-400' }
        };
        const DEFAULT_SEGMENT_COLORS = ['bg-blue-500', 'bg-emerald-500', 'bg-amber-500', 'bg-purple-500', 'bg-teal-500', 'bg-pink-500', 'bg-slate-400'];

        const segments = [];
        const legendParts = [];

        entries.forEach(([val, pct], idx) => {
            let colorClass = TAG_COLOUR_MAP[attrKey]?.[val];
            if (!colorClass) {
                colorClass = val === 'unknown' ? 'bg-rose-400' : DEFAULT_SEGMENT_COLORS[idx % DEFAULT_SEGMENT_COLORS.length];
            }

            let displayVal = val;
            if (attrKey === 'lit') {
                if (val === 'yes') displayVal = 'lit';
                else if (val === 'no') displayVal = 'unlit';
            }

            segments.push(`<div class="${colorClass} h-2" style="width: ${pct}%;" title="${displayVal}: ${pct}%"></div>`);
            legendParts.push(`<span class="inline-flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full ${colorClass} inline-block shrink-0"></span>${displayVal} (${pct}%)</span>`);
        });

        return `
            <div class="street-info-row flex flex-col gap-1 text-[11px] cursor-pointer p-1.5 rounded transition-colors hover:bg-gray-100 select-none" data-attr="${attrKey}">
                <div class="flex justify-between items-center text-gray-700 font-medium">
                    <span class="font-bold text-slate-700">${label}</span>
                </div>
                <div class="w-full bg-gray-100 rounded-full h-2 overflow-hidden flex shadow-inner">
                    ${segments.join('')}
                </div>
                <div class="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-gray-600">
                    ${legendParts.join(' ')}
                </div>
            </div>
        `;
    };

    activePinnedAttrRow = null;
    updateStreetGeomHighlight(null, null);

    const highwayBar = buildBar('highway', 'Highway Type', streetInfo.highway);
    const surfaceBar = buildBar('surface', 'Surface', streetInfo.surface);
    const litBar = buildBar('lit', 'Lighting', streetInfo.lit);
    const maxspeedBar = buildBar('maxspeed', 'Speed Limit', streetInfo.maxspeed);
    const lanesBar = buildBar('lanes', 'Lanes', streetInfo.lanes);
    const sidewalkBar = buildBar('sidewalk', 'Pavement', streetInfo.sidewalk);

    let etymologyCardHtml = '';
    if (!streetInfo.wikidata) {
        etymologyCardHtml = `
            <div id="wikidata-etymology-card" class="border-t border-gray-200 pt-2.5 flex flex-col gap-1">
                <div class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Named after</div>
                <div class="text-xs text-slate-500 italic mt-0.5">Unknown etymology</div>
            </div>
        `;
    } else if (etymologyCache.has(streetInfo.wikidata)) {
        const cachedContent = etymologyCache.get(streetInfo.wikidata);
        etymologyCardHtml = `
            <div id="wikidata-etymology-card" data-wikidata-id="${streetInfo.wikidata}" class="border-t border-gray-200 pt-2.5 flex flex-col gap-1">
                ${cachedContent}
            </div>
        `;
    } else {
        etymologyCardHtml = `
            <div id="wikidata-etymology-card" data-wikidata-id="${streetInfo.wikidata}" class="border-t border-gray-200 pt-2.5 flex flex-col gap-1">
                <div class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Named after</div>
                <div class="flex items-start gap-2.5 mt-1 bg-slate-50 p-2 rounded border border-slate-200 animate-pulse">
                    <div class="w-12 h-12 bg-slate-200 rounded shrink-0"></div>
                    <div class="flex flex-col gap-1.5 min-w-0 flex-1 py-1">
                        <div class="h-3 bg-slate-200 rounded w-1/2"></div>
                        <div class="h-2.5 bg-slate-200 rounded w-5/6"></div>
                    </div>
                </div>
            </div>
        `;
    }

    let html = `
        <div class="p-4 flex flex-col gap-3 text-xs text-gray-800">
            <div class="flex items-center justify-between border-b border-gray-200 pb-2">
                <span class="font-bold text-slate-900 text-sm">${streetName || 'Street Info'}</span>
                ${totalLen ? `<span class="font-semibold text-slate-500 text-xs">${totalLen}</span>` : ''}
            </div>
            <div class="flex flex-col gap-2.5">
                ${highwayBar}
                ${surfaceBar}
                ${litBar}
                ${maxspeedBar}
                ${lanesBar}
                ${sidewalkBar}
            </div>
            ${etymologyCardHtml}
        </div>
    `;

    container.innerHTML = html;

    const rowEls = container.querySelectorAll('.street-info-row');
    rowEls.forEach(rowEl => {
        const attrKey = rowEl.dataset.attr;
        const pctMap = streetInfo[attrKey];
        if (!pctMap) return;

        rowEl.addEventListener('mouseenter', () => {
            updateStreetGeomHighlight(attrKey, pctMap);
        });

        rowEl.addEventListener('mouseleave', () => {
            if (activePinnedAttrRow) {
                const pinnedAttr = activePinnedAttrRow.dataset.attr;
                const pinnedMap = streetInfo[pinnedAttr];
                updateStreetGeomHighlight(pinnedAttr, pinnedMap);
            } else {
                updateStreetGeomHighlight(null, null);
            }
        });

        rowEl.addEventListener('click', () => {
            if (activePinnedAttrRow === rowEl) {
                activePinnedAttrRow.classList.remove('bg-blue-50', 'ring-1', 'ring-blue-400');
                activePinnedAttrRow = null;
                updateStreetGeomHighlight(null, null);
            } else {
                if (activePinnedAttrRow) {
                    activePinnedAttrRow.classList.remove('bg-blue-50', 'ring-1', 'ring-blue-400');
                }
                activePinnedAttrRow = rowEl;
                activePinnedAttrRow.classList.add('bg-blue-50', 'ring-1', 'ring-blue-400');
                updateStreetGeomHighlight(attrKey, pctMap);
            }
        });
    });

    if (streetInfo.wikidata && !etymologyCache.has(streetInfo.wikidata)) {
        fetchWikidataEtymology(streetInfo.wikidata);
    }
}

/**
 * Fetches Wikidata etymology details asynchronously via the Wikidata REST API.
 *
 * @param {string} wikidataId - Wikidata Q-identifier string (e.g. 'Q1234').
 */
export async function fetchWikidataEtymology(wikidataId) {
    const etymCard = document.getElementById('wikidata-etymology-card');
    if (!etymCard || !wikidataId) return;

    if (etymologyCache.has(wikidataId)) {
        const cachedHtml = etymologyCache.get(wikidataId);
        etymCard.classList.remove('hidden');
        etymCard.innerHTML = cachedHtml;
        return;
    }

    try {
        const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${wikidataId}&format=json&props=labels|descriptions|claims&languages=en&origin=*`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const entity = data?.entities?.[wikidataId];
        if (!entity) throw new Error('Entity not found');

        const label = entity.labels?.en?.value || wikidataId;
        const description = entity.descriptions?.en?.value || '';

        let imgUrl = '';
        if (entity.claims?.P18?.[0]?.mainsnak?.datavalue?.value) {
            const fileName = entity.claims.P18[0].mainsnak.datavalue.value;
            try {
                const commonsUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=File:${encodeURIComponent(fileName)}&prop=imageinfo&iiprop=url&iiurlwidth=120&format=json&origin=*`;
                const cRes = await fetch(commonsUrl);
                if (cRes.ok) {
                    const cData = await cRes.json();
                    const pages = cData?.query?.pages;
                    if (pages) {
                        const pageObj = Object.values(pages)[0];
                        if (pageObj?.imageinfo?.[0]?.thumburl) {
                            imgUrl = pageObj.imageinfo[0].thumburl;
                        }
                    }
                }
            } catch (cErr) {
                console.warn(`Failed loading Commons thumbnail for ${fileName}:`, cErr);
            }
        }

        const html = `
            <div class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Named after</div>
            <div class="flex items-start gap-2.5 mt-1 bg-slate-50 p-2 rounded border border-slate-200">
                ${imgUrl ? `<img src="${imgUrl}" alt="${label}" class="w-12 h-12 object-cover rounded shadow-xs shrink-0 border border-slate-300" />` : ''}
                <div class="flex flex-col min-w-0">
                    <a href="https://www.wikidata.org/wiki/${wikidataId}" target="_blank" rel="noopener noreferrer" class="font-bold text-blue-600 hover:underline text-xs truncate">
                        ${label}
                    </a>
                    ${description ? `<span class="text-[11px] text-gray-600 leading-tight line-clamp-2">${description}</span>` : ''}
                </div>
            </div>
        `;

        etymologyCache.set(wikidataId, html);

        const currentCard = document.getElementById('wikidata-etymology-card');
        if (currentCard && currentCard.dataset.wikidataId === wikidataId) {
            currentCard.classList.remove('hidden');
            currentCard.innerHTML = html;
        }
    } catch (err) {
        console.warn(`Failed loading Wikidata etymology for ${wikidataId}:`, err);
        const fallbackHtml = `
            <div class="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Named after</div>
            <div class="text-xs text-slate-500 italic mt-0.5">Unknown etymology</div>
        `;
        etymologyCache.set(wikidataId, fallbackHtml);

        const currentCard = document.getElementById('wikidata-etymology-card');
        if (currentCard && currentCard.dataset.wikidataId === wikidataId) {
            currentCard.classList.remove('hidden');
            currentCard.innerHTML = fallbackHtml;
        }
    }
}
