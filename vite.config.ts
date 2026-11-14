import { defineConfig } from 'vite';
const backendTarget = `http://127.0.0.1:${process.env.BACKEND_PORT || '8000'}`;
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

export default defineConfig({ plugins: [securityHeaders()], worker: { format: 'es' }, server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': backendTarget } }, preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy: { '/api': backendTarget } } });
