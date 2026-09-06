/**
 * @file config.js
 * @description Application Configuration, shared state object and colour palettes.
 */

/**
 * Global timestamp for address dataset. Fallbacks to current time if window variable is unset.
 * @type {number}
 */
export const DATA_TIMESTAMP = window.DATA_TIMESTAMP || Date.now();

/**
 * Global URLs for address PMTiles datasets per layer.
 * @type {Object<string, string>}
 */
export const PMTILES_URLS = window.PMTILES_URLS || {
    postcode_area: 'pmtiles/postcode_area.pmtiles',
    city: 'pmtiles/city.pmtiles',
    suburb: 'pmtiles/suburb.pmtiles',
    street: 'pmtiles/street.pmtiles',
    points: 'pmtiles/points.pmtiles'
};

/**
 * In-memory cache map for suburb address points JSON data (`{ suburbId: pointsData }`).
 * @type {Object<string, Object>}
 */
export const suburbPointsCache = {};
export const sectorPointsCache = {};

/**
 * Central state object tracking map viewport state, search filters, breadcrumb trails and UI visibility.
 * @type {Object}
 */
export const state = {
    isInitializing: true,
    trail: [{ id: 'root', name: 'UK' }],
    currentLevel: 'root',
    initialPointToSelect: null,
    currentSelectedPoint: null,
    currentSelectedPointTags: null,
    currentSelectedPointName: null,
    showEnvelope: localStorage.getItem('showEnvelope') === 'true',
    activeSection: 'sublevels',
    sidebarVisible: window.innerWidth >= 768,
    currentSortColumn: 'name',
    currentSortDirection: 'asc',
    activeRenderFrameId: null,
    searchActive: false,
    rootSearchIndex: null,
    loadedPostcodeSearchIndices: {},
    searchDebounceTimer: null,
    searchQuery: '',
    searchSelectedIndex: -1,
    searchOnlyCurrentArea: true
};

/**
 * Expression to be used to determine if a placeholder is being represented
 * @type {Array}
 */
export const isPlaceholderExpr = [
    'in',
    ['downcase', ['coalesce', ['get', 'raw_name'], ['get', 'name'], '']],
    ['literal', ['no postcode', 'no city', 'no suburb', 'no street', 'missing', 'unknown']]
];
