'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  classify, loginExpression, challengeExpression, submitNativeChallenge, resolveSecurityProfile, waitForState,
  LOGIN_ACTION_URL, SECURITY_QUESTION_PATH, TIMECARD_SEARCH_URL,
  SECURITY_PROFILE_PATH, SECURITY_PROFILE_WARNING,
} = require('../../../plugins/paycom/backend/auth/adapter');

const base = {
  url: 'https://www.paycomonline.net/v4/cl/cl-login.php', text: '', readyState: 'complete',
  loginPresent: [false, false, false], loginVisible: [false, false, false],
  loginFormCount: 0, loginFormAction: '', loginFormMethod: '', challengeFormCount: 0,
  challengeFormAction: '', challengeFormMethod: '', authenticated: false, timecardSearchReady: false, challenge: [],
};

test('Paycom adapter recognizes only exact login, challenge, and authenticated states', () => {
  assert.equal(classify({ ...base, loginPresent: [true, true, true], loginVisible: [true, true, true], loginFormCount: 1, loginFormAction: LOGIN_ACTION_URL, loginFormMethod: 'post' }), 'logged_out');
  assert.equal(classify({ ...base, loginPresent: [true, true, true], loginVisible: [true, true, true], loginFormCount: 1, loginFormAction: base.url, loginFormMethod: 'post' }), 'pending');
  assert.equal(classify({ ...base, loginPresent: [true, true, true], loginVisible: [true, true, true], loginFormCount: 1, loginFormAction: base.url, loginFormMethod: 'get' }), 'pending');
  const challengeUrl = `https://www.paycomonline.net${SECURITY_QUESTION_PATH}`;
  assert.equal(classify({ ...base, url: challengeUrl, challenge: [{ index: 2 }, { index: 5 }], challengeFormCount: 1, challengeFormAction: challengeUrl, challengeFormMethod: 'post', authenticated: true }), 'security_questions_required');
  assert.equal(classify({ ...base, url: challengeUrl, challenge: [{ index: 2 }, { index: 5 }], challengeFormCount: 1, challengeFormAction: challengeUrl, challengeFormMethod: 'get', authenticated: true }), 'manual_verification_required');
  assert.equal(classify({ ...base, url: challengeUrl, challenge: [{ index: 2 }, { index: 2 }], authenticated: true }), 'manual_verification_required');
  assert.equal(classify({ ...base, url: challengeUrl, authenticated: true }), 'pending');
  assert.equal(classify({ ...base, url: TIMECARD_SEARCH_URL, authenticated: true, timecardSearchReady: true }), 'timecard_application');
  assert.equal(classify({ ...base, url: `${TIMECARD_SEARCH_URL}&session_nonce=fixture`, timecardSearchReady: true }), 'timecard_application');
  for (const query of ['from=other&session_nonce=fixture', 'from=main_menu&from=main_menu', 'from=main_menu&session_nonce=a&session_nonce=b', 'session_nonce=fixture']) {
    assert.equal(classify({ ...base, url: TIMECARD_SEARCH_URL.split('?')[0] + '?' + query, timecardSearchReady: true }), 'manual_verification_required');
  }
  assert.equal(classify({ ...base, url: `${TIMECARD_SEARCH_URL}&session_nonce=fixture`, timecardSearchReady: true, captchaPresent: true }), 'manual_verification_required');
  assert.equal(classify({ ...base, url: `${TIMECARD_SEARCH_URL}&unexpected=1`, authenticated: true, timecardSearchReady: true }), 'manual_verification_required');
  assert.equal(classify({ ...base, url: 'https://www.paycomonline.net/v4/cl/web.php/home', authenticated: true }), 'authenticated');
  assert.equal(classify({ ...base, url: 'https://www.paycomonline.net/v4/cl/cl-menu.php?frmlogin=1&session_nonce=fixture', authenticated: true }), 'authenticated');
  assert.equal(classify({ ...base, url: 'https://www.paycomonline.net/v4/cl/web.php/client-landing/arc?frmlogin=1', authenticated: true }), 'authenticated');
  assert.equal(classify({ ...base, url: 'https://www.paycomonline.net/v4/cl/web.php/client-landing/arc?frmlogin=2', authenticated: true }), 'pending');
  assert.equal(classify({ ...base, url: 'https://www.paycomonline.net/v4/cl/web.php/client-landing/arc?frmlogin=1&unexpected=1', authenticated: true }), 'pending');
  assert.equal(classify({ ...base, url: 'https://www.paycomonline.net/v4/cl/web.php/client-landing/arc?frmlogin=1', authenticated: false }), 'pending');
  assert.equal(classify({ ...base, url: 'https://example.com/v4/cl/web.php/home', authenticated: true }), 'manual_verification_required');
  assert.equal(classify({ ...base, url: 'https://www.paycomonline.net/v4/cl/evil', challenge: [{ index: 2 }, { index: 5 }] }), 'manual_verification_required');
  assert.equal(classify({ ...base, loginPresent: [true, true, true], loginVisible: [false, false, false], loginFormCount: 1, loginFormAction: base.url, loginFormMethod: 'post' }), 'pending');
  assert.equal(classify({ ...base, text: 'Your account is locked' }), 'account_locked');
  const primaryRejection = { ...base, text: 'Invalid client code, username, or password' };
  const securityRejection = { ...base, url: challengeUrl, text: 'Security answers are not correct' };
  assert.equal(classify(primaryRejection, { phase: 'primary_login' }), 'primary_credentials_rejected');
  assert.equal(classify(securityRejection, { phase: 'security_questions' }), 'security_answers_rejected');
  assert.equal(classify({ ...securityRejection, url: base.url }, { phase: 'security_questions' }), 'security_answers_rejected');
  assert.equal(classify(primaryRejection), 'manual_verification_required');
  assert.equal(classify(securityRejection), 'manual_verification_required');
  assert.equal(classify({ ...securityRejection, url: 'https://www.paycomonline.net/v4/cl/web.php/home' }, { phase: 'security_questions' }), 'manual_verification_required');
});

test('Paycom waits for page initialization before accepting visible login or PIN forms', () => {
  const login = { ...base, loginPresent: [true, true, true], loginVisible: [true, true, true],
    loginFormCount: 1, loginFormAction: LOGIN_ACTION_URL, loginFormMethod: 'post' };
  const url = `https://www.paycomonline.net${SECURITY_QUESTION_PATH}`;
  const challenge = { ...base, url, challenge: [{ index: 2 }, { index: 5 }],
    challengeFormCount: 1, challengeFormAction: url, challengeFormMethod: 'post' };
  for (const readyState of ['loading', 'interactive', undefined]) {
    assert.equal(classify({ ...login, readyState }), 'pending');
    assert.equal(classify({ ...challenge, readyState }), 'pending');
    assert.equal(classify({ ...challenge, readyState, text: 'Your account is locked' }), 'account_locked');
  }
  assert.equal(classify(login), 'logged_out');
  assert.equal(classify(challenge), 'security_questions_required');
});

test('initial target creation ignores transient about:blank before classifying Paycom', async () => {
  const snapshots = [
    { url: 'about:blank' },
    { ...base, loginPresent: [true, true, true], loginVisible: [true, true, true], loginFormCount: 1, loginFormAction: LOGIN_ACTION_URL, loginFormMethod: 'post' },
  ];
  const result = await waitForState({ async evaluate() { return snapshots.shift(); } }, 1_000, new Set(['manual_verification_required', 'logged_out']));
  assert.equal(result.state, 'logged_out');
});

test('Paycom secret entry expressions are closed to exact credential and PIN fields', () => {
  const credentials = {
    clientCode: 'fixture-client', username: 'fixture-user', password: 'fixture-password',
    pin1: 'one', pin2: 'two', pin3: 'three', pin4: 'four', pin5: 'five',
  };
  const login = loginExpression(credentials);
  assert.equal(login.includes('input[name='), true);
  assert.equal(login.includes('pin1'), false);
  assert.equal(login.includes("toUpperCase()!=='POST'"), true);
  assert.equal(login.includes('/v4/cl/cl-loginproc.php'), true);
  assert.equal(login.includes('setTimeout'), false);
  assert.equal(login.includes('requestSubmit()'), true);
  const challenge = challengeExpression(credentials, [{ index: 2 }, { index: 5 }]);
  assert.equal(challenge.includes('fixture-password'), false);
  assert.equal(challenge.includes('"2":"two"'), true);
  assert.equal(challenge.includes('"5":"five"'), true);
  assert.equal(challenge.includes('"1":"one"'), false);
  assert.equal(challenge.includes("toUpperCase()!=='POST'"), true);
  assert.equal(challenge.includes('setTimeout'), false);
  assert.equal(challenge.includes("button.name==='continue'"), true);
  assert.equal(challenge.includes("'firstIndex'"), true);
  assert.equal(challenge.includes("'secondIndex'"), true);
  assert.equal(challenge.includes('hidden[0].value===String(item.index)'), true);
  assert.equal(challenge.includes('native_challenge_ready'), true);
  assert.equal(challenge.includes('requestSubmit('), false);
});

test('Paycom security answers use OS input with numbered mapping and focus proof', async () => {
  const credentials = {
    clientCode: 'fixture-client', username: 'fixture-user', password: 'fixture-password',
    pin1: 'one', pin2: 'two', pin3: 'three', pin4: 'four', pin5: 'five',
  };
  const challenge = [
    { index: 2, name: 'firstSecurityQuestion', id: 'first_sq_eye_input' },
    { index: 5, name: 'secondSecurityQuestion', id: 'second_sq_eye_input' },
  ];
  const commands = [];
  const connection = {
    async evaluate(expression) {
      if (expression.includes('targetIndex=2') || expression.includes('targetIndex=5')) return expression.includes('verifyFocus=true')
        ? { status: 'native_challenge_field_focused' } : { status: 'native_challenge_field_ready', x: 10, y: 10 };
      return { status: 'native_challenge_ready', x: 10, y: 20 };
    },
    async command(method, parameters) { commands.push({ method, parameters }); return {}; },
  };
  const actions = [];
  const browser = { nativeInput: {
    async click(_connection, x, y) { actions.push({ click: [x, y] }); },
    async type(text) { actions.push({ text }); },
  } };
  await submitNativeChallenge(connection, credentials, challenge, browser);
  assert.deepEqual(actions, [{ click: [10, 10] }, { text: 'two' }, { click: [10, 10] }, { text: 'five' }, { click: [10, 20] }]);
  assert.deepEqual(commands, []);
  await assert.rejects(submitNativeChallenge(connection, credentials, challenge), { code: 'browser_interaction_required' });

});

test('Paycom security-profile campaign is recognized only with the exact route and controls', () => {
  const url = `https://www.paycomonline.net${SECURITY_PROFILE_PATH}?session_nonce=fixture`;
  const prompt = {
    ...base, url, text: 'Setup Your Security Profile\nVerify your contact information',
    securityProfile: {
      inputNames: ['cell-number', 'email', 'work-number'],
      buttonTexts: ['Continue', 'Not Now', 'Verify', 'Verify', 'Verify'],
    },
  };
  assert.equal(classify(prompt), 'security_profile_prompt');
  assert.equal(classify({
    ...prompt,
    text: `${prompt.text}\nWarning\n${SECURITY_PROFILE_WARNING}`,
    securityProfile: {
      ...prompt.securityProfile,
      buttonTexts: ['', 'Cancel', 'Continue', 'Continue', 'Not Now', 'Verify', 'Verify', 'Verify'],
    },
  }), 'security_profile_confirmation');
  assert.equal(classify({ ...prompt, url: `${url}&unexpected=1` }), 'manual_verification_required');
  assert.equal(classify({ ...prompt, securityProfile: { ...prompt.securityProfile, inputNames: ['email'] } }), 'manual_verification_required');
  assert.equal(classify({ ...prompt, securityProfile: { ...prompt.securityProfile, buttonTexts: ['Continue'] } }), 'manual_verification_required');
  for (const text of ['Verify your identity', 'Learn about multi-factor authentication', 'Enter verification code']) {
    assert.equal(classify({ ...prompt, text: `${prompt.text}\n${text}` }), 'security_profile_prompt');
  }
  for (const control of ['otpPresent', 'captchaPresent']) {
    assert.equal(classify({ ...prompt, [control]: true }), 'manual_verification_required');
  }
  assert.equal(classify({ ...prompt, readyState: 'loading' }), 'pending');
  assert.equal(classify({ ...prompt, challenge: [{ index: 1, name: 'pin1', id: 'pin1' }] }), 'manual_verification_required');
});

test('security-profile campaign dismissal uses the exact three native-click phases', async () => {
  const url = `https://www.paycomonline.net${SECURITY_PROFILE_PATH}?session_nonce=fixture`;
  const prompt = {
    ...base, url, text: 'Setup Your Security Profile\nVerify your contact information',
    securityProfile: {
      inputNames: ['cell-number', 'email', 'work-number'],
      buttonTexts: ['Continue', 'Not Now', 'Verify', 'Verify', 'Verify'],
    },
  };
  const confirmation = {
    ...prompt, text: `${prompt.text}\nWarning\n${SECURITY_PROFILE_WARNING}`,
    securityProfile: {
      ...prompt.securityProfile,
      buttonTexts: ['', 'Cancel', 'Continue', 'Continue', 'Not Now', 'Verify', 'Verify', 'Verify'],
    },
  };
  const partial = { ...prompt, securityProfile: { inputNames: [], buttonTexts: [] } };
  const snapshots = [{ ...partial, readyState: 'loading' }, confirmation, partial, prompt, partial,
    { ...base, url: 'https://www.paycomonline.net/v4/cl/web.php/home', authenticated: true }];
  const preparedStatuses = [];
  const commands = [];
  const connection = {
    async evaluate(expression) {
      for (const status of ['security_profile_dismiss_ready', 'security_profile_confirmation_ready', 'security_profile_proceed_ready']) {
        if (expression.includes(status)) { preparedStatuses.push(status); return { status, x: 10, y: 20 }; }
      }
      return snapshots.shift();
    },
    async command(method, parameters) { commands.push({ method, parameters }); return {}; },
  };
  const result = await resolveSecurityProfile(connection, { state: 'security_profile_prompt', snapshot: prompt });
  assert.equal(result.state, 'authenticated');
  assert.deepEqual(preparedStatuses, [
    'security_profile_dismiss_ready', 'security_profile_confirmation_ready', 'security_profile_proceed_ready',
  ]);
  assert.equal(commands.length, 9);
  assert.equal(commands.every(item => item.method === 'Input.dispatchMouseEvent'), true);
});

test('login verification stops at authenticated landing without timecard navigation', async () => {
  const { verifyTimecardApplication } = require('../../../plugins/paycom/backend/auth/adapter');
  const initial = { state: 'authenticated', snapshot: { ...base,
    url: 'https://www.paycomonline.net/v4/cl/web.php/home', authenticated: true } };
  const unexpected = async () => assert.fail('Login-only verification must not navigate or interact after login');
  assert.equal(await verifyTimecardApplication({ command: unexpected, evaluate: unexpected }, initial,
    {}, unexpected, undefined, value => value, true), initial);
  await assert.rejects(verifyTimecardApplication({ command: unexpected, evaluate: unexpected },
    { state: 'manual_verification_required', snapshot: base }, {}, unexpected, undefined, value => value, true),
    /manual_verification_required/);
});

test('profile transition stops at verification, rejection, or an unexpected route without another click', async () => {
  const { verifyTimecardApplication } = require('../../../plugins/paycom/backend/auth/adapter');
  const url = `https://www.paycomonline.net${SECURITY_PROFILE_PATH}`;
  for (const [change, code] of [
    [{ otpPresent: true }, 'manual_verification_required'],
    [{ captchaPresent: true }, 'manual_verification_required'],
    [{ text: 'Your account is locked' }, 'account_locked'],
    [{ url: `${url}?unexpected=fixture` }, 'manual_verification_required'],
    [{ url: 'https://example.invalid/' }, 'manual_verification_required'],
  ]) {
    let clicks = 0;
    const connection = {
      async evaluate(expression) {
        return expression.includes('security_profile_dismiss_ready')
          ? { status: 'security_profile_dismiss_ready', x: 10, y: 20 }
          : { ...base, url, securityProfile: { inputNames: [], buttonTexts: [] }, ...change };
      },
      async command(method) { assert.equal(method, 'Input.dispatchMouseEvent'); clicks++; return {}; },
    };
    await assert.rejects(verifyTimecardApplication(connection, { state: 'security_profile_prompt', snapshot: { ...base, url } },
      {}, () => assert.fail('Must not resubmit credentials'), undefined, value => value, true), error => error.code === code);
    assert.equal(clicks, 3);
  }
});

test('profile rendering timeout and cancellation do not repeat dismissal', async t => {
  const url = `https://www.paycomonline.net${SECURITY_PROFILE_PATH}`;
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  for (const cancel of [false, true]) {
    now = 0;
    let clicks = 0;
    const controller = new AbortController();
    const connection = {
      async evaluate(expression) {
        if (expression.includes('security_profile_dismiss_ready')) return { status: 'security_profile_dismiss_ready', x: 10, y: 20 };
        now = 16_000;
        if (cancel) controller.abort();
        return { ...base, url, text: 'Verify your identity', securityProfile: { inputNames: [], buttonTexts: [] } };
      },
      async command() { clicks++; return {}; },
    };
    const operation = resolveSecurityProfile(connection, { state: 'security_profile_prompt', snapshot: { ...base, url } }, controller.signal);
    if (cancel) await assert.rejects(operation, error => error.code === 'acquisition_cancelled');
    else {
      const result = await operation;
      assert.equal(result.state, 'manual_verification_required');
      assert.equal(result.diagnostic.reason, 'security_profile_response_timeout');
    }
    assert.equal(clicks, 3);
  }
});

test('challenge diagnostics distinguish provider rejection, additional verification, and changed layouts', () => {
  const { classifyState } = require('../../../plugins/paycom/backend/auth/adapter');
  const url = `https://www.paycomonline.net${SECURITY_QUESTION_PATH}`;
  const snapshot = { ...base, url, challenge: [{ index: 2 }, { index: 5 }], challengeFormCount: 1,
    challengeFormAction: url, challengeFormMethod: 'post' };
  for (const [change, state, reason] of [
    [{ text: 'Security answers are not correct' }, 'security_answers_rejected', 'security_answers_rejected'],
    [{ text: 'Verify your identity' }, 'manual_verification_required', 'additional_verification'],
    [{ text: 'Invalid username' }, 'manual_verification_required', 'ambiguous_rejection'],
    [{ challengeFormMethod: 'get' }, 'manual_verification_required', 'challenge_layout_changed'],
    [{ url: `${url}?unexpected=private-value` }, 'manual_verification_required', 'unexpected_query'],
  ]) assert.deepEqual(classifyState({ ...snapshot, ...change }, { phase: 'security_questions' }), { state, reason });
});

test('challenge submission retains the exact terminal classifier reason without raw page text', async () => {
  const { verifyTimecardApplication } = require('../../../plugins/paycom/backend/auth/adapter');
  const url = `https://www.paycomonline.net${SECURITY_QUESTION_PATH}`;
  const snapshot = { ...base, url, challenge: [{ index: 2 }, { index: 5 }], challengeFormCount: 1,
    challengeFormAction: url, challengeFormMethod: 'post' };
  const observations = [];
  const connection = {
    async evaluate(expression) {
      if (expression.includes('targetIndex=')) return expression.includes('verifyFocus=true')
        ? { status: 'native_challenge_field_focused' } : { status: 'native_challenge_field_ready', x: 10, y: 10 };
      if (expression.includes('native_challenge_ready')) return { status: 'native_challenge_ready', x: 10, y: 10 };
      return { ...snapshot, text: 'Verify your identity' };
    },
    async command() { return {}; },
  };
  await assert.rejects(verifyTimecardApplication(connection, { state: 'security_questions_required', snapshot },
    { pin2: 'two', pin5: 'five' }, () => {}, undefined, value => { observations.push(value); return value; }, true,
    { nativeInput: { async click() {}, async type() {} } }), /manual_verification_required/);
  assert.deepEqual(observations[0].diagnostic, { phase: 'security_questions', route: 'security_question', evidence: 'adapter_check', reason: 'additional_verification' });
});


test('Paycom requests native interaction before counting a PIN attempt', async () => {
  const { verifyTimecardApplication } = require('../../../plugins/paycom/backend/auth/adapter');
  let submitted = 0;
  await assert.rejects(verifyTimecardApplication({}, { state: 'security_questions_required', snapshot: {} },
    {}, () => submitted++), { code: 'browser_interaction_required' });
  assert.equal(submitted, 0);
});
