// DOM-only Cortex login operations. No cookies, tokens or page text leave this function.
(input) => {
  const approved = (value) => {
    try {
      const url = new URL(value, location.href);
      return input.origins.includes(url.origin) && !url.username && !url.password;
    } catch {
      return false;
    }
  };
  if (!approved(location.href)) return { state: 'untrusted' };
  const visible = (element) =>
    !!element && !element.disabled && element.getClientRects().length > 0;
  const find = (selector) => [...document.querySelectorAll(selector)].find(visible);
  const text = (document.body?.innerText || '').toLowerCase();
  const password = find('#ap_password, input[name="password"], input[type="password"]');
  const username = find(
    '#ap_email, input[name="email"], input[type="email"], input[name="username"]',
  );
  const otp = find(
    '#auth-mfa-otpcode, #input-box-otp, #cvf-input-code, input[name="otpCode"], input[name="code"], input[autocomplete="one-time-code"]',
  );
  const captcha =
    find('#auth-captcha-image, #auth-captcha-guess, input[name="guess"], iframe[src*="captcha"]') ||
    /enter the characters|robot check|solve this puzzle/.test(text);
  let state = 'pending';
  if (/account (?:is |has been )?(?:locked|on hold)|account temporarily locked/.test(text))
    state = 'account_locked';
  else if (
    /your password is incorrect|incorrect password|cannot find an account|there was a problem with your e-mail/.test(
      text,
    )
  )
    state = 'invalid_credentials';
  else if (
    /sorry.{0,3} something went wrong|service unavailable|access denied|not authorized/.test(text)
  )
    state = 'provider_unavailable';
  else if (
    captcha ||
    otp ||
    /verify your identity|approval required|unusual activity|security challenge/.test(text) ||
    /\/ap\/(cvf|challenge|mfa)/.test(location.pathname)
  )
    state = 'challenge';
  else if (password) state = 'password';
  else if (username) state = 'username';
  else if (
    location.origin === input.applicationOrigin &&
    /^\/operations\/execution(?:\/|$)/.test(location.pathname) &&
    /delivery execution/.test(text) &&
    /itineraries|routes|drivers|delivery associates/.test(text)
  )
    state = 'authenticated';
  if (input.action === 'observe') return { state };
  if (input.action === 'login' && !['username', 'password'].includes(state)) return { state };
  if (input.action === 'verify' && (!otp || captcha)) return { state: 'challenge' };
  const field = input.action === 'verify' ? otp : state === 'password' ? password : username;
  const form = field?.form;
  if (!field || !form || !approved(form.action)) return { state: 'challenge' };
  const button = [
    ...form.querySelectorAll(
      'input[type="submit"], button[type="submit"], #signInSubmit, #continue',
    ),
  ].find(visible);
  if (button?.hasAttribute('formaction') && !approved(button.formAction))
    return { state: 'challenge' };
  const set = (element, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (input.action === 'verify') set(field, input.code);
  else {
    if (username?.form === form) set(username, input.credentials.username);
    if (state === 'password') set(password, input.credentials.password);
    const remember = [...form.querySelectorAll('#auth-remember-me, input[name="rememberMe"]')].find(
      visible,
    );
    if (remember && !remember.checked) remember.click();
  }
  if (button) button.click();
  else form.requestSubmit();
  return { state: 'submitted' };
};
