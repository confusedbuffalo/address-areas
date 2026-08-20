/**
 * Cloudflare Pages Function to proxy PMTiles requests to R2 bucket binding (env.BUCKET).
 * Route: /pmtiles/[[path]]
 */

export async function onRequest(context) {
    const { request, env, params } = context;

    // Handle CORS preflight (OPTIONS) requests
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'access-control-allow-origin': '*',
                'access-control-allow-methods': 'GET, HEAD, OPTIONS',
                'access-control-allow-headers': 'Range, Content-Type',
                'access-control-max-age': '86400'
            }
        });
    }

    // Only allow GET and HEAD requests
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    // Ensure BUCKET binding is available
    if (!env.BUCKET) {
        return new Response('R2 bucket binding (BUCKET) is missing', { status: 500 });
    }

    // Extract path from params. 'path' is an array of segments for [[path]] catch-all
    const pathSegments = params.path || [];
    const objectKey = Array.isArray(pathSegments) ? pathSegments.join('/') : pathSegments;

    if (!objectKey) {
        return new Response('Not Found', { status: 404 });
    }

    // Pass Range and conditional headers to R2
    const options = {};
    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
        options.range = request.headers;
    }
    const ifMatch = request.headers.get('if-match');
    if (ifMatch) options.onlyIf = { ...options.onlyIf, etagMatches: ifMatch };

    const ifNoneMatch = request.headers.get('if-none-match');
    if_none_match: if (ifNoneMatch) options.onlyIf = { ...options.onlyIf, etagDoesNotMatch: ifNoneMatch };

    try {
        const object = await env.BUCKET.get(objectKey, options);

        if (object === null) {
            return new Response('File Not Found', { status: 404 });
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);

        // Security / CORS headers
        headers.set('access-control-allow-origin', '*');
        headers.set('access-control-allow-methods', 'GET, HEAD, OPTIONS');
        headers.set('access-control-allow-headers', 'Range, Content-Type');
        headers.set('accept-ranges', 'bytes');

        // Content Type fallback for pmtiles
        if (objectKey.endsWith('.pmtiles')) {
            headers.set('content-type', 'application/x-protobuf');
        }

        // Cache-Control headers
        headers.set('cache-control', 'public, max-age=86400, s-maxage=604800');

        // Handle 206 Partial Content vs 200 OK
        let status = 200;
        if (rangeHeader && object.range) {
            status = 206;
            const size = object.size;
            const offset = object.range.offset;
            const length = object.range.length;
            headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${size}`);
            headers.set('content-length', length.toString());
        } else {
            headers.set('content-length', object.size.toString());
        }

        if (request.method === 'HEAD') {
            return new Response(null, { status, headers });
        }

        return new Response(object.body, { status, headers });
    } catch (err) {
        return new Response(`Error fetching object: ${err.message}`, { status: 500 });
    }
}
