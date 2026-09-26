import { useState } from 'react';
import { KeyRound, ShieldCheck, Smartphone } from 'lucide-react';
import type { AuthenticatorSetup } from '../../../../shared/contracts/index.js';
import { api } from '../../app/api.js';
import { usePasskeys, useSecurityStatus } from '../../app/endpoints.js';
import { registerPasskey } from '../../app/passkeys.js';
import { useAction } from '../../app/useAction.js';
import { ConfirmDialog, DataState, ErrorBox, Modal, RecoveryCodes } from '../../ui/index.js';

type Removing =
  { kind: 'passkey'; id: string; last: boolean } | { kind: 'authenticator'; last: boolean };

export function MultiFactorPanel() {
  const status = useSecurityStatus();
  const passkeys = usePasskeys();
  const [setup, setSetup] = useState<AuthenticatorSetup>();
  const [codes, setCodes] = useState<string[]>([]);
  const [removing, setRemoving] = useState<Removing>();
  const refresh = () => {
    status.refresh();
    passkeys.refresh();
    window.dispatchEvent(new Event('dispatch-security-changed'));
  };
  const action = useAction(
    async (work: () => Promise<void>) => {
      await work();
      refresh();
    },
    { inline: true },
  );
  const setupAction = useAction(
    async () => {
      setSetup(
        await api<AuthenticatorSetup>('/api/auth/security/authenticator/register/start', {}),
      );
    },
    { inline: true },
  );
  const run = (work: () => Promise<void>) => void action.run(work);

  return (
    <section className="security-sessions security-mfa" aria-labelledby="security-mfa-title">
      <div className="security-sessions-heading">
        <div className="security-panel-heading">
          <ShieldCheck size={19} aria-hidden="true" />
          <h2 id="security-mfa-title">Two-step sign-in</h2>
        </div>
        {status.data && (
          <span className={`security-tag ${status.data.enrolled ? 'security-current' : ''}`}>
            {status.data.enrolled ? 'On' : 'Optional'}
          </span>
        )}
      </div>
      <ErrorBox message={action.error || setupAction.error} />
      <DataState data={status.data} error={status.error}>
        {(security) => (
          <>
            <div className="security-row security-factor-row">
              <KeyRound size={18} aria-hidden="true" />
              <div className="security-row-copy">
                <span>Passkeys</span>
                <small>Use your device, password manager, or security key.</small>
                <DataState data={passkeys.data} error={passkeys.error}>
                  {(items) => (
                    <div className="security-factor-list">
                      {items.map((key) => (
                        <div key={key.id}>
                          <span>{key.name}</span>
                          <button
                            className="security-quiet"
                            disabled={action.busy}
                            onClick={() =>
                              setRemoving({
                                kind: 'passkey',
                                id: key.id,
                                last: security.passkeyCount === 1 && !security.authenticator,
                              })
                            }
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </DataState>
                <form
                  className="security-factor-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget;
                    const name = String(new FormData(form).get('name'));
                    run(async () => {
                      const recovery = await registerPasskey(name);
                      form.reset();
                      if (recovery.length) setCodes(recovery);
                    });
                  }}
                >
                  <input
                    name="name"
                    aria-label="Passkey name"
                    required
                    maxLength={60}
                    placeholder="Passkey name"
                    disabled={action.busy}
                  />
                  <button disabled={action.busy || security.passkeyCount >= 10}>Add passkey</button>
                </form>
              </div>
            </div>
            <div className="security-row security-factor-row">
              <Smartphone size={18} aria-hidden="true" />
              <div className="security-row-copy">
                <span>Authenticator app</span>
                <small>Use a time-based 6-digit code from any compatible app.</small>
              </div>
              {security.authenticator ? (
                <button
                  className="security-quiet"
                  disabled={action.busy}
                  onClick={() =>
                    setRemoving({
                      kind: 'authenticator',
                      last: security.passkeyCount === 0,
                    })
                  }
                >
                  Remove
                </button>
              ) : (
                <button disabled={setupAction.busy} onClick={() => void setupAction.run()}>
                  Add app
                </button>
              )}
            </div>
            {security.enrolled && (
              <div className="security-sessions-footer">
                <button
                  className="security-quiet"
                  disabled={action.busy}
                  onClick={() =>
                    run(async () => {
                      const result = await api<{ codes: string[] }>(
                        '/api/auth/security/recovery-codes',
                        {},
                      );
                      setCodes(result.codes);
                    })
                  }
                >
                  Replace recovery codes
                </button>
              </div>
            )}
          </>
        )}
      </DataState>
      {setup && (
        <AuthenticatorDialog
          setup={setup}
          busy={action.busy}
          error={action.error}
          close={() => setSetup(undefined)}
          finish={(code) =>
            run(async () => {
              const result = await api<{ codes: string[] }>(
                '/api/auth/security/authenticator/register/finish',
                { code },
              );
              setSetup(undefined);
              if (result.codes.length) setCodes(result.codes);
            })
          }
        />
      )}
      {codes.length > 0 && (
        <Modal title="Recovery codes" dismissible={false} onClose={() => setCodes([])}>
          <RecoveryCodes codes={codes} done={() => setCodes([])} />
        </Modal>
      )}
      {removing && (
        <ConfirmDialog
          title={removing.last ? 'Turn off two-step sign-in?' : 'Remove sign-in method?'}
          confirm={removing.last ? 'Turn off' : 'Remove'}
          tone={removing.last ? 'danger' : 'primary'}
          busy={action.busy}
          onCancel={() => setRemoving(undefined)}
          onConfirm={() =>
            run(async () => {
              const route =
                removing.kind === 'passkey'
                  ? `/api/auth/security/passkeys/${removing.id}/remove`
                  : '/api/auth/security/authenticator/remove';
              await api(route, {});
              setRemoving(undefined);
            })
          }
        >
          {removing.last
            ? 'Your account will return to password-only sign-in. Recovery codes will be invalidated and other sessions signed out.'
            : 'Other sessions will be signed out. Your remaining sign-in methods will keep working.'}
        </ConfirmDialog>
      )}
    </section>
  );
}

function AuthenticatorDialog({
  setup,
  busy,
  error,
  close,
  finish,
}: {
  setup: AuthenticatorSetup;
  busy: boolean;
  error: string;
  close: () => void;
  finish: (code: string) => void;
}) {
  return (
    <Modal title="Add authenticator app" onClose={close} dismissible={!busy}>
      <form
        className="security-form authenticator-setup"
        onSubmit={(event) => {
          event.preventDefault();
          finish(String(new FormData(event.currentTarget).get('code')));
        }}
      >
        <p>Scan this QR code, or enter the setup key manually. Then enter the current code.</p>
        <img src={setup.qrCode} alt="Authenticator app setup QR code" />
        <code>{setup.secret}</code>
        <label>
          6-digit code
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            minLength={6}
            maxLength={6}
            required
          />
        </label>
        <ErrorBox message={error} />
        <div className="form-actions">
          <button className="primary" disabled={busy}>
            {busy ? 'Verifying…' : 'Verify and add'}
          </button>
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
