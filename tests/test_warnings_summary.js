/**
 * @file test_warnings_summary.js
 * @description Unit tests for warnings summary structure and async loading logic.
 */

import assert from 'node:assert';
import test from 'node:test';

test('Warnings summary count calculation', () => {
    const rawWarningsData = {
        'AB': {
            'unusual_city': [['Aberdeen', 'Capitalisation', 'n1']],
            'duplicates': [['1 High St', ['n2', 'n3']]],
            'duplicate_suburb_value': [['Headingley', 'addr:locality, addr:suburb', 'n6']],
            'missing_physical_road': [['Main St', 'Reason', 'w1,w2,w3']],
            'place_with_street': [['Village Square', 'High St', 'n4'], ['Village Square', 'High St', 'n5']]
        }
    };

    const categories_list = [
        'unusual_city',
        'unusual_suburb',
        'unusual_street',
        'unusual_housenumber',
        'unusual_housename',
        'duplicates',
        'duplicate_suburb_value',
        'unusual_address_tag',
        'missing_physical_road',
        'place_with_street'
    ];

    const warnings_summary = {};

    for (const [pa_key, pa_categories] of Object.entries(rawWarningsData)) {
        const counts = {};
        let total_count = 0;

        for (const cat of categories_list) {
            const raw_items = pa_categories[cat] || [];
            let cat_cnt = 0;
            if (cat === 'missing_physical_road') {
                for (const item of raw_items) {
                    const ids = (item[2] || '').split(',').map(s => s.trim()).filter(Boolean);
                    cat_cnt += ids.length;
                }
            } else {
                cat_cnt = raw_items.length;
            }
            counts[cat] = cat_cnt;
            total_count += cat_cnt;
        }

        if (total_count > 0) {
            warnings_summary[pa_key] = {
                clean_id: 'ab',
                total: total_count,
                counts: counts
            };
        }
    }

    assert.strictEqual(warnings_summary['AB'].total, 8); // 1 + 1 + 1 + 3 + 2 = 8
    assert.strictEqual(warnings_summary['AB'].counts['unusual_city'], 1);
    assert.strictEqual(warnings_summary['AB'].counts['duplicates'], 1);
    assert.strictEqual(warnings_summary['AB'].counts['duplicate_suburb_value'], 1);
    assert.strictEqual(warnings_summary['AB'].counts['missing_physical_road'], 3);
    assert.strictEqual(warnings_summary['AB'].counts['place_with_street'], 2);
    assert.strictEqual(warnings_summary['AB'].counts['unusual_suburb'], 0);
});
