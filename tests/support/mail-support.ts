import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
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
      if (!name.endsWith('.json')) continue;
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
