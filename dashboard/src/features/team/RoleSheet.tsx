import { useState } from 'react';
import {
  permissions as allPermissions,
  type DspView,
  type Permission,
  type Role,
} from '../../../../shared/contracts/index.js';
import { api } from '../../app/api.js';
import { Modal } from '../../ui/index.js';
import { can, permissionLabels } from '../../app/permissions.js';
import { useAction } from '../../app/useAction.js';

const groups: [string, Permission[]][] = [
  ['Timecard', ['timecard.view', 'timecard.manage']],
  ['Collections', ['collections.run']],
  ['Connections', ['connections.manage']],
  ['Team', ['members.invite', 'members.manage', 'roles.manage']],
  ['DSP', ['settings.manage', 'audit.view']],
];
const implied: Partial<Record<Permission, Permission>> = { 'timecard.manage': 'timecard.view' };
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
  const locked = (permission: Permission) =>
    allPermissions.some((p) => implied[p] === permission && chosen.includes(p));
  const inUse = role ? (role.members ?? 0) + (role.invitations ?? 0) > 0 : false;
  const save = useAction(
    async () => {
      await api(role ? `/api/dsp/roles/${role.id}` : '/api/dsp/roles', {
        name,
        permissions: allPermissions.filter((p) => chosen.includes(p)),
      });
      close();
      await saved(Boolean(role));
    },
    { success: role ? 'Role updated' : 'Role created' },
  );
  const remove = useAction(
    async () => {
      await api(`/api/dsp/roles/${role!.id}/remove`, {});
      close();
      await saved(false);
    },
    { success: 'Role deleted' },
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
    <Modal variant="sheet" title={role ? `Edit ${role.name}` : 'Create role'} onClose={close}>
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
          {role ? (
            <button
              type="button"
              className="danger"
              disabled={inUse}
              title={inUse ? 'Move this role’s members and pending invitations first.' : undefined}
              onClick={() => void remove.run()}
            >
              Delete role
            </button>
          ) : (
            <button type="button" onClick={close}>
              Cancel
            </button>
          )}
          <button className="primary">{role ? 'Save role' : 'Create role'}</button>
        </div>
      </form>
    </Modal>
  );
}
