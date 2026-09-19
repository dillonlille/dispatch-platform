import { Check, ChevronDown } from 'lucide-react';
import type { DspView } from '../../../shared/contracts/index.js';
import { Popover } from '../ui/index.js';

// Lets a platform owner look through any role the DSP has, custom ones included.
export function ViewRoleMenu({
  view,
  viewAs,
}: {
  view: DspView;
  viewAs: (roleId?: string) => void;
}) {
  const current = (role: { id: string; owner: boolean }) =>
    view.role.owner ? role.owner : role.id === view.role.id;
  return (
    <Popover
      className="view-role-menu"
      label="View as role"
      trigger={
        <>
          {view.roles?.find(current)?.name ?? view.role.name}
          <ChevronDown aria-hidden="true" />
        </>
      }
    >
      {view.roles?.map((role) => (
        <button
          key={role.id}
          aria-current={current(role) || undefined}
          onClick={() => {
            if (!current(role)) viewAs(role.owner ? undefined : role.id);
          }}
        >
          <span>{role.name}</span>
          {current(role) && <Check size={16} aria-hidden="true" />}
        </button>
      ))}
    </Popover>
  );
}
