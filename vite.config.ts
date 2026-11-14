import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
const csp = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://huggingface.co https://cdn-lfs.huggingface.co https://*.hf.co https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
function securityHeaders() {
  return {
    name: 'security-headers',
    configureServer(server: { middlewares: { use: (handler: (req: unknown, res: { setHeader: (name: string, value: string) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((_req, res, next) => { res.setHeader('Content-Security-Policy', csp); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
    },
    configurePreviewServer(server: { middlewares: { use: (handler: (req: unknown, res: { setHeader: (name: string, value: string) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((_req, res, next) => { res.setHeader('Content-Security-Policy', csp); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
    }
  };
}

function backendPortFromEnvFile(): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(new URL('.env', import.meta.url), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let port: string | undefined;
  for (const [index, line] of contents.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (!/^\s*(?:export\s+)?BACKEND_PORT\b/.test(line)) continue;
    const match = line.match(/^\s*(?:export\s+)?BACKEND_PORT\s*=\s*(?:"([^"]*)"\s*(?:#.*)?|'([^']*)'\s*(?:#.*)?|([^#]*)(?:#.*)?)\s*$/);
    if (!match) throw new Error(`Invalid backend setting in .env at line ${index + 1}`);
    port = (match[1] ?? match[2] ?? match[3]).trim();
  }
  return port;
}

const backendTarget = `http://127.0.0.1:${process.env.BACKEND_PORT ?? backendPortFromEnvFile() ?? '8000'}`;
export default defineConfig({ plugins: [securityHeaders()], worker: { format: 'es' }, server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': backendTarget } }, preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy: { '/api': backendTarget } } });
