'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PassThrough } = require('node:stream');
const { LineInteraction } = require('../src/interactions/line');
const { collectSetupAuthInput } = require('../src/interactions/setup-auth');

function command(overrides = {}) {
  return {
    command: 'setup-auth', format: 'plain', replaceExisting: false, replaceSpecified: false,
    removeSpecified: false, confirmed: false,
    testAuthentication: false, testAuthenticationSpecified: false, nonInteractive: false,
    ...overrides,
  };
}
function preparation({ configured = true } = {}) {
  return {
    workflow: 'setup_auth', target: { provider: 'paycom', profile: 'paycom-main' },
    state: {
      broker: { status: 'stopped', managed: false },
      vault: { status: configured ? 'ready' : 'absent', verified: configured },
      profile: { status: configured ? 'configured' : 'not_configured', ...(configured ? { provider: 'paycom' } : {}) },
      credentialIngress: 'available',
    },
    capabilities: {
      credentialActions: [
        { id: 'keep', available: configured, reason: configured ? null : 'profile_not_configured' },
        { id: 'enroll', available: !configured, reason: configured ? 'profile_exists' : null },
        { id: 'replace', available: configured, reason: configured ? null : 'profile_not_configured' },
        { id: 'remove', available: configured, reason: configured ? null : 'profile_not_configured' },
      ],
      authenticationTest: { id: 'run', available: true, reason: null },
    },
    defaults: { credentialAction: configured ? 'keep' : 'enroll', startBroker: true, testAuthentication: false },
  };
}

test('line interaction accepts bounded numbered selections and exposes no secret prompt', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  let rendered = '';
  output.on('data', chunk => { rendered += chunk.toString('utf8'); });
  const interaction = new LineInteraction({ input, output });
  assert.equal(typeof interaction.secret, 'undefined');
  input.end('2\n');
  const selected = await interaction.select({
    message: 'Choose an option',
    options: [
      { value: 'keep', label: 'Keep' },
      { value: 'replace', label: 'Replace' },
    ],
    defaultValue: 'keep',
  });
  interaction.close();
  assert.equal(selected, 'replace');
  assert.equal(rendered.includes('1. Keep (default)'), true);
  assert.equal(rendered.includes('2. Replace'), true);
});

test('line interaction treats terminal EOF as cancellation', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  const interaction = new LineInteraction({ input, output });
  input.end();
  await assert.rejects(interaction.select({
    message: 'Choose an option',
    options: [{ value: 'keep', label: 'Keep' }],
    defaultValue: 'keep',
  }), error => error.code === 'cancelled');
  interaction.close();
});

test('setup choice collector honors flags and derives remaining choices from preparation', async () => {
  let selectCalls = 0;
  const interaction = {
    available: () => true,
    write: () => {},
    select: async menu => { selectCalls += 1; return menu.defaultValue; },
    confirm: async () => true,
  };
  const value = await collectSetupAuthInput(command({
    replaceExisting: true, replaceSpecified: true,
  }), interaction, preparation());
  assert.equal(value.cancelled, false);
  assert.equal(value.input.credentialAction, 'replace');
  assert.equal(value.input.testAuthentication, false);
  assert.equal(selectCalls, 1);
});

test('setup choice collector offers only core-approved credential actions', async () => {
  let options;
  const value = await collectSetupAuthInput(command(), {
    available: () => true,
    write: () => {},
    select: async menu => { if (!options) options = menu.options; return menu.defaultValue; },
    confirm: async () => true,
  }, preparation());
  assert.deepEqual(options.map(item => item.value), ['keep', 'replace', 'remove']);
  assert.equal(value.input.credentialAction, 'keep');
});

test('setup choice collector fails closed for an unknown available action', async () => {
  const prepared = preparation();
  prepared.capabilities.credentialActions.push({ id: 'external_action', available: true, reason: null });
  await assert.rejects(collectSetupAuthInput(command(), {
    available: () => true,
    write: () => {},
    select: async menu => menu.defaultValue,
    confirm: async () => true,
  }, prepared), error => error.code === 'setup_action_unavailable');
});

test('setup choice collector falls back without prompting and uses core defaults', async () => {
  const interaction = {
    available: () => false,
    write: () => { throw new Error('unexpected write'); },
    select: async () => { throw new Error('unexpected select'); },
    confirm: async () => { throw new Error('unexpected confirm'); },
  };
  const value = await collectSetupAuthInput(command(), interaction, preparation({ configured: false }));
  assert.equal(value.interactive, false);
  assert.deepEqual(value.input, {
    provider: 'paycom', profile: 'paycom-main', credentialAction: 'enroll',
    startBroker: true, testAuthentication: false,
  });
  const blockedRemoval = await collectSetupAuthInput(command({ removeSpecified: true }), interaction, preparation());
  assert.equal(blockedRemoval.cancelled, true);
  const confirmedRemoval = await collectSetupAuthInput(command({ removeSpecified: true, confirmed: true }), interaction, preparation());
  assert.equal(confirmedRemoval.cancelled, false);
  assert.equal(confirmedRemoval.input.credentialAction, 'remove');
});
