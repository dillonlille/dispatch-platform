import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';
import { createServer, type ProxyOptions, type ViteDevServer } from 'vite';
import { demo, fixture } from '../testing/fixture-server.js';

const previewCookie = (value: string, port: number) =>
  value.replace(/^dispatch_session=/, `dispatch_preview_${port}=`);

async function enterDemo(
  app: Awaited<ReturnType<typeof fixture>>,
  response: http.ServerResponse,
  port: number,
) {
  try {
    const login = await app.request('/api/auth/login', {
      email: demo.email,
      password: demo.password,
    });
    const cookies = login.headers.getSetCookie();
    if (login.status !== 200 || !cookies.some((value) => value.startsWith('dispatch_session=')))
      throw new Error('Demo sign-in failed');
    response.writeHead(303, {
      // The browser retains the entry link's fragment, such as #account.
      location: '/',
      'set-cookie': cookies.map((value) => previewCookie(value, port)),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    response.end();
  } catch {
    response.writeHead(502, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    response.end('Unable to sign in to the demo preview. Try opening the preview link again.');
  }
}

// Cookies ignore ports. Only this preview's cookie may reach its fixture backend;
// the backend and published application keep their normal session cookie name.
function sessionProxy(target: string, port: number): ProxyOptions {
  const cookie = `dispatch_preview_${port}`;
  return {
    target,
    changeOrigin: false,
    configure(proxy) {
      proxy.on('proxyReq', (outgoing, incoming) => {
        const session = incoming.headers.cookie
          ?.split(';')
          .map((part) => part.trim())
          .find((part) => part.startsWith(`${cookie}=`));
        if (session) outgoing.setHeader('cookie', session.replace(cookie, 'dispatch_session'));
        else outgoing.removeHeader('cookie');
      });
      proxy.on('proxyRes', (response) => {
        const cookies = response.headers['set-cookie'];
        if (cookies)
          response.headers['set-cookie'] = cookies.map((value) => previewCookie(value, port));
      });
    },
  };
}

export async function startPreview({
  cwd = process.cwd(),
  host = process.env.DISPATCH_DEV_HOST || '127.0.0.1',
  port = Number(process.env.DISPATCH_DEV_PORT || 0),
  binary,
}: { cwd?: string; host?: string; port?: number; binary?: string } = {}) {
  if (['0.0.0.0', '::', '[::]', '*'].includes(host))
    throw new Error(`DISPATCH_DEV_HOST must name one address, not ${host}`);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('DISPATCH_DEV_PORT must be an integer between 0 and 65535');

  let ui: ViteDevServer | undefined;
  let app: Awaited<ReturnType<typeof fixture>> | undefined;
  const entryPath = `/__preview/${randomUUID()}`;
  // Bind once and retain the socket. Concurrent worktrees cannot claim the same
  // free port between discovery and startup, and HMR shares this exact server.
  const server = http.createServer((request, response) => {
    const pathname = (request.url ?? '/').split('?')[0]!;
    if (!ui || !app) {
      response.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '1' });
      response.end('Preview starting');
    } else if (pathname.startsWith('/__preview/')) {
      if (pathname !== entryPath) {
        response.writeHead(404, { 'cache-control': 'no-store' });
        response.end();
      } else if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' });
        response.end();
      } else {
        const address = server.address();
        if (address && typeof address !== 'string') void enterDemo(app, response, address.port);
      }
    } else {
      ui.middlewares(request, response);
    }
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await Promise.all([stopped, ui?.close(), app?.close()]);
    })());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Preview has no TCP address');
    const origin = `http://${isIP(host) === 6 ? `[${host}]` : host}:${address.port}`;
    app = await fixture({
      binary,
      env: { DISPATCH_ORIGIN: origin },
      output: 'inherit',
    });
    ui = await createServer({
      configFile: path.join(cwd, 'vite.config.ts'),
      root: path.join(cwd, 'dashboard'),
      clearScreen: false,
      server: {
        host,
        port: address.port,
        middlewareMode: { server },
        hmr: { server },
        proxy: { '/api': sessionProxy(`http://127.0.0.1:${app.env.PORT}`, address.port) },
      },
    });
    const exited = app.exited();
    void exited.then(close);
    return { origin, previewUrl: origin + entryPath, root: app.root, close, exited };
  } catch (error) {
    await close();
    throw error;
  }
}
