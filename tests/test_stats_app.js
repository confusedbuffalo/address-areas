import assert from 'node:assert/strict';
import { getDefaultStartIndex, formatDateStr, getAreaFilename } from '../templates/src/stats_app.js';

console.log('Running stats_app unit tests...');

// Test 1: getDefaultStartIndex finds date 1 year prior to latest date in weekly array
{
    const dates = [];
    // 104 weeks (2 years) from 2024-01-05 to 2025-12-26
    let current = new Date(2024, 0, 5);
    for (let i = 0; i < 104; i++) {
        const y = current.getFullYear();
        const m = String(current.getMonth() + 1).padStart(2, '0');
        const d = String(current.getDate()).padStart(2, '0');
        dates.push(`${y}-${m}-${d}`);
        current.setDate(current.getDate() + 7);
    }

    const startIdx = getDefaultStartIndex(dates);
    assert.ok(startIdx > 0 && startIdx < dates.length - 1);

    // Check that the date at startIdx is approximately 52 weeks prior
    const diffWeeks = (dates.length - 1) - startIdx;
    assert.ok(diffWeeks >= 50 && diffWeeks <= 53, `Expected ~52 weeks diff, got ${diffWeeks}`);
    console.log('✓ Test 1 passed: getDefaultStartIndex 1 year calculation');
}

// Test 2: formatDateStr formats YYYY-MM-DD
{
    const formatted = formatDateStr('2025-06-13');
    assert.ok(formatted.includes('2025') && formatted.includes('Jun'));
    console.log('✓ Test 2 passed: formatDateStr formatting');
}

// Test 3: getAreaFilename returns correct filename for area keys
{
    assert.equal(getAreaFilename('uk'), 'uk.json');
    assert.equal(getAreaFilename('No postcode'), 'no-postcode.json');
    assert.equal(getAreaFilename('Unknown'), 'unknown.json');
    assert.equal(getAreaFilename('DH'), 'DH.json');
    console.log('✓ Test 3 passed: getAreaFilename key mapping');
}

console.log('All stats_app unit tests passed successfully!');
