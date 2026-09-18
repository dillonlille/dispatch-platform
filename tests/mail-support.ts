import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import net from 'node:net';
// A local SMTP sink lets Production tests exercise real mail settings without
// enabling development capture or sending to an external recipient.
export async function smtpCapture() {
  const messages: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.write('220 fixture ESMTP\r\n');
    let buffer = '',
      message = '',
      data = false;
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const index = buffer.indexOf('\r\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data) {
          if (line === '.') {
            messages.push(
              message
                .replace(/=\r\n/g, '')
                .replace(/=([A-Fa-f0-9]{2})/g, (_, hex: string) =>
                  String.fromCharCode(parseInt(hex, 16)),
                ),
            );
            data = false;
            message = '';
            socket.write('250 accepted\r\n');
          } else message += line.replace(/^\.\./, '.') + '\r\n';
        } else if (line === 'DATA') {
          data = true;
          socket.write('354 send message\r\n');
        } else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `smtp://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    messages,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export async function capturedMail(
  root: string,
  to: string,
  previousText?: string,
): Promise<{
  to: string;
  subject: string;
  text: string;
  html: string;
  origin: string;
  environment: string;
}> {
  const directory = path.join(root, 'data/platform/development-mail');
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    for (const name of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
      const file = path.join(directory, name);
      const message = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (message.to === to && message.text !== previousText) {
        assert.equal(fs.statSync(file).mode & 0o077, 0);
        return message;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Invitation email was not delivered to the fixture mailbox');
}
