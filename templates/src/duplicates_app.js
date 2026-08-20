/**
 * @file duplicates_app.js
 * @description Frontend logic for the Duplicate Addresses page (/duplicates/index.html).
 */

import { DATA_TIMESTAMP } from './config.js';
import { decodeOsmId, updateDataDateElement, showToast } from './utils.js';

function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function getOsmUrl(osmId) {
    const decoded = decodeOsmId(osmId);
    if (!decoded) return '#';
    return `https://www.openstreetmap.org/${decoded.fullType}/${decoded.id}`;
}

function makeJosmCall(idsChunk) {
    const objectsParam = idsChunk.join(',');
    const josmUrl = `http://127.0.0.1:8111/load_object?objects=${objectsParam}&relation_members=true`;
    return fetch(josmUrl, { mode: 'no-cors' });
}

function sendIdsToJosm(ids) {
    if (!ids || ids.length === 0) {
        showToast("No elements found to edit.");
        return Promise.resolve();
    }

    const chunk1 = ids.slice(0, 200);
    const chunk2 = ids.slice(200, 400);

    return makeJosmCall(chunk1)
        .then(() => {
            if (chunk2.length > 0) {
                return new Promise(resolve => setTimeout(resolve, 500))
                    .then(() => makeJosmCall(chunk2));
            }
        })
        .then(() => {
            showToast("Sent objects to JOSM!");
        })
        .catch(err => {
            console.error("Failed to connect to JOSM", err);
            const modal = document.getElementById('josm-modal');
            if (modal) modal.classList.remove('hidden');
        });
}

window.sendSingleToJosm = function(osmId) {
    sendIdsToJosm([osmId]);
};

let duplicatesGlobalData = {};

window.sendGroupToJosm = function(paKey, groupIdx) {
    const groups = duplicatesGlobalData[paKey];
    if (groups && groups[groupIdx]) {
        sendIdsToJosm(groups[groupIdx].osm_ids);
    }
};

window.sendAreaToJosm = function(paKey) {
    const groups = duplicatesGlobalData[paKey];
    if (groups) {
        const allIds = [];
        groups.forEach(g => {
            if (g.osm_ids) allIds.push(...g.osm_ids);
        });
        const uniqueIds = Array.from(new Set(allIds));
        sendIdsToJosm(uniqueIds);
    }
};

function renderDuplicates(duplicatesData) {
    duplicatesGlobalData = duplicatesData;
    const container = document.getElementById('duplicates-container');
    if (!container) return;

    const paKeys = Object.keys(duplicatesData).sort((a, b) => {
        if (a === 'No postcode') return 1;
        if (b === 'No postcode') return -1;
        return a.localeCompare(b);
    });

    if (paKeys.length === 0) {
        container.innerHTML = `
            <div class="bg-white p-8 rounded-xl shadow-sm border border-gray-200 text-center text-gray-500 text-sm">
                No duplicate addresses found! All address points have unique details.
            </div>
        `;
        return;
    }

    let html = '';

    paKeys.forEach((paKey, paIdx) => {
        const groups = duplicatesData[paKey] || [];
        if (groups.length === 0) return;

        const paId = `pa-${paIdx}`;
        const totalObjects = groups.reduce((sum, g) => sum + (g.osm_ids ? g.osm_ids.length : 0), 0);
        const canEditAll = totalObjects <= 400;

        html += `
            <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <!-- Postcode Area Accordion Header -->
                <div class="w-full px-5 py-4 bg-gray-50 hover:bg-gray-100 flex items-center justify-between border-b border-gray-200 text-left transition-colors select-none">
                    <button id="header-${paId}" class="flex items-center gap-3 cursor-pointer group grow" onclick="toggleAccordion('${paId}')">
                        <svg id="caret-${paId}" class="h-5 w-5 text-gray-500 group-hover:text-gray-700 transition-transform duration-200 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                        </svg>
                        <h3 class="text-base font-bold text-slate-900">${escapeHtml(paKey)}</h3>
                        <span class="bg-indigo-100 text-indigo-800 text-xs font-bold px-2.5 py-1 rounded-full border border-indigo-200">
                            ${groups.length} ${groups.length === 1 ? 'issue' : 'issues'}
                        </span>
                    </button>
                    <div class="ml-4 shrink-0">
                        <button id="edit-all-${paId}" onclick="sendAreaToJosm('${escapeHtml(paKey)}')" class="${canEditAll ? 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer' : 'bg-gray-300 text-gray-500 cursor-not-allowed'} text-xs font-bold px-3 py-1.5 rounded transition shadow-xs" ${canEditAll ? '' : 'disabled title="Too many elements (>400)"'}>
                            Edit all
                        </button>
                    </div>
                </div>

                <!-- Postcode Area Content Table -->
                <div id="content-${paId}" class="hidden overflow-x-auto">
                    <table class="w-full text-left text-xs border-collapse">
                        <thead>
                            <tr class="bg-gray-50 text-gray-500 uppercase font-semibold border-b border-gray-200">
                                <th class="px-5 py-3">Address</th>
                                <th class="px-5 py-3">Duplicate Objects</th>
                                <th class="px-5 py-3 w-24 text-right">Edit</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-gray-100 bg-white">
        `;

        groups.forEach((group, groupIdx) => {
            const osmLinks = (group.osm_ids || []).map(id => {
                const url = getOsmUrl(id);
                return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline font-mono font-semibold">${escapeHtml(id)}</a>`;
            }).join(', ');

            html += `
                <tr class="hover:bg-gray-50/80 transition-colors">
                    <td class="px-5 py-3 font-semibold text-slate-900">${escapeHtml(group.title)}</td>
                    <td class="px-5 py-3 text-slate-700">${osmLinks}</td>
                    <td class="px-5 py-3 text-right font-medium">
                        <button onclick="sendGroupToJosm('${escapeHtml(paKey)}', ${groupIdx})" class="text-blue-600 hover:text-blue-800 hover:underline font-semibold cursor-pointer">
                            Edit
                        </button>
                    </td>
                </tr>
            `;
        });

        html += `
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

window.toggleAccordion = function(id) {
    const content = document.getElementById(`content-${id}`);
    const caret = document.getElementById(`caret-${id}`);
    if (content && caret) {
        content.classList.toggle('hidden');
        caret.classList.toggle('rotate-90');
    }
};

document.addEventListener('DOMContentLoaded', () => {
    updateDataDateElement();
    fetch('../data/duplicates.json')
        .then(res => {
            if (!res.ok) throw new Error(`HTTP error ${res.status}`);
            return res.json();
        })
        .then(data => renderDuplicates(data))
        .catch(err => {
            console.error("Failed to load duplicates data:", err);
            const container = document.getElementById('duplicates-container');
            if (container) {
                container.innerHTML = `
                    <div class="bg-white p-8 rounded-xl shadow-sm border border-gray-200 text-center text-red-600 text-sm">
                        Failed to load duplicate address data.
                    </div>
                `;
            }
        });
});
