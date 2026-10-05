import { createServer } from 'node:http';
import { tokenMatches } from './bridge.mjs';

const MAX_BODY = 15 * 1024 * 1024; // 10 MB file as base64 ≈ 13.4 MB

export function createHelperServer({ token, appVersion, routes }) {
  return createServer(async (req, res) => {
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method === 'GET' && req.url === '/ping') {
        return send(200, { ok: true, app: 'debate-uploader', appVersion });
      }
      if (!tokenMatches(req.headers['x-bridge-token'], token)) {
        return send(401, { ok: false, error: 'bad_token' });
      }
      const route = req.method === 'POST' ? routes[req.url] : undefined;
      if (!route) return send(404, { ok: false, error: 'not_found' });

      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return send(413, { ok: false, error: 'too_large' });
        chunks.push(chunk);
      }
      let body;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      } catch {
        return send(400, { ok: false, error: 'bad_json' });
      }
      send(200, await route(body));
    } catch (err) {
      send(500, { ok: false, error: err?.message ?? 'internal' });
    }
  });
}
