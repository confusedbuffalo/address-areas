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
 * Colour palette for map fills and labels. Red is reserved exclusively for missing/unaddressed items.
 * @type {Array<{fill: string, label: string}>}
 */
export const palette = [
    { fill: '#f3e8ff', label: '#6b21a8' }, // Purple
    { fill: '#e0e7ff', label: '#3730a3' }, // Indigo
    { fill: '#dbeafe', label: '#1e40af' }, // Blue
    { fill: '#e0f2fe', label: '#075985' }, // Sky
    { fill: '#ccfbf1', label: '#115e59' }, // Teal
    { fill: '#dcfce7', label: '#166534' }, // Emerald
    { fill: '#fef9c3', label: '#854d0e' }, // Yellow
    { fill: '#fef3c7', label: '#92400e' }, // Amber
    { fill: '#ffedd5', label: '#9a3412' }  // Orange
];

/**
 * Colour palette entry for missing/unaddressed values.
 * @type {{fill: string, label: string}}
 */
export const missingColor = { fill: '#fee2e2', label: '#991b1b' };

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
