'use strict';

const net = require('node:net');
const path = require('node:path');
const { privateJson } = require('../../core/installations/src/release-delivery-files');

const DEFAULT_HOSTS = Object.freeze([
  'logistics.amazon.com', 'www.amazon.com', '*.media-amazon.com', '*.ssl-images-amazon.com',
  'static.siege-amazon.com', 'fls-na.amazon.com', 'unagi.amazon.com', 'unagi-na.amazon.com',
  'paycomonline.net', '*.paycomonline.net',
]);
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;
function invalid() { throw new Error('directory_network_invalid'); }

function networkPolicy(value = { version: 1, hosts: DEFAULT_HOSTS }) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== 'hosts,version' || value.version !== 1
      || !Array.isArray(value.hosts) || value.hosts.length > 100
      || new Set(value.hosts).size !== value.hosts.length) invalid();
  for (const host of value.hosts) {
    if (typeof host !== 'string' || !HOST.test(host.replace(/^\*\./, ''))
        || net.isIP(host) || host.endsWith('.localhost') || host.endsWith('.local')
        || (host.startsWith('*.') && host.split('.').length < 3)) invalid();
  }
  const hosts = Object.freeze([...value.hosts]);
  return Object.freeze({ version: 1, hosts,
    allows: host => HOST.test(host) && hosts.some(rule => rule.startsWith('*.')
      ? host.endsWith(rule.slice(1)) && host.length > rule.length - 1 : host === rule),
  });
}

function loadNetworkPolicy(paths) {
  let value;
  try { value = privateJson(path.join(paths.local, 'config/directory-network.json'), process.geteuid()); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return networkPolicy(value);
}

// Restrict DNS results to ordinary public IPv4 unicast. Reject complete special
// blocks, including the few globally reachable exceptions, to keep this boundary
// conservative. IPv6, IP literals, mapped addresses and alternate IP syntax never
// reach the connector. The approved address is pinned for this one connection.
function publicAddress(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
    || a === 192 && b === 0 && (c === 0 || c === 2)
    || a === 192 && b === 88 && c === 99
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
    || a === 203 && b === 0 && c === 113);
}

module.exports = { networkPolicy, loadNetworkPolicy, publicAddress };
