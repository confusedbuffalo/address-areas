/**
 * @file main.js
 * @description Application Main Entry Point: initialises map layers, event listeners and initial state.
 */

import { state, PMTILES_URLS, isPlaceholderExpr } from './config.js';
import { updateDataDateElement, getUrlParams, decodeOsmId } from './utils.js';
import { map, popup, updateMapFilters, updateUrlParams, updateEditButton, updateEnvelopeCard } from './map.js';
import { initSidebar } from './sidebar.js';
import { resolveTrailFromUrlParams, loadLayer } from './layers.js';

const initialParams = getUrlParams();
state.initialPointToSelect = initialParams.selectedPoint;

// Expose loadLayer and updateEnvelopeCard globally for inline handlers if necessary
window.loadLayer = loadLayer;
window.updateEnvelopeCard = updateEnvelopeCard;
window.state = state;

// Initialise Date in Footer
updateDataDateElement();
document.addEventListener('DOMContentLoaded', updateDataDateElement);

// Initialise Sidebar responsive layout & handlers
initSidebar();

// Attach URL parameter updates on map move/zoom
map.on('moveend', updateUrlParams);
map.on('zoomend', () => {
    updateUrlParams();
    updateMapFilters();
});
map.on('zoom', updateMapFilters);

function formatPmtilesUrl(url) {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) {
        return `pmtiles://${url}`;
    }
    return url.startsWith('pmtiles://') ? url : `pmtiles://${url}`;
}

// Map layer initialisation
map.on('load', async () => {
    const layersList = ['postcode_area', 'city', 'suburb', 'street', 'points'];
    layersList.forEach(layer => {
        const url = PMTILES_URLS[layer];
        if (url) {
            map.addSource(layer, {
                type: 'vector',
                url: formatPmtilesUrl(url)
            });
        }
    });

    const hullLevels = ['postcode_area', 'city', 'suburb', 'street'];
    hullLevels.forEach(lvl => {
        map.addLayer({
            id: `${lvl}-fill`,
            type: 'fill',
            source: lvl,
            'source-layer': lvl,
            paint: {
                'fill-color': ['get', 'fillColour'],
                'fill-opacity': 0.6
            }
        });

        map.addLayer({
            id: `${lvl}-outline`,
            type: 'line',
            source: lvl,
            'source-layer': lvl,
            paint: {
                'line-color': ['get', 'labelColour'],
                'line-width': 1.5
            }
        });

        map.addLayer({
            id: `${lvl}-label`,
            type: 'symbol',
            source: lvl,
            'source-layer': lvl,
            layout: {
                'text-field': ['get', 'name'],
                'text-size': [
                    'case',
                    isPlaceholderExpr, 10,
                    14
                ],
                'text-anchor': 'center',
                'symbol-sort-key': [
                    'case',
                    isPlaceholderExpr, 2,
                    1
                ]
            },
            paint: {
                'text-color': ['get', 'labelColour'],
                'text-halo-color': '#ffffff',
                'text-halo-width': [
                    'case',
                    isPlaceholderExpr, 1.5,
                    2.5
                ],
                'text-opacity': [
                    'case',
                    isPlaceholderExpr, 0.6,
                    1.0
                ]
            }
        });
    });

    map.addLayer({
        id: 'points-circle',
        type: 'circle',
        source: 'points',
        'source-layer': 'points',
        filter: ['!=', ['get', 'is_cluster'], true],
        paint: {
            'circle-radius': 7,
            'circle-color': ['get', 'labelColour'],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2
        }
    });

    map.addLayer({
        id: 'points-label',
        type: 'symbol',
        source: 'points',
        'source-layer': 'points',
        filter: ['!=', ['get', 'is_cluster'], true],
        layout: {
            'text-field': ['get', 'name'],
            'text-size': 11,
            'text-anchor': 'bottom',
            'text-offset': [0, -1]
        },
        paint: {
            'text-color': ['get', 'labelColour'],
            'text-halo-color': '#ffffff',
            'text-halo-width': 2
        }
    });

    map.addLayer({
        id: 'points-cluster-circles',
        type: 'circle',
        source: 'points',
        'source-layer': 'points',
        filter: ['==', ['get', 'is_cluster'], true],
        paint: {
            'circle-color': ['get', 'labelColour'],
            'circle-radius': [
                'step',
                ['get', 'point_count'],
                15, 10,
                20, 50,
                25, 200,
                30, 400,
                35, 800,
                40
            ],
            'circle-opacity': 0.75
        }
    });

    map.addLayer({
        id: 'points-cluster-counts',
        type: 'symbol',
        source: 'points',
        'source-layer': 'points',
        filter: ['==', ['get', 'is_cluster'], true],
        layout: {
            'text-field': ['to-string', ['get', 'point_count']],
            'text-size': 12
        },
        paint : {
            'text-color': ['get', 'labelColour'],
            'text-halo-color': '#ffffff',
            'text-halo-width': 2,
            'text-halo-blur': 0.5
        }
    });

    state.trail = await resolveTrailFromUrlParams();
    state.currentLevel = state.trail[state.trail.length - 1].id;

    updateMapFilters();

    const lastItem = state.trail[state.trail.length - 1];
    await loadLayer(lastItem.id, lastItem.name, { isInitialLoad: true });

    state.isInitializing = false;
    updateUrlParams();
});

// Map click handlers
map.on('click', (e) => {
    const pointFeatures = map.getLayer('points-circle') && map.getLayoutProperty('points-circle', 'visibility') !== 'none'
        ? map.queryRenderedFeatures(e.point, { layers: ['points-circle'] })
        : [];
    if (pointFeatures.length === 0 && popup.isOpen()) {
        popup.remove();
    }

    const visibleFillLayers = ['postcode_area-fill', 'city-fill', 'suburb-fill', 'street-fill']
        .filter(l => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');

    if (visibleFillLayers.length === 0) return;
    const features = map.queryRenderedFeatures(e.point, { layers: visibleFillLayers });
    if (features.length > 0) {
        const feature = features[0];
        const props = feature.properties;
        if (props.child_id) {
            loadLayer(props.child_id, props.raw_name || props.name, { feature: feature, preventZoomOut: true });
        }
    }
});

map.on('click', 'points-cluster-circles', (e) => {
    if (!e.features || !e.features.length) return;

    const feature = e.features[0];
    const coordinates = feature.geometry.coordinates.slice();

    while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) {
        coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360;
    }

    const currentZoom = map.getZoom();
    const targetZoom = Math.min(currentZoom + 2.5, map.getMaxZoom());

    map.flyTo({
        center: coordinates,
        zoom: targetZoom,
        speed: 1.2,
        curve: 1.4,
        essential: true
    });
});

let isSelectingPoint = false;

map.on('click', 'points-circle', (e) => {
    if (e.features.length === 0) return;
    isSelectingPoint = true;
    const feature = e.features[0];
    const coordinates = feature.geometry.coordinates.slice();
    const properties = feature.properties;

    if (properties.parent_id && properties.parent_id !== state.currentLevel) {
        loadLayer(properties.parent_id, null, { preserveViewport: true });
    }

    state.currentSelectedPoint = {
        osm_id: properties.osm_id,
        lat: coordinates[1],
        lng: coordinates[0]
    };
    updateUrlParams();
    updateEditButton();

    let popup_tags = properties.popup_tags;
    if (typeof popup_tags === 'string') {
        try {
            popup_tags = JSON.parse(popup_tags);
        } catch (err) {
            popup_tags = {};
        }
    }

    const keysOrder = [
        'addr:floor', 'addr:unit', 'addr:flats', 'addr:housename',
        'addr:housenumber', 'addr:street', 'addr:place', 'addr:parentstreet',
        'addr:suburb', 'addr:locality', 'addr:hamlet', 'addr:village',
        'addr:town', 'addr:city', 'addr:postcode'
    ];

    let content = '';
    keysOrder.forEach(key => {
        if (popup_tags && popup_tags[key] !== undefined && popup_tags[key] !== null && popup_tags[key] !== '') {
            content += `<div class="leading-tight py-0.5"><span class="font-bold text-slate-900">${key}:</span> <span class="text-slate-700 font-medium">${popup_tags[key]}</span></div>`;
        }
    });

    if (content === '') {
        content = '<div class="text-slate-500">No address tags.</div>';
    }

    let titleHtml = '';
    if (properties.osm_name) {
        titleHtml = `<div class="font-bold text-sm text-slate-950 border-b border-slate-200 pb-1 mb-1.5">${properties.osm_name}</div>`;
    }

    let osmLinkHtml = '';
    if (properties.osm_id) {
        const decoded = decodeOsmId(properties.osm_id);
        if (decoded) {
            const osmUrl = `https://www.openstreetmap.org/${decoded.fullType}/${decoded.id}`;
            osmLinkHtml = `<div class="pt-2 border-t border-slate-200 mt-1"><a href="${osmUrl}" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline font-semibold">${properties.osm_id}</a></div>`;
        }
    }

    while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) {
        coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360;
    }

    popup.setLngLat(coordinates)
        .setHTML(`<div class="p-1 space-y-1 text-xs font-sans max-w-xs">${titleHtml}${content}${osmLinkHtml}</div>`)
        .addTo(map);

    updateEnvelopeCard(popup_tags, properties.osm_name || '');

    setTimeout(() => {
        isSelectingPoint = false;
    }, 0);
});

// Map hover & Popup close handlers
map.on('mousemove', (e) => {
    const activeLayers = ['postcode_area-fill', 'city-fill', 'suburb-fill', 'street-fill', 'points-circle', 'points-cluster-circles', 'points-cluster-counts']
        .filter(l => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');

    if (activeLayers.length === 0) {
        map.getCanvas().style.cursor = '';
        return;
    }

    const features = map.queryRenderedFeatures(e.point, { layers: activeLayers });
    map.getCanvas().style.cursor = features.length ? 'pointer' : '';
});

popup.on('close', () => {
    if (isSelectingPoint) return;
    state.currentSelectedPoint = null;
    state.currentSelectedPointTags = null;
    state.currentSelectedPointName = null;
    updateEnvelopeCard();
    updateUrlParams();
    updateEditButton();
});

// Edit Button Listeners
map.on('move', updateEditButton);
map.on('zoom', updateEditButton);
map.on('load', updateEditButton);

const editBtnElement = document.getElementById('edit-btn');
if (editBtnElement) {
    editBtnElement.addEventListener('click', (e) => {
        if (!editBtnElement.hasAttribute('href') || map.getZoom() < 15) {
            e.preventDefault();
        }
    });
}
