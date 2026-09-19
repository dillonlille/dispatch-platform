import { BrowserVerification } from './BrowserVerification.js';
import { useState, type FormEvent } from 'react';
import { Plug, RefreshCw } from 'lucide-react';
import type { Connection } from '../../../../shared/contracts/index.js';
import { api, useData } from '../../app/api.js';
import { Badge, ConfirmDialog, DataState, ErrorBox, Modal } from '../../ui/index.js';
import { time, title } from '../../lib/format.js';
import { messageOf } from '../../lib/errors.js';
import { useAction } from '../../app/useAction.js';

export function ConnectionCard({
  development,
  provider,
  timezone,
}: {
  development: boolean;
  provider: Connection['provider'];
  timezone: string;
}) {
  const name = provider === 'paycom' ? 'Paycom' : 'Cortex';
  const endpoint = `/api/dsp/connections/${provider}`;
  const { data, error, refresh } = useData<Connection>(
    provider === 'paycom' ? '/api/dsp/connections' : endpoint,
    4000,
  );
  const [disconnecting, setDisconnecting] = useState(false);
  const [credentialError, setCredentialError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [editing, setEditing] = useState(false),
    [closedVerification, setClosedVerification] = useState<string>();
  const connect = useAction(
    async (credentials: Record<string, unknown>) => {
      try {
        await api(endpoint, credentials);
      } catch (error) {
        setSaveError(messageOf(error));
        throw error;
      } finally {
        refresh();
      }
    },
    { success: 'Connection saved' },
  );
  const verify = useAction(
    async (code: FormDataEntryValue | null) => {
      await api(`${endpoint}/verify`, { code });
      refresh();
    },
    { success: 'Verification submitted' },
  );
  const check = useAction(
    async () => {
      await api(`${endpoint}/check`, {});
      refresh();
    },
    { success: 'Connection checked' },
  );
  const disconnect = useAction(
    async () => {
      await api(`${endpoint}/disable`, { removeCredentials: true });
      refresh();
      setDisconnecting(false);
    },
    { success: () => `${name} disconnected` },
  );
  const saving = connect.busy,
    busy = connect.busy || disconnect.busy;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const securityAnswers = [1, 2, 3, 4, 5].map((number) => String(form.get(`pin${number}`) ?? ''));
    if (provider === 'paycom' && new Set(securityAnswers).size !== 5) {
      setCredentialError('Enter five distinct security PINs in their original Paycom numbering.');
      return;
    }
    setCredentialError('');
    setSaveError('');
    event.currentTarget.reset();
    setEditing(false);
    setClosedVerification(data?.verificationSessionId);
    await connect.run({
      ...(provider === 'paycom' ? { clientCode: form.get('clientCode'), securityAnswers } : {}),
      username: form.get('username'),
      password: form.get('password'),
    });
  }
  return (
    <>
      <DataState data={data} error={error}>
        {(data) => (
          <article className="archived-connection-card">
            <header>
              <h3>
                <Plug size={20} />
                {name}
              </h3>
            </header>
            <div className="archived-connection-content">
              <div role="status">
                <Badge value={saving ? 'signing_in' : data.status} />
              </div>
              <p className="muted">
                {saving
                  ? `Signing in to ${name}…`
                  : data.status === 'ready'
                    ? `Your ${name} connection is ready to use.`
                    : data.enabled
                      ? 'Test your connection or update the saved credentials.'
                      : `Connect your ${name} account to get started.`}
              </p>
              {!saving && <ErrorBox message={saveError || (data.error ? title(data.error) : '')} />}
              {!saving && data.status === 'needs_verification' && (
                <div className="verification">
                  <h3>
                    {provider === 'cortex'
                      ? 'Finish signing in to Cortex'
                      : 'Paycom needs your verification'}
                  </h3>
                  <p>
                    {data.verificationSessionId
                      ? 'Complete the verification in the browser window, then press Submit to continue.'
                      : 'Enter the verification code from your provider.'}
                  </p>
                  {data.verificationSessionId ? (
                    <button type="button" onClick={() => setClosedVerification(undefined)}>
                      Open verification window
                    </button>
                  ) : (
                    <form
                      className="inline-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void verify.run(new FormData(event.currentTarget).get('code'));
                      }}
                    >
                      <input
                        name="code"
                        aria-label="Verification code"
                        autoComplete="one-time-code"
                        required
                        maxLength={128}
                      />
                      <button className="primary">Verify</button>
                    </form>
                  )}
                  {development && !data.verificationSessionId && (
                    <small>Synthetic fixture verification code: 123456.</small>
                  )}
                </div>
              )}

              {data.lastVerifiedAt && (
                <p className="muted">Last checked: {time(data.lastVerifiedAt, timezone)}</p>
              )}
            </div>
            <footer>
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  setCredentialError('');
                  setEditing(true);
                }}
              >
                {data.enabled ? 'Update credentials' : `Connect ${name}`}
              </button>
              {data.enabled && (
                <>
                  <button
                    disabled={
                      busy || data.status === 'signing_in' || data.status === 'needs_verification'
                    }
                    onClick={() => {
                      setSaveError('');
                      void check.run();
                    }}
                  >
                    <RefreshCw size={16} />
                    Test connection
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => setDisconnecting(true)}
                  >
                    Disconnect
                  </button>
                </>
              )}
            </footer>
          </article>
        )}
      </DataState>
      {disconnecting && (
        <ConfirmDialog
          title={`Disconnect ${name}?`}
          confirm="Disconnect"
          busy={busy}
          onConfirm={() => {
            setSaveError('');
            void disconnect.run();
          }}
          onCancel={() => setDisconnecting(false)}
        >
          Features will lose access to this service until you reconnect. Previously collected data
          will remain available.
        </ConfirmDialog>
      )}
      {editing && (
        <Modal title={`${name} credentials`} onClose={() => setEditing(false)}>
          <p className="muted">
            Enter the account your DSP uses. Saved credentials are encrypted and are never displayed
            here.
          </p>
          {development && (
            <div className="notice">
              Development uses synthetic data. Use any test credentials; use password
              “require-verification” to exercise verification.
            </div>
          )}
          <form onSubmit={(event) => void save(event)} onInput={() => setCredentialError('')}>
            {provider === 'paycom' && (
              <label>
                Client code
                <input
                  name="clientCode"
                  required
                  maxLength={80}
                  autoComplete="off"
                  defaultValue={data?.accountLabel ?? ''}
                />
              </label>
            )}
            <label>
              {provider === 'cortex' ? 'Email address' : 'Username'}
              <input
                name="username"
                type={provider === 'cortex' ? 'email' : 'text'}
                required
                maxLength={200}
                autoComplete="off"
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                required
                maxLength={256}
                autoComplete="new-password"
              />
            </label>
            {provider === 'paycom' &&
              [1, 2, 3, 4, 5].map((number) => (
                <label key={number}>
                  PIN {number}
                  <input
                    name={`pin${number}`}
                    type="password"
                    required
                    maxLength={64}
                    autoComplete="off"
                  />
                </label>
              ))}
            {provider === 'paycom' && (
              <p className="muted">
                Enter all five distinct security answers in the order configured for your Paycom
                account.
              </p>
            )}
            <ErrorBox message={credentialError} />
            <div className="form-actions">
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save credentials'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {data?.verificationSessionId &&
        closedVerification !== data.verificationSessionId &&
        !editing &&
        !saving &&
        !disconnecting && (
          <BrowserVerification
            key={data.verificationSessionId}
            sessionId={data.verificationSessionId}
            provider={provider}
            close={() => {
              setClosedVerification(data.verificationSessionId);
              refresh();
            }}
          />
        )}
    </>
  );
}
