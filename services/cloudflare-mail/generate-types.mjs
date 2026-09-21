import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const output = 'services/cloudflare-mail/worker-configuration.d.ts';
execFileSync(
  'npx',
  [
    '--yes',
    'wrangler@4.133.0',
    'types',
    output,
    '--config',
    'services/cloudflare-mail/wrangler.jsonc',
    '--include-runtime=false',
    '--strict-vars=false',
  ],
  { stdio: 'inherit' },
);
// Keep Worker globals and process.env types out of the dashboard/Node programs.
fs.writeFileSync(
  output,
  `import type { SendEmail } from '@cloudflare/workers-types';\n${fs.readFileSync(output, 'utf8')}\nexport type { Env };\n`,
);

execFileSync('node_modules/.bin/prettier', ['--write', output], { stdio: 'inherit' });
