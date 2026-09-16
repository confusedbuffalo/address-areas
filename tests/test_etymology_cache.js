import assert from 'node:assert/strict';

// DOM element mock supporting innerHTML, classList, dataset, addEventListener, querySelectorAll
class ElementMock {
    constructor(tagName = 'div', id = '') {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this.dataset = {};
        this._innerHTML = '';
        this._classList = new Set();
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
        return null;
    }

    querySelectorAll() {
        return [];
    }

    addEventListener() {}
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
        if (id === 'wikidata-etymology-card') {
            const streetCard = getOrCreateElement('street-info-card');
            if (streetCard.innerHTML.includes('id="wikidata-etymology-card"')) {
                const el = getOrCreateElement('wikidata-etymology-card');
                const matchData = streetCard.innerHTML.match(/data-wikidata-id="([^"]+)"/);
                if (matchData) {
                    el.dataset.wikidataId = matchData[1];
                }
                return el;
            }
        }
        return getOrCreateElement(id);
    },
    querySelectorAll() {
        return [];
    }
};

global.window = {};

console.log('Running etymology cache unit tests...');

const mapModule = await import('../templates/src/map.js');
const { renderStreetInfoCard, fetchWikidataEtymology, etymologyCache } = mapModule;

// Test 1: Render street without wikidata ID shows 'Unknown etymology'
{
    etymologyCache.clear();
    const streetInfo = {
        has_physical_road: true,
        total_length_m: 500,
        highway: { residential: 100 }
    };
    renderStreetInfoCard(streetInfo, 'Test Street');
    const container = document.getElementById('street-info-card');
    assert.ok(container.innerHTML.includes('Unknown etymology'), 'Should show Unknown etymology');
    console.log('✓ Test 1 passed: Street without wikidata shows Unknown etymology');
}

// Test 2: Render street with uncached wikidata ID shows skeleton loader
{
    etymologyCache.clear();
    let fetchCalled = false;
    global.fetch = async () => {
        fetchCalled = true;
        return {
            ok: true,
            json: async () => ({
                entities: {
                    Q1234: {
                        labels: { en: { value: 'Test Person' } },
                        descriptions: { en: { value: 'A historical figure' } }
                    }
                }
            })
        };
    };

    const streetInfo = {
        has_physical_road: true,
        wikidata: 'Q1234',
        highway: { residential: 100 }
    };
    renderStreetInfoCard(streetInfo, 'Test Street');

    const container = document.getElementById('street-info-card');
    assert.ok(container.innerHTML.includes('animate-pulse'), 'Should contain skeleton animate-pulse class');
    assert.ok(fetchCalled, 'Fetch should be triggered for uncached Q1234');
    console.log('✓ Test 2 passed: Uncached wikidata shows skeleton loader and triggers fetch');
}

// Test 3: Fetching wikidata populates cache and updates DOM
{
    etymologyCache.clear();
    global.fetch = async () => {
        return {
            ok: true,
            json: async () => ({
                entities: {
                    Q5678: {
                        labels: { en: { value: 'Ada Lovelace' } },
                        descriptions: { en: { value: 'Computer Pioneer' } }
                    }
                }
            })
        };
    };

    const streetInfo = {
        has_physical_road: true,
        wikidata: 'Q5678',
        highway: { residential: 100 }
    };
    renderStreetInfoCard(streetInfo, 'Ada Lovelace Way');

    await fetchWikidataEtymology('Q5678');

    assert.ok(etymologyCache.has('Q5678'), 'Cache should store Q5678');
    const cachedHtml = etymologyCache.get('Q5678');
    assert.ok(cachedHtml.includes('Ada Lovelace'), 'Cached HTML should contain Ada Lovelace');

    const card = document.getElementById('wikidata-etymology-card');
    assert.ok(card.innerHTML.includes('Ada Lovelace'), 'DOM should be updated with Ada Lovelace');
    console.log('✓ Test 3 passed: Fetching populates cache and updates DOM');
}

// Test 4: Subsequent render with cached wikidata uses cache instantly without calling fetch
{
    let fetchCallCount = 0;
    global.fetch = async () => {
        fetchCallCount++;
        return { ok: false };
    };

    const streetInfo = {
        has_physical_road: true,
        wikidata: 'Q5678',
        highway: { residential: 100 }
    };
    renderStreetInfoCard(streetInfo, 'Ada Lovelace Way');

    const container = document.getElementById('street-info-card');
    assert.ok(container.innerHTML.includes('Ada Lovelace'), 'DOM should render cached content directly');
    assert.equal(fetchCallCount, 0, 'Fetch should not be called when value is cached');
    console.log('✓ Test 4 passed: Cached etymology renders instantly without network fetch');
}

console.log('All etymology cache unit tests passed successfully!');
