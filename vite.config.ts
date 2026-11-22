import { defineConfig, loadEnv, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';
import { handleOpenRouterRequest } from './netlify/functions/openrouter.mjs';
import { handleGlobalStats } from './netlify/functions/global-stats.mjs';

const csp = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://huggingface.co https://cdn-lfs.huggingface.co https://*.hf.co https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

function openRouterProxy(apiKey: string | undefined, model: string | undefined): Plugin {
  const middleware = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use('/api/openrouter', (req, res, next) => {
      if (req.method !== 'POST') {
        void handleOpenRouterRequest({ method: req.method, body: '', headers: req.headers, apiKey, model })
          .then(result => { res.writeHead(result.statusCode, result.headers); res.end(result.body); })
          .catch(next);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size <= 102400) chunks.push(chunk);
      });
      req.on('end', () => {
        const body = size <= 102400 ? Buffer.concat(chunks).toString('utf8') : 'x'.repeat(102401);
        void handleOpenRouterRequest({
          method: req.method,
          body,
          headers: req.headers,
          clientIp: req.socket.remoteAddress,
          apiKey,
          model,
        }).then(result => { res.writeHead(result.statusCode, result.headers); res.end(result.body); })
          .catch(next);
      });
    });
  };
  return {
    name: 'server-side-openrouter-proxy',
    configureServer: middleware,
    configurePreviewServer: middleware,
  };
}

function globalStatsProxy(databaseUrl: string | undefined): Plugin {
  const middleware = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use('/.netlify/functions/global-stats', (req, res, next) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size <= 4096) chunks.push(chunk);
      });
      req.on('end', () => {
        const body = size <= 4096 ? Buffer.concat(chunks).toString('utf8') : 'x'.repeat(4097);
        const queryStringParameters = Object.fromEntries(new URL(req.url ?? '/', 'http://localhost').searchParams);
        void handleGlobalStats({ httpMethod: req.method, body, queryStringParameters }, databaseUrl)
          .then(result => { res.writeHead(result.statusCode, result.headers); res.end(result.body); })
          .catch(next);
      });
      req.on('error', next);
    });
  };
  return {
    name: 'local-global-stats',
    configureServer: middleware,
    configurePreviewServer: middleware,
  };
}

function securityHeaders(): Plugin {
  return {
    name: 'security-headers',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => { res.setHeader('Content-Security-Policy', csp); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); Object.entries(isolationHeaders).forEach(([name, value]) => res.setHeader(name, value)); next(); });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => { res.setHeader('Content-Security-Policy', csp); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); Object.entries(isolationHeaders).forEach(([name, value]) => res.setHeader(name, value)); next(); });
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [securityHeaders(), openRouterProxy(env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL), globalStatsProxy(env.DATABASE_URL)],
    optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
    worker: { format: 'es' },
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  };
});
