// Serves the demo app. In production this is your real app's resettable copy on Render.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo-app');

export function startDemoApp(port = 4173) {
  const server = http.createServer(async (req, res) => {
    try {
      const html = await fs.readFile(path.join(root, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    } catch { res.writeHead(500).end(); }
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, url: `http://127.0.0.1:${port}` })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startDemoApp(Number(process.env.PORT) || 4173);
  console.log(`Demo app on ${url}`);
}
