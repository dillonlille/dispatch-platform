import { Ellipsis, Lock } from 'lucide-react';
import type { DspView, Role } from '../../../../shared/contracts/index.js';
import { DataState, Empty } from '../../ui/index.js';
import { can, permissionLabels } from '../../app/permissions.js';
import { assignable } from './assignable.js';

const visible = 2;

function PermissionSummary({ role }: { role: Role }) {
  if (role.owner) return <span className="muted">All permissions</span>;
  if (!role.permissions.length) return <span className="muted">No permissions</span>;
  const names = role.permissions.map((p) => permissionLabels[p]);
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
  const manage = can(view, 'roles.manage');
  return (
    <DataState data={roles}>
      {(roles) => (
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
      )}
    </DataState>
  );
}
