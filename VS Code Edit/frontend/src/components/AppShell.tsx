import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";

export default function AppShell({
  children,
  onLogout,
  localMode = false,
}: {
  children: ReactNode;
  onLogout: () => void;
  localMode?: boolean;
}) {
  const [location] = useLocation();
  return <div className="app-shell">
    <aside className="nav-rail">
      <Link className="brand" href="/" aria-label="KuduNS home" data-testid="link-kudu-home">
        <img src="/kuduns-mark.svg" alt="" className="brand-mark-image" /><span className="brand-name">Kudu<span>NS</span></span>
      </Link>
      <p className="brand-tagline">INDUSTRIAL DATA<br />UNIFIED NAMESPACE</p>
      <div className="rail-section-label">WORKSPACE</div>
      <nav className="primary-nav" aria-label="Primary navigation">
        <Link href="/data-sources" aria-current={location.startsWith("/data-sources") ? "page" : undefined} data-testid="nav-data-sources">Data sources</Link>
        <Link href="/data-explorer" aria-current={location.startsWith("/data-explorer") ? "page" : undefined} data-testid="nav-data-explorer">Data explorer</Link>
        <Link href="/visualisations" aria-current={location.startsWith("/visualisations") ? "page" : undefined} data-testid="nav-visualisations">Visualisations</Link>
        {localMode && <Link href="/settings" aria-current={location === "/settings" ? "page" : undefined} data-testid="nav-settings">Settings</Link>}
      </nav>
      <div className="rail-bottom">
        <div className="environment"><span className="environment-dot" /> {localMode ? "LOCAL · NO LOGIN" : "PRIVATE REGISTRY"}</div>
        {!localMode && <button className="signout-button" type="button" onClick={onLogout} data-testid="button-sign-out">Sign out</button>}
      </div>
    </aside>
    <div className="workspace">
      <header className="workspace-bar"><span>OPERATIONS REGISTRY</span><span className="workspace-status">{localMode ? "LOCAL" : "ON-PREMISES"}</span></header>
      <div className="workspace-content">{children}</div>
      <footer className="footer"><span>KUDUNS · INDUSTRIAL DATA</span><span>PRIVATE INFRASTRUCTURE</span></footer>
    </div>
  </div>;
}
