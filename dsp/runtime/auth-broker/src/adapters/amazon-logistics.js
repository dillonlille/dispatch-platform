'use strict';

const { CdpConnection, createTarget } = require('../cdp');

const PROVIDER = 'amazon-logistics';
const APPLICATION_ORIGIN = 'https://logistics.amazon.com';
const APPLICATION_PATH = '/operations/execution';
const APPLICATION_URL = `${APPLICATION_ORIGIN}${APPLICATION_PATH}`;
const PERFORMANCE_PATH = '/performance';
const LOGIN_ORIGIN = 'https://www.amazon.com';
const LOGIN_PATH = '/ap/signin';
const LOGIN_ACTION_URL = `${LOGIN_ORIGIN}${LOGIN_PATH}`;
const APPROVED_HOSTS = Object.freeze(['logistics.amazon.com', 'www.amazon.com']);
const ALLOWED_LOGIN_QUERY_KEYS = new Set([
  'clientContext', 'disableLoginPrepopulate', 'language', 'marketPlaceId', 'openid.assoc_handle', 'openid.claimed_id',
  'openid.identity', 'openid.mode', 'openid.ns', 'openid.ns.pape',
  'openid.pape.max_auth_age', 'openid.return_to', 'pageId', 'ref_', 'showRmrMe',
]);
const TERMINAL_STATES = new Set([
  'authenticated', 'credentials_required', 'username_required', 'password_required', 'mfa_required',
  'captcha_required', 'security_challenge', 'invalid_credentials',
  'account_locked', 'manual_verification_required',
]);
const AFTER_USERNAME_STATES = new Set([...TERMINAL_STATES].filter(state => state !== 'username_required'));
const AFTER_PASSWORD_STATES = new Set([...TERMINAL_STATES].filter(state => state !== 'password_required'));
const AFTER_CREDENTIALS_STATES = new Set([...TERMINAL_STATES].filter(state => !['credentials_required', 'username_required', 'password_required'].includes(state)));

class AmazonLogisticsAuthError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new AmazonLogisticsAuthError('acquisition_cancelled');
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    try { throwIfAborted(signal); } catch (error) { reject(error); return; }
    const timer = setTimeout(done, ms);
    function done() { cleanup(); resolve(); }
    function aborted() { cleanup(); reject(new AmazonLogisticsAuthError('acquisition_cancelled')); }
    function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', aborted); }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function parsedApprovedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !APPROVED_HOSTS.includes(url.hostname.toLowerCase())
        || url.port || url.username || url.password || url.hash) return null;
    return url;
  } catch { return null; }
}

function exactApplicationUrl(value) {
  const url = parsedApprovedUrl(value);
  return Boolean(url && url.origin === APPLICATION_ORIGIN
    && [APPLICATION_PATH, `${APPLICATION_PATH}/`].includes(url.pathname) && url.search === '');
}

function loginUrl(value, { requireReturn = true } = {}) {
  const url = parsedApprovedUrl(value);
  if (!url || url.origin !== LOGIN_ORIGIN || url.pathname !== LOGIN_PATH) return null;
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => !ALLOWED_LOGIN_QUERY_KEYS.has(key))) return null;
  const returnValue = url.searchParams.get('openid.return_to');
  if (requireReturn && returnValue === null) return null;
  if (returnValue !== null && !exactApplicationUrl(returnValue)) return null;
  return url;
}

function exactLoginUrl(value) { return Boolean(loginUrl(value)); }
function exactLoginAction(value) {
  const url = loginUrl(value, { requireReturn: false });
  return Boolean(url && (url.search === '' || exactLoginUrl(value)));
}

function challengeUrl(value) {
  const url = parsedApprovedUrl(value);
  return Boolean(url && url.origin === LOGIN_ORIGIN && /^\/ap\/(?:cvf|challenge)(?:\/|$)/i.test(url.pathname));
}

const SNAPSHOT = `(()=>{
  const visible=e=>!!e&&!e.disabled&&e.offsetParent!==null;
  const unique=selectors=>Array.from(new Set(selectors.flatMap(selector=>Array.from(document.querySelectorAll(selector))))).filter(visible);
  const username=unique(['#ap_email','input[name="email"]']);
  const password=unique(['#ap_password','input[name="password"]']);
  const fields=[...username,...password];
  const forms=Array.from(new Set(fields.map(field=>field.form).filter(Boolean)));
  const submits=forms.length===1?Array.from(forms[0].querySelectorAll('button,input[type="submit"]')).filter(visible):[];
  const text=String(document.body&&document.body.innerText||'').slice(0,12000);
  const root=document.querySelector('#root,#app,[data-reactroot],main,[role="main"]');
  // Account and Performance links live in collapsed navigation menus. Their
  // DOM presence is stable across viewport sizes; visibility is not.
  const logoutPresent=Array.from(document.querySelectorAll('#fp-profile-menu a, a,button,input[type="button"],input[type="submit"]'))
    .some(control=>/^(?:sign out|log out)$/i.test(String(control.innerText||control.textContent||control.value||'').replace(/\\s+/g,' ').trim()));
  const performanceLinkPresent=Array.from(document.querySelectorAll('a[href]')).some(anchor=>{try{const u=new URL(anchor.href);return u.protocol==='https:'&&u.origin==='https://logistics.amazon.com'&&u.pathname==='/performance'}catch{return false}});
  const host=location.hostname.toLowerCase();
  const applicationReady=location.protocol==='https:'&&host==='logistics.amazon.com'&&['/operations/execution','/operations/execution/'].includes(location.pathname)
    &&location.search===''&&document.readyState==='complete'&&!!root&&String(root.innerText||root.textContent||'').trim().length>0
    &&username.length===0&&password.length===0&&logoutPresent&&performanceLinkPresent;
  return {
    url:location.href,
    title:String(document.title||'').slice(0,120),
    readyState:document.readyState,
    text,
    usernameCount:username.length,
    usernameTypes:username.map(field=>String(field.type||'').toLowerCase()).sort(),
    passwordCount:password.length,
    passwordTypes:password.map(field=>String(field.type||'').toLowerCase()).sort(),
    formCount:forms.length,
    formAction:forms.length===1?forms[0].action:'',
    formMethod:forms.length===1?forms[0].method:'',
    submitIds:submits.map(button=>button.id||button.name||'').sort(),
    otpPresent:unique(['input#input-box-otp','input#cvf-input-code','input[name="otpCode"]','input[name="code"]']).length>0,
    verificationRejected:Array.from(document.querySelectorAll('[role="alert"],.a-alert-content')).filter(visible).some(e=>/code.{0,40}(not valid|invalid|incorrect)|incorrect.{0,20}code/i.test(e.innerText||'')),
    verificationExpired:Array.from(document.querySelectorAll('[role="alert"],.a-alert-content')).filter(visible).some(e=>/code.{0,40}expired|expired.{0,20}code/i.test(e.innerText||'')),
    captchaPresent:unique(['#auth-captcha-guess','input[name="guess"]','img[alt*="captcha" i]']).length>0,
    logoutPresent,
    performanceLinkPresent,
    applicationReady
  };
})()`;

function exactArray(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function classify(snapshot, { phase = 'observation' } = {}) {
  const url = parsedApprovedUrl(snapshot?.url);
  if (!url) return 'manual_verification_required';
  const text = String(snapshot?.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (/account.{0,40}(locked|disabled|suspended)|too many.{0,30}(attempt|request)/.test(text)) return 'account_locked';
  if (snapshot?.captchaPresent === true || /captcha|enter the characters|robot check/.test(text)) return 'captcha_required';
  if (challengeUrl(snapshot.url)) {
    if (snapshot?.otpPresent === true || /one[- ]time password|security code|authenticator|two[- ]step|verification code/.test(text)) return 'mfa_required';
    return 'security_challenge';
  }
  if (snapshot?.otpPresent === true || /one[- ]time password|security code|authenticator|two[- ]step|verification code/.test(text)) return 'mfa_required';
  if (/verify your identity|approval required|unusual activity|security challenge/.test(text)) return 'security_challenge';
  const rejected = /password.{0,30}(incorrect|invalid)|incorrect.{0,20}password|cannot find an account|no account.{0,20}found|invalid.{0,30}(email|username|credential)/.test(text);
  if (rejected) {
    return ['username_submission', 'password_submission'].includes(phase) && exactLoginUrl(snapshot.url)
      ? 'invalid_credentials' : 'manual_verification_required';
  }
  if (exactApplicationUrl(snapshot.url)) {
    const proven = snapshot.applicationReady === true && snapshot.logoutPresent === true
      && snapshot.performanceLinkPresent === true && snapshot.usernameCount === 0 && snapshot.passwordCount === 0;
    if (proven) return 'authenticated';
    return snapshot.readyState === 'complete' ? 'manual_verification_required' : 'pending';
  }
  if (exactLoginUrl(snapshot.url)) {
    const formValid = snapshot.formCount === 1 && exactLoginAction(snapshot.formAction)
      && String(snapshot.formMethod).toUpperCase() === 'POST';
    const submitIds = Array.isArray(snapshot.submitIds) ? snapshot.submitIds : [];
    const usernameShape = snapshot.usernameCount === 1 && Array.isArray(snapshot.usernameTypes)
      && snapshot.usernameTypes.length === 1 && ['email', 'text'].includes(snapshot.usernameTypes[0]);
    const passwordShape = snapshot.passwordCount === 1 && exactArray(snapshot.passwordTypes, ['password']);
    if (['username_submission', 'password_submission'].includes(phase) && formValid && submitIds.length === 0
        && (usernameShape && passwordShape || usernameShape && snapshot.passwordCount === 0
          || passwordShape && snapshot.usernameCount === 0)) return 'pending';
    if (formValid && snapshot.usernameCount === 1 && snapshot.passwordCount === 1
        && usernameShape && passwordShape
        && exactArray(submitIds, ['signInSubmit'])) return 'credentials_required';
    if (formValid && snapshot.usernameCount === 0 && snapshot.passwordCount === 1
        && exactArray(snapshot.passwordTypes, ['password']) && exactArray(submitIds, ['signInSubmit'])) return 'password_required';
    if (formValid && snapshot.usernameCount === 1 && snapshot.passwordCount === 0
        && usernameShape && exactArray(submitIds, ['continue'])) return 'username_required';
    return snapshot.readyState === 'complete' ? 'manual_verification_required' : 'pending';
  }
  return snapshot.readyState === 'complete' ? 'manual_verification_required' : 'pending';
}

function stateMetadata(snapshot) {
  const url = parsedApprovedUrl(snapshot?.url);
  const formAction = parsedApprovedUrl(snapshot?.formAction);
  const safeArray = value => Array.isArray(value)
    ? value.filter(item => typeof item === 'string' && /^[A-Za-z0-9_-]{0,64}$/.test(item)).slice(0, 8)
    : [];
  return {
    origin: url?.origin || null,
    path: url?.pathname || null,
    queryKeys: url ? [...url.searchParams.keys()].sort() : [],
    title: typeof snapshot?.title === 'string' ? snapshot.title.slice(0, 120) : null,
    readyState: ['loading', 'interactive', 'complete'].includes(snapshot?.readyState) ? snapshot.readyState : null,
    usernameCount: Number.isInteger(snapshot?.usernameCount) ? snapshot.usernameCount : null,
    usernameTypes: safeArray(snapshot?.usernameTypes),
    passwordCount: Number.isInteger(snapshot?.passwordCount) ? snapshot.passwordCount : null,
    passwordTypes: safeArray(snapshot?.passwordTypes),
    formCount: Number.isInteger(snapshot?.formCount) ? snapshot.formCount : null,
    formActionOrigin: formAction?.origin || null,
    formActionPath: formAction?.pathname || null,
    formActionQueryKeys: formAction ? [...formAction.searchParams.keys()].sort() : [],
    formMethod: typeof snapshot?.formMethod === 'string' ? snapshot.formMethod.toUpperCase().slice(0, 16) : null,
    submitIds: safeArray(snapshot?.submitIds),
    otpPresent: snapshot?.otpPresent === true,
    captchaPresent: snapshot?.captchaPresent === true,
    applicationReady: snapshot?.applicationReady === true,
  };
}

function safeLoginExpression(kind, value) {
  if (!['username', 'password'].includes(kind) || typeof value !== 'string' || !value) {
    throw new AmazonLogisticsAuthError('authentication_failed');
  }
  const selectors = kind === 'username' ? ['#ap_email', 'input[name="email"]'] : ['#ap_password', 'input[name="password"]'];
  const oppositeSelectors = kind === 'username' ? ['#ap_password', 'input[name="password"]'] : ['#ap_email', 'input[name="email"]'];
  const expectedTypes = kind === 'username' ? ['email', 'text'] : ['password'];
  const submitId = kind === 'username' ? 'continue' : 'signInSubmit';
  const encoded = JSON.stringify(value).replace(/</g, '\\u003c');
  return `(()=>{
    const approved=${JSON.stringify(APPROVED_HOSTS)},allowed=${JSON.stringify([...ALLOWED_LOGIN_QUERY_KEYS])},application=${JSON.stringify(APPLICATION_URL)},loginOrigin=${JSON.stringify(LOGIN_ORIGIN)};
    const parsed=u=>{try{const x=new URL(u),keys=Array.from(x.searchParams.keys());if(x.protocol!=='https:'||!approved.includes(x.hostname.toLowerCase())||x.origin!==loginOrigin||x.port||x.username||x.password||x.hash||x.pathname!=='/ap/signin'||new Set(keys).size!==keys.length||keys.some(key=>!allowed.includes(key)))return null;const value=x.searchParams.get('openid.return_to');if(value!==null&&value!==application&&value!==application+'/')return null;return x}catch{return null}};
    const safePage=u=>{const x=parsed(u);return !!x&&[application,application+'/'].includes(x.searchParams.get('openid.return_to'))};
    const safeAction=u=>{const x=parsed(u);return !!x&&(x.search===''||safePage(u))};
    if(!safePage(location.href))return {status:'login_layout_changed'};
    const visible=e=>!!e&&!e.disabled&&e.offsetParent!==null;
    const unique=selectors=>Array.from(new Set(selectors.flatMap(selector=>Array.from(document.querySelectorAll(selector))))).filter(visible);
    const fields=unique(${JSON.stringify(selectors)}),opposite=unique(${JSON.stringify(oppositeSelectors)});
    if(fields.length!==1||opposite.length!==0||!${JSON.stringify(expectedTypes)}.includes(String(fields[0].type||'').toLowerCase()))return {status:'login_layout_changed'};
    const field=fields[0],form=field.form,buttons=form?Array.from(form.querySelectorAll('button,input[type="submit"]')).filter(visible):[];
    if(!form||String(form.method).toUpperCase()!=='POST'||!safeAction(form.action)||buttons.length!==1||buttons[0].id!=='${submitId}'||buttons[0].form!==form)return {status:'login_layout_changed'};
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(field,${encoded});field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));
    form.requestSubmit(buttons[0]);return {status:'submitted'};
  })()`;
}

function usernameExpression(credentials) { return safeLoginExpression('username', credentials?.username); }
function passwordExpression(credentials) { return safeLoginExpression('password', credentials?.password); }

function credentialsExpression(credentials) {
  if (typeof credentials?.username !== 'string' || !credentials.username
      || typeof credentials?.password !== 'string' || !credentials.password) {
    throw new AmazonLogisticsAuthError('authentication_failed');
  }
  const username = JSON.stringify(credentials.username).replace(/</g, '\\u003c');
  const password = JSON.stringify(credentials.password).replace(/</g, '\\u003c');
  return `(()=>{
    const approved=${JSON.stringify(APPROVED_HOSTS)},allowed=${JSON.stringify([...ALLOWED_LOGIN_QUERY_KEYS])},application=${JSON.stringify(APPLICATION_URL)},loginOrigin=${JSON.stringify(LOGIN_ORIGIN)};
    const parsed=u=>{try{const x=new URL(u),keys=Array.from(x.searchParams.keys());if(x.protocol!=='https:'||!approved.includes(x.hostname.toLowerCase())||x.origin!==loginOrigin||x.port||x.username||x.password||x.hash||x.pathname!=='/ap/signin'||new Set(keys).size!==keys.length||keys.some(key=>!allowed.includes(key)))return null;const value=x.searchParams.get('openid.return_to');if(value!==null&&value!==application&&value!==application+'/')return null;return x}catch{return null}};
    const safePage=u=>{const x=parsed(u);return !!x&&[application,application+'/'].includes(x.searchParams.get('openid.return_to'))};
    const safeAction=u=>{const x=parsed(u);return !!x&&(x.search===''||safePage(u))};
    if(!safePage(location.href))return {status:'login_layout_changed'};
    const visible=e=>!!e&&!e.disabled&&e.offsetParent!==null;
    const unique=selectors=>Array.from(new Set(selectors.flatMap(selector=>Array.from(document.querySelectorAll(selector))))).filter(visible);
    const usernames=unique(['#ap_email','input[name="email"]']),passwords=unique(['#ap_password','input[name="password"]']);
    if(usernames.length!==1||passwords.length!==1||!['email','text'].includes(String(usernames[0].type||'').toLowerCase())||String(passwords[0].type||'').toLowerCase()!=='password')return {status:'login_layout_changed'};
    const form=usernames[0].form,buttons=form?Array.from(form.querySelectorAll('button,input[type="submit"]')).filter(visible):[];
    if(!form||passwords[0].form!==form||String(form.method).toUpperCase()!=='POST'||!safeAction(form.action)||buttons.length!==1||buttons[0].id!=='signInSubmit'||buttons[0].form!==form)return {status:'login_layout_changed'};
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(usernames[0],${username});usernames[0].dispatchEvent(new Event('input',{bubbles:true}));usernames[0].dispatchEvent(new Event('change',{bubbles:true}));
    setter.call(passwords[0],${password});passwords[0].dispatchEvent(new Event('input',{bubbles:true}));passwords[0].dispatchEvent(new Event('change',{bubbles:true}));
    form.requestSubmit(buttons[0]);return {status:'submitted'};
  })()`;
}

async function waitForState(connection, timeoutMs, accepted = TERMINAL_STATES, signal, context = {}) {
  const deadline = Date.now() + timeoutMs;
  let settling = null;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      const snapshot = await connection.evaluate(SNAPSHOT);
      if (snapshot?.url === 'about:blank') {
        await delay(50, signal);
        continue;
      }
      const state = classify(snapshot, context);
      if (accepted.has(state)) {
        // Amazon renders the challenge and application after the document has
        // loaded. Let that rendering settle before diagnosing an unknown page.
        if (['security_challenge', 'manual_verification_required'].includes(state)) {
          if (!settling || settling.state !== state || settling.url !== snapshot.url)
            settling = { state, url: snapshot.url, since: Date.now() };
          if (Date.now() - settling.since >= 1500) return { state, snapshot };
        } else return { state, snapshot };
      } else settling = null;
    } catch (error) {
      if (signal?.aborted) throw new AmazonLogisticsAuthError('acquisition_cancelled');
    }
    await delay(200, signal);
  }
  throw new AmazonLogisticsAuthError('authentication_timeout');
}

async function prepareHandoff(browser, sourceTarget, authenticated, signal, onState) {
  throwIfAborted(signal);
  if (authenticated?.state !== 'authenticated' || classify(authenticated.snapshot) !== 'authenticated') {
    throw new AmazonLogisticsAuthError('manual_verification_required');
  }
  if (typeof onState === 'function') try { onState('handoff_source_verified', stateMetadata(authenticated.snapshot)); } catch {}
  if (typeof browser.browserWebSocketUrl !== 'string') throw new AmazonLogisticsAuthError('browser_protocol_failed');
  const cleanTarget = await createTarget(browser.endpoint, APPLICATION_URL);
  const cleanConnection = await CdpConnection.connect(cleanTarget.webSocketDebuggerUrl);
  try {
    const clean = await waitForState(cleanConnection, 45_000, TERMINAL_STATES, signal);
    if (clean.state !== 'authenticated') throw new AmazonLogisticsAuthError(clean.state);
  } finally { cleanConnection.close(); }
  const browserConnection = await CdpConnection.connect(browser.browserWebSocketUrl);
  try {
    for (let pass = 0; pass < 20; pass += 1) {
      throwIfAborted(signal);
      const targets = await browserConnection.command('Target.getTargets');
      const unwanted = (targets.targetInfos || []).filter(info => info.targetId !== cleanTarget.id && info.type === 'page');
      if (!unwanted.length) break;
      for (const info of unwanted) await browserConnection.command('Target.closeTarget', { targetId: info.targetId });
      await delay(50, signal);
      if (pass === 19) throw new AmazonLogisticsAuthError('manual_verification_required');
    }
  } finally { browserConnection.close(); }
  if (typeof onState === 'function') try { onState('handoff_target_verified', stateMetadata({ url: APPLICATION_URL })); } catch {}
  return { status: 'authenticated', targetId: cleanTarget.id, replacedCredentialPage: sourceTarget.id !== cleanTarget.id };
}

async function authenticateConnection(browser, target, connection, credentials, { signal, onSubmit, onState } = {}) {
  const observed = result => {
    if (typeof onState === 'function') try { onState(result.state, stateMetadata(result.snapshot)); } catch {}
    return result;
  };
  let submissionLatched = false;
  const ensureSubmitted = kind => {
    if (submissionLatched) return;
    if (typeof onSubmit !== 'function') throw new AmazonLogisticsAuthError('authentication_failed');
    onSubmit(kind);
    submissionLatched = true;
  };
  let current = observed(await waitForState(connection, 20_000, TERMINAL_STATES, signal, { phase: 'observation' }));
  let credentialsSubmitted = false;
  let usernameSubmitted = false;
  let passwordSubmitted = false;
  for (let pass = 0; pass < 4; pass += 1) {
    if (current.state === 'authenticated') return prepareHandoff(browser, target, current, signal, onState);
    if (current.state === 'credentials_required' && !credentialsSubmitted) {
      ensureSubmitted('credentials');
      const submitted = await connection.evaluate(credentialsExpression(credentials));
      if (submitted?.status !== 'submitted') throw new AmazonLogisticsAuthError('manual_verification_required');
      if (typeof onState === 'function') try { onState('credentials_submitted', stateMetadata(current.snapshot)); } catch {}
      credentialsSubmitted = true;
      usernameSubmitted = true;
      passwordSubmitted = true;
      current = observed(await waitForState(connection, 45_000, AFTER_CREDENTIALS_STATES, signal, { phase: 'password_submission' }));
      continue;
    }
    if (current.state === 'username_required' && !usernameSubmitted) {
      ensureSubmitted('credentials');
      const submitted = await connection.evaluate(usernameExpression(credentials));
      if (submitted?.status !== 'submitted') throw new AmazonLogisticsAuthError('manual_verification_required');
      if (typeof onState === 'function') try { onState('username_submitted', stateMetadata(current.snapshot)); } catch {}
      usernameSubmitted = true;
      current = observed(await waitForState(connection, 45_000, AFTER_USERNAME_STATES, signal, { phase: 'username_submission' }));
      continue;
    }
    if (current.state === 'password_required' && !passwordSubmitted) {
      ensureSubmitted('credentials');
      const submitted = await connection.evaluate(passwordExpression(credentials));
      if (submitted?.status !== 'submitted') throw new AmazonLogisticsAuthError('manual_verification_required');
      if (typeof onState === 'function') try { onState('password_submitted', stateMetadata(current.snapshot)); } catch {}
      passwordSubmitted = true;
      current = observed(await waitForState(connection, 45_000, AFTER_PASSWORD_STATES, signal, { phase: 'password_submission' }));
      continue;
    }
    throw new AmazonLogisticsAuthError(current.state === 'pending' ? 'manual_verification_required' : current.state);
  }
  throw new AmazonLogisticsAuthError('manual_verification_required');
}

const amazonLogisticsAdapter = Object.freeze({
  provider: PROVIDER,
  completeVerification: (browser, options) => require('./amazon-verification').completeVerification(browser, options),
  async recover(browser, options = {}) {
    // Recovery only observes stored sign-in state. It never submits credentials.
    return this.authenticate(browser, null, { ...options,
      onSubmit() { throw new AmazonLogisticsAuthError('manual_verification_required'); } });
  },
  async inspect(browser, { signal, onState } = {}) {
    throwIfAborted(signal);
    const target = await createTarget(browser.endpoint, APPLICATION_URL);
    const connection = await CdpConnection.connect(target.webSocketDebuggerUrl, { commandTimeoutMs: 10_000 });
    try {
      await connection.command('Page.enable');
      const deadline = Date.now() + 15_000;
      let snapshot = null;
      let state = 'pending';
      while (Date.now() < deadline) {
        throwIfAborted(signal);
        try {
          snapshot = await connection.evaluate(SNAPSHOT);
          if (snapshot?.url !== 'about:blank') {
            state = classify(snapshot, { phase: 'inspection' });
            if (state !== 'pending' || snapshot.readyState === 'complete') break;
          }
        } catch (error) {
          if (signal?.aborted) throw new AmazonLogisticsAuthError('acquisition_cancelled');
        }
        await delay(200, signal);
      }
      if (!snapshot || snapshot.url === 'about:blank') throw new AmazonLogisticsAuthError('authentication_timeout');
      if (state === 'pending' && snapshot.readyState === 'complete') state = 'manual_verification_required';
      const metadata = stateMetadata(snapshot);
      if (typeof onState === 'function') try { onState(state, metadata); } catch {}
      return { state, observedAt: new Date().toISOString(), metadata };
    } finally {
      connection.close();
    }
  },
  async authenticate(browser, credentials, options = {}) {
    throwIfAborted(options.signal);
    const target = await createTarget(browser.endpoint, APPLICATION_URL);
    const connection = await CdpConnection.connect(target.webSocketDebuggerUrl, { commandTimeoutMs: 10_000 });
    try {
      await connection.command('Page.enable');
      return await authenticateConnection(browser, target, connection, credentials, options);
    } finally { connection.close(); }
  },
});

module.exports = {
  PROVIDER, APPLICATION_ORIGIN, APPLICATION_PATH, APPLICATION_URL, PERFORMANCE_PATH,
  LOGIN_ORIGIN, LOGIN_PATH, LOGIN_ACTION_URL, APPROVED_HOSTS, ALLOWED_LOGIN_QUERY_KEYS,
  TERMINAL_STATES, AFTER_USERNAME_STATES, AFTER_PASSWORD_STATES, AFTER_CREDENTIALS_STATES, SNAPSHOT,
  AmazonLogisticsAuthError, parsedApprovedUrl, exactApplicationUrl, exactLoginUrl, exactLoginAction,
  challengeUrl, classify, stateMetadata, usernameExpression, passwordExpression, credentialsExpression,
  waitForState, prepareHandoff, authenticateConnection, amazonLogisticsAdapter,
};
