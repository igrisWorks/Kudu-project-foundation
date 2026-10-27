import { useCallback, useEffect, useState } from "react";
import { Link, Route, Switch } from "wouter";
import { AUTH_EXPIRED_EVENT, ApiError, getAuthSession, login, logout, setCsrfToken } from "./api";
import AppShell from "./components/AppShell";
import SignInPage from "./pages/SignInPage";
import HomePage from "./pages/HomePage";
import { AssetDetailPage, AssetFormPage, AssetListPage } from "./pages/AssetsPage";
import { DataSourceDetailPage, DataSourceFormPage, DataSourceListPage } from "./pages/DataSourcesPage";
import { EventDetailPage, EventsListPage } from "./pages/EventsPage";

function NotFoundPage() {
  return <main className="page-main"><section className="not-found">
    <div className="eyebrow"><span className="eyebrow-line" />ROUTE NOT FOUND</div>
    <h1>Nothing at this address.</h1>
    <p className="intro">This registry route does not exist. Return to system status or choose a registry from navigation.</p>
    <div className="detail-actions" style={{ justifyContent: "center", marginTop: 22 }}>
      <Link href="/" className="button button-primary" data-testid="link-not-found-home">Return to status</Link>
      <Link href="/assets" className="button" data-testid="link-not-found-assets">Browse assets</Link>
    </div>
  </section></main>;
}

export default function App() {
  const [session, setSession] = useState<
    | { kind: "loading" }
    | { kind: "ready"; configured: boolean; authenticated: boolean }
    | { kind: "unavailable"; message: string }
  >({ kind: "loading" });

  const checkSession = useCallback(async () => {
    setSession({ kind: "loading" });
    try {
      const response = await getAuthSession();
      setSession({ kind: "ready", configured: response.configured, authenticated: response.authenticated });
    } catch (error) {
      setSession({
        kind: "unavailable",
        message: error instanceof ApiError ? error.message : "The Kudu API could not be reached.",
      });
    }
  }, []);

  useEffect(() => {
    void checkSession();
    const onExpired = () => {
      setCsrfToken(null);
      setSession({ kind: "ready", configured: true, authenticated: false });
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, [checkSession]);

  const handleLogin = async (password: string) => {
    const response = await login(password);
    if (!response.authenticated) throw new Error("Sign in was not completed.");
    setSession({ kind: "ready", configured: true, authenticated: true });
  };

  const handleLogout = async () => {
    try {
      await logout();
      setSession({ kind: "ready", configured: true, authenticated: false });
    } catch {
      setSession({ kind: "unavailable", message: "Sign out could not be confirmed. Reconnect and retry." });
    } finally {
      setCsrfToken(null);
    }
  };

  if (session.kind !== "ready" || !session.authenticated) {
    return <SignInPage
      configured={session.kind === "ready" ? session.configured : null}
      checking={session.kind === "loading"}
      connectionError={session.kind === "unavailable" ? session.message : undefined}
      onLogin={handleLogin}
      onRetry={() => void checkSession()}
    />;
  }

  return <AppShell onLogout={() => void handleLogout()}><Switch>
    <Route path="/" component={HomePage} />
    <Route path="/assets" component={AssetListPage} />
    <Route path="/assets/new"><AssetFormPage editing={false} /></Route>
    <Route path="/assets/:id/edit"><AssetFormPage editing /></Route>
    <Route path="/assets/:id"><AssetDetailPage /></Route>
    <Route path="/data-sources" component={DataSourceListPage} />
    <Route path="/data-sources/new"><DataSourceFormPage editing={false} /></Route>
    <Route path="/data-sources/:id/edit"><DataSourceFormPage editing /></Route>
    <Route path="/data-sources/:id"><DataSourceDetailPage /></Route>
    <Route path="/events" component={EventsListPage} />
    <Route path="/events/:id" component={EventDetailPage} />
    <Route><NotFoundPage /></Route>
  </Switch></AppShell>;
}
