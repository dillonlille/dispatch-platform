'use strict';

const { CdpConnection, boundedJson, validateTarget } = require('../cdp');

function fail(code) { throw Object.assign(new Error(code), { code }); }
function verificationExpression(code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) fail('invalid_input');
  return `(() => {
    const approved=u=>{try{const x=new URL(u);return x.origin==='https://www.amazon.com'&&!x.username&&!x.password&&!x.hash&&['/ap/cvf/transactionapproval','/ap/cvf/approval'].includes(x.pathname)}catch{return false}};
    if(!approved(location.href))return {status:'manual_verification_required'};
    const visible=e=>e.tagName==='INPUT'&&!e.disabled&&e.offsetParent!==null;
    const inputs=[...document.querySelectorAll('input[name="otpCode"]')].filter(visible);
    if(inputs.length!==1)return {status:'manual_verification_required'};
    const field=inputs[0],form=field.form;
    if(!form||form.method.toUpperCase()!=='POST'||!approved(form.action))return {status:'manual_verification_required'};
    const buttons=[...form.querySelectorAll('input[type="submit"]')].filter(visible);
    if(buttons.length!==1)return {status:'manual_verification_required'};
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(code)});
    field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));
    form.requestSubmit(buttons[0]);return {status:'submitted'};
  })()`;
}

async function verifyConnection(connection, { code, signal } = {}) {
  if (signal?.aborted) fail('acquisition_cancelled');
  const adapter = require('./amazon-logistics');
  const expression = verificationExpression(code);
  const before = await connection.evaluate(adapter.SNAPSHOT);
  if (adapter.classify(before) === 'authenticated') return { status: 'authenticated' };
  if (adapter.classify(before) !== 'mfa_required') fail('manual_verification_required');
  await connection.command('Page.enable');
  const frame = (await connection.command('Page.getFrameTree')).frameTree.frame;
  if (signal?.aborted) fail('acquisition_cancelled');
  const result = await connection.evaluate(expression);
  if (result?.status !== 'submitted') fail('manual_verification_required');
  // The form posts a new document. Wait for that navigation before examining
  // errors, otherwise a slow response can be confused with the previous error.
  await connection.waitFor('Page.frameNavigated', event => event.frame?.id === frame.id && event.frame.loaderId !== frame.loaderId, 45_000);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) fail('acquisition_cancelled');
    let snapshot;
    try { snapshot = await connection.evaluate(adapter.SNAPSHOT); }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); continue; }
    const state = adapter.classify(snapshot);
    if (state === 'authenticated') return { status: 'authenticated' };
    if (snapshot.verificationExpired) fail('verification_expired');
    if (snapshot.verificationRejected) fail('verification_code_rejected');
    if (['captcha_required', 'account_locked', 'invalid_credentials'].includes(state)) fail(state);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  fail('verification_expired');
}

async function completeVerification(browser, options = {}) {
  const targets = (await boundedJson(`${browser.endpoint}/json/list`, { signal: options.signal }))
    .filter(target => target.type === 'page' && target.url !== 'about:blank');
  if (targets.length !== 1) fail('manual_verification_required');
  const target = validateTarget(targets[0], browser.endpoint);
  const connection = await CdpConnection.connect(target.webSocketDebuggerUrl, { signal: options.signal });
  try { return await verifyConnection(connection, options); }
  finally { connection.close(); }
}

module.exports = { verificationExpression, verifyConnection, completeVerification };
