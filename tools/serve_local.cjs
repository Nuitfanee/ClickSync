const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createNativeWorker } = require('./native_worker.cjs');
const root = path.resolve(__dirname, '..');
const port = Number(process.env.CLICKSYNC_PORT || 8765);
const pendingBattery = new Map();
const batteryCache = new Map();
let nativeQueue = Promise.resolve();
const nativeWorker = createNativeWorker();
function runNative(productId, packet = null) {
  const task = () => nativeWorker.request(productId,packet);
  const result = nativeQueue.then(task);
  nativeQueue = result.catch(() => {});
  return result;
}
function readNativeBattery(productId) {
  const cached = batteryCache.get(productId);
  if (cached && Date.now() - cached.time < 10000) return Promise.resolve(cached.value);
  if (pendingBattery.has(productId)) return pendingBattery.get(productId);
  const job = runNative(productId).then(value => {
    batteryCache.set(productId, {time:Date.now(),value}); return value;
  }).finally(() => pendingBattery.delete(productId));
  pendingBattery.set(productId, job);
  return job;
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/razer-')) {
    const host = req.headers.host;
    if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(host)
      || (req.headers.origin && req.headers.origin !== `http://${host}`)
      || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403).end(); return; }
    const url = new URL(req.url, `http://${host}`);
    if (!['/api/razer-battery','/api/razer-exchange'].includes(url.pathname)) { res.writeHead(404).end(); return; }
    const productId = Number(url.searchParams.get('productId'));
    if (![192,193].includes(productId)) { res.writeHead(400).end('Unsupported productId'); return; }
    if (process.platform !== 'win32') { res.writeHead(405).end(); return; }
    let operation;
    if (url.pathname === '/api/razer-exchange') {
      if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) { res.writeHead(405).end(); return; }
      try {
        let body='';
        for await (const chunk of req) { body+=chunk; if (body.length>4096) { res.writeHead(413).end(); return; } }
        const packet=JSON.parse(body).packet;
        if (!Array.isArray(packet) || packet.length!==90 || packet.some(x=>!Number.isInteger(x)||x<0||x>255)) throw new Error('Invalid packet');
        operation=runNative(productId,packet);
      } catch { res.writeHead(400).end('Invalid packet'); return; }
    } else {
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      operation=readNativeBattery(productId);
    }
    operation.then(value => {
      res.writeHead(200, {'Content-Type':'application/json', 'Cache-Control':'no-store'}).end(JSON.stringify(value));
    }).catch(error => {
      res.writeHead(503, {'Content-Type':'application/json', 'Cache-Control':'no-store'}).end(JSON.stringify({ok:false,error:error.message}));
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let filename;
  try { filename = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname)); }
  catch { res.writeHead(400).end(); return; }
  if (filename !== root && !filename.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  if (filename === root) filename = path.join(root, 'index.html');
  fs.readFile(filename, (error, data) => {
    if (error) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}).listen(port, '127.0.0.1', () => console.log(`ClickSync: http://localhost:${port}/index.html\nKeep this window open. Ctrl+C stops the server.`));
