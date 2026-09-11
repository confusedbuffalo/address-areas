import assert from 'node:assert/strict';

// DOM mock supporting element creation and properties
class ElementMock {
    constructor(tagName = 'div', id = '') {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this.dataset = {};
        this._innerHTML = '';
        this._classList = new Set();
        this.listeners = {};
        if (id === 'envelope-card') {
            this._classList.add('hidden');
        }
        this.classList = {
            add: (...cls) => cls.forEach(c => this._classList.add(c)),
            remove: (...cls) => cls.forEach(c => this._classList.delete(c)),
            contains: (cls) => this._classList.has(cls)
        };
    }

    get innerHTML() {
        return this._innerHTML;
    }

    set innerHTML(val) {
        this._innerHTML = val;
    }

    querySelector(selector) {
        if (selector === '.segment-edit-all-btn') {
            if (this._innerHTML.includes('segment-edit-all-btn')) {
                const btn = new ElementMock('button');
                return btn;
            }
        }
        return null;
    }

    querySelectorAll(selector) {
        if (selector === '.street-info-row') return [];
        return [];
    }

    addEventListener(event, fn) {
        this.listeners[event] = fn;
    }
}

const elementsMap = new Map();

function getOrCreateElement(id) {
    if (!elementsMap.has(id)) {
        elementsMap.set(id, new ElementMock('div', id));
    }
    return elementsMap.get(id);
}

global.document = {
    getElementById(id) {
        return getOrCreateElement(id);
    },
    querySelectorAll() {
        return [];
    }
};

global.window = {};

console.log('Running street info card unit tests...');

const mapModule = await import('../templates/src/map.js');
const { formatStreetLength, renderStreetInfoCard } = mapModule;
const { state } = await import('../templates/src/config.js');

// --- Test 1: formatStreetLength ---
assert.strictEqual(formatStreetLength(500, false), '500 m');
assert.strictEqual(formatStreetLength(500, true), '500 m');
assert.strictEqual(formatStreetLength(999, false), '999 m');
assert.strictEqual(formatStreetLength(999, true), '999 m');

assert.strictEqual(formatStreetLength(1000, false), '1.0 km');
assert.strictEqual(formatStreetLength(2500, false), '2.5 km');

assert.strictEqual(formatStreetLength(1000, true), '0.6 mi');
assert.strictEqual(formatStreetLength(1609.344, true), '1.0 mi');
assert.strictEqual(formatStreetLength(2500, true), '1.6 mi');
console.log('✓ Test 1 passed: formatStreetLength metric and imperial conversions');

// --- Test 2: Clean heading title without percentage ---
const sampleInfo = {
    has_physical_road: true,
    total_length_m: 1250,
    highway: { 'residential': 100 },
    segments: ['w1001', 'w1002']
};

state.useImperial = false;
renderStreetInfoCard(sampleInfo, 'Church Street\n75%');

const container = document.getElementById('street-info-card');
assert.ok(!container.classList.contains('hidden'), 'Card should be visible');

assert.ok(container.innerHTML.includes('<span class="font-bold text-slate-900 text-sm">Church Street</span>'), 'Heading should be street name without percentage');
assert.ok(container.innerHTML.includes('1.3 km'), 'Length should be 1.3 km for 1250m metric');
console.log('✓ Test 2 passed: Heading title excludes percentage addressed and shows metric length');

// --- Test 3: Imperial length formatting in card ---
state.useImperial = true;
renderStreetInfoCard(sampleInfo, 'Church Street');
assert.ok(container.innerHTML.includes('0.8 mi'), 'Length should be 0.8 mi when imperial is enabled');
console.log('✓ Test 3 passed: Card updates to miles when useImperial is true');

// --- Test 4: Segments section rendering & links ---
assert.ok(container.innerHTML.includes('Segments (2)'), 'HTML should contain Segments (2)');
assert.ok(container.innerHTML.includes('segment-edit-all-btn'), 'HTML should contain segment edit all button');
assert.ok(container.innerHTML.includes('https://www.openstreetmap.org/way/1001'), 'HTML should contain way 1001 OSM link');
assert.ok(container.innerHTML.includes('https://www.openstreetmap.org/way/1002'), 'HTML should contain way 1002 OSM link');

console.log('✓ Test 4 passed: Segments expandable list and links rendered correctly');

console.log('All street info card unit tests passed successfully!');
