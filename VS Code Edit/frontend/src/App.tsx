import { Link, Route, Switch } from "wouter";
import AppShell from "./components/AppShell";
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
  return <AppShell><Switch>
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
