'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  APPLICATION_URL, LOGIN_ACTION_URL, SNAPSHOT, AFTER_USERNAME_STATES,
  classify, exactApplicationUrl, exactLoginUrl, exactLoginAction,
  stateMetadata, usernameExpression, passwordExpression, credentialsExpression,
  waitForState, authenticateConnection, amazonLogisticsAdapter,
} = require('../src/adapters/amazon-logistics');
const { BrowserSessionManager, DEFAULT_ADAPTERS } = require('../src/session-manager');
const { PERSISTENT_PROVIDERS } = require('../src/browser-runtime');
const { publicProviders, validateCredentials } = require('../src/providers');
const { defaultPaths } = require('../src/paths');
const { CredentialVault } = require('../src/vault');
const { persistentProvidersToReset } = require('../src/admin-cli');

const LOGIN_URL = 'https://www.amazon.com/ap/signin?openid.mode=checkid_setup&openid.return_to=https%3A%2F%2Flogistics.amazon.com%2Foperations%2Fexecution';
const base = {
  url: LOGIN_URL,
  title: 'Amazon Sign-In',
  readyState: 'complete',
  text: '',
  usernameCount: 0,
  usernameTypes: [],
  passwordCount: 0,
  passwordTypes: [],
  formCount: 0,
  formAction: '',
  formMethod: '',
  submitIds: [],
  otpPresent: false,
  captchaPresent: false,
  logoutPresent: false,
  performanceLinkPresent: false,
  applicationReady: false,
};
function usernamePage(overrides = {}) {
  return {
    ...base, usernameCount: 1, usernameTypes: ['email'], formCount: 1,
    formAction: LOGIN_ACTION_URL, formMethod: 'post', submitIds: ['continue'], ...overrides,
  };
}
function passwordPage(overrides = {}) {
  return {
    ...base, passwordCount: 1, passwordTypes: ['password'], formCount: 1,
    formAction: LOGIN_ACTION_URL, formMethod: 'post', submitIds: ['signInSubmit'], ...overrides,
  };
}

test('Amazon Logistics provider is closed, registered, and persistent', () => {
  assert.deepEqual(validateCredentials('amazon-logistics', {
    username: 'fixture-amazon-user', password: 'fixture-amazon-password',
  }), { username: 'fixture-amazon-user', password: 'fixture-amazon-password' });
  assert.throws(() => validateCredentials('amazon-logistics', {
    username: 'fixture-amazon-user', password: 'fixture-amazon-password', otp: '123456',
  }), error => error.code === 'invalid_input');
  const provider = publicProviders().find(item => item.provider === 'amazon-logistics');
  assert.deepEqual(provider, { provider: 'amazon-logistics', fields: ['username', 'password'] });
  assert.equal(DEFAULT_ADAPTERS['amazon-logistics'], amazonLogisticsAdapter);
  assert.equal(typeof amazonLogisticsAdapter.inspect, 'function');
  assert.equal(PERSISTENT_PROVIDERS.includes('amazon-logistics'), true);
  assert.deepEqual(persistentProvidersToReset('paycom', 'amazon-logistics'), ['paycom', 'amazon-logistics']);
  assert.deepEqual(persistentProvidersToReset('amazon-logistics', 'amazon-logistics'), ['amazon-logistics']);
});

test('Amazon state classification requires exact routes, phases, and capability evidence', () => {
  assert.equal(exactApplicationUrl(APPLICATION_URL), true);
  assert.equal(exactApplicationUrl(`${APPLICATION_URL}/`), true);
  assert.equal(exactApplicationUrl(`${APPLICATION_URL}//`), false);
  assert.equal(exactApplicationUrl(`${APPLICATION_URL}?unexpected=1`), false);
  assert.equal(exactLoginUrl(LOGIN_URL), true);
  assert.equal(exactLoginUrl(`${LOGIN_URL}&marketPlaceId=fixture`), true);
  assert.equal(exactLoginUrl(`${LOGIN_URL}&clientContext=fixture`), true);
  assert.equal(exactLoginUrl(`${LOGIN_URL}&clientContext=fixture&clientContext=duplicate`), false);
  assert.equal(exactLoginUrl(`${LOGIN_URL}&redirect=https://evil.example`), false);
  assert.equal(exactLoginUrl(LOGIN_ACTION_URL), false);
  assert.equal(exactLoginAction(LOGIN_ACTION_URL), true);
  assert.equal(exactLoginUrl('https://www.amazon.com/ap/signin?unexpected=1'), false);
  assert.equal(exactLoginUrl('https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fevil.example%2F'), false);
  assert.equal(exactLoginUrl('https://amazon.com/ap/signin?openid.return_to=https%3A%2F%2Flogistics.amazon.com%2Foperations%2Fexecution'), false);

  assert.equal(classify({
    ...base, url: APPLICATION_URL, title: 'Operations', applicationReady: true,
    logoutPresent: true, performanceLinkPresent: true,
  }), 'authenticated');
  assert.equal(classify({ ...base, url: APPLICATION_URL, applicationReady: true }), 'manual_verification_required');
  assert.equal(classify({ ...base, url: APPLICATION_URL, title: 'Operations' }), 'manual_verification_required');
  assert.equal(classify(usernamePage()), 'username_required');
  assert.equal(classify(passwordPage()), 'password_required');
  assert.equal(classify(passwordPage({ formMethod: 'get' })), 'manual_verification_required');
  assert.equal(classify(passwordPage({ submitIds: ['alternate', 'signInSubmit'] })), 'manual_verification_required');
  assert.equal(classify({
    ...usernamePage(), passwordCount: 1, passwordTypes: ['password'], submitIds: ['signInSubmit'],
  }), 'credentials_required');
  const combinedWithoutSubmit = {
    ...usernamePage(), passwordCount: 1, passwordTypes: ['password'], submitIds: [],
  };
  assert.equal(classify(combinedWithoutSubmit, { phase: 'password_submission' }), 'pending');
  assert.equal(classify(combinedWithoutSubmit, { phase: 'observation' }), 'manual_verification_required');
  assert.equal(classify({ ...base, url: 'https://evil.example/ap/signin', usernameCount: 1 }), 'manual_verification_required');
});

test('Amazon challenge, lockout, and rejection states fail closed', () => {
  assert.equal(classify({ ...base, url: 'https://www.amazon.com/ap/cvf/verify', otpPresent: true }), 'mfa_required');
  assert.equal(classify({ ...base, captchaPresent: true, text: 'Enter the characters shown' }), 'captcha_required');
  assert.equal(classify({ ...base, url: 'https://www.amazon.com/ap/challenge/approval' }), 'security_challenge');
  assert.equal(classify({ ...base, text: 'Your account has been locked' }), 'account_locked');
  const rejected = { ...base, text: 'The password you entered is incorrect' };
  assert.equal(classify(rejected, { phase: 'password_submission' }), 'invalid_credentials');
  assert.equal(classify(rejected, { phase: 'observation' }), 'manual_verification_required');
  assert.equal(classify({ ...base, readyState: 'loading' }), 'pending');
});

test('Amazon inspection metadata excludes query values and page text', () => {
  const metadata = stateMetadata(usernamePage({
    formAction: `${LOGIN_ACTION_URL}?marketPlaceId=private-value`, text: 'private page text',
  }));
  assert.equal(metadata.formActionOrigin, 'https://www.amazon.com');
  assert.equal(metadata.formActionPath, '/ap/signin');
  assert.deepEqual(metadata.formActionQueryKeys, ['marketPlaceId']);
  assert.equal(JSON.stringify(metadata).includes('private-value'), false);
  assert.equal(JSON.stringify(metadata).includes('private page text'), false);
});

test('Amazon secret-entry expressions are exact-route, exact-form, and single-field', () => {
  const credentials = { username: 'fixture-amazon-user', password: 'fixture-amazon-password' };
  const username = usernameExpression(credentials);
  const password = passwordExpression(credentials);
  const combined = credentialsExpression(credentials);
  assert.equal(username.includes('fixture-amazon-user'), true);
  assert.equal(username.includes('fixture-amazon-password'), false);
  assert.equal(password.includes('fixture-amazon-password'), true);
  assert.equal(password.includes('fixture-amazon-user'), false);
  assert.equal(combined.includes('fixture-amazon-user'), true);
  assert.equal(combined.includes('fixture-amazon-password'), true);
  assert.equal(combined.includes('passwords[0].form!==form'), true);
  assert.equal(combined.includes('buttons.length!==1'), true);
  for (const expression of [username, password]) {
    assert.equal(expression.includes("x.pathname!=='/ap/signin'"), true);
    assert.equal(expression.includes("String(form.method).toUpperCase()!=='POST'"), true);
    assert.equal(expression.includes('opposite.length!==0'), true);
    assert.equal(expression.includes('buttons.length!==1'), true);
    assert.equal(expression.includes('form.requestSubmit(buttons[0])'), true);
    assert.equal(expression.includes('setTimeout'), false);
  }
});

test('Amazon readiness waits through transient about:blank and returns a closed state', async () => {
  const snapshots = [{ url: 'about:blank' }, usernamePage()];
  const result = await waitForState({ async evaluate() { return snapshots.shift(); } }, 1_000);
  assert.equal(result.state, 'username_required');
});

test('Amazon post-submit polling ignores the unchanged credential phase', async () => {
  const snapshots = [usernamePage(), usernamePage(), passwordPage()];
  const result = await waitForState(
    { async evaluate() { return snapshots.shift(); } },
    1_000, AFTER_USERNAME_STATES, null, { phase: 'username_submission' },
  );
  assert.equal(result.state, 'password_required');
});

test('Amazon combined credential form submits once and stops on MFA', async () => {
  const snapshots = [
    { ...usernamePage(), passwordCount: 1, passwordTypes: ['password'], submitIds: ['signInSubmit'] },
    { ...base, url: 'https://www.amazon.com/ap/cvf/verify', otpPresent: true },
  ];
  const expressions = [];
  const connection = {
    async evaluate(expression) {
      if (expression === SNAPSHOT) return snapshots.shift();
      expressions.push(expression);
      return { status: 'submitted' };
    },
  };
  let latches = 0;
  const states = [];
  await assert.rejects(authenticateConnection(
    { endpoint: 'http://127.0.0.1:9555' }, { id: 'fixture-target' }, connection,
    { username: 'fixture-amazon-user', password: 'fixture-amazon-password' },
    { onSubmit() { latches += 1; }, onState(state) { states.push(state); } },
  ), error => error.code === 'mfa_required');
  assert.equal(latches, 1);
  assert.equal(expressions.length, 1);
  assert.equal(expressions[0].includes('fixture-amazon-user'), true);
  assert.equal(expressions[0].includes('fixture-amazon-password'), true);
  assert.deepEqual(states, ['credentials_required', 'credentials_submitted', 'mfa_required']);
});

test('Amazon authentication executes both closed phases once and stops on MFA', async () => {
  const snapshots = [
    usernamePage(), usernamePage(), passwordPage(),
    { ...base, url: 'https://www.amazon.com/ap/cvf/verify', otpPresent: true },
  ];
  const submitted = [];
  const connection = {
    async evaluate(expression) {
      if (expression === SNAPSHOT) return snapshots.shift();
      submitted.push(expression);
      return { status: 'submitted' };
    },
  };
  let latches = 0;
  await assert.rejects(authenticateConnection(
    { endpoint: 'http://127.0.0.1:9555' }, { id: 'fixture-target' }, connection,
    { username: 'fixture-amazon-user', password: 'fixture-amazon-password' },
    { onSubmit() { latches += 1; } },
  ), error => error.code === 'mfa_required');
  assert.equal(latches, 1);
  assert.equal(submitted.length, 2);
  assert.equal(submitted[0].includes('fixture-amazon-user'), true);
  assert.equal(submitted[1].includes('fixture-amazon-password'), true);
});

test('Amazon terminal challenge codes survive the broker boundary and credentials are scrubbed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-amazon-session-'));
  fs.chmodSync(root, 0o700);
  const paths = defaultPaths({
    databaseRoot: path.join(root, 'db'), secretRoot: path.join(root, 'secrets'),
    stateRoot: path.join(root, 'state'), runtimeRoot: path.join(root, 'run'),
  });
  const vault = new CredentialVault(paths);
  vault.put('amazon-operations', 'amazon-logistics', {
    username: 'fixture-amazon-user', password: 'fixture-amazon-password',
  });
  let observed;
  const browser = { endpoint: 'http://127.0.0.1:9555', closed: false, async close() { this.closed = true; } };
  const manager = new BrowserSessionManager({
    vault,
    browserRuntime: { launch: async () => browser },
    adapters: {
      'amazon-logistics': {
        provider: 'amazon-logistics',
        async authenticate(_browser, credentials, { onSubmit }) {
          observed = credentials;
          onSubmit('credentials');
          throw Object.assign(new Error('mfa_required'), { code: 'mfa_required' });
        },
      },
    },
  });
  try {
    await assert.rejects(manager.acquire({
      profile: 'amazon-operations', collector: 'cdf', runId: 'run-amazon-mfa', ttlSeconds: 30,
    }), error => error.code === 'mfa_required');
    assert.equal(browser.closed, true);
    assert.deepEqual(observed, { username: '', password: '' });
  } finally {
    await manager.close();
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
