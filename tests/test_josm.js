import assert from 'node:assert/strict';

// Mock DOM environment for sendIdsToJosm tests
class ElementMock {
    constructor(tagName = 'div', id = '') {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this.classList = new Set();
    }
    classList = {
        add: (cls) => this.classList.add(cls),
        remove: (cls) => this.classList.delete(cls)
    };
}

global.document = {
    getElementById() { return null; }
};

let fetchedUrls = [];

global.fetch = (url) => {
    fetchedUrls.push(url);
    return Promise.resolve({ ok: true });
};

console.log('Running JOSM batching unit tests...');

const { sendIdsToJosm } = await import('../templates/src/josm.js');

// Test 1: Empty array produces no calls
{
    fetchedUrls = [];
    await sendIdsToJosm([]);
    assert.equal(fetchedUrls.length, 0, 'No fetch calls should be made for empty array');
    console.log('✓ Test 1 passed: Empty array makes zero fetch calls');
}

// Test 2: Array <= 200 elements makes 1 batch call
{
    fetchedUrls = [];
    const ids = Array.from({ length: 150 }, (_, i) => `n${i + 1}`);
    await sendIdsToJosm(ids);
    assert.equal(fetchedUrls.length, 1, 'Exactly 1 fetch call should be made for 150 items');
    assert.ok(fetchedUrls[0].includes('objects=n1,n2,'), 'First URL should start with first IDs');
    assert.ok(fetchedUrls[0].includes('n150'), 'First URL should contain n150');
    console.log('✓ Test 2 passed: 150 elements send 1 batch request of 150 items');
}

// Test 3: Array of 450 elements makes 3 batch calls of 200, 200, 50
{
    fetchedUrls = [];
    const ids = Array.from({ length: 450 }, (_, i) => `w${i + 1}`);
    await sendIdsToJosm(ids);

    assert.equal(fetchedUrls.length, 3, 'Exactly 3 fetch calls should be made for 450 items');

    // Parse objects param from each URL
    const objects1 = new URL(fetchedUrls[0]).searchParams.get('objects').split(',');
    const objects2 = new URL(fetchedUrls[1]).searchParams.get('objects').split(',');
    const objects3 = new URL(fetchedUrls[2]).searchParams.get('objects').split(',');

    assert.equal(objects1.length, 200, 'Chunk 1 should have 200 items');
    assert.equal(objects1[0], 'w1');
    assert.equal(objects1[199], 'w200');

    assert.equal(objects2.length, 200, 'Chunk 2 should have 200 items');
    assert.equal(objects2[0], 'w201');
    assert.equal(objects2[199], 'w400');

    assert.equal(objects3.length, 50, 'Chunk 3 should have 50 items');
    assert.equal(objects3[0], 'w401');
    assert.equal(objects3[49], 'w450');

    console.log('✓ Test 3 passed: 450 elements send 3 batch requests (200, 200, 50)');
}

console.log('All JOSM batching unit tests passed successfully!');
