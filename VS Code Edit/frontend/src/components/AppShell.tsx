import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";

export default function AppShell({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  const [location] = useLocation();
  return <div className="app-shell">
    <aside className="nav-rail">
      <Link className="brand" href="/" aria-label="KuduNS home" data-testid="link-kudu-home">
        <img src="/kuduns-mark.svg" alt="" className="brand-mark-image" /><span className="brand-name">Kudu<span>NS</span></span>
      </Link>
      <p className="brand-tagline">INDUSTRIAL DATA<br />UNIFIED NAMESPACE</p>
      <div className="rail-section-label">WORKSPACE</div>
      <nav className="primary-nav" aria-label="Primary navigation">
        <Link href="/" aria-current={location === "/" ? "page" : undefined} data-testid="nav-home"><span className="nav-glyph" aria-hidden="true">01</span>Status</Link>
        <Link href="/assets" aria-current={location.startsWith("/assets") ? "page" : undefined} data-testid="nav-assets"><span className="nav-glyph" aria-hidden="true">02</span>Assets</Link>
        <Link href="/data-sources" aria-current={location.startsWith("/data-sources") ? "page" : undefined} data-testid="nav-data-sources"><span className="nav-glyph" aria-hidden="true">03</span>Data sources</Link>
        <Link href="/events" aria-current={location.startsWith("/events") ? "page" : undefined} data-testid="nav-events"><span className="nav-glyph" aria-hidden="true">04</span>Events</Link>
        <Link href="/namespace" aria-current={location === "/namespace" ? "page" : undefined} data-testid="nav-namespace"><span className="nav-glyph" aria-hidden="true">05</span>Unified Namespace</Link>
      </nav>
      <div className="rail-bottom">
        <div className="environment"><span className="environment-dot" /> PRIVATE REGISTRY</div>
        <button className="signout-button" type="button" onClick={onLogout} data-testid="button-sign-out">Sign out</button>
      </div>
    </aside>
    <div className="workspace">
      <header className="workspace-bar"><span>OPERATIONS REGISTRY</span><span className="workspace-status">ON-PREMISES</span></header>
      <div className="workspace-content">{children}</div>
      <footer className="footer"><span>KUDUNS · INDUSTRIAL DATA</span><span>PRIVATE INFRASTRUCTURE</span></footer>
    </div>
  </div>;
}
