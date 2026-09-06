import assert from 'node:assert/strict';
import { normalizeTrail } from '../templates/src/layers.js';

console.log('Running trail normalization unit tests...');

// Test 1: City selection from search (e.g., Thetford in IP)
{
    const trail = normalizeTrail('ip_thetford', ['IP', 'Thetford']);
    assert.deepEqual(trail, [
        { id: 'root', name: 'UK' },
        { id: 'ip', name: 'IP' },
        { id: 'ip_thetford', name: 'Thetford' }
    ]);
    console.log('✓ Test 1 passed: City selection from search');
}

// Test 2: Postcode area selection from search (e.g., IP)
{
    const trail = normalizeTrail('ip', ['IP']);
    assert.deepEqual(trail, [
        { id: 'root', name: 'UK' },
        { id: 'ip', name: 'IP' }
    ]);
    console.log('✓ Test 2 passed: Postcode area selection from search');
}

// Test 3: Suburb selection from search
{
    const trail = normalizeTrail('dh1_durham_gilesgate', ['DH1', 'Durham', 'Gilesgate']);
    assert.deepEqual(trail, [
        { id: 'root', name: 'UK' },
        { id: 'dh1', name: 'DH1' },
        { id: 'dh1_durham', name: 'Durham' },
        { id: 'dh1_durham_gilesgate', name: 'Gilesgate' }
    ]);
    console.log('✓ Test 3 passed: Suburb selection from search');
}

// Test 4: Street selection from search
{
    const trail = normalizeTrail('dh1_durham_gilesgate_highstreet', ['DH1', 'Durham', 'Gilesgate', 'High Street']);
    assert.deepEqual(trail, [
        { id: 'root', name: 'UK' },
        { id: 'dh1', name: 'DH1' },
        { id: 'dh1_durham', name: 'Durham' },
        { id: 'dh1_durham_gilesgate', name: 'Gilesgate' },
        { id: 'dh1_durham_gilesgate_highstreet', name: 'High Street' }
    ]);
    console.log('✓ Test 4 passed: Street selection from search');
}

// Test 5: Input trail already contains root item
{
    const trail = normalizeTrail('ip_thetford', [
        { id: 'root', name: 'UK' },
        { id: 'ip', name: 'IP' },
        { id: 'ip_thetford', name: 'Thetford' }
    ]);
    assert.deepEqual(trail, [
        { id: 'root', name: 'UK' },
        { id: 'ip', name: 'IP' },
        { id: 'ip_thetford', name: 'Thetford' }
    ]);
    console.log('✓ Test 5 passed: Trail with existing root object');
}

// Test 6: Empty or null trail input defaults to root
{
    assert.deepEqual(normalizeTrail('root', []), [{ id: 'root', name: 'UK' }]);
    assert.deepEqual(normalizeTrail('root', null), [{ id: 'root', name: 'UK' }]);
    console.log('✓ Test 6 passed: Empty / null trail fallback');
}

console.log('All trail normalization tests passed successfully!');
