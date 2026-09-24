import { api } from '../../app/api.js';
import { useAction } from '../../app/useAction.js';
import { navigate, signInHash } from '../../app/navigation.js';
import { ErrorBox, Modal } from '../../ui/index.js';

export function PasswordDialog({ close }: { close: () => void }) {
  const action = useAction(
    async (form: FormData) => {
      if (form.get('password') !== form.get('confirmPassword'))
        throw new Error('The new passwords must match.');
      await api('/api/auth/password', {
        currentPassword: form.get('currentPassword'),
        password: form.get('password'),
      });
      navigate(signInHash);
      location.reload();
    },
    { inline: true },
  );
  return (
    <Modal title="Change password" onClose={close} dismissible={!action.busy}>
      <form
        className="security-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(new FormData(event.currentTarget));
        }}
      >
        <label>
          Current password
          <input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            maxLength={128}
            required
            disabled={action.busy}
          />
        </label>
        <div className="security-password-fields">
          <label>
            New password
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
              disabled={action.busy}
            />
          </label>
          <label>
            Confirm password
            <input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
              disabled={action.busy}
            />
          </label>
        </div>
        <p className="muted">Changing your password signs out all sessions.</p>
        <ErrorBox message={action.error} />
        <div className="form-actions">
          <button type="submit" className="primary" disabled={action.busy}>
            {action.busy ? 'Saving…' : 'Save password'}
          </button>
          <button type="button" className="security-quiet" disabled={action.busy} onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
