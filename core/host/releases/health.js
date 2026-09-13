'use strict';
const http = require('node:http');

// Core's loopback listener validates the public Host header. Node fetch can
// replace that header with the loopback address, so use the HTTP transport.
function requestHealth(url, { headers, signal }) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers, signal }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 4096) {
          const error = new Error('release_health_response_invalid');
          reject(error); response.destroy(); request.destroy();
        }
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({
        ok: response.statusCode === 200,
        json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
  });
}
module.exports = { requestHealth };
