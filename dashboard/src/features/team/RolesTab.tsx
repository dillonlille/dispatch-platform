import { Ellipsis, Lock } from 'lucide-react';
import type { DspView, Role } from '../../../../shared/contracts/index.js';
import { DataState, DataTable, Empty, useDataTable, type TableColumn } from '../../ui/index.js';
import { can, permissionLabels } from '../../app/permissions.js';
import { assignable } from './assignable.js';

const visible = 2;
const none: Role[] = [];

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
  const columns: TableColumn<Role>[] = [
    {
      id: 'role',
      header: 'Role',
      headerClassName: 'role-name-column',
      hideable: false,
      value: (role) => role.name,
      cell: (role) => (
        <strong className="role-name">
          {role.name}
          {role.owner && <Lock size={14} aria-label="Locked" />}
        </strong>
      ),
    },
    {
      id: 'permissions',
      header: 'Permissions',
      cell: (role) => <PermissionSummary role={role} />,
    },
    {
      id: 'members',
      header: 'Members',
      headerClassName: 'role-members-column',
      className: 'muted',
      value: (role) => role.members,
      cell: (role) => role.members,
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      name: 'Actions',
      hideable: false,
      cell: (role) =>
        manage &&
        !role.owner &&
        assignable(view, role) && (
          <button
            className="icon-button"
            aria-label={`Edit ${role.name}`}
            onClick={() => edit(role)}
          >
            <Ellipsis size={18} />
          </button>
        ),
    },
  ];
  const table = useDataTable({ columns, rows: roles ?? none, rowId: (role) => role.id });
  return (
    <DataState data={roles}>
      {(roles) => (
        <div className="table-wrap role-table">
          <DataTable table={table} />
          {!roles.length && <Empty title="No roles" />}
        </div>
      )}
    </DataState>
  );
}
