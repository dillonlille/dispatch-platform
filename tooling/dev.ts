import path from 'node:path';
import { demo } from './fixture-server.js';
import { startPreview } from './dev-server.js';

const app = await startPreview();
process.stdout.write(
  `Worktree: ${path.basename(process.cwd())}\nDevelopment fixtures: ${app.origin}\nSign in: ${demo.email} / ${demo.password}\nTemporary state: ${app.root}\n`,
);
const stop = () => void app.close();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await app.exited;
await app.close();
