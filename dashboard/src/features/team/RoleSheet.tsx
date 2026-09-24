import { useState } from 'react';
import {
  permissions as allPermissions,
  type DspView,
  type Permission,
  type Role,
} from '../../../../shared/contracts/index.js';
import { Modal } from '../../ui/index.js';
import {
  can,
  impliedPermissions as implied,
  permissionGroups as groups,
  permissionLabels,
} from '../../app/permissions.js';
import { useAction } from '../../app/useAction.js';
import { saveTeamRole } from '../../app/endpoints.js';

export function RoleSheet({
  view,
  role,
  close,
  saved,
}: {
  view: DspView;
  role?: Role;
  close: () => void;
  saved: (permissionsChanged: boolean) => Promise<void> | void;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [chosen, setChosen] = useState<Permission[]>(role?.permissions ?? []);
  const [confirming, setConfirming] = useState(false);
  const ordered = (permissions: Permission[]) =>
    allPermissions.filter((p) => permissions.includes(p));
  const dirty =
    name !== (role?.name ?? '') ||
    ordered(chosen).join() !== ordered(role?.permissions ?? []).join();
  // Edits leave only through Save or Discard; closing the tab drops them silently.
  const leave = () => (dirty ? setConfirming(true) : close());
  const locked = (permission: Permission) =>
    allPermissions.some((p) => implied[p] === permission && chosen.includes(p));
  const save = useAction(
    async () => {
      await saveTeamRole(role?.id, {
        name,
        permissions: allPermissions.filter((p) => chosen.includes(p)),
      });
      close();
      await saved(Boolean(role));
    },
    { success: role ? 'Role updated' : 'Role created' },
  );
  function toggle(permission: Permission, on: boolean) {
    setChosen((current) => {
      const next = current.filter((p) => p !== permission);
      if (!on) return next;
      const needs = implied[permission];
      return [...next, permission, ...(needs && !next.includes(needs) ? [needs] : [])];
    });
  }
  return (
    <Modal variant="sheet" title={role ? `Edit ${role.name}` : 'Create role'} onClose={leave}>
      <form
        className="role-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run();
        }}
      >
        <label>
          Role name
          <input
            name="name"
            required
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {groups.map(([group, items]) => (
          <fieldset className="permission-group" key={group}>
            <legend>{group}</legend>
            <div className="permission-rows">
              {items.map((permission) => (
                <label className="permission-row" key={permission}>
                  <span>
                    {permissionLabels[permission]}
                    {locked(permission) && (
                      <small>
                        Included with{' '}
                        {
                          permissionLabels[
                            allPermissions.find(
                              (p) => implied[p] === permission && chosen.includes(p),
                            )!
                          ]
                        }
                      </small>
                    )}
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={chosen.includes(permission)}
                    disabled={locked(permission) || !can(view, permission)}
                    onChange={(event) => toggle(permission, event.target.checked)}
                  />
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        <div className="form-actions">
          <button type="button" onClick={leave}>
            Cancel
          </button>
          <button className="primary">{role ? 'Save role' : 'Create role'}</button>
        </div>
      </form>
      {confirming && (
        <Modal title="Save changes?" dismissible={false} onClose={() => {}}>
          <p>This role has unsaved changes.</p>
          <div className="form-actions">
            <button type="button" onClick={close}>
              Discard changes
            </button>
            <button
              type="button"
              className="primary"
              disabled={save.busy || !name.trim()}
              onClick={async () => {
                if (!(await save.run())) setConfirming(false);
              }}
            >
              Save changes
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
