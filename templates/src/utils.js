/**
 * @file utils.js
 * @description General utility functions for string comparison, data formatting, URL parameter parsing and toast notifications.
 */

import { DATA_TIMESTAMP } from './config.js';

/**
 * Formats a Unix timestamp (in milliseconds) into a localised date/time string.
 *
 * @param {number} timestamp - Unix timestamp in milliseconds.
 * @returns {string} Formatted date string.
 */
export function formatDataDate(timestamp) {
    try {
        const date = new Date(timestamp);
        return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(date);
    } catch (e) {
        console.error("Error formatting data date:", e);
        return new Date(timestamp).toLocaleString();
    }
}

/**
 * Updates the 'data-date' element in the sidebar footer with the formatted timestamp.
 */
export function updateDataDateElement() {
    const dateEl = document.getElementById('data-date');
    if (dateEl) {
        dateEl.innerText = formatDataDate(DATA_TIMESTAMP);
    }
}

/**
 * Parses query parameters from the current window location search string.
 *
 * @returns {{lat: number|null, lng: number|null, zoom: number|null, selectedPoint: string|null, id: string|null}} Parsed parameters.
 */
export function getUrlParams() {
    if (typeof window === 'undefined' || !window.location) {
        return { lat: null, lng: null, zoom: null, selectedPoint: null, id: null };
    }
    const params = new URLSearchParams(window.location.search);
    const lat = parseFloat(params.get('lat'));
    const lng = parseFloat(params.get('lng'));
    const zoom = parseFloat(params.get('zoom'));
    const selectedPoint = params.get('point');
    const id = params.get('id');

    return {
        lat: isNaN(lat) ? null : lat,
        lng: isNaN(lng) ? null : lng,
        zoom: isNaN(zoom) ? null : zoom,
        selectedPoint: selectedPoint || null,
        id: id || null
    };
}

/**
 * Checks whether a given identifier string represents a street level ID (4 underscore-separated parts).
 *
 * @param {string} dataId - The identifier string to check.
 * @returns {boolean} True if ID is street-level.
 */
export function isStreetId(dataId) {
    if (!dataId || dataId === 'root') return false;
    return dataId.split('_').length === 4;
}

/**
 * Extracts the parent suburb ID for a given street ID string.
 *
 * @param {string} dataId - Street or child identifier string.
 * @returns {string} Parent suburb identifier string.
 */
export function getSuburbIdForStreet(dataId) {
    if (!dataId) return '';
    const parts = dataId.split('_');
    if (parts.length === 4) {
        return parts.slice(0, 3).join('_');
    }
    return dataId;
}

/**
 * Extracts the parent city ID for a given suburb ID string.
 *
 * @param {string} suburbId - Suburb identifier string.
 * @returns {string} Parent city identifier string.
 */
export function getCityIdForSuburb(suburbId) {
    if (!suburbId) return '';
    const parts = suburbId.split('_');
    if (parts.length >= 3) {
        return parts.slice(0, 2).join('_');
    }
    return suburbId;
}

/**
 * Returns the letter key partition for a city name.
 *
 * @param {string} cityName - City display or raw name.
 * @returns {string} Letter partition key ('a'-'z', 'no-city', or 'other').
 */
export function getCityLetterKey(cityName) {
    if (!cityName || isMissingValue(cityName) || cityName.trim().toLowerCase() === 'no city') {
        return 'no-city';
    }
    const clean = cityName.trim();
    const firstChar = clean.length > 0 ? clean[0].toLowerCase() : '';
    if (firstChar >= 'a' && firstChar <= 'z') {
        return firstChar;
    }
    return 'other';
}

/**
 * Decodes a single compact hierarchy tuple array into a feature object.
 *
 * @param {Array<*>|Object} item - Compact hierarchy tuple array or object.
 * @returns {Object} Decoded hierarchy feature object.
 */
export function decodeHierarchyItem(item) {
    if (!Array.isArray(item)) return item;
    const level = item[2];
    const obj = {
        name: item[0],
        raw_name: item[1],
        level: level,
        child_id: item[3],
        count: item[4],
        addr_perc: item[5],
        bbox: item[6]
    };
    if (item[7] && Array.isArray(item[7])) {
        if (level === 'city') {
            obj.suburbs = item[7].map(decodeHierarchyItem);
        } else if (level === 'suburb') {
            obj.streets = item[7].map(decodeHierarchyItem);
        } else if (level === 'street') {
            obj.sector_ids = item[7];
        } else {
            obj.children = item[7].map(decodeHierarchyItem);
        }
    }
    return obj;
}

/**
 * Decodes an array of compact hierarchy feature tuples into an array of feature objects.
 *
 * @param {Array<*>|Object} data - Compact hierarchy data.
 * @returns {Array<Object>} Decoded array of feature objects.
 */
export function decodeHierarchyData(data) {
    if (!data) return [];
    if (!Array.isArray(data)) return data;
    return data.map(decodeHierarchyItem);
}

/**
 * Decodes a single compact point tuple array into a point feature object.
 *
 * @param {Array<*>|Object} item - Compact point tuple array or object.
 * @returns {Object} Decoded point object.
 */
export function decodePointItem(item) {
    if (!Array.isArray(item)) return item;
    return {
        name: item[0],
        postcode: item[1],
        level: 'points',
        osm_id: item[2],
        coords: item[3]
    };
}

/**
 * Decodes a dictionary mapping street IDs to compact point tuple arrays.
 *
 * @param {Object} data - Dictionary of street point tuple arrays.
 * @returns {Object<string, Array<Object>>} Decoded dictionary mapping street IDs to point objects.
 */
export function decodePointsData(data) {
    if (!data || typeof data !== 'object') return {};
    const decoded = {};
    for (const [streetId, points] of Object.entries(data)) {
        decoded[streetId] = Array.isArray(points) ? points.map(decodePointItem) : points;
    }
    return decoded;
}

/**
 * Normalises input data into an array of feature objects.
 *
 * @param {Object|Array} data - Raw data array or GeoJSON object.
 * @returns {Array<Object>} Array of feature objects.
 */
export function getFeaturesArray(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (data.features) return data.features;
    return [];
}

/**
 * Displays a temporary toast notification message on screen.
 *
 * @param {string} message - Message text to display.
 */
export function showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'bg-slate-800 text-white text-xs font-semibold px-4 py-2.5 rounded shadow-lg transition-opacity duration-300 pointer-events-auto border border-slate-700 opacity-0';
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => { toast.classList.remove('opacity-0'); }, 10);
    setTimeout(() => {
        toast.classList.add('opacity-0');
        setTimeout(() => { toast.remove(); }, 300);
    }, 2500);
}

// Module-scoped set of missing value placeholders for fast O(1) set lookup
const MISSING_VALUES = new Set(['missing', 'no city', 'no suburb', 'no street', 'no postcode', 'unknown']);

/**
 * Calculates rank ordering priority for missing value placeholders.
 *
 * @param {string} lowerName - Lowercased category name string.
 * @returns {number} Priority rank (lower number indicates higher priority).
 */
function getMissingRank(lowerName) {
    if (lowerName.startsWith('no ')) return 1;
    if (lowerName === 'unknown') return 2;
    if (lowerName === 'missing') return 3;
    return 4;
}

/**
 * Checks if a name string represents an unaddressed/missing value category placeholder.
 *
 * @param {string} name - Category name string.
 * @returns {boolean} True if category is missing/unaddressed placeholder.
 */
export function isMissingValue(name) {
    if (!name) return true;
    if (MISSING_VALUES.has(name)) return true;
    return MISSING_VALUES.has(name.toLowerCase());
}

// Cached Intl.Collator instance to avoid expensive options parsing on every string comparison during sorting
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Compares two string names alphabetically while prioritising missing value placeholders.
 *
 * @param {string} a - First string name.
 * @param {string} b - Second string name.
 * @returns {number} Negative if a < b, positive if a > b, 0 if equal.
 */
export function compareNames(a, b) {
    if (a === b) return 0;

    const lowerA = a ? a.toLowerCase() : '';
    const lowerB = b ? b.toLowerCase() : '';

    if (lowerA === lowerB) return 0;

    const isAMissing = !lowerA || MISSING_VALUES.has(lowerA);
    const isBMissing = !lowerB || MISSING_VALUES.has(lowerB);

    if (isAMissing && isBMissing) {
        const rankA = getMissingRank(lowerA);
        const rankB = getMissingRank(lowerB);
        if (rankA !== rankB) {
            return rankA - rankB;
        }
        return nameCollator.compare(lowerA, lowerB);
    }
    if (isAMissing) {
        return -1;
    }
    if (isBMissing) {
        return 1;
    }

    return nameCollator.compare(lowerA, lowerB);
}

/**
 * Decodes a combined OSM ID string (e.g., 'w1234', 'n313075037', 'r5678') into full type and numeric ID.
 *
 * @param {string} osmId - Combined OSM identifier string.
 * @returns {{type: string, id: string, fullType: string}|null} Decoded object or null.
 */
export function decodeOsmId(osmId) {
    if (!osmId || typeof osmId !== 'string') return null;
    const prefix = osmId.charAt(0);
    const numericId = osmId.slice(1);
    const typeMap = { 'n': 'node', 'w': 'way', 'r': 'relation' };
    const fullType = typeMap[prefix];
    if (!fullType || !numericId) return null;
    return { type: prefix, id: numericId, fullType: fullType };
}

/**
 * Constructs an OpenStreetMap URL for a given combined OSM ID string.
 *
 * @param {string} osmId - Combined OSM identifier string.
 * @returns {string} OSM URL string or '#' if invalid.
 */
export function getOsmUrl(osmId) {
    const decoded = decodeOsmId(osmId);
    if (!decoded) return '#';
    return `https://www.openstreetmap.org/${decoded.fullType}/${decoded.id}`;
}

/**
 * Safely retrieves properties from a feature object wrapper or properties object.
 *
 * @param {Object|null} item - Feature object or feature properties object.
 * @returns {Object} Feature properties object or empty object if item is null/undefined.
 */
export function getFeatureProperties(item) {
    if (!item) return {};
    return item.properties || item;
}

/**
 * Formats display name for a feature, sanitising newlines.
 *
 * @param {Object} item - Feature object or properties object.
 * @returns {string} Formatted display name string.
 */
export function getDisplayName(item) {
    const props = getFeatureProperties(item);
    let displayName = (props.raw_name || props.name || '').trim();
    if (!displayName) {
        displayName = props.osm_id || 'Unnamed';
    }
    return displayName.replace(/\r?\n/g, ' - ');
}

/**
 * Generates an integer hash code for a string.
 *
 * @param {string} str - Input string.
 * @returns {number} Non-negative hash code integer.
 */
export function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return Math.abs(hash);
}

/**
 * Constructs envelope address text lines according to specified ordering and formatting.
 *
 * @param {Object} tags - Address popup_tags object.
 * @param {string} [name=''] - Feature name string (e.g. osm_name or name tag).
 * @returns {Array<string>} Array of non-empty line strings.
 */
export function buildEnvelopeAddressLines(tags, name = '') {
    if ((!tags || typeof tags !== 'object') && !name) return [];

    const getTag = (key) => (tags && tags[key] !== undefined && tags[key] !== null ? String(tags[key]).trim() : '');

    // Line 0: Feature name
    const nameLine = name ? String(name).trim() : getTag('osm_name');

    // Floor line: addr:floor (Floor <val>)
    const floor = getTag('addr:floor');
    const floorLine = floor ? `Floor ${floor}` : '';

    // Housename line: addr:unit/Flats addr:flats addr:housename
    const flats = getTag('addr:flats');
    const flatsVal = flats ? `Flats ${flats}` : '';
    const houseNameLine = [flatsVal, getTag('addr:unit'), getTag('addr:housename')].filter(Boolean).join(' ');

    // Line 2: addr:housenumber addr:street addr:place
    // addr:place and addr:street together are an error, this highlights this a little
    const streetLine = [
        getTag('addr:housenumber'), getTag('addr:street'), getTag('addr:place')
    ].filter(Boolean).join(' ');

    const lines = [
        nameLine,
        floorLine,
        houseNameLine,
        streetLine,
        getTag('addr:parentstreet'),
        getTag('addr:suburb'),
        getTag('addr:locality'),
        getTag('addr:hamlet'),
        getTag('addr:village'),
        getTag('addr:town'),
        getTag('addr:city').toUpperCase(),
        getTag('addr:postcode')
    ]
        .filter(l => l && l.length > 0);

    return lines;
}
