import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";

export default function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <div className="app-shell">
    <header className="app-topbar">
      <Link className="brand" href="/" aria-label="Kudu home" data-testid="link-kudu-home">
        <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span>KUDU</span>
      </Link>
      <nav className="primary-nav" aria-label="Primary navigation">
        <Link href="/" aria-current={location === "/" ? "page" : undefined} data-testid="nav-home">Status</Link>
        <Link href="/assets" aria-current={location.startsWith("/assets") ? "page" : undefined} data-testid="nav-assets">Assets</Link>
        <Link href="/data-sources" aria-current={location.startsWith("/data-sources") ? "page" : undefined} data-testid="nav-data-sources">Data sources</Link>
        <Link href="/events" aria-current={location.startsWith("/events") ? "page" : undefined} data-testid="nav-events">Events</Link>
      </nav>
      <div className="environment"><span className="environment-dot" /> LOCAL REGISTRY</div>
    </header>
    {children}
    <footer className="footer"><span>KUDU / PROJECT FOUNDATION</span><span>PRIVATE INFRASTRUCTURE. YOUR DATA.</span></footer>
  </div>;
}
