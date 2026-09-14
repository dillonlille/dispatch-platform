import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('./archived-paycom/paycom-adapter.test.js');
require('./archived-paycom/attempt-guard.test.js');
require('./archived-paycom/authentication-diagnostics.test.js');
