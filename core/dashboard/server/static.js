'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { securityHeaders } = require('../../core/api/http');
const DEFAULT_PUBLIC_ROOT = path.resolve(__dirname, '../public');
const STATIC_FILES = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8', 'no-store'],
  '/index.html': ['index.html', 'text/html; charset=utf-8', 'no-store'],
  '/assets/launcher.js': ['assets/launcher.js', 'text/javascript; charset=utf-8', 'no-store'],
  '/assets/frontend.js': ['assets/frontend.js', 'text/javascript; charset=utf-8', 'no-store'],
  '/assets/inter.woff2': ['assets/inter.woff2', 'font/woff2', 'public, max-age=86400'],
  '/assets/updates.js': ['assets/updates.js', 'text/javascript; charset=utf-8', 'no-store'],
  '/assets/backups.js': ['assets/backups.js', 'text/javascript; charset=utf-8', 'no-store'],
  '/assets/styles.css': ['assets/styles.css', 'text/css; charset=utf-8', 'no-store'],
});

function loadStaticFiles(publicRoot) {
  // Snapshot the shell and its assets together. A changed file gets a new URL,
  // so even browsers with a fresh cached copy of an older release fetch it.
  const files = new Map();
  const assetUrls = new Map();
  for (const [requestPath, [relative, contentType, cacheControl]] of Object.entries(STATIC_FILES)) {
    const bytes = fs.readFileSync(path.join(publicRoot, relative));
    files.set(requestPath, { bytes, contentType, cacheControl });
    if (requestPath.startsWith('/assets/')) {
      const digest = createHash('sha256').update(bytes).digest('hex');
      const assetUrl = requestPath.replace(/(\.[^.]+)$/, `.${digest}$1`);
      assetUrls.set(requestPath, assetUrl);
      files.set(assetUrl, { bytes, contentType, cacheControl: 'public, max-age=31536000, immutable' });
    }
  }
  for (const requestPath of ['/', '/index.html']) {
    const file = files.get(requestPath);
    const html = file.bytes.toString('utf8').replace(/\b(href|src)="([^"]+)"/g,
      (match, attribute, url) => assetUrls.has(url) ? `${attribute}="${assetUrls.get(url)}"` : match);
    file.bytes = Buffer.from(html);
  }
  return files;
}

function sendStatic(response, files, requestPath, method, turnstile = null) {
  const definition = files.get(requestPath);
  if (!definition) return false;
  const { contentType, cacheControl } = definition;
  let bytes = definition.bytes;
  const headers = securityHeaders(contentType);
  if (contentType.startsWith('text/html')) {
    headers['Content-Security-Policy'] = headers['Content-Security-Policy'].replace("font-src 'self'", "font-src 'self' data:");
    if (turnstile) headers['Content-Security-Policy'] = headers['Content-Security-Policy']
      .replace("script-src 'self'", "script-src 'self' https://challenges.cloudflare.com")
      + "; frame-src https://challenges.cloudflare.com";
    const nonce = randomBytes(18).toString('base64');
    bytes = Buffer.from(bytes.toString('utf8').replaceAll('__DISPATCH_STYLE_NONCE__', nonce));
    headers['Content-Security-Policy'] = headers['Content-Security-Policy']
      .replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`)
      .replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`);
  }
  response.writeHead(200, {
    ...headers,
    'Cache-Control': cacheControl,
    'Content-Length': bytes.length,
  });
  response.end(method === 'HEAD' ? undefined : bytes);
  return true;
}


module.exports = { DEFAULT_PUBLIC_ROOT, loadStaticFiles, sendStatic };
