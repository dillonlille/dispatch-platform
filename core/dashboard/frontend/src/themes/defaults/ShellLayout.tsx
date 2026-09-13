import type { ShellLayoutProps } from "../types.ts";

export function DefaultShellLayout({
  navigation,
  mobileNavigation,
  banner,
  header,
  children,
}: ShellLayoutProps) {
  return (
    <div className="application">
      <aside className="desktop-sidebar">{navigation}</aside>
      {mobileNavigation}
      <div className="main-area">
        {banner}
        <header className="topbar">{header}</header>
        <main id="main-content" className="page-container" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
