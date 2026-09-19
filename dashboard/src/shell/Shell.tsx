import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Menu, X, ChevronDown, LogOut, Eye, type LucideIcon } from 'lucide-react';
import type { DspView, SessionView } from '../../../shared/contracts/index.js';
import { Brand } from '../app/Brand.js';
import { Popover, useFocusTrap } from '../ui/index.js';
import { dspHash, platformHash } from '../app/navigation.js';
import type { DspRouteId, PlatformRouteId } from '../app/routes.js';
import { ViewRoleMenu } from './ViewRoleMenu.js';

export function Shell({
  session,
  view,
  dspId,
  page,
  current,
  label,
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
  /** The navigation item the open page belongs to. */
  current: string;
  label: string;
  navigation: readonly { id: string; label: string; icon?: LucideIcon }[];
  logout: () => void;
  exitView: () => void;
  viewAs: (roleId?: string) => void;
  children: ReactNode;
}) {
  const [mobile, setMobile] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const name = `${session.user.firstName} ${session.user.lastName}`;
  const workspace = view?.dsp.name ?? (session.user.platformOwner ? 'Platform' : 'Workspace');
  useEffect(() => {
    document.title = `${label} · Dispatch`;
  }, [label]);
  // Navigation closes the drawer; a DSP view that finishes loading behind it does not.
  useEffect(() => setMobile(false), [page, dspId]);
  useFocusTrap(sidebar, { active: mobile, onEscape: () => setMobile(false) });
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
              href={dspId ? dspHash(dspId, id as DspRouteId) : platformHash(id as PlatformRouteId)}
              className="nav-item"
              aria-current={current === id ? 'page' : undefined}
              onClick={() => setMobile(false)}
            >
              {Icon && <Icon aria-hidden="true" />}
              <span>{itemLabel}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-account">
          <Popover
            className="account-menu"
            triggerClassName="account-button"
            label="Account menu"
            trigger={
              <>
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
              </>
            }
          >
            <a href={dspId ? dspHash(dspId, 'settings') : platformHash('account')}>
              Account settings
            </a>
            {!session.user.platformOwner && session.dsps.length > 1 && (
              <a href={platformHash()}>Switch DSP</a>
            )}
            <button onClick={logout}>
              <LogOut size={16} />
              Sign out
            </button>
          </Popover>
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
