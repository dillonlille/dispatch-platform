import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import type { Credentials } from '../../services/browsers/protocol.js';
import { AppError } from '../../shared/errors.js';
import type { BrowserCommand } from '../../services/browsers/protocol.js';
const require = createRequire(import.meta.url);

export interface Connection {
  evaluate(expression: string): Promise<any>;
  command(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): void;
}
export interface PaycomBrowser {
  endpoint: string;
  browserWebSocketUrl: string;
  nativeInput?: {
    click(connection: Connection, x: number, y: number, signal?: AbortSignal): Promise<void>;
    type(text: string, signal?: AbortSignal): Promise<void>;
  };
  close(): Promise<void>;
  isAlive(): boolean;
}
interface Observation {
  state: string;
  observedAt: string;
  metadata: Record<string, any>;
}
interface AdapterOptions {
  signal: AbortSignal;
  loginOnly: boolean;
  onSubmit?: (kind: string) => void;
  onState: (state: string, metadata?: Record<string, unknown>) => void;
  resumeAuthentication?: () => Promise<{ status: string }>;
}
const { paycomAdapter, SNAPSHOT, classifyState } = require('./provider/auth/adapter.js') as {
  paycomAdapter: {
    authenticate(
      browser: PaycomBrowser,
      credentials: Record<string, string>,
      options: AdapterOptions,
    ): Promise<{ status: string }>;
    recover(browser: PaycomBrowser, options: AdapterOptions): Promise<{ status: string }>;
    prepareBrowserAssistance(
      browser: PaycomBrowser,
      options: { signal: AbortSignal },
    ): Promise<any>;
    completeBrowserAssistance(
      browser: PaycomBrowser,
      context: unknown,
      options: AdapterOptions,
    ): Promise<{ status: string }>;
  };
  SNAPSHOT: string;
  classifyState(snapshot: unknown): { state: string; reason: string };
};
const { CdpConnection, boundedJson } = require('./provider/auth/cdp.js') as {
  CdpConnection: { connect(url: string, options?: { signal?: AbortSignal }): Promise<Connection> };
  boundedJson(
    url: string,
  ): Promise<{ id: string; type: string; url: string; webSocketDebuggerUrl: string }[]>;
};
const { ChromeBrowserRuntime } = require('./provider/auth/browser-runtime.js') as {
  ChromeBrowserRuntime: new (options: Record<string, unknown>) => {
    reconcile(): Promise<void>;
    launch(options: {
      provider: string;
      profile: string;
      nativeInput?: boolean;
      signal: AbortSignal;
    }): Promise<PaycomBrowser>;
  };
};
const { AttemptGuard } = require('./provider/auth/attempt-guard.js') as {
  AttemptGuard: new (file: string) => {
    check(profile: string, options?: { ownerRetry: boolean }): void;
    submitted(profile: string): void;
    succeeded(profile: string): void;
    failed(profile: string, code: string): void;
    observationRecoverable(profile: string): boolean;
  };
};
const { AuthenticationDiagnostics, sanitizeObservation, MAX_AUTH_OBSERVATIONS } =
  require('./provider/auth/authentication-diagnostics.js') as {
    AuthenticationDiagnostics: new (
      file: string,
    ) => Map<string, { status: string; observedAt: string; observations: Observation[] }>;
    sanitizeObservation(state: string, metadata: unknown, at: number): Observation | null;
    MAX_AUTH_OBSERVATIONS: number;
  };
const errors = new Set([
  'browser_unavailable',
  'unsafe_browser',
  'browser_start_failed',
  'browser_profile_busy',
  'browser_cleanup_failed',
  'browser_protocol_failed',
  'browser_timeout',
  'authentication_timeout',
  'primary_credentials_rejected',
  'security_answers_rejected',
  'invalid_credentials',
  'account_locked',
  'manual_verification_required',
  'authentication_failed',
  'acquisition_cancelled',
  'attempt_cooldown',
  'attempt_state_invalid',
  'browser_interaction_required',
]);
export function authenticationError(error: unknown) {
  const code = (error as { code?: string })?.code;
  return new AppError(code && errors.has(code) ? code : 'authentication_failed', 409);
}

/** Runs the archived adapter without exposing its credentials or browser to other DSPs. */
export class PaycomAuthentication {
  private runtime: InstanceType<typeof ChromeBrowserRuntime>;
  private attempts: InstanceType<typeof AttemptGuard>;
  private diagnostics: InstanceType<typeof AuthenticationDiagnostics>;
  private observations: Observation[] = [];
  private controller = new AbortController();
  private assistance: { targetId: string; resumeLogin: boolean } | null = null;
  private submitted = false;
  private credentials: Record<string, string> = {};
  private ownerRetry = false;
  browser?: PaycomBrowser;
  readonly profile = 'paycom-main';
  constructor(profileRoot: string, executable: string, directoryNetwork = true) {
    const state = path.join(profileRoot, 'authentication');
    fs.mkdirSync(state, { mode: 0o700, recursive: true });
    this.runtime = new ChromeBrowserRuntime({
      stateRoot: path.join(state, 'profiles'),
      executable,
      transport: 'tcp',
      directoryNetwork,
    });
    this.attempts = new AttemptGuard(path.join(state, 'attempts.json'));
    this.diagnostics = new AuthenticationDiagnostics(path.join(state, 'diagnostics.json'));
  }
  private observe = (state: string, metadata?: Record<string, unknown>) => {
    const clean = sanitizeObservation(state, metadata, Date.now());
    if (clean) {
      this.observations.push(clean);
      if (this.observations.length > MAX_AUTH_OBSERVATIONS) this.observations.shift();
    }
  };
  private record(status: string) {
    this.diagnostics.set(this.profile, {
      status,
      observedAt: new Date().toISOString(),
      observations: this.observations,
    });
  }
  private options(loginOnly = true): AdapterOptions {
    return {
      signal: this.controller.signal,
      loginOnly,
      onState: this.observe,
      onSubmit: () => {
        if (this.submitted) return;
        this.attempts.check(this.profile, { ownerRetry: this.ownerRetry });
        this.attempts.submitted(this.profile);
        this.submitted = true;
      },
    };
  }
  private setCredentials(value: Credentials) {
    this.scrub();
    this.credentials = {
      clientCode: value.clientCode,
      username: value.username,
      password: value.password,
    };
    value.securityAnswers?.forEach((answer, index) => {
      this.credentials[`pin${index + 1}`] = answer;
    });
  }
  private scrub() {
    for (const key of Object.keys(this.credentials)) this.credentials[key] = '';
    this.credentials = {};
  }
  async start(credentials: Credentials, ownerRetry = false): Promise<'ready' | 'challenge'> {
    this.ownerRetry = ownerRetry;
    this.setCredentials(credentials);
    let observationRecovery = false;
    try {
      if (!ownerRetry) this.attempts.check(this.profile);
    } catch (error) {
      observationRecovery =
        (error as { code?: string }).code === 'manual_verification_required' &&
        this.attempts.observationRecoverable(this.profile);
      if (!observationRecovery) {
        this.scrub();
        throw authenticationError(error);
      }
    }
    await this.runtime.reconcile();
    this.browser = await this.runtime.launch({
      provider: 'paycom',
      profile: this.profile,
      signal: this.controller.signal,
    });
    if (observationRecovery) {
      // An interrupted submission can only observe a session, never replay login.
      this.scrub();
      try {
        await paycomAdapter.recover(this.browser, this.options());
        return this.ready();
      } catch (error) {
        return this.failed(error);
      }
    }
    return this.authenticate();
  }
  private async authenticate(): Promise<'ready' | 'challenge'> {
    try {
      try {
        await paycomAdapter.authenticate(this.browser!, this.credentials, this.options());
      } catch (error) {
        if ((error as { code?: string }).code !== 'browser_interaction_required' || this.submitted)
          throw error;
        // The archive upgrades once, before any submission, to an ordinary window.
        await this.browser!.close();
        this.browser = await this.runtime.launch({
          provider: 'paycom',
          profile: this.profile,
          nativeInput: true,
          signal: this.controller.signal,
        });
        await paycomAdapter.authenticate(this.browser, this.credentials, this.options());
      }
      return this.ready();
    } catch (error) {
      return this.failed(error);
    }
  }
  private ready(): 'ready' {
    this.attempts.succeeded(this.profile);
    this.submitted = false;
    this.assistance = null;
    this.scrub();
    this.record('authenticated');
    return 'ready';
  }
  private async failed(error: unknown): Promise<'challenge'> {
    const safe = authenticationError(error);
    if (this.submitted) this.attempts.failed(this.profile, safe.code);
    this.record(safe.code);
    if (safe.code !== 'manual_verification_required') {
      this.scrub();
      throw safe;
    }
    this.assistance = await paycomAdapter.prepareBrowserAssistance(this.browser!, {
      signal: this.controller.signal,
    });
    if (!this.assistance?.resumeLogin) this.scrub();
    return 'challenge';
  }
  async check(credentials: Credentials): Promise<'ready' | 'challenge'> {
    this.ownerRetry = true;
    this.submitted = false;
    this.setCredentials(credentials);
    return this.authenticate();
  }
  private async withPage<T>(action: (connection: Connection) => Promise<T>) {
    const targets = await boundedJson(`${this.browser!.endpoint}/json/list`);
    const target = targets.find((target) => {
      try {
        return (
          target.type === 'page' &&
          (!this.assistance || target.id === this.assistance.targetId) &&
          new URL(target.url).origin === 'https://www.paycomonline.net'
        );
      } catch {
        return false;
      }
    });
    if (!target) throw new AppError('manual_verification_required', 409);
    const connection = await CdpConnection.connect(target.webSocketDebuggerUrl, {
      signal: this.controller.signal,
    });
    try {
      return await action(connection);
    } finally {
      connection.close();
    }
  }
  async screenshot(): Promise<string> {
    return this.withPage(
      async (connection) =>
        (await connection.command('Page.captureScreenshot', { format: 'png' })).data as string,
    );
  }
  async continue(): Promise<'ready' | 'challenge'> {
    const current = await this.withPage(async (connection) => {
      const snapshot = await connection.evaluate(SNAPSHOT);
      return { snapshot, ...classifyState(snapshot) };
    });
    if (
      current.snapshot.captchaPresent ||
      current.snapshot.otpPresent ||
      current.state === 'pending'
    )
      return 'challenge';
    try {
      if (this.assistance) {
        await paycomAdapter.completeBrowserAssistance(this.browser!, this.assistance, {
          ...this.options(),
          resumeAuthentication: () =>
            paycomAdapter.authenticate(this.browser!, this.credentials, this.options()),
        });
      } else {
        // Manual verification may finish login, but never retype PINs on a changed form.
        await paycomAdapter.recover(this.browser!, this.options());
      }
      return this.ready();
    } catch (error) {
      const safe = authenticationError(error);
      if (this.submitted) this.attempts.failed(this.profile, safe.code);
      this.record(safe.code);
      if (safe.code !== 'manual_verification_required') {
        this.scrub();
        throw safe;
      }
      return 'challenge';
    }
  }
  async assist(input: Extract<BrowserCommand, { action: 'assist' }>['input']) {
    await this.withPage(async (connection) => {
      if (input.kind === 'click') {
        await connection.command('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: input.x,
          y: input.y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        await connection.command('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: input.x,
          y: input.y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
      }
      if (input.kind === 'pointer') {
        await connection.command('Input.dispatchMouseEvent', {
          type: { down: 'mousePressed', move: 'mouseMoved', up: 'mouseReleased' }[input.phase],
          x: input.x,
          y: input.y,
          button: input.phase === 'move' && !input.pressed ? 'none' : 'left',
          buttons: input.pressed ? 1 : 0,
          clickCount: input.phase === 'move' ? 0 : 1,
        });
      }
      if (input.kind === 'scroll') {
        await connection.command('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: input.x,
          y: input.y,
          deltaX: input.deltaX,
          deltaY: input.deltaY,
        });
      }
      if (input.kind === 'type') {
        if (this.browser!.nativeInput && /^[\x20-\x7e]{1,64}$/.test(input.text))
          await this.browser!.nativeInput.type(input.text, this.controller.signal);
        else await connection.command('Input.insertText', { text: input.text });
      }
      if (input.kind === 'key') {
        const keys: Record<string, number> = {
          Enter: 13,
          Tab: 9,
          Backspace: 8,
          Escape: 27,
          ArrowDown: 40,
          ArrowUp: 38,
          ArrowLeft: 37,
          ArrowRight: 39,
          Delete: 46,
          Home: 36,
          End: 35,
          PageUp: 33,
          PageDown: 34,
        };
        const keyCode = keys[input.key];
        if (!keyCode) throw new AppError('invalid_input');
        await connection.command('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: input.key,
          windowsVirtualKeyCode: keyCode,
          modifiers: input.shift ? 8 : 0,
          ...(input.key === 'Enter' ? { text: '\r' } : {}),
        });
        await connection.command('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: input.key,
          windowsVirtualKeyCode: keyCode,
          modifiers: input.shift ? 8 : 0,
        });
      }
    });
    // User input never resumes login. Only the explicit Submit action does.
    return;
  }
  async verify(code: string) {
    await this.withPage(async (connection) => {
      const focus = await connection.evaluate(
        `(()=>{const fields=[...document.querySelectorAll('input[autocomplete="one-time-code"],input[name="code"],input[name="otp"],input[name="verificationCode"],input[name="verification_code"]')].filter(e=>!e.disabled&&e.offsetParent!==null);if(fields.length!==1)return false;fields[0].focus();return true})()`,
      );
      if (!focus) throw new AppError('manual_verification_required', 409);
      await connection.command('Input.insertText', { text: code });
      await connection.command('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r',
      });
      await connection.command('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        windowsVirtualKeyCode: 13,
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    return this.continue();
  }
  async prepareCollection() {
    try {
      await paycomAdapter.recover(this.browser!, this.options(false));
      this.ready();
    } catch (error) {
      await this.failed(error);
      throw new AppError('verification_required', 409);
    }
  }
  async close() {
    this.controller.abort();
    this.scrub();
    await this.browser?.close();
  }
}
