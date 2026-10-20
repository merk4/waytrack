import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage } from 'node:http';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Serves /api/* in `vite dev` with the real server handlers (same code as the Netlify
 * functions), so local development needs no netlify-cli. Env vars are read server-side
 * only; nothing without a VITE_ prefix reaches the client bundle.
 */
function devApi(mode: string): Plugin {
  return {
    name: 'waymark-dev-api',
    apply: 'serve',
    configureServer(server) {
      const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') };
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        try {
          const mod = (await server.ssrLoadModule('/src/server/devApi.ts')) as typeof import('./src/server/devApi.ts');
          // Client disconnect = response closed before we finished (IncomingMessage 'close'
          // fires as soon as the body is read in modern Node, so it can't be used here).
          const abort = new AbortController();
          res.on('close', () => {
            if (!res.writableEnded) abort.abort();
          });
          const request = await toRequest(req, abort.signal);
          const response = await mod.handleDevApi(request, env, req.socket.remoteAddress ?? 'local');
          if (!response) return next();
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          // Stream (e.g. NDJSON progress from /api/generate) instead of buffering.
          if (response.body) {
            const reader = response.body.getReader();
            abort.signal.addEventListener('abort', () => void reader.cancel());
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
          }
          res.end();
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

async function toRequest(req: IncomingMessage, signal: AbortSignal): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const method = req.method ?? 'GET';
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
    method,
    signal,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v] as [string, string]] : [])),
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
  });
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), devApi(mode)],
  build: { target: 'es2022', sourcemap: true },
  // Pre-bundle up front: MapLibre is imported lazily, and discovering it mid-session makes
  // Vite re-optimise and fail that import with "504 Outdated Optimize Dep" until reload.
  optimizeDeps: { include: ['maplibre-gl', 'react', 'react-dom/client', 'react/jsx-runtime', '@tanstack/react-query', 'zod'] },
}));
