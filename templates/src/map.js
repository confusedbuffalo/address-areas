/**
 * @file map.js
 * @description MapLibre GL map instance initialisation, layer filters, popup management and edit button handler.
 */

import { isPlaceholderExpr, state } from './config.js';
import { getUrlParams, getFeaturesArray, isStreetId, decodeOsmId, buildEnvelopeAddressLines } from './utils.js';

const initialParams = getUrlParams();

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
    const hullLevels = ['postcode_area', 'city', 'suburb', 'street'];
    const isStreet = isStreetId(state.currentLevel);

    let activeLevel = null;
    if (!isStreet) {
        if (state.currentLevel === 'root') {
            activeLevel = 'postcode_area';
        } else {
            const depth = state.currentLevel.split('_').length;
            if (depth === 1) activeLevel = 'city';
            else if (depth === 2) activeLevel = 'suburb';
            else if (depth === 3) activeLevel = 'street';
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
}
