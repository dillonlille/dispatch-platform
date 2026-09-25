import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
interface Settings {
  environment: string;
  name: string;
  origin: string;
  sender: string;
}

/** The committed configurations are examples; only this private copy names a deployment. */
export function mailConfig(settings: Settings) {
  if (!['preview', 'production'].includes(settings.environment))
    throw new Error('Environment must be preview or production');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(settings.name))
    throw new Error('A valid Worker name is required');
  const origin = URL.parse(settings.origin);
  if (
    !origin ||
    origin.protocol !== 'https:' ||
    origin.origin !== settings.origin ||
    origin.username ||
    origin.password
  )
    throw new Error('A canonical HTTPS origin is required');
  if (
    settings.sender.length > 254 ||
    !/^[-\w.+]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(settings.sender)
  )
    throw new Error('A single sender email address is required');
  const file = path.join(
    root,
    'services/cloudflare-mail',
    settings.environment === 'production' ? 'wrangler.production.jsonc' : 'wrangler.jsonc',
  );
  const template = ts.parseConfigFileTextToJson(file, fs.readFileSync(file, 'utf8'));
  if (template.error) throw new Error('Invalid mail configuration template');
  return {
    ...template.config,
    name: settings.name,
    main: path.join(root, 'services/cloudflare-mail/worker.ts'),
    send_email: [{ name: 'EMAIL', allowed_sender_addresses: [settings.sender] }],
    vars: {
      DISPATCH_ENVIRONMENT: settings.environment,
      DISPATCH_ORIGIN: settings.origin,
      MAIL_FROM: settings.sender,
    },
  };
}

export function writeMailConfig(output: string, settings: Settings) {
  const config = mailConfig(settings);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  // A retry must not overwrite an existing host configuration.
  fs.writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: Object.fromEntries(
      ['environment', 'name', 'origin', 'sender', 'output'].map((key) => [key, { type: 'string' }]),
    ),
  });
  const read = (key: string) => {
    const value = values[key];
    if (typeof value !== 'string' || !value) throw new Error(`--${key} is required`);
    return value;
  };
  writeMailConfig(path.resolve(read('output')), {
    environment: read('environment'),
    name: read('name'),
    origin: read('origin'),
    sender: read('sender'),
  });
  process.stdout.write('Private mail configuration written. No Worker was deployed.\n');
}
