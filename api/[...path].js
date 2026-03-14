const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

export const config = {
  api: {
    bodyParser: false,
  },
};

function trimTrailingSlash(url) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getBackendBaseUrl() {
  const raw = process.env.BACKEND_API_BASE || process.env.VITE_API_BASE || '';
  return raw ? trimTrailingSlash(raw) : '';
}

function buildTargetUrl(req, backendBase) {
  const host = req.headers.host || 'localhost';
  const incoming = new URL(req.url || '/', `http://${host}`);
  const withoutApiPrefix = incoming.pathname.replace(/^\/api\/?/, '');
  const targetPath = withoutApiPrefix ? `/${withoutApiPrefix}` : '';
  return `${backendBase}${targetPath}${incoming.search}`;
}

function copyResponseHeaders(upstream, res) {
  for (const [key, value] of upstream.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    res.setHeader(key, value);
  }
}

async function streamResponse(upstream, res) {
  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

export default async function handler(req, res) {
  const backendBase = getBackendBaseUrl();
  if (!backendBase) {
    res.status(500).json({
      error:
        'Backend API is not configured. Set BACKEND_API_BASE in Vercel project settings (for example: https://your-backend.example.com/api).',
    });
    return;
  }

  try {
    const targetUrl = buildTargetUrl(req, backendBase);
    const method = req.method || 'GET';
    const headers = { ...req.headers };

    delete headers.host;
    delete headers['content-length'];

    const init = {
      method,
      headers,
      redirect: 'manual',
    };

    if (method !== 'GET' && method !== 'HEAD') {
      init.body = await readRawBody(req);
    }

    const upstream = await fetch(targetUrl, init);
    copyResponseHeaders(upstream, res);
    res.status(upstream.status);
    await streamResponse(upstream, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Proxy request failed';
    res.status(502).json({ error: `Proxy error: ${message}` });
  }
}
