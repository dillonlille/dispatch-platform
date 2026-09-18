import { useState } from 'react';
import { Ellipsis, Lock } from 'lucide-react';
import {
  permissions as allPermissions,
  type DspView,
  type Permission,
  type Role,
} from '../../shared/contracts/index.js';
import { api } from './api.js';
import { Empty, Loading, Modal, can } from './ui.js';
import { type Perform } from './platform.js';

const labels: Record<Permission, string> = {
  'timecard.view': 'View Timecard',
  'timecard.manage': 'Manage Timecard',
  'collections.run': 'Run Collections',
  'connections.manage': 'Manage Connections',
  'members.invite': 'Invite Members',
  'members.manage': 'Manage Members',
  'roles.manage': 'Manage Roles',
  'settings.manage': 'Manage DSP Settings',
  'audit.view': 'View Audit Log',
};
const groups: [string, Permission[]][] = [
  ['Timecard', ['timecard.view', 'timecard.manage']],
  ['Collections', ['collections.run']],
  ['Connections', ['connections.manage']],
  ['Team', ['members.invite', 'members.manage', 'roles.manage']],
  ['DSP', ['settings.manage', 'audit.view']],
];
const implied: Partial<Record<Permission, Permission>> = { 'timecard.manage': 'timecard.view' };
const visible = 2;

// Nobody hands out access they do not hold; the server enforces the same rule.
export function assignable(view: DspView, role: Role) {
  return role.owner ? view.role.owner : role.permissions.every((p) => can(view, p));
}

function PermissionSummary({ role }: { role: Role }) {
  if (role.owner) return <span className="muted">All permissions</span>;
  if (!role.permissions.length) return <span className="muted">No permissions</span>;
  const names = role.permissions.map((p) => labels[p]);
  if (names.length <= visible) return <span className="muted">{names.join(', ')}</span>;
  return (
    <span
      className="permission-summary"
      tabIndex={0}
      aria-label={`${role.name} permissions: ${names.join(', ')}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.currentTarget.blur();
      }}
    >
      {names.slice(0, visible).join(', ')}
      <span className="permission-more">+{names.length - visible}</span>
      <span className="permission-card" role="tooltip">
        <ul>
          {names.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </span>
    </span>
  );
}

export function RolesTab({
  view,
  roles,
  edit,
}: {
  view: DspView;
  roles?: Role[];
  edit: (role: Role) => void;
}) {
  if (!roles) return <Loading />;
  const manage = can(view, 'roles.manage');
  return (
    <div className="table-wrap role-table">
      <table>
        <thead>
          <tr>
            <th style={{ width: '30%' }}>Role</th>
            <th>Permissions</th>
            <th style={{ width: '14%' }}>Members</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {roles.map((role) => (
            <tr key={role.id}>
              <td>
                <strong className="role-name">
                  {role.name}
                  {role.owner && <Lock size={14} aria-label="Locked" />}
                </strong>
              </td>
              <td>
                <PermissionSummary role={role} />
              </td>
              <td className="muted">{role.members}</td>
              <td>
                {manage && !role.owner && assignable(view, role) && (
                  <button
                    className="icon-button"
                    aria-label={`Edit ${role.name}`}
                    onClick={() => edit(role)}
                  >
                    <Ellipsis size={18} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!roles.length && <Empty title="No roles" />}
    </div>
  );
}

export function RoleSheet({
  view,
  role,
  perform,
  close,
  saved,
}: {
  view: DspView;
  role?: Role;
  perform: Perform;
  close: () => void;
  saved: (permissionsChanged: boolean) => Promise<void> | void;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [chosen, setChosen] = useState<Permission[]>(role?.permissions ?? []);
  const locked = (permission: Permission) =>
    allPermissions.some((p) => implied[p] === permission && chosen.includes(p));
  const inUse = role ? role.members + role.invitations > 0 : false;
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
          void perform(
            async () => {
              await api(role ? `/api/dsp/roles/${role.id}` : '/api/dsp/roles', {
                name,
                permissions: allPermissions.filter((p) => chosen.includes(p)),
              });
              close();
              await saved(Boolean(role));
            },
            role ? 'Role updated' : 'Role created',
          );
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
                    {labels[permission]}
                    {locked(permission) && (
                      <small>
                        Included with{' '}
                        {
                          labels[
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
              onClick={() =>
                void perform(async () => {
                  await api(`/api/dsp/roles/${role.id}/remove`, {});
                  close();
                  await saved(false);
                }, 'Role deleted')
              }
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
