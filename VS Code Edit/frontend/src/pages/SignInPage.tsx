import { useState, type FormEvent } from "react";

export default function SignInPage({
  configured,
  checking,
  connectionError,
  onLogin,
  onRetry,
}: {
  configured: boolean | null;
  checking: boolean;
  connectionError?: string;
  onLogin: (password: string) => Promise<void>;
  onRetry: () => void;
}) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    const submittedPassword = password;
    setPassword("");
    try {
      await onLogin(submittedPassword);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="app-shell signin-shell">
    <header className="app-topbar signin-topbar">
      <div className="brand" aria-label="Kudu">
        <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span>KUDU</span>
      </div>
      <div className="environment"><span className="environment-dot" /> PRIVATE REGISTRY</div>
    </header>
    <main className="page-main signin-main">
      <section className="panel signin-panel">
        <div className="eyebrow"><span className="eyebrow-line" /> OPERATOR ACCESS</div>
        <h1>Sign in to Kudu</h1>
        <p className="intro">Authenticate to access the asset registry, data sources, and event records.</p>
        {checking && <p className="notice" role="status">Checking the authentication service…</p>}
        {connectionError && <div className="notice error" role="alert">
          {connectionError}
          <button className="button button-quiet" type="button" onClick={onRetry}>Retry</button>
        </div>}
        {configured === false && <div className="notice error" role="alert">
          Authentication is not configured. Set <code>KUDU_AUTH_PASSWORD_HASH</code> and <code>SESSION_SECRET</code>, then restart Kudu.
        </div>}
        {configured === true && !checking && <form className="signin-form" onSubmit={submit}>
          <label className="field">
            <span>Operator password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              required
              maxLength={1024}
              disabled={submitting}
              data-testid="input-operator-password"
            />
          </label>
          {error && <div className="notice error" role="alert" data-testid="signin-error">{error}</div>}
          <button className="button button-primary" type="submit" disabled={submitting || !password} data-testid="button-sign-in">
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>}
        <p className="field-hint">Sessions expire after 8 hours. The health checks remain available without signing in.</p>
      </section>
    </main>
    <footer className="footer"><span>KUDU / PROJECT FOUNDATION</span><span>PRIVATE INFRASTRUCTURE. YOUR DATA.</span></footer>
  </div>;
}
