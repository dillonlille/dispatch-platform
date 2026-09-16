// DOM checks adapted from integrations/paycom/provider/auth/adapter.js.
// Executed in a fresh isolated world; Rust owns retries, credentials and lifecycle.
(input) => {
  const ORIGIN = input.origin;
  const LOGIN_PATH = '/v4/cl/cl-login.php';
  const LOGIN_URL = `${ORIGIN}${LOGIN_PATH}`;
  const LOGIN_ACTION_PATH = '/v4/cl/cl-loginproc.php';
  const LOGIN_ACTION_URL = `${ORIGIN}${LOGIN_ACTION_PATH}`;
  const AUTH_PATH_PREFIX = '/v4/cl/web.php/';
  const AUTH_PREFIX = `${ORIGIN}${AUTH_PATH_PREFIX}`;
  const CLIENT_LANDING_PATH = '/v4/cl/web.php/client-landing/arc';
  const MAIN_MENU_PATH = '/v4/cl/cl-menu.php';
  const SECURITY_QUESTION_PATH = '/v4/cl/web.php/security/security-question/login';
  const TIMECARD_SEARCH_PATH = '/v4/cl/web.php/timecardsearch/index';
  const TIMECARD_SEARCH_URL = `${ORIGIN}${TIMECARD_SEARCH_PATH}?from=main_menu`;
  const SECURITY_PROFILE_PATH = '/v4/cl/web.php/two-factor/react/index/preferences/campaign';
  const SECURITY_PROFILE_WARNING =
    'You will no longer be prompted at login to verify your info this month. You will continue to use security questions to access your account. You may verify your information at any time from your contact information page.';
  const LOGIN_FIELDS = Object.freeze({
    clientCode: 'input[name="clientcode"]',
    username: 'input[name="username"]',
    password: 'input[name="password"]',
  });
  var PaycomAuthError = class extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  };

  function parsedPaycomUrl(value) {
    try {
      const url = new URL(value);
      if (url.origin !== ORIGIN || url.username || url.password || url.hash) return null;
      return url;
    } catch {
      return null;
    }
  }
  function exactLoginUrl(value) {
    const url = parsedPaycomUrl(value);
    return Boolean(url && url.pathname === LOGIN_PATH && url.search === '');
  }
  function exactLoginActionUrl(value) {
    const url = parsedPaycomUrl(value);
    return Boolean(url && url.pathname === LOGIN_ACTION_PATH && url.search === '');
  }
  function authenticatedUrl(value) {
    const url = parsedPaycomUrl(value);
    if (!url) return false;
    const keys = [...url.searchParams.keys()];
    const oneEach = new Set(keys).size === keys.length;
    if (url.pathname.startsWith(AUTH_PATH_PREFIX) && url.pathname !== CLIENT_LANDING_PATH)
      return oneEach && keys.every((key) => key === 'session_nonce') && keys.length <= 1;
    if (
      ![CLIENT_LANDING_PATH, MAIN_MENU_PATH].includes(url.pathname) ||
      !oneEach ||
      keys.some((key) => !['frmlogin', 'session_nonce'].includes(key)) ||
      keys.length > 2
    )
      return false;
    return !url.searchParams.has('frmlogin') || url.searchParams.get('frmlogin') === '1';
  }
  function exactSecurityQuestionUrl(value) {
    const url = parsedPaycomUrl(value);
    if (!url || url.pathname !== SECURITY_QUESTION_PATH) return false;
    const keys = [...url.searchParams.keys()];
    return keys.length <= 1 && keys.every((key) => key === 'session_nonce');
  }
  function exactTimecardSearchUrl(value) {
    const url = parsedPaycomUrl(value);
    if (!url || url.pathname !== TIMECARD_SEARCH_PATH) return false;
    const keys = [...url.searchParams.keys()];
    return (
      new Set(keys).size === keys.length &&
      keys.length <= 2 &&
      keys.every((key) => ['from', 'session_nonce'].includes(key)) &&
      url.searchParams.get('from') === 'main_menu'
    );
  }
  function securityProfileUrl(value) {
    const url = parsedPaycomUrl(value);
    if (!url || url.pathname !== SECURITY_PROFILE_PATH) return false;
    const keys = [...url.searchParams.keys()];
    return keys.length <= 1 && keys.every((key) => key === 'session_nonce');
  }
  function securityProfileState(snapshot) {
    if (!securityProfileUrl(snapshot?.url) || !snapshot.securityProfile) return null;
    const inputs = JSON.stringify(snapshot.securityProfile.inputNames);
    const buttons = JSON.stringify(snapshot.securityProfile.buttonTexts);
    const text = String(snapshot.text || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (
      inputs !== JSON.stringify(['cell-number', 'email', 'work-number']) ||
      !text.includes('Setup Your Security Profile') ||
      !text.includes('Verify your contact information')
    )
      return 'manual_verification_required';
    if (
      buttons === JSON.stringify(['Continue', 'Not Now', 'Verify', 'Verify', 'Verify']) &&
      !text.includes('Warning')
    )
      return 'security_profile_prompt';
    if (
      buttons ===
        JSON.stringify([
          '',
          'Cancel',
          'Continue',
          'Continue',
          'Not Now',
          'Verify',
          'Verify',
          'Verify',
        ]) &&
      text.includes('Warning') &&
      text.includes(SECURITY_PROFILE_WARNING)
    )
      return 'security_profile_confirmation';
    return 'manual_verification_required';
  }
  const VERIFICATION_CONTROLS = `
  const displayed=e=>{
    if(!visible(e))return false;
    const style=getComputedStyle(e),rect=e.getBoundingClientRect();
    return style.visibility!=='hidden'&&style.visibility!=='collapse'&&style.opacity!=='0'&&rect.width>0&&rect.height>0;
  };
  const otpPresent=Array.from(document.querySelectorAll('input[autocomplete="one-time-code"],input[name="otp"],input[name="verificationCode"],input[name="verification_code"]')).some(displayed);
  const captchaPresent=Array.from(document.querySelectorAll('iframe')).some(frame=>{
    if(!displayed(frame))return false;
    try{const url=new URL(frame.src);return /(?:^|[./_-])(?:hcaptcha|recaptcha|captcha)(?:[./_-]|$)/i.test(url.hostname+url.pathname)}catch{return false}
  });
`;
  const SNAPSHOT = `(()=>{
  const visible=e=>!!e&&!e.disabled&&e.offsetParent!==null;
  ${VERIFICATION_CONTROLS}
  const login=['input[name="clientcode"]','input[name="username"]','input[name="password"]'];
  const loginFields=login.map(selector=>document.querySelector(selector));
  const challenge=[];
  for(const field of Array.from(document.querySelectorAll('input')).filter(visible)){
    if(login.some(selector=>field.matches(selector)))continue;
    const labels=[];
    if(field.id){const label=document.querySelector('label[for="'+CSS.escape(field.id)+'"]');if(label)labels.push(label.innerText||label.textContent||'');}
    labels.push(field.getAttribute('aria-label')||'',field.placeholder||'',field.name||'',field.id||'');
    const found=[];
    for(const label of labels){
      const text=String(label).trim();
      const match=text.match(/^\\s*(?:(?:enter|unique)\\s+)?(?:paycom\\s+)?(?:security\\s+)?pin(?:\\s*(?:number|no\\.?|#))?\\s*([1-5])\\s*[:?]?\\s*$/i)||text.match(/^(?:security[_-]?)?pin[_-]?([1-5])$/i);
      if(match)found.push(Number(match[1]));
    }
    const unique=Array.from(new Set(found));
    if(unique.length===1)challenge.push({index:unique[0],name:field.name||'',id:field.id||''});
  }
  const forms=new Set(loginFields.filter(Boolean).map(field=>field.form));
  const challengeForms=new Set(challenge.map(item=>document.querySelector(item.id?'#'+CSS.escape(item.id):'input[name="'+CSS.escape(item.name)+'"]')?.form).filter(Boolean));
  const profileInputs=Array.from(document.querySelectorAll('input')).filter(visible);
  const profileButtons=Array.from(document.querySelectorAll('button,input[type="submit"]')).filter(visible);
  const timecardStatus=Array.from(document.querySelectorAll('p,[data-testid="typography"]')).filter(visible)
    .map(element=>(element.innerText||element.textContent||'').trim()).filter(text=>/^Employee Status Is .+/.test(text));
  const timecardExports=Array.from(document.querySelectorAll('button')).filter(visible)
    .filter(element=>/^Export$/i.test((element.innerText||element.textContent||'').trim()));
  return {
    url:location.href,
    title:String(document.title||'').slice(0,120),
    readyState:document.readyState,
    otpPresent,captchaPresent,
    text:(document.body&&document.body.innerText||'').slice(0,12000),
    loginPresent:loginFields.map(Boolean),
    loginVisible:loginFields.map(visible),
    loginFormCount:forms.size,
    loginFormAction:forms.size===1&&loginFields[0]?.form?loginFields[0].form.action:'',
    loginFormMethod:forms.size===1&&loginFields[0]?.form?loginFields[0].form.method:'',
    challengeFormCount:challengeForms.size,
    challengeFormAction:challengeForms.size===1?[...challengeForms][0].action:'',
    challengeFormMethod:challengeForms.size===1?[...challengeForms][0].method:'',
    authenticated:Boolean(document.querySelector('#mainMenuLink')&&document.querySelector('#clientLogout')&&!document.querySelector('input[name="clientcode"]')),
    timecardSearchReady:document.title==='Timecard Search'&&timecardStatus.length===1&&timecardExports.length===1,
    securityProfile:{
      inputNames:profileInputs.map(field=>field.name).sort(),
      buttonTexts:profileButtons.map(button=>(button.innerText||button.value||'').trim()).sort()
    },
    challenge
  };
})()`;
  function verificationTextMatches(text) {
    const value = String(text || '').toLowerCase();
    return [
      ['captcha', /captcha/],
      ['verification_code', /verification code/],
      ['verify_identity', /verify your identity/],
      ['multi_factor', /multi-factor/],
      ['one_time_code', /one-time code/],
    ]
      .filter(([, pattern]) => pattern.test(value))
      .map(([name]) => name);
  }
  function classifyState(snapshot, { phase = 'observation' } = {}) {
    const result = (state, reason = state) => ({
      state,
      reason,
    });
    if (!snapshot || typeof snapshot.url !== 'string' || !parsedPaycomUrl(snapshot.url))
      return result('manual_verification_required', 'untrusted_url');
    const text = String(snapshot.text || '').toLowerCase();
    const parsed = parsedPaycomUrl(snapshot.url);
    if (/account.{0,30}(locked|disabled)|too many.{0,20}attempt/.test(text))
      return result('account_locked');
    const primaryRejected =
      /invalid.{0,30}(client|user|password|credential)|incorrect.{0,20}(password|login)/.test(text);
    const securityRejected = /security answers?.{0,40}(not correct|incorrect|invalid)/.test(text);
    const exactLoginRoute = exactLoginUrl(snapshot.url) || exactLoginActionUrl(snapshot.url);
    const exactSecurityRoute = exactSecurityQuestionUrl(snapshot.url);
    if (primaryRejected || securityRejected) {
      if (phase === 'primary_login' && primaryRejected && exactLoginRoute)
        return result('primary_credentials_rejected');
      if (
        phase === 'security_questions' &&
        securityRejected &&
        (exactSecurityRoute || exactLoginRoute)
      )
        return result('security_answers_rejected');
      return result('manual_verification_required', 'ambiguous_rejection');
    }
    const manualChallenge = verificationTextMatches(text).length > 0;
    if (snapshot.otpPresent === true || snapshot.captchaPresent === true)
      return result('manual_verification_required', 'additional_verification');
    if (parsed.pathname === SECURITY_PROFILE_PATH) {
      if (Array.isArray(snapshot.challenge) && snapshot.challenge.length)
        return result('manual_verification_required', 'unexpected_challenge');
      if (!securityProfileUrl(snapshot.url))
        return result('manual_verification_required', 'unexpected_query');
      if (snapshot.readyState !== 'complete') return result('pending', 'page_loading');
      const state = securityProfileState(snapshot);
      if (state && state !== 'manual_verification_required') return result(state);
      if (manualChallenge) return result('manual_verification_required', 'additional_verification');
      return result('manual_verification_required', 'security_profile_layout_changed');
    }
    if (manualChallenge) return result('manual_verification_required', 'additional_verification');
    if (snapshot.readyState !== 'complete') return result('pending', 'page_loading');
    if (parsed.pathname === SECURITY_QUESTION_PATH) {
      if (!exactSecurityQuestionUrl(snapshot.url))
        return result('manual_verification_required', 'unexpected_query');
      if (!Array.isArray(snapshot.challenge) || !snapshot.challenge.length)
        return result('pending', 'page_loading');
      const indices = snapshot.challenge.map((item) => item.index);
      return indices.length === 2 &&
        new Set(indices).size === 2 &&
        snapshot.challengeFormCount === 1 &&
        exactSecurityQuestionUrl(snapshot.challengeFormAction) &&
        String(snapshot.challengeFormMethod).toUpperCase() === 'POST'
        ? result('security_questions_required')
        : result('manual_verification_required', 'challenge_layout_changed');
    }
    if (parsed.pathname === TIMECARD_SEARCH_PATH) {
      if (!exactTimecardSearchUrl(snapshot.url))
        return result('manual_verification_required', 'unexpected_query');
      return snapshot.timecardSearchReady === true
        ? result('timecard_application')
        : result('pending', 'page_loading');
    }
    if (snapshot.authenticated === true && authenticatedUrl(snapshot.url))
      return result('authenticated');
    if (Array.isArray(snapshot.challenge) && snapshot.challenge.length)
      return result('manual_verification_required', 'unexpected_challenge');
    if (
      Array.isArray(snapshot.loginPresent) &&
      snapshot.loginPresent.length === 3 &&
      snapshot.loginPresent.every(Boolean) &&
      Array.isArray(snapshot.loginVisible) &&
      snapshot.loginVisible.every(Boolean) &&
      snapshot.loginFormCount === 1 &&
      exactLoginUrl(snapshot.url) &&
      exactLoginActionUrl(snapshot.loginFormAction) &&
      String(snapshot.loginFormMethod).toUpperCase() === 'POST'
    )
      return result('logged_out');
    return result('pending', 'page_unrecognized');
  }
  function classify(snapshot, context) {
    return classifyState(snapshot, context).state;
  }

  function loginExpression(credentials) {
    return `(()=>{
    const values=${JSON.stringify({
      clientCode: credentials.clientCode,
      username: credentials.username,
      password: credentials.password,
    }).replace(/</g, '\\u003c')};
    const safe=(u,path)=>{try{const x=new URL(u);return x.origin===${JSON.stringify(ORIGIN)}&&!x.username&&!x.password&&!x.hash&&x.pathname===path&&!x.search}catch{return false}};
    if(!safe(location.href,'/v4/cl/cl-login.php')||document.readyState!=='complete')return {status:'login_layout_changed'};
    const visible=e=>!!e&&!e.disabled&&e.offsetParent!==null;
    const selectors=${JSON.stringify(LOGIN_FIELDS)};
    const fields={};
    for(const key of Object.keys(selectors)){fields[key]=document.querySelector(selectors[key]);if(!visible(fields[key]))return {status:'login_layout_changed'}}
    const forms=new Set(Object.values(fields).map(field=>field.form));
    if(forms.size!==1||!fields.password.form||String(fields.password.form.method).toUpperCase()!=='POST'||!safe(fields.password.form.action,'/v4/cl/cl-loginproc.php'))return {status:'login_layout_changed'};
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    for(const key of Object.keys(fields)){setter.call(fields[key],values[key]);fields[key].dispatchEvent(new Event('input',{bubbles:true}));fields[key].dispatchEvent(new Event('change',{bubbles:true}));}
    fields.password.form.requestSubmit();
    return {status:'submitted'};
  })()`;
  }
  function challengeIndices(challenge) {
    if (!Array.isArray(challenge) || challenge.length !== 2)
      throw new PaycomAuthError('manual_verification_required');
    const indices = challenge.map((item) => item?.index).sort((a, b) => a - b);
    if (
      indices.some((index) => !Number.isInteger(index) || index < 1 || index > 5) ||
      new Set(indices).size !== 2
    )
      throw new PaycomAuthError('manual_verification_required');
    return indices;
  }
  function challengeFocusExpression(challenge, targetIndex, { verifyFocus = false } = {}) {
    const indices = challengeIndices(challenge);
    if (!indices.includes(targetIndex)) throw new PaycomAuthError('manual_verification_required');
    return `(()=>{
    const safe=u=>{try{const x=new URL(u),keys=Array.from(x.searchParams.keys());return x.origin===${JSON.stringify(ORIGIN)}&&!x.username&&!x.password&&!x.hash&&x.pathname==='/v4/cl/web.php/security/security-question/login'&&keys.length<=1&&keys.every(key=>key==='session_nonce')}catch{return false}};
    if(!safe(location.href)||document.readyState!=='complete')return {status:'challenge_layout_changed'};
    const expected=${JSON.stringify(indices)},targetIndex=${targetIndex},verifyFocus=${JSON.stringify(verifyFocus)};
    const visible=e=>!!e&&!e.disabled&&e.offsetParent!==null;
    const fields=[];
    for(const field of Array.from(document.querySelectorAll('input')).filter(visible)){
      const labels=[];if(field.id){const label=document.querySelector('label[for="'+CSS.escape(field.id)+'"]');if(label)labels.push(label.innerText||label.textContent||'')}
      labels.push(field.getAttribute('aria-label')||'',field.placeholder||'',field.name||'',field.id||'');
      const found=[];for(const label of labels){const text=String(label).trim();const match=text.match(/^\\s*(?:(?:enter|unique)\\s+)?(?:paycom\\s+)?(?:security\\s+)?pin(?:\\s*(?:number|no\\.?|#))?\\s*([1-5])\\s*[:?]?\\s*$/i)||text.match(/^(?:security[_-]?)?pin[_-]?([1-5])$/i);if(match)found.push(Number(match[1]))}
      const unique=Array.from(new Set(found));if(unique.length===1)fields.push({field,index:unique[0]});
    }
    const actual=fields.map(item=>item.index).sort((a,b)=>a-b),names=fields.map(item=>item.field.name).sort(),types=fields.map(item=>String(item.field.type||'').toLowerCase());
    const hiddenOk=fields.every(item=>{const name=item.field.name==='firstSecurityQuestion'?'firstIndex':item.field.name==='secondSecurityQuestion'?'secondIndex':null;if(!name||!item.field.form)return false;const hidden=Array.from(item.field.form.querySelectorAll('input[type="hidden"][name="'+name+'"]'));return hidden.length===1&&hidden[0].value===String(item.index)});
    if(JSON.stringify(actual)!==JSON.stringify(expected)||fields.length!==2||JSON.stringify(names)!==JSON.stringify(['firstSecurityQuestion','secondSecurityQuestion'])||types.some(type=>type!=='password')||new Set(fields.map(item=>item.field.form)).size!==1||!hiddenOk)return {status:'challenge_layout_changed'};
    const target=fields.find(item=>item.index===targetIndex)?.field;
    if(!target||!target.form||String(target.form.method).toUpperCase()!=='POST'||!safe(target.form.action)||target.value!=='')return {status:'challenge_layout_changed'};
    if(verifyFocus)return document.activeElement===target?{status:'native_challenge_field_focused'}:{status:'challenge_layout_changed'};
    target.scrollIntoView({block:'center',inline:'center'});const rect=target.getBoundingClientRect();
    return rect.width>0&&rect.height>0?{status:'native_challenge_field_ready',x:rect.x+rect.width/2,y:rect.y+rect.height/2}:{status:'challenge_layout_changed'};
  })()`;
  }
  function challengeExpression(credentials, challenge, { retainValues = false } = {}) {
    const indices = challengeIndices(challenge);
    const values = retainValues
      ? {}
      : Object.fromEntries(indices.map((index) => [String(index), credentials[`pin${index}`]]));
    const encoded = JSON.stringify(values).replace(/</g, '\\u003c');
    return `(()=>{
    const safe=u=>{try{const x=new URL(u),keys=Array.from(x.searchParams.keys());return x.origin===${JSON.stringify(ORIGIN)}&&!x.username&&!x.password&&!x.hash&&x.pathname==='/v4/cl/web.php/security/security-question/login'&&keys.length<=1&&keys.every(key=>key==='session_nonce')}catch{return false}};
    if(!safe(location.href)||document.readyState!=='complete')return {status:'challenge_layout_changed'};
    const expected=${JSON.stringify(indices)},values=${encoded},retainValues=${JSON.stringify(retainValues)};
    const visible=e=>!!e&&!e.disabled&&e.offsetParent!==null;
    if(retainValues){${VERIFICATION_CONTROLS}if(otpPresent||captchaPresent)return {status:'challenge_layout_changed'}}
    const fields=[];
    for(const field of Array.from(document.querySelectorAll('input')).filter(visible)){
      const labels=[];if(field.id){const label=document.querySelector('label[for="'+CSS.escape(field.id)+'"]');if(label)labels.push(label.innerText||label.textContent||'')}
      labels.push(field.getAttribute('aria-label')||'',field.placeholder||'',field.name||'',field.id||'');
      const found=[];for(const label of labels){const text=String(label).trim();const match=text.match(/^\\s*(?:(?:enter|unique)\\s+)?(?:paycom\\s+)?(?:security\\s+)?pin(?:\\s*(?:number|no\\.?|#))?\\s*([1-5])\\s*[:?]?\\s*$/i)||text.match(/^(?:security[_-]?)?pin[_-]?([1-5])$/i);if(match)found.push(Number(match[1]))}
      const unique=Array.from(new Set(found));if(unique.length===1)fields.push({field,index:unique[0]});
    }
    const actual=fields.map(item=>item.index).sort((a,b)=>a-b);
    const form=fields[0]?.field.form,names=fields.map(item=>item.field.name).sort(),types=fields.map(item=>String(item.field.type||'').toLowerCase());
    const buttons=form?Array.from(form.querySelectorAll('button,input[type="submit"]')).filter(visible):[];
    const submitters=buttons.filter(button=>String(button.type||'').toLowerCase()==='submit'&&button.name==='continue'&&(button.innerText||button.value||'').trim()==='Continue');
    const hiddenOk=fields.every(item=>{const name=item.field.name==='firstSecurityQuestion'?'firstIndex':item.field.name==='secondSecurityQuestion'?'secondIndex':null;if(!name||!form)return false;const hidden=Array.from(form.querySelectorAll('input[type="hidden"][name="'+name+'"]'));return hidden.length===1&&hidden[0].value===String(item.index)});
    if(JSON.stringify(actual)!==JSON.stringify(expected)||fields.length!==2||JSON.stringify(names)!==JSON.stringify(['firstSecurityQuestion','secondSecurityQuestion'])||types.some(type=>type!=='password')||fields.some(item=>retainValues?!item.field.value:item.field.value!==values[String(item.index)])||new Set(fields.map(item=>item.field.form)).size!==1||!form||String(form.method).toUpperCase()!=='POST'||!safe(form.action)||!hiddenOk||submitters.length!==1)return {status:'challenge_layout_changed'};
    const button=submitters[0];button.scrollIntoView({block:'center',inline:'center'});const rect=button.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
    return rect.width>0&&rect.height>0&&Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0&&x<=10000&&y<=10000?{status:'native_challenge_ready',x,y}:{status:'challenge_layout_changed'};
  })()`;
  }

  function securityProfileDismissExpression() {
    return `(()=>{
    const url=new URL(location.href),keys=Array.from(url.searchParams.keys());
    if(url.origin!==${JSON.stringify(ORIGIN)}||url.username||url.password||url.hash||url.pathname!==${JSON.stringify(SECURITY_PROFILE_PATH)}||keys.length>1||keys.some(key=>key!=='session_nonce'))return {status:'manual_verification_required'};
    const visible=e=>!!e&&!e.disabled&&e.offsetParent!==null;
    ${VERIFICATION_CONTROLS}
    if(otpPresent||captchaPresent)return {status:'manual_verification_required'};
    const inputs=Array.from(document.querySelectorAll('input')).filter(visible),names=inputs.map(e=>e.name).sort();
    if(JSON.stringify(names)!==JSON.stringify(['cell-number','email','work-number']))return {status:'manual_verification_required'};
    const buttons=Array.from(document.querySelectorAll('button,input[type="submit"]')).filter(visible),texts=buttons.map(e=>(e.innerText||e.value||'').trim()).sort();
    if(JSON.stringify(texts)!==JSON.stringify(['Continue','Not Now','Verify','Verify','Verify']))return {status:'manual_verification_required'};
    const button=buttons.find(e=>(e.innerText||e.value||'').trim()==='Not Now');
    if(!button)return {status:'manual_verification_required'};
    button.scrollIntoView({block:'center',inline:'center'});
    const rect=button.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
    return rect.width>0&&rect.height>0&&Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0
      ?{status:'security_profile_dismiss_ready',x,y}:{status:'manual_verification_required'};
  })()`;
  }
  function securityProfileConfirmationExpression() {
    return `(()=>{
    const url=new URL(location.href),keys=Array.from(url.searchParams.keys());
    if(url.origin!==${JSON.stringify(ORIGIN)}||url.username||url.password||url.hash||url.pathname!==${JSON.stringify(SECURITY_PROFILE_PATH)}||keys.length>1||keys.some(key=>key!=='session_nonce'))return {status:'manual_verification_required'};
    const visible=e=>!!e&&!e.disabled&&e.offsetParent!==null;
    ${VERIFICATION_CONTROLS}
    if(otpPresent||captchaPresent)return {status:'manual_verification_required'};
    const inputs=Array.from(document.querySelectorAll('input')).filter(visible),names=inputs.map(e=>e.name).sort();
    if(JSON.stringify(names)!==JSON.stringify(['cell-number','email','work-number']))return {status:'manual_verification_required'};
    const buttons=Array.from(document.querySelectorAll('button,input[type="submit"]')).filter(visible),texts=buttons.map(e=>(e.innerText||e.value||'').trim()).sort();
    if(JSON.stringify(texts)!==JSON.stringify(['','Cancel','Continue','Continue','Not Now','Verify','Verify','Verify']))return {status:'manual_verification_required'};
    const warning=${JSON.stringify(SECURITY_PROFILE_WARNING)},body=(document.body&&document.body.innerText||'').replace(/\\s+/g,' ').trim();
    if(!body.includes('Setup Your Security Profile')||!body.includes('Verify your contact information')||!body.includes('Warning')||!body.includes(warning))return {status:'manual_verification_required'};
    let button=null;
    for(const candidate of buttons.filter(e=>(e.innerText||e.value||'').trim()==='Continue')){
      for(let node=candidate,depth=0;depth<8&&node;node=node.parentElement,depth++){
        const local=Array.from(node.querySelectorAll('button,input[type="submit"]')).filter(visible),localTexts=local.map(e=>(e.innerText||e.value||'').trim()).sort(),localText=(node.innerText||'').replace(/\\s+/g,' ').trim();
        if(JSON.stringify(localTexts)===JSON.stringify(['','Cancel','Continue'])&&localText.includes('Warning')&&localText.includes(warning)){button=candidate;break}
      }
      if(button)break;
    }
    if(!button)return {status:'manual_verification_required'};
    button.scrollIntoView({block:'center',inline:'center'});
    const rect=button.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
    return rect.width>0&&rect.height>0&&Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0
      ?{status:'security_profile_confirmation_ready',x,y}:{status:'manual_verification_required'};
  })()`;
  }
  function securityProfileProceedExpression() {
    return `(()=>{
    const url=new URL(location.href),keys=Array.from(url.searchParams.keys());
    if(url.origin!==${JSON.stringify(ORIGIN)}||url.username||url.password||url.hash||url.pathname!==${JSON.stringify(SECURITY_PROFILE_PATH)}||keys.length>1||keys.some(key=>key!=='session_nonce'))return {status:'manual_verification_required'};
    const visible=e=>!!e&&!e.disabled&&e.offsetParent!==null;
    ${VERIFICATION_CONTROLS}
    if(otpPresent||captchaPresent)return {status:'manual_verification_required'};
    const inputs=Array.from(document.querySelectorAll('input')).filter(visible),names=inputs.map(e=>e.name).sort();
    if(JSON.stringify(names)!==JSON.stringify(['cell-number','email','work-number']))return {status:'manual_verification_required'};
    const buttons=Array.from(document.querySelectorAll('button,input[type="submit"]')).filter(visible),texts=buttons.map(e=>(e.innerText||e.value||'').trim()).sort();
    const body=(document.body&&document.body.innerText||'').replace(/\\s+/g,' ').trim();
    if(JSON.stringify(texts)!==JSON.stringify(['Continue','Not Now','Verify','Verify','Verify'])||!body.includes('Setup Your Security Profile')||!body.includes('Verify your contact information')||body.includes('Warning'))return {status:'manual_verification_required'};
    const candidates=buttons.filter(e=>(e.innerText||e.value||'').trim()==='Continue');
    if(candidates.length!==1)return {status:'manual_verification_required'};
    const button=candidates[0];button.scrollIntoView({block:'center',inline:'center'});
    const rect=button.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
    return rect.width>0&&rect.height>0&&Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0
      ?{status:'security_profile_proceed_ready',x,y}:{status:'manual_verification_required'};
  })()`;
  }

  switch (input.action) {
    case 'observe': {
      const snapshot = eval(SNAPSHOT);
      return { ...classifyState(snapshot, { phase: input.phase }), snapshot };
    }
    case 'login':
      return eval(loginExpression(input.credentials));
    case 'focus':
      return eval(
        challengeFocusExpression(input.challenge, input.index, { verifyFocus: input.verifyFocus }),
      );
    case 'pins':
      return eval(
        challengeExpression(input.credentials, input.challenge, {
          retainValues: input.retainValues,
        }),
      );
    case 'profile':
      return eval(
        {
          dismiss: securityProfileDismissExpression,
          confirm: securityProfileConfirmationExpression,
          proceed: securityProfileProceedExpression,
        }[input.step](),
      );
    default:
      throw new Error('invalid_action');
  }
};
