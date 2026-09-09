const DEFAULT_BACKEND_URL = 'http://187.127.150.191:25567';

module.exports = async function handler(request, response) {
    const pathParts = Array.isArray(request.query.path)
        ? request.query.path
        : [request.query.path].filter(Boolean);
    const apiPath = pathParts.join('/');

    if (!apiPath || !/^[A-Za-z0-9_~.%/-]+$/.test(apiPath)) {
        return response.status(400).json({ error: 'Invalid API path.' });
    }

    // Live events remain available when opening the bot host directly. Vercel
    // uses the dashboard's three-second polling fallback to avoid a long-lived
    // serverless request.
    if (apiPath === 'events') return response.status(204).end();

    const backendBase = String(process.env.BOT_BACKEND_URL || DEFAULT_BACKEND_URL).replace(/\/$/, '');
    const targetUrl = `${backendBase}/api/${apiPath}`;
    const headers = { Accept: request.headers.accept || 'application/json' };
    if (request.headers.cookie) headers.Cookie = request.headers.cookie;
    if (request.headers['content-type']) headers['Content-Type'] = request.headers['content-type'];

    let body;
    if (!['GET', 'HEAD'].includes(request.method)) {
        body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body || {});
    }

    try {
        const upstream = await fetch(targetUrl, {
            method: request.method,
            headers,
            body,
            signal: AbortSignal.timeout(15000)
        });

        const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
        let responseBody = Buffer.from(await upstream.arrayBuffer());

        if (apiPath === 'status' && contentType.includes('application/json')) {
            const status = JSON.parse(responseBody.toString('utf8'));
            status.liveEvents = false;
            responseBody = Buffer.from(JSON.stringify(status));
        }

        const setCookies = typeof upstream.headers.getSetCookie === 'function'
            ? upstream.headers.getSetCookie()
            : [upstream.headers.get('set-cookie')].filter(Boolean);
        if (setCookies.length) response.setHeader('Set-Cookie', setCookies);
        response.setHeader('Content-Type', contentType);
        response.setHeader('Cache-Control', 'no-store');
        return response.status(upstream.status).send(responseBody);
    } catch (error) {
        return response.status(502).json({
            error: 'The dashboard could not reach the bot host. Confirm that the backend is online and BOT_BACKEND_URL is correct.'
        });
    }
};
