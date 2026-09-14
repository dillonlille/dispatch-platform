import net from 'node:net';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs';
import { AppError } from '../../shared/errors.js';
export function publicAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a! >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  // The broker deliberately uses public IPv4 destinations; no mapped-address ambiguity.
  return false;
}
export interface EgressPolicy {
  hosts: readonly string[];
  fixture?: { hostname: string; port: number };
}
export class Egress {
  private sockets = new Set<net.Socket>();
  private server: net.Server;
  constructor(
    readonly socketPath: string,
    private policy: EgressPolicy,
  ) {
    this.server = net.createServer((socket) => this.accept(socket));
  }
  async listen() {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, resolve);
    });
    fs.chmodSync(this.socketPath, 0o600);
  }
  private track(socket: net.Socket) {
    this.sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => this.sockets.delete(socket));
    socket.setTimeout(120_000, () => socket.destroy());
  }
  private accept(socket: net.Socket) {
    if (this.sockets.size >= 64) {
      socket.destroy();
      return;
    }
    this.track(socket);
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 16_384) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      socket.pause();
      void this.connect(socket, buffer.subarray(0, end + 4), buffer.subarray(end + 4)).catch(() =>
        socket.destroy(),
      );
    };
    socket.on('data', onData);
  }
  private async connect(client: net.Socket, header: Buffer, rest: Buffer) {
    const first = header.toString('latin1').split('\r\n')[0]!,
      parts = first.split(' ');
    const connect = parts[0] === 'CONNECT';
    const url = new URL(connect ? `https://${parts[1]}` : parts[1]!);
    if (url.username || url.password || url.hash || !/^[a-z0-9.-]+$/.test(url.hostname))
      throw new AppError('egress_denied');
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    let address: string;
    if (
      this.policy.fixture &&
      url.hostname === this.policy.fixture.hostname &&
      port === this.policy.fixture.port
    )
      address = '127.0.0.1';
    else {
      if (!connect || port !== 443 || !this.policy.hosts.includes(url.hostname))
        throw new AppError('egress_denied');
      const result = await lookup(url.hostname, { family: 4 });
      if (!publicAddress(result.address)) throw new AppError('egress_denied');
      address = result.address;
    }
    if (client.destroyed) return;
    const upstream = net.connect({ host: address, port });
    this.track(upstream);
    await new Promise<void>((resolve, reject) => {
      upstream.once('connect', resolve);
      upstream.once('error', reject);
    });
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    if (connect) client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    else {
      const lines = header
        .toString('latin1')
        .split('\r\n')
        .filter((line) => line && !/^(connection|proxy-connection):/i.test(line));
      lines[0] = `${parts[0]} ${url.pathname}${url.search} HTTP/1.1`;
      // Plain HTTP exists only for local fixtures. Close after each response so
      // a reused proxy connection cannot forward an unparsed absolute URL.
      upstream.write(lines.join('\r\n') + '\r\nConnection: close\r\n\r\n');
    }
    if (rest.length) upstream.write(rest);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
  }
  async close() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
  }
}
