import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Menu, X, Check, ChevronDown, LogOut, Eye, type LucideIcon } from 'lucide-react';
import type { DspView, SessionView } from '../../shared/contracts/index.js';
import { Brand } from './brand.js';
import { title } from './ui.js';

// Lets a platform owner look through any role the DSP has, custom ones included.
function ViewRoleMenu({ view, viewAs }: { view: DspView; viewAs: (roleId?: string) => void }) {
  const details = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!details.current?.contains(event.target as Node)) details.current!.open = false;
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  const current = (role: { id: string; owner: boolean }) =>
    view.role.owner ? role.owner : role.id === view.role.id;
  return (
    <details
      ref={details}
      className="view-role-menu"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      }}
    >
      <summary aria-label="View as role">
        {view.roles?.find(current)?.name ?? view.role.name}
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="account-popover">
        {view.roles?.map((role) => (
          <button
            key={role.id}
            aria-current={current(role) || undefined}
            onClick={() => {
              details.current!.open = false;
              if (!current(role)) viewAs(role.owner ? undefined : role.id);
            }}
          >
            <span>{role.name}</span>
            {current(role) && <Check size={16} aria-hidden="true" />}
          </button>
        ))}
      </div>
    </details>
  );
}

export function Shell({
  session,
  view,
  dspId,
  page,
  navigation,
  logout,
  exitView,
  viewAs,
  children,
}: {
  session: SessionView;
  view?: DspView;
  dspId?: string;
  page: string;
  navigation: { id: string; label: string; icon: LucideIcon }[];
  logout: () => void;
  exitView: () => void;
  viewAs: (roleId?: string) => void;
  children: ReactNode;
}) {
  const [mobile, setMobile] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const name = `${session.user.firstName} ${session.user.lastName}`;
  const workspace = view?.dsp.name ?? (session.user.platformOwner ? 'Platform' : 'Workspace');
  const label =
    navigation.find((item) => item.id === page)?.label ??
    ({
      'paycom-settings': 'Timecard',
      account: 'Settings',
      jobs: 'Diagnostics',
    }[page] ||
      title(page));
  useEffect(() => {
    document.title = `${label} · Dispatch`;
    setMobile(false);
  }, [label, page, view?.dsp.id]);
  useEffect(() => {
    if (!mobile) return;
    const before = document.body.style.overflow;
    const previousFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    const focusable = () =>
      Array.from(
        sidebar.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), summary') ??
          [],
      ).filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobile(false);
      if (event.key === 'Tab') {
        const elements = focusable();
        const first = elements[0],
          last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.body.style.overflow = before;
      document.removeEventListener('keydown', key);
      previousFocus?.focus();
    };
  }, [mobile]);
  return (
    <div className="application">
      <a
        href="#main-content"
        className="skip-link"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to content
      </a>
      {mobile && (
        <button
          className="navigation-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        ref={sidebar}
        className={`desktop-sidebar ${mobile ? 'navigation-open' : ''}`}
        role={mobile ? 'dialog' : undefined}
        aria-modal={mobile || undefined}
        aria-label={mobile ? 'Navigation' : undefined}
      >
        <div className="sidebar-brand">
          <Brand />
          <p>{workspace}</p>
        </div>
        <button
          className="mobile-navigation-close icon-button"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        >
          <X size={18} />
        </button>
        <nav className="nav-list" aria-label="Primary navigation">
          {navigation.map(({ id, label: itemLabel, icon: Icon }) => (
            <a
              key={id}
              href={`#${dspId ? `dsp/${dspId}/` : ''}${id}`}
              className="nav-item"
              aria-current={
                page === id || (id === 'paycom' && page === 'paycom-settings') ? 'page' : undefined
              }
              onClick={() => setMobile(false)}
            >
              <Icon aria-hidden="true" />
              <span>{itemLabel}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-account">
          <details
            className="account-menu"
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.currentTarget.open = false;
            }}
          >
            <summary className="account-button" aria-label="Account menu">
              <span className="avatar">
                {session.user.firstName[0]}
                {session.user.lastName[0]}
              </span>
              <span className="account-copy">
                <strong>{name}</strong>
                <span>
                  {session.user.platformOwner
                    ? `Platform owner${view ? ' · Viewing DSP' : ''}`
                    : view
                      ? view.role.name
                      : 'Team member'}
                </span>
              </span>
              <ChevronDown aria-hidden="true" />
            </summary>
            <div className="account-popover">
              <a
                href={dspId ? `#dsp/${dspId}/settings` : '#account'}
                onClick={(event) => event.currentTarget.closest('details')?.removeAttribute('open')}
              >
                Account settings
              </a>
              {!session.user.platformOwner && session.dsps.length > 1 && (
                <a href="#dsps">Switch DSP</a>
              )}
              <button onClick={logout}>
                <LogOut size={16} />
                Sign out
              </button>
            </div>
          </details>
        </div>
      </aside>
      <div className="main-area" inert={mobile}>
        {view && session.user.platformOwner && (
          <div className="dsp-view-banner" role="region" aria-label="DSP viewing mode">
            <Eye aria-hidden="true" />
            <div>
              <strong>
                Viewing {view.dsp.name} as {view.role.owner ? 'DSP owner' : view.role.name}
              </strong>
              <span>
                {view.role.owner ? 'Full owner' : view.role.name} access. Changes are saved to this
                DSP.
              </span>
            </div>
            <ViewRoleMenu view={view} viewAs={viewAs} />
            <button onClick={exitView}>Exit view</button>
          </div>
        )}
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            aria-label="Open navigation"
            onClick={() => setMobile(true)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            <span>{workspace}</span>
            <span aria-hidden="true">/</span>
            <strong>{label}</strong>
          </div>
        </header>
        <main id="main-content" className="page-container" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
