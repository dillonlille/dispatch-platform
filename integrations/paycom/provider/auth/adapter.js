"use strict";
//#region plugins/paycom/backend/auth/adapter.js
const { CdpConnection, createTarget } = require("./cdp.js");
const ORIGIN = "https://www.paycomonline.net";
const LOGIN_PATH = "/v4/cl/cl-login.php";
const LOGIN_URL = `${ORIGIN}${LOGIN_PATH}`;
const LOGIN_ACTION_PATH = "/v4/cl/cl-loginproc.php";
const LOGIN_ACTION_URL = `${ORIGIN}${LOGIN_ACTION_PATH}`;
const AUTH_PATH_PREFIX = "/v4/cl/web.php/";
const AUTH_PREFIX = `${ORIGIN}${AUTH_PATH_PREFIX}`;
const CLIENT_LANDING_PATH = "/v4/cl/web.php/client-landing/arc";
const MAIN_MENU_PATH = "/v4/cl/cl-menu.php";
const SECURITY_QUESTION_PATH = "/v4/cl/web.php/security/security-question/login";
const TIMECARD_SEARCH_PATH = "/v4/cl/web.php/timecardsearch/index";
const TIMECARD_SEARCH_URL = `${ORIGIN}${TIMECARD_SEARCH_PATH}?from=main_menu`;
const SECURITY_PROFILE_PATH = "/v4/cl/web.php/two-factor/react/index/preferences/campaign";
const SECURITY_PROFILE_WARNING = "You will no longer be prompted at login to verify your info this month. You will continue to use security questions to access your account. You may verify your information at any time from your contact information page.";
const LOGIN_FIELDS = Object.freeze({
	clientCode: "input[name=\"clientcode\"]",
	username: "input[name=\"username\"]",
	password: "input[name=\"password\"]"
});
var PaycomAuthError = class extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
};
function throwIfAborted(signal) {
	if (signal?.aborted) throw new PaycomAuthError("acquisition_cancelled");
}
function delay(ms, signal) {
	return new Promise((resolve, reject) => {
		try {
			throwIfAborted(signal);
		} catch (error) {
			reject(error);
			return;
		}
		const timer = setTimeout(done, ms);
		function done() {
			cleanup();
			resolve();
		}
		function aborted() {
			cleanup();
			reject(new PaycomAuthError("acquisition_cancelled"));
		}
		function cleanup() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", aborted);
		}
		signal?.addEventListener("abort", aborted, { once: true });
	});
}
function parsedPaycomUrl(value) {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.hostname !== "www.paycomonline.net" || url.port || url.username || url.password || url.hash) return null;
		return url;
	} catch {
		return null;
	}
}
function exactLoginUrl(value) {
	const url = parsedPaycomUrl(value);
	return Boolean(url && url.pathname === LOGIN_PATH && url.search === "");
}
function exactLoginActionUrl(value) {
	const url = parsedPaycomUrl(value);
	return Boolean(url && url.pathname === LOGIN_ACTION_PATH && url.search === "");
}
function authenticatedUrl(value) {
	const url = parsedPaycomUrl(value);
	if (!url) return false;
	const keys = [...url.searchParams.keys()];
	const oneEach = new Set(keys).size === keys.length;
	if (url.pathname.startsWith(AUTH_PATH_PREFIX) && url.pathname !== CLIENT_LANDING_PATH) return oneEach && keys.every((key) => key === "session_nonce") && keys.length <= 1;
	if (![CLIENT_LANDING_PATH, MAIN_MENU_PATH].includes(url.pathname) || !oneEach || keys.some((key) => !["frmlogin", "session_nonce"].includes(key)) || keys.length > 2) return false;
	return !url.searchParams.has("frmlogin") || url.searchParams.get("frmlogin") === "1";
}
function exactSecurityQuestionUrl(value) {
	const url = parsedPaycomUrl(value);
	if (!url || url.pathname !== SECURITY_QUESTION_PATH) return false;
	const keys = [...url.searchParams.keys()];
	return keys.length <= 1 && keys.every((key) => key === "session_nonce");
}
function exactTimecardSearchUrl(value) {
	const url = parsedPaycomUrl(value);
	if (!url || url.pathname !== TIMECARD_SEARCH_PATH) return false;
	const keys = [...url.searchParams.keys()];
	return new Set(keys).size === keys.length && keys.length <= 2 && keys.every((key) => ["from", "session_nonce"].includes(key)) && url.searchParams.get("from") === "main_menu";
}
function securityProfileUrl(value) {
	const url = parsedPaycomUrl(value);
	if (!url || url.pathname !== SECURITY_PROFILE_PATH) return false;
	const keys = [...url.searchParams.keys()];
	return keys.length <= 1 && keys.every((key) => key === "session_nonce");
}
function securityProfileState(snapshot) {
	if (!securityProfileUrl(snapshot?.url) || !snapshot.securityProfile) return null;
	const inputs = JSON.stringify(snapshot.securityProfile.inputNames);
	const buttons = JSON.stringify(snapshot.securityProfile.buttonTexts);
	const text = String(snapshot.text || "").replace(/\s+/g, " ").trim();
	if (inputs !== JSON.stringify([
		"cell-number",
		"email",
		"work-number"
	]) || !text.includes("Setup Your Security Profile") || !text.includes("Verify your contact information")) return "manual_verification_required";
	if (buttons === JSON.stringify([
		"Continue",
		"Not Now",
		"Verify",
		"Verify",
		"Verify"
	]) && !text.includes("Warning")) return "security_profile_prompt";
	if (buttons === JSON.stringify([
		"",
		"Cancel",
		"Continue",
		"Continue",
		"Not Now",
		"Verify",
		"Verify",
		"Verify"
	]) && text.includes("Warning") && text.includes(SECURITY_PROFILE_WARNING)) return "security_profile_confirmation";
	return "manual_verification_required";
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
	const value = String(text || "").toLowerCase();
	return [
		["captcha", /captcha/],
		["verification_code", /verification code/],
		["verify_identity", /verify your identity/],
		["multi_factor", /multi-factor/],
		["one_time_code", /one-time code/]
	].filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
}
function classifyState(snapshot, { phase = "observation" } = {}) {
	const result = (state, reason = state) => ({
		state,
		reason
	});
	if (!snapshot || typeof snapshot.url !== "string" || !parsedPaycomUrl(snapshot.url)) return result("manual_verification_required", "untrusted_url");
	const text = String(snapshot.text || "").toLowerCase();
	const parsed = parsedPaycomUrl(snapshot.url);
	if (/account.{0,30}(locked|disabled)|too many.{0,20}attempt/.test(text)) return result("account_locked");
	const primaryRejected = /invalid.{0,30}(client|user|password|credential)|incorrect.{0,20}(password|login)/.test(text);
	const securityRejected = /security answers?.{0,40}(not correct|incorrect|invalid)/.test(text);
	const exactLoginRoute = exactLoginUrl(snapshot.url) || exactLoginActionUrl(snapshot.url);
	const exactSecurityRoute = exactSecurityQuestionUrl(snapshot.url);
	if (primaryRejected || securityRejected) {
		if (phase === "primary_login" && primaryRejected && exactLoginRoute) return result("primary_credentials_rejected");
		if (phase === "security_questions" && securityRejected && (exactSecurityRoute || exactLoginRoute)) return result("security_answers_rejected");
		return result("manual_verification_required", "ambiguous_rejection");
	}
	const manualChallenge = verificationTextMatches(text).length > 0;
	if (snapshot.otpPresent === true || snapshot.captchaPresent === true) return result("manual_verification_required", "additional_verification");
	if (parsed.pathname === SECURITY_PROFILE_PATH) {
		if (Array.isArray(snapshot.challenge) && snapshot.challenge.length) return result("manual_verification_required", "unexpected_challenge");
		if (!securityProfileUrl(snapshot.url)) return result("manual_verification_required", "unexpected_query");
		if (snapshot.readyState !== "complete") return result("pending", "page_loading");
		const state = securityProfileState(snapshot);
		if (state && state !== "manual_verification_required") return result(state);
		if (manualChallenge) return result("manual_verification_required", "additional_verification");
		return result("manual_verification_required", "security_profile_layout_changed");
	}
	if (manualChallenge) return result("manual_verification_required", "additional_verification");
	if (snapshot.readyState !== "complete") return result("pending", "page_loading");
	if (parsed.pathname === SECURITY_QUESTION_PATH) {
		if (!exactSecurityQuestionUrl(snapshot.url)) return result("manual_verification_required", "unexpected_query");
		if (!Array.isArray(snapshot.challenge) || !snapshot.challenge.length) return result("pending", "page_loading");
		const indices = snapshot.challenge.map((item) => item.index);
		return indices.length === 2 && new Set(indices).size === 2 && snapshot.challengeFormCount === 1 && exactSecurityQuestionUrl(snapshot.challengeFormAction) && String(snapshot.challengeFormMethod).toUpperCase() === "POST" ? result("security_questions_required") : result("manual_verification_required", "challenge_layout_changed");
	}
	if (parsed.pathname === TIMECARD_SEARCH_PATH) {
		if (!exactTimecardSearchUrl(snapshot.url)) return result("manual_verification_required", "unexpected_query");
		return snapshot.timecardSearchReady === true ? result("timecard_application") : result("pending", "page_loading");
	}
	if (snapshot.authenticated === true && authenticatedUrl(snapshot.url)) return result("authenticated");
	if (Array.isArray(snapshot.challenge) && snapshot.challenge.length) return result("manual_verification_required", "unexpected_challenge");
	if (Array.isArray(snapshot.loginPresent) && snapshot.loginPresent.length === 3 && snapshot.loginPresent.every(Boolean) && Array.isArray(snapshot.loginVisible) && snapshot.loginVisible.every(Boolean) && snapshot.loginFormCount === 1 && exactLoginUrl(snapshot.url) && exactLoginActionUrl(snapshot.loginFormAction) && String(snapshot.loginFormMethod).toUpperCase() === "POST") return result("logged_out");
	return result("pending", "page_unrecognized");
}
function classify(snapshot, context) {
	return classifyState(snapshot, context).state;
}
function classificationDiagnostic(state, phase, snapshot, reason) {
	return {
		phase,
		route: exactSecurityQuestionUrl(snapshot?.url) ? "security_question" : exactLoginUrl(snapshot?.url) || exactLoginActionUrl(snapshot?.url) ? "login" : securityProfileUrl(snapshot?.url) ? "security_profile" : authenticatedUrl(snapshot?.url) ? "application" : "unknown",
		evidence: ["primary_credentials_rejected", "security_answers_rejected"].includes(state) ? "provider_rejection" : "adapter_check",
		reason
	};
}
function stateMetadata(snapshot, diagnostic = null) {
	const url = parsedPaycomUrl(snapshot?.url);
	let formActionPath = null;
	try {
		const action = new URL(snapshot?.challengeFormAction || "");
		if (action.origin === ORIGIN) formActionPath = action.pathname;
	} catch {}
	const profileInputs = Array.isArray(snapshot?.securityProfile?.inputNames) ? snapshot.securityProfile.inputNames.filter((value) => typeof value === "string" && value.length <= 64).slice(0, 16) : [];
	const profileActions = Array.isArray(snapshot?.securityProfile?.buttonTexts) ? snapshot.securityProfile.buttonTexts.filter((value) => typeof value === "string" && value.length <= 64).slice(0, 16) : [];
	return {
		origin: url?.origin || null,
		path: url?.pathname || null,
		queryKeys: url ? [...url.searchParams.keys()].sort() : [],
		title: typeof snapshot?.title === "string" ? snapshot.title.slice(0, 120) : null,
		readyState: [
			"loading",
			"interactive",
			"complete"
		].includes(snapshot?.readyState) ? snapshot.readyState : null,
		otpPresent: typeof snapshot?.otpPresent === "boolean" ? snapshot.otpPresent : null,
		captchaPresent: typeof snapshot?.captchaPresent === "boolean" ? snapshot.captchaPresent : null,
		verificationTextMatches: verificationTextMatches(snapshot?.text),
		loginFormCount: Number.isInteger(snapshot?.loginFormCount) ? snapshot.loginFormCount : null,
		challengeFormCount: Number.isInteger(snapshot?.challengeFormCount) ? snapshot.challengeFormCount : null,
		profileInputNames: url?.pathname === SECURITY_PROFILE_PATH ? profileInputs : [],
		profileActionLabels: url?.pathname === SECURITY_PROFILE_PATH ? profileActions : [],
		challengeIndices: Array.isArray(snapshot?.challenge) ? snapshot.challenge.map((item) => item.index).sort() : [],
		challengeFormActionPath: formActionPath,
		challengeFormMethod: ["GET", "POST"].includes(String(snapshot?.challengeFormMethod).toUpperCase()) ? String(snapshot.challengeFormMethod).toUpperCase() : null,
		diagnostic
	};
}
function loginExpression(credentials) {
	return `(()=>{
    const values=${JSON.stringify({
		clientCode: credentials.clientCode,
		username: credentials.username,
		password: credentials.password
	}).replace(/</g, "\\u003c")};
    const safe=(u,path)=>{try{const x=new URL(u);return x.protocol==='https:'&&x.hostname==='www.paycomonline.net'&&!x.port&&!x.username&&!x.password&&!x.hash&&x.pathname===path&&!x.search}catch{return false}};
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
	if (!Array.isArray(challenge) || challenge.length !== 2) throw new PaycomAuthError("manual_verification_required");
	const indices = challenge.map((item) => item?.index).sort((a, b) => a - b);
	if (indices.some((index) => !Number.isInteger(index) || index < 1 || index > 5) || new Set(indices).size !== 2) throw new PaycomAuthError("manual_verification_required");
	return indices;
}
function challengeFocusExpression(challenge, targetIndex, { verifyFocus = false } = {}) {
	const indices = challengeIndices(challenge);
	if (!indices.includes(targetIndex)) throw new PaycomAuthError("manual_verification_required");
	return `(()=>{
    const safe=u=>{try{const x=new URL(u),keys=Array.from(x.searchParams.keys());return x.protocol==='https:'&&x.hostname==='www.paycomonline.net'&&!x.port&&!x.username&&!x.password&&!x.hash&&x.pathname==='/v4/cl/web.php/security/security-question/login'&&keys.length<=1&&keys.every(key=>key==='session_nonce')}catch{return false}};
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
	const values = retainValues ? {} : Object.fromEntries(indices.map((index) => [String(index), credentials[`pin${index}`]]));
	const encoded = JSON.stringify(values).replace(/</g, "\\u003c");
	return `(()=>{
    const safe=u=>{try{const x=new URL(u),keys=Array.from(x.searchParams.keys());return x.protocol==='https:'&&x.hostname==='www.paycomonline.net'&&!x.port&&!x.username&&!x.password&&!x.hash&&x.pathname==='/v4/cl/web.php/security/security-question/login'&&keys.length<=1&&keys.every(key=>key==='session_nonce')}catch{return false}};
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
function requireNativeInput(browser) {
	if (!browser?.nativeInput || typeof browser.nativeInput.click !== "function" || typeof browser.nativeInput.type !== "function") throw new PaycomAuthError("browser_interaction_required");
	return browser.nativeInput;
}
async function submitNativeChallenge(connection, credentials, challenge, browser, signal) {
	const input = requireNativeInput(browser);
	const indices = challengeIndices(challenge);
	if (indices.some((index) => typeof credentials[`pin${index}`] !== "string" || !/^[\x20-\x7e]{1,64}$/.test(credentials[`pin${index}`]))) throw new PaycomAuthError("manual_verification_required");
	for (const index of indices) {
		throwIfAborted(signal);
		const field = await connection.evaluate(challengeFocusExpression(challenge, index));
		if (field?.status !== "native_challenge_field_ready") throw new PaycomAuthError("manual_verification_required");
		await input.click(connection, field.x, field.y, signal);
		if ((await connection.evaluate(challengeFocusExpression(challenge, index, { verifyFocus: true })))?.status !== "native_challenge_field_focused") throw new PaycomAuthError("manual_verification_required");
		await input.type(credentials[`pin${index}`], signal);
	}
	const ready = await connection.evaluate(challengeExpression(credentials, challenge));
	if (ready?.status !== "native_challenge_ready") throw new PaycomAuthError("manual_verification_required");
	throwIfAborted(signal);
	await input.click(connection, ready.x, ready.y, signal);
}
function securityProfileDismissExpression() {
	return `(()=>{
    const url=new URL(location.href),keys=Array.from(url.searchParams.keys());
    if(url.protocol!=='https:'||url.hostname!=='www.paycomonline.net'||url.port||url.username||url.password||url.hash||url.pathname!==${JSON.stringify(SECURITY_PROFILE_PATH)}||keys.length>1||keys.some(key=>key!=='session_nonce'))return {status:'manual_verification_required'};
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
    if(url.protocol!=='https:'||url.hostname!=='www.paycomonline.net'||url.port||url.username||url.password||url.hash||url.pathname!==${JSON.stringify(SECURITY_PROFILE_PATH)}||keys.length>1||keys.some(key=>key!=='session_nonce'))return {status:'manual_verification_required'};
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
    if(url.protocol!=='https:'||url.hostname!=='www.paycomonline.net'||url.port||url.username||url.password||url.hash||url.pathname!==${JSON.stringify(SECURITY_PROFILE_PATH)}||keys.length>1||keys.some(key=>key!=='session_nonce'))return {status:'manual_verification_required'};
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
function awaitingProfileControls(snapshot, reason) {
	return securityProfileUrl(snapshot?.url) && snapshot.otpPresent !== true && snapshot.captchaPresent !== true && ["security_profile_layout_changed", "additional_verification"].includes(reason);
}
async function waitForState(connection, timeoutMs, accepted, signal, context = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		throwIfAborted(signal);
		try {
			last = await connection.evaluate(SNAPSHOT);
			if (last?.url === "about:blank") {
				await delay(50, signal);
				continue;
			}
			const { state, reason } = classifyState(last, context);
			const profileRendering = awaitingProfileControls(last, reason);
			if (accepted.has(state) && !profileRendering) return {
				state,
				snapshot: last,
				diagnostic: classificationDiagnostic(state, context.phase || "observation", last, reason)
			};
		} catch (error) {
			if (signal?.aborted) throw new PaycomAuthError("acquisition_cancelled");
		}
		await delay(200, signal);
	}
	if (securityProfileUrl(last?.url)) return {
		state: "manual_verification_required",
		snapshot: last,
		diagnostic: classificationDiagnostic("manual_verification_required", context.phase || "observation", last, "security_profile_response_timeout")
	};
	throw new PaycomAuthError("authentication_timeout");
}
const SECURITY_PROFILE_STATES = /* @__PURE__ */ new Set(["security_profile_prompt", "security_profile_confirmation"]);
async function waitForStateChange(connection, previous, signal, context = {}) {
	const deadline = Date.now() + 15e3;
	let lastSnapshot;
	while (Date.now() < deadline) {
		throwIfAborted(signal);
		try {
			const snapshot = await connection.evaluate(SNAPSHOT);
			lastSnapshot = snapshot;
			const { state, reason } = classifyState(snapshot, context);
			const profileRendering = awaitingProfileControls(snapshot, reason);
			if (state !== "pending" && state !== previous && !profileRendering) return {
				state,
				snapshot,
				diagnostic: classificationDiagnostic(state, context.phase || "observation", snapshot, reason)
			};
		} catch (error) {
			if (signal?.aborted) throw new PaycomAuthError("acquisition_cancelled");
		}
		await delay(200, signal);
	}
	if (securityProfileUrl(lastSnapshot?.url)) return {
		state: "manual_verification_required",
		snapshot: lastSnapshot,
		diagnostic: classificationDiagnostic("manual_verification_required", context.phase || "observation", lastSnapshot, "security_profile_response_timeout")
	};
	if (context.phase === "security_questions" && lastSnapshot) return {
		state: "manual_verification_required",
		snapshot: lastSnapshot,
		diagnostic: classificationDiagnostic("manual_verification_required", context.phase, lastSnapshot, "challenge_response_timeout")
	};
	if (context.phase === "security_profile" && lastSnapshot) return {
		state: "manual_verification_required",
		snapshot: lastSnapshot,
		diagnostic: classificationDiagnostic("manual_verification_required", context.phase, lastSnapshot, "security_profile_response_timeout")
	};
	throw new PaycomAuthError("manual_verification_required");
}
async function nativeClick(connection, prepared, expected) {
	if (prepared?.status !== expected || !Number.isFinite(prepared.x) || !Number.isFinite(prepared.y) || prepared.x < 0 || prepared.y < 0 || prepared.x > 1e4 || prepared.y > 1e4) throw new PaycomAuthError("manual_verification_required");
	await connection.command("Input.dispatchMouseEvent", {
		type: "mouseMoved",
		x: prepared.x,
		y: prepared.y
	});
	await connection.command("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: prepared.x,
		y: prepared.y,
		button: "left",
		clickCount: 1
	});
	await connection.command("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: prepared.x,
		y: prepared.y,
		button: "left",
		clickCount: 1
	});
}
async function resolveSecurityProfile(connection, initial, signal) {
	let current = initial;
	let confirmationAccepted = false;
	for (let phase = 0; phase < 3 && SECURITY_PROFILE_STATES.has(current.state); phase++) {
		const before = current.state;
		const proceed = before === "security_profile_prompt" && confirmationAccepted;
		const expression = before === "security_profile_confirmation" ? securityProfileConfirmationExpression() : proceed ? securityProfileProceedExpression() : securityProfileDismissExpression();
		const expected = before === "security_profile_confirmation" ? "security_profile_confirmation_ready" : proceed ? "security_profile_proceed_ready" : "security_profile_dismiss_ready";
		let prepared;
		try {
			prepared = await connection.evaluate(expression);
		} catch {
			throw new PaycomAuthError("manual_verification_required");
		}
		try {
			await nativeClick(connection, prepared, expected);
		} catch (error) {
			throw error instanceof PaycomAuthError ? error : new PaycomAuthError("manual_verification_required");
		}
		if (before === "security_profile_confirmation") confirmationAccepted = true;
		current = await waitForStateChange(connection, before, signal, { phase: "security_profile" });
	}
	if (SECURITY_PROFILE_STATES.has(current.state)) throw new PaycomAuthError("manual_verification_required");
	return current;
}
async function verifyTimecardApplication(connection, initial, credentials, ensureSubmitted, signal, observe = (value) => value, loginOnly = false, browser = null, observationOnly = false) {
	let current = initial;
	let challengeSubmitted = false;
	for (let phase = 0; phase < 8; phase++) {
		if (SECURITY_PROFILE_STATES.has(current.state)) {
			current = observe(await resolveSecurityProfile(connection, current, signal));
			continue;
		}
		if (current.state === "security_questions_required") {
			if (challengeSubmitted) throw new PaycomAuthError("manual_verification_required");
			throwIfAborted(signal);
			if (observationOnly) ensureSubmitted("security_questions");
			requireNativeInput(browser);
			ensureSubmitted("security_questions");
			try {
				await submitNativeChallenge(connection, credentials, current.snapshot.challenge, browser, signal);
			} catch (error) {
				observe({
					state: "manual_verification_required",
					snapshot: current.snapshot,
					diagnostic: classificationDiagnostic("manual_verification_required", "security_questions", current.snapshot, "challenge_entry_failed")
				});
				throw error;
			}
			challengeSubmitted = true;
			current = observe(await waitForStateChange(connection, "security_questions_required", signal, { phase: "security_questions" }));
			continue;
		}
		if (current.state === "timecard_application") return current;
		if (current.state === "authenticated") {
			if (loginOnly) return current;
			throwIfAborted(signal);
			if ((await connection.command("Page.navigate", { url: TIMECARD_SEARCH_URL }))?.errorText) throw new PaycomAuthError("manual_verification_required");
			current = observe(await waitForState(connection, 45e3, /* @__PURE__ */ new Set([
				"timecard_application",
				"security_questions_required",
				"security_profile_prompt",
				"security_profile_confirmation",
				"manual_verification_required",
				"account_locked",
				"logged_out"
			]), signal, { phase: "application_navigation" }));
			continue;
		}
		throw new PaycomAuthError(current.state);
	}
	throw new PaycomAuthError("manual_verification_required");
}
async function prepareHandoff(browser, sourceTarget, sourceConnection, signal, onState, observedUrl = null) {
	const observed = (state) => {
		if (typeof onState === "function") try {
			onState(state);
		} catch {}
	};
	throwIfAborted(signal);
	const currentUrl = observedUrl || await sourceConnection.evaluate("location.href");
	if (!exactTimecardSearchUrl(currentUrl)) throw new PaycomAuthError("manual_verification_required");
	observed("handoff_source_verified");
	if (typeof browser.browserWebSocketUrl !== "string") throw new PaycomAuthError("browser_protocol_failed");
	const cleanTarget = await createTarget(browser.endpoint, currentUrl);
	observed("handoff_target_created");
	const cleanConnection = await CdpConnection.connect(cleanTarget.webSocketDebuggerUrl);
	try {
		if ((await waitForState(cleanConnection, 45e3, /* @__PURE__ */ new Set([
			"timecard_application",
			"security_questions_required",
			"security_profile_prompt",
			"security_profile_confirmation",
			"manual_verification_required"
		]), signal)).state !== "timecard_application") throw new PaycomAuthError("manual_verification_required");
		observed("handoff_target_verified");
	} finally {
		cleanConnection.close();
	}
	const browserConnection = await CdpConnection.connect(browser.browserWebSocketUrl);
	try {
		for (let pass = 0; pass < 20; pass++) {
			throwIfAborted(signal);
			const unwanted = ((await browserConnection.command("Target.getTargets")).targetInfos || []).filter((info) => info.targetId !== cleanTarget.id && info.type === "page");
			if (!unwanted.length) break;
			for (const info of unwanted) await browserConnection.command("Target.closeTarget", { targetId: info.targetId });
			await delay(50, signal);
			if (pass === 19) throw new PaycomAuthError("manual_verification_required");
		}
		observed("handoff_targets_closed");
	} finally {
		browserConnection.close();
	}
	return {
		status: "authenticated",
		targetId: cleanTarget.id,
		replacedCredentialPage: sourceTarget.id !== cleanTarget.id
	};
}
const RETAINED_PIN_FINGERPRINT = `(async()=>{
  const fields=['firstSecurityQuestion','secondSecurityQuestion'].map(name=>document.querySelector('input[name="'+name+'"]'));
  if(fields.some(field=>!field||field.type!=='password'||!field.value))return null;
  const bytes=new TextEncoder().encode(JSON.stringify(fields.map(field=>field.value)));
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
})()`;
const paycomAdapter = Object.freeze({
	provider: "paycom",
	nativeInteraction: true,
	async prepareBrowserAssistance(browser, { signal } = {}) {
		throwIfAborted(signal);
		if (!browser.nativeInput) return null;
		const { boundedJson } = require("./cdp.js");
		const targets = await boundedJson(`${browser.endpoint}/json/list`, { signal });
		let selected = null;
		for (const target of targets.filter((item) => item.type === "page" && parsedPaycomUrl(item.url))) {
			const connection = await CdpConnection.connect(target.webSocketDebuggerUrl, { signal });
			try {
				const snapshot = await connection.evaluate(SNAPSHOT);
				if (classifyState(snapshot).reason === "additional_verification" && snapshot.captchaPresent === true && snapshot.otpPresent !== true) {
					if (selected) return null;
					const frame = (await connection.command("Page.getFrameTree")).frameTree.frame;
					const pinFingerprint = await connection.evaluate(RETAINED_PIN_FINGERPRINT);
					selected = {
						...target,
						loaderId: frame.loaderId,
						challenge: snapshot.challenge,
						pinFingerprint,
						resumeLogin: !pinFingerprint && (snapshot.loginPresent?.every(Boolean) || snapshot.challenge?.length === 2)
					};
				}
			} finally {
				connection.close();
			}
		}
		if (!selected) return null;
		for (const target of targets.filter((item) => item.type === "page" && item.id !== selected.id)) await boundedJson(`${browser.endpoint}/json/close/${target.id}`, { signal }).catch(() => {});
		return {
			pluginId: "paycom",
			type: "captcha",
			targetId: selected.id,
			loaderId: selected.loaderId,
			challenge: selected.challenge,
			pinFingerprint: selected.pinFingerprint,
			resumeLogin: selected.resumeLogin
		};
	},
	async completeBrowserAssistance(browser, context, { signal, onState, loginOnly = false, resumeAuthentication } = {}) {
		const { boundedJson } = require("./cdp.js");
		const target = (await boundedJson(`${browser.endpoint}/json/list`, { signal })).find((item) => item.type === "page" && item.id === context.targetId && parsedPaycomUrl(item.url));
		if (!target) throw new PaycomAuthError("manual_verification_required");
		const connection = await CdpConnection.connect(target.webSocketDebuggerUrl, { signal });
		const observed = (value) => {
			if (typeof onState === "function") try {
				onState(value.state, stateMetadata(value.snapshot, value.diagnostic));
			} catch {}
			return value;
		};
		const refuseSubmission = () => {
			throw new PaycomAuthError("manual_verification_required");
		};
		try {
			await connection.command("Page.enable");
			let current = observed(await waitForState(connection, 15e3, /* @__PURE__ */ new Set([
				"authenticated",
				"timecard_application",
				"security_questions_required",
				"security_profile_prompt",
				"security_profile_confirmation",
				"manual_verification_required",
				"account_locked",
				"logged_out"
			]), signal, { phase: "recovery_observation" }));
			if (context.resumeLogin && ["logged_out", "security_questions_required"].includes(current.state) && typeof resumeAuthentication === "function") {
				if ((await connection.command("Page.getFrameTree")).frameTree.frame.loaderId !== context.loaderId) refuseSubmission();
				return await resumeAuthentication();
			}
			if (current.state === "security_questions_required") {
				const frame = (await connection.command("Page.getFrameTree")).frameTree.frame;
				if (!context.pinFingerprint || frame.loaderId !== context.loaderId || await connection.evaluate(RETAINED_PIN_FINGERPRINT) !== context.pinFingerprint) refuseSubmission();
				const ready = await connection.evaluate(challengeExpression(Object.freeze({}), context.challenge, { retainValues: true }));
				if (ready?.status !== "native_challenge_ready") refuseSubmission();
				throwIfAborted(signal);
				await requireNativeInput(browser).click(connection, ready.x, ready.y, signal);
				current = observed(await waitForStateChange(connection, "security_questions_required", signal, { phase: "security_questions" }));
			}
			const verified = await verifyTimecardApplication(connection, current, Object.freeze({}), refuseSubmission, signal, observed, loginOnly, browser, true);
			if (loginOnly) return { status: "authenticated" };
			return prepareHandoff(browser, target, connection, signal, onState, verified.snapshot.url);
		} finally {
			connection.close();
		}
	},
	async inspect(browser, { signal, onState } = {}) {
		throwIfAborted(signal);
		const target = await createTarget(browser.endpoint, `${ORIGIN}${CLIENT_LANDING_PATH}`);
		const connection = await CdpConnection.connect(target.webSocketDebuggerUrl, { commandTimeoutMs: 1e4 });
		try {
			await connection.command("Page.enable");
			const deadline = Date.now() + 15e3;
			let snapshot = null;
			let state = "pending";
			while (Date.now() < deadline) {
				throwIfAborted(signal);
				try {
					snapshot = await connection.evaluate(SNAPSHOT);
					if (snapshot?.url !== "about:blank") {
						state = classify(snapshot, { phase: "inspection" });
						if (state !== "pending" || snapshot.readyState === "complete") break;
					}
				} catch (error) {
					if (signal?.aborted) throw new PaycomAuthError("acquisition_cancelled");
				}
				await delay(200, signal);
			}
			if (!snapshot || snapshot.url === "about:blank") throw new PaycomAuthError("authentication_timeout");
			if (state === "pending" && snapshot.readyState === "complete") state = "manual_verification_required";
			const metadata = stateMetadata(snapshot);
			if (typeof onState === "function") try {
				onState(state, metadata);
			} catch {}
			return {
				state,
				observedAt: (/* @__PURE__ */ new Date()).toISOString(),
				metadata
			};
		} finally {
			connection.close();
		}
	},
	async recover(browser, { signal, onState, loginOnly = false } = {}) {
		const observed = (value) => {
			if (typeof onState === "function") try {
				onState(value.state, stateMetadata(value.snapshot, value.diagnostic));
			} catch {}
			return value;
		};
		const refuseSubmission = () => {
			throw new PaycomAuthError("manual_verification_required");
		};
		throwIfAborted(signal);
		const target = await createTarget(browser.endpoint, `${ORIGIN}${CLIENT_LANDING_PATH}`);
		const connection = await CdpConnection.connect(target.webSocketDebuggerUrl, { commandTimeoutMs: 1e4 });
		try {
			await connection.command("Page.enable");
			const current = observed(await waitForState(connection, 15e3, /* @__PURE__ */ new Set([
				"authenticated",
				"timecard_application",
				"logged_out",
				"security_questions_required",
				"security_profile_prompt",
				"security_profile_confirmation",
				"manual_verification_required",
				"account_locked"
			]), signal, { phase: "recovery_observation" }));
			if (["logged_out", "security_questions_required"].includes(current.state)) refuseSubmission();
			if (["manual_verification_required", "account_locked"].includes(current.state)) throw new PaycomAuthError(current.state);
			const verified = await verifyTimecardApplication(connection, current, Object.freeze({}), refuseSubmission, signal, observed, loginOnly, browser, true);
			if (loginOnly) return { status: "authenticated" };
			return prepareHandoff(browser, target, connection, signal, onState, verified.snapshot.url);
		} finally {
			connection.close();
		}
	},
	async authenticate(browser, credentials, { signal, onSubmit, onState, loginOnly = false } = {}) {
		const observed = (value) => {
			if (typeof onState === "function") try {
				onState(value.state, stateMetadata(value.snapshot, value.diagnostic));
			} catch {}
			return value;
		};
		let submissionLatched = false;
		const ensureSubmitted = (kind) => {
			if (submissionLatched) return;
			if (typeof onSubmit !== "function") throw new PaycomAuthError("authentication_failed");
			onSubmit(kind);
			submissionLatched = true;
		};
		throwIfAborted(signal);
		const target = await createTarget(browser.endpoint, `${ORIGIN}${CLIENT_LANDING_PATH}`);
		const connection = await CdpConnection.connect(target.webSocketDebuggerUrl, { commandTimeoutMs: 1e4 });
		try {
			await connection.command("Page.enable");
			let current = observed(await waitForState(connection, 15e3, /* @__PURE__ */ new Set([
				"authenticated",
				"timecard_application",
				"logged_out",
				"security_questions_required",
				"security_profile_prompt",
				"security_profile_confirmation",
				"manual_verification_required",
				"account_locked"
			]), signal, { phase: "observation" }));
			if (current.snapshot?.captchaPresent === true && current.snapshot?.otpPresent !== true) requireNativeInput(browser);
			if (current.state === "logged_out") {
				throwIfAborted(signal);
				requireNativeInput(browser);
				ensureSubmitted("credentials");
				if ((await connection.evaluate(loginExpression(credentials)))?.status !== "submitted") throw new PaycomAuthError("manual_verification_required");
				current = observed(await waitForState(connection, 45e3, /* @__PURE__ */ new Set([
					"authenticated",
					"timecard_application",
					"security_questions_required",
					"security_profile_prompt",
					"security_profile_confirmation",
					"manual_verification_required",
					"primary_credentials_rejected",
					"account_locked"
				]), signal, { phase: "primary_login" }));
			}
			const verified = await verifyTimecardApplication(connection, current, credentials, ensureSubmitted, signal, observed, loginOnly, browser);
			if (loginOnly) return { status: "authenticated" };
			return prepareHandoff(browser, target, connection, signal, onState, verified.snapshot.url);
		} finally {
			connection.close();
		}
	}
});
module.exports = {
	paycomAdapter,
	PaycomAuthError,
	LOGIN_URL,
	LOGIN_ACTION_URL,
	AUTH_PREFIX,
	LOGIN_FIELDS,
	SNAPSHOT,
	SECURITY_QUESTION_PATH,
	TIMECARD_SEARCH_PATH,
	TIMECARD_SEARCH_URL,
	CLIENT_LANDING_PATH,
	MAIN_MENU_PATH,
	SECURITY_PROFILE_PATH,
	SECURITY_PROFILE_WARNING,
	classify,
	classifyState,
	loginExpression,
	challengeExpression,
	challengeFocusExpression,
	submitNativeChallenge,
	securityProfileUrl,
	securityProfileState,
	securityProfileDismissExpression,
	securityProfileConfirmationExpression,
	securityProfileProceedExpression,
	resolveSecurityProfile,
	verifyTimecardApplication,
	waitForState,
	prepareHandoff,
	exactLoginUrl,
	exactLoginActionUrl,
	exactSecurityQuestionUrl,
	exactTimecardSearchUrl,
	authenticatedUrl
};
//#endregion
