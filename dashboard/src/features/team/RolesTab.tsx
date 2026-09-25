import { Ellipsis, Lock } from 'lucide-react';
import type { DspView, Role } from '../../../../shared/contracts/index.js';
import {
  DataState,
  DataTable,
  Empty,
  Popover,
  useDataTable,
  type TableColumn,
} from '../../ui/index.js';
import { can, permissionLabels, visiblePermissions } from '../../app/permissions.js';
import { assignable } from './assignable.js';

const visible = 2;
const none: Role[] = [];

function PermissionSummary({ view, role }: { view: DspView; role: Role }) {
  if (role.owner) return <span className="muted">All permissions</span>;
  const names = visiblePermissions(view, role.permissions).map((p) => permissionLabels[p]);
  if (!names.length) return <span className="muted">No permissions</span>;
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
  remove,
}: {
  view: DspView;
  roles?: Role[];
  edit: (role: Role) => void;
  remove: (role: Role) => void;
}) {
  const manage = can(view, 'roles.manage');
  const columns: TableColumn<Role>[] = [
    {
      id: 'role',
      header: 'Role',
      headerClassName: 'role-name-column',
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
      cell: (role) => <PermissionSummary view={view} role={role} />,
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
      cell: (role) => {
        const inUse = (role.members ?? 0) + (role.invitations ?? 0) > 0;
        return (
          manage &&
          !role.owner &&
          assignable(view, role) && (
            <Popover
              className="row-menu"
              label={`Actions for ${role.name}`}
              trigger={<Ellipsis size={18} />}
              anchored
            >
              <button onClick={() => edit(role)}>Edit role</button>
              <button
                className="danger"
                disabled={inUse}
                title={
                  inUse ? 'Move this role’s members and pending invitations first.' : undefined
                }
                onClick={() => remove(role)}
              >
                Delete role
              </button>
            </Popover>
          )
        );
      },
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
