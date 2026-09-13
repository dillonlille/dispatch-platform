'use strict';

const { validateProfile } = require('./providers');
const admin = require('./admin-cli');

function usage() {
  return [
    'Usage:',
    '  dispatch-paycom-credentials enroll [profile]',
    '  dispatch-paycom-credentials replace [profile]',
    '',
    'The profile defaults to paycom-main.',
    'Credential values are accepted only from /dev/tty with echo disabled.',
    'The Auth Broker must be stopped while credentials are changed.',
  ].join('\n');
}

function parse(argv) {
  if (argv.length < 1 || argv.length > 2 || !['enroll', 'replace'].includes(argv[0])) throw new Error('invalid_request');
  return { operation: argv[0], profile: validateProfile(argv[1] || 'paycom-main') };
}

function main(argv = process.argv.slice(2)) {
  process.umask(0o077);
  try {
    const { operation, profile } = parse(argv);
    return admin.main([operation, profile, 'paycom']);
  } catch {
    process.stderr.write(`${usage()}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, status: 'invalid_request' })}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { main, parse, usage };
