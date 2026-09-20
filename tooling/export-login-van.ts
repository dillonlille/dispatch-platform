/** Rebuild the original editable van; the authoring code is never shipped to browsers. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = process.cwd();
const server = await createServer({
  configFile: false,
  root,
  cacheDir: path.join(root, 'node_modules/.vite-login-export'),
  server: { host: '127.0.0.1', port: 0 },
});
server.middlewares.use('/__van-export', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><head><title>Van export</title></head><body></body></html>');
});
await server.listen();
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls!.local[0]! + '__van-export');
  const bytes = await page.evaluate<number[]>(`(async () => {
    const font = new FontFace('Inter', 'url(/dashboard/public/assets/inter.woff2)');
    document.fonts.add(await font.load());
    const { createStepVan } = await import('/tooling/assets/login-van.js');
    const { GLTFExporter } = await import('/node_modules/three/examples/jsm/exporters/GLTFExporter.js');
    const model = createStepVan();
    const result = await new GLTFExporter().parseAsync(model, { binary: true, maxTextureSize: 1024 });
    return Array.from(new Uint8Array(result));
  })()`);
  const file = path.join(root, 'dashboard/src/features/auth/assets/login-van.glb');
  await fs.writeFile(file, Buffer.from(bytes));
  const poster = await page.evaluate<string>(`(async () => {
    const { startVan } = await import('/dashboard/src/features/auth/van/renderer.ts');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:749px;height:717px';
    document.body.append(canvas);
    const controller = new AbortController();
    const image = await new Promise((resolve, reject) => {
      void startVan(canvas, controller.signal, ready => {
        if (ready) resolve(canvas.toDataURL('image/png').split(',')[1]);
        else reject(new Error('Cannot render the fallback poster'));
      });
    });
    controller.abort();
    return image;
  })()`);
  await fs.writeFile(file.replace('.glb', '-poster.png'), Buffer.from(poster, 'base64'));
  console.log(
    `Exported ${bytes.length} bytes to ${path.relative(root, file)} and rebuilt its poster`,
  );
} finally {
  await browser.close();
  await server.close();
}
