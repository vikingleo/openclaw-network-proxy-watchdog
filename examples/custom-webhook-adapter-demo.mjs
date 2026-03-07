#!/usr/bin/env node
import http from 'node:http';

const host = process.env.DEMO_HOST || '127.0.0.1';
const port = Number(process.env.DEMO_PORT || '18795');
const token = process.env.DEMO_TOKEN || 'demo-token';
const state = {
  current: 'primary',
  targets: ['primary', 'backup', 'hk'],
};

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function unauthorized(res) {
  sendJson(res, 401, { error: 'unauthorized' });
}

const server = http.createServer(async (req, res) => {
  const auth = req.headers.authorization || '';
  if (token && auth !== `Bearer ${token}`) {
    unauthorized(res);
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: 'invalid-json' });
      return;
    }
  }

  if (req.method === 'GET' && req.url === '/api/describe') {
    sendJson(res, 200, {
      data: {
        driver: 'demo-webhook-adapter',
        current: state.current,
        targets: state.targets,
      },
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/targets') {
    sendJson(res, 200, { data: { targets: state.targets } });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/targets/current') {
    sendJson(res, 200, { data: { current: state.current } });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/targets/switch') {
    const target = typeof body?.target === 'string' ? body.target.trim() : '';
    if (!target) {
      sendJson(res, 400, { error: 'missing-target' });
      return;
    }
    if (!state.targets.includes(target)) {
      sendJson(res, 404, { error: 'target-not-found', target });
      return;
    }
    const from = state.current;
    state.current = target;
    sendJson(res, 200, {
      data: {
        from,
        to: state.current,
        changed: from !== state.current,
      },
    });
    return;
  }

  sendJson(res, 404, { error: 'not-found' });
});

server.listen(port, host, () => {
  console.log(JSON.stringify({
    ok: true,
    host,
    port,
    token,
    endpoints: [
      'GET /api/describe',
      'GET /api/targets',
      'GET /api/targets/current',
      'POST /api/targets/switch',
    ],
  }, null, 2));
});
