import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mailConfig, writeMailConfig } from '../../tooling/host/mail-config.js';

const settings = {
  environment: 'preview',
  name: 'dispatch-fixture-mail',
  origin: 'https://dev.example.test',
  sender: 'no-reply@dev.example.test',
};

test('private mail config keeps the environment, sender restriction and secret binding together', () => {
  for (const environment of ['preview', 'production']) {
    const config = mailConfig({ ...settings, environment });
    assert.equal(config.name, settings.name);
    assert.equal(config.vars.DISPATCH_ENVIRONMENT, environment);
    assert.equal(config.vars.DISPATCH_ORIGIN, settings.origin);
    assert.equal(config.vars.MAIL_FROM, settings.sender);
    assert.deepEqual(config.send_email, [
      { name: 'EMAIL', allowed_sender_addresses: [settings.sender] },
    ]);
    assert.deepEqual(config.secrets, { required: ['MAIL_TOKEN'] });
    assert.equal(config.vars.MAIL_TOKEN, undefined);
    assert(path.isAbsolute(config.main) && fs.existsSync(config.main));
  }
});

test('mail configuration rejects ambiguous origins, senders and environments before writing', () => {
  for (const origin of [
    'http://dev.example.test',
    'https://dev.example.test/',
    'https://dev.example.test/path',
    'https://dev.example.test?query=1',
    'https://user:password@dev.example.test',
    'not-a-url',
  ])
    assert.throws(() => mailConfig({ ...settings, origin }));
  for (const sender of ['two@example.test,three@example.test', 'bad\r\n@example.test', 'invalid'])
    assert.throws(() => mailConfig({ ...settings, sender }));
  assert.throws(() => mailConfig({ ...settings, environment: 'staging' }));
  assert.throws(() => mailConfig({ ...settings, name: '../worker' }));
});

test('mail config is private, usable outside the source directory and never overwrites another config', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-mail-config-'));
  try {
    const file = path.join(temporary, 'private', 'worker.json');
    writeMailConfig(file, settings);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => writeMailConfig(file, { ...settings, name: 'another-worker' }));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
