import { useState } from 'react';
import { RefreshCw, Plus, Ellipsis } from 'lucide-react';
import type { DspView, Membership, Role } from '../../../../shared/contracts/index.js';
import { api, useData } from '../../app/api.js';
import {
  Badge,
  ConfirmDialog,
  DataState,
  Empty,
  ErrorBox,
  Header,
  Modal,
  SearchInput,
  Tabs,
} from '../../ui/index.js';
import { time } from '../../lib/format.js';
import { can } from '../../app/permissions.js';
import { useAction } from '../../app/useAction.js';
import { RoleSheet } from './RoleSheet.js';
import { RolesTab } from './RolesTab.js';
import { assignable } from './assignable.js';

type Invitation = { email: string; role: string; expiresAt: number; accepted: boolean };
export function TeamPage({ view, reopen }: { view: DspView; reopen: () => Promise<void> }) {
  const { data, error, refresh } = useData<Membership[]>('/api/dsp/members', 10000);
  const canInvite = can(view, 'members.invite'),
    canManage = can(view, 'members.manage'),
    canRoles = can(view, 'roles.manage');
  const invitations = useData<Invitation[]>(canInvite ? '/api/dsp/invitations' : '', 10000);
  const roles = useData<Role[]>('/api/dsp/roles', 10000);
  const [roleEditor, setRoleEditor] = useState<Role | 'new'>();
  const grantable = roles.data?.filter((role) => assignable(view, role)) ?? [];
  const [tab, setTab] = useState('members');
  const [search, setSearch] = useState('');
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Membership>();
  const [removing, setRemoving] = useState(false);
  const [revoking, setRevoking] = useState<Invitation>();
  const revoke = useAction(
    async (invitation: Invitation) => {
      await api('/api/dsp/invitations/revoke', { email: invitation.email });
      setRevoking(undefined);
      invitations.refresh();
    },
    { success: 'Invitation revoked' },
  );
  const invite = useAction(
    async (form: FormData) => {
      await api('/api/dsp/members/invite', { email: form.get('email'), role: form.get('role') });
      setInviting(false);
      invitations.refresh();
      roles.refresh();
    },
    { success: (form) => `Invitation email queued for ${form.get('email')}` },
  );
  // A null role removes the member.
  const assign = useAction(
    async (member: Membership, role: FormDataEntryValue | null) => {
      await api(`/api/dsp/members/${member.id}`, { role });
      setEditing(undefined);
      await reopen();
      refresh();
    },
    { success: (_, role) => (role === null ? 'Member removed' : 'Role updated') },
  );
  const members =
    data?.filter((member) =>
      `${member.name} ${member.email}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  return (
    <>
      <Header title="Team & Roles">
        {tab === 'roles' && canRoles ? (
          <button className="primary" onClick={() => setRoleEditor('new')}>
            <Plus size={16} />
            Create role
          </button>
        ) : (
          canInvite && (
            <button className="primary" onClick={() => setInviting(true)}>
              <Plus size={16} />
              Invite member
            </button>
          )
        )}
      </Header>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ['members', 'Members'],
          ['roles', 'Roles'],
          ...(canInvite ? [['invitations', 'Invitations']] : []),
        ]}
        label="Team"
      />
      <ErrorBox message={error || roles.error || invitations.error} />
      {tab === 'members' && (
        <>
          <div className="table-toolbar">
            <SearchInput
              label="Search members"
              placeholder="Search members"
              value={search}
              onChange={setSearch}
            />
            <button className="icon-button" aria-label="Refresh members" onClick={refresh}>
              <RefreshCw size={16} />
            </button>
          </div>
          <DataState data={data}>
            {() => (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: '45%' }}>Member</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((member) => (
                      <tr key={member.id}>
                        <td>
                          <div className="member-identity">
                            <span className="avatar">
                              {member.name
                                .split(/\s+/)
                                .slice(0, 2)
                                .map((part) => part[0])
                                .join('')}
                            </span>
                            <div>
                              <strong>{member.name}</strong>
                              <small>{member.email}</small>
                            </div>
                          </div>
                        </td>
                        <td>{member.role}</td>
                        <td>
                          <Badge value={member.status} />
                        </td>
                        <td>
                          {canManage && grantable.some((role) => role.id === member.roleId) && (
                            <button
                              className="icon-button"
                              aria-label={`Edit ${member.name}`}
                              onClick={() => {
                                setRemoving(false);
                                setEditing(member);
                              }}
                            >
                              <Ellipsis size={18} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!members.length && (
                  <Empty title="No team members">
                    Invite a member to give them access to this DSP.
                  </Empty>
                )}
              </div>
            )}
          </DataState>
        </>
      )}
      {tab === 'roles' && <RolesTab view={view} roles={roles.data} edit={setRoleEditor} />}
      {roleEditor && (
        <RoleSheet
          view={view}
          role={roleEditor === 'new' ? undefined : roleEditor}
          close={() => setRoleEditor(undefined)}
          saved={async (permissionsChanged) => {
            if (permissionsChanged) await reopen();
            roles.refresh();
            refresh();
          }}
        />
      )}
      {tab === 'invitations' && canInvite && (
        <>
          <div className="table-toolbar">
            <p className="muted">Pending invitations to your DSP.</p>
            <button
              className="icon-button"
              aria-label="Refresh invitations"
              onClick={invitations.refresh}
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email address</th>
                  <th>Role</th>
                  <th>Expires</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invitations.data
                  ?.filter(
                    (invitation) => !invitation.accepted && invitation.expiresAt > Date.now(),
                  )
                  .map((invitation, index) => (
                    <tr key={`${invitation.email}:${index}`}>
                      <td>{invitation.email}</td>
                      <td>{invitation.role}</td>
                      <td>
                        {time(new Date(invitation.expiresAt).toISOString(), view.dsp.timezone)}
                      </td>
                      <td>
                        <button
                          className="text-button"
                          aria-label={`Revoke invitation for ${invitation.email}`}
                          onClick={() => setRevoking(invitation)}
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {(invitations.data?.filter(
              (invitation) => !invitation.accepted && invitation.expiresAt > Date.now(),
            ).length ?? 0) === 0 && (
              <Empty title="No invitations">Invite a team member to get started.</Empty>
            )}
          </div>
        </>
      )}
      {revoking && (
        <ConfirmDialog
          title="Revoke invitation"
          confirm="Revoke invitation"
          onConfirm={() => void revoke.run(revoking)}
          onCancel={() => setRevoking(undefined)}
        >
          Revoke the pending invitation for {revoking.email}? Its link will stop working.
        </ConfirmDialog>
      )}
      {inviting && (
        <Modal
          variant="sheet"
          title="Invite member"
          description={`Give someone access to ${view.dsp.name}.`}
          onClose={() => setInviting(false)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void invite.run(new FormData(event.currentTarget));
            }}
          >
            <label>
              Email address
              <input name="email" type="email" required />
            </label>
            <label>
              Role
              <select
                name="role"
                required
                defaultValue={
                  (grantable.find((role) => role.name === 'Member') ?? grantable.at(-1))?.id
                }
              >
                {grantable.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-actions">
              <button type="button" onClick={() => setInviting(false)}>
                Cancel
              </button>
              <button className="primary">Send invitation</button>
            </div>
          </form>
        </Modal>
      )}
      {editing && (
        <Modal variant="sheet" title={`Edit ${editing.name}`} onClose={() => setEditing(undefined)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void assign.run(editing, new FormData(event.currentTarget).get('role'));
            }}
          >
            <label>
              Role
              <select name="role" defaultValue={editing.roleId ?? undefined}>
                {grantable.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
            {removing ? (
              <div className="form-actions" role="group" aria-label="Remove member confirmation">
                <span>Remove {editing.name} and delete their account?</span>
                <button type="button" onClick={() => setRemoving(false)}>
                  Keep member
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => void assign.run(editing, null)}
                >
                  Remove member
                </button>
              </div>
            ) : (
              <div className="form-actions">
                <button type="button" className="danger" onClick={() => setRemoving(true)}>
                  Remove member
                </button>
                <button className="primary">Save role</button>
              </div>
            )}
          </form>
        </Modal>
      )}
    </>
  );
}
