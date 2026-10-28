import { useEffect, useState } from "react";
import type { FormEvent } from "react";

export default function DesktopConnectionPage() {
  const [serverUrl, setServerUrl] = useState("");
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [showLocalGuidance, setShowLocalGuidance] = useState(false);
  const [localModeInfo, setLocalModeInfo] = useState<DesktopLocalModeInfo | null>(null);
  const isHttp = serverUrl.trim().toLowerCase().startsWith("http://");

  useEffect(() => {
    let active = true;
    if (window.kuduDesktop) {
      void window.kuduDesktop.getLocalModeInfo().then((info) => {
        if (active) setLocalModeInfo(info);
      }).catch(() => {});
    }
    return () => { active = false; };
  }, []);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("");
    setBusy(true);
    try {
      if (!window.kuduDesktop) {
        setStatus("Open this screen in the KuduNS desktop application to connect.");
        return;
      }
      const result = await window.kuduDesktop.connectServer({
        url: serverUrl,
        allowInsecureHttp,
      });
      if (result.status === "cancelled") {
        setStatus("Connection cancelled.");
      } else if (result.status === "error") {
        setStatus(result.message ?? "The server connection could not be completed.");
      }
    } catch {
      setStatus("The connection could not be completed. Check the server address and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="desktop-shell">
      <section className="desktop-panel" aria-labelledby="desktop-title">
        <header className="desktop-brand">
          <img src="./kuduns-wordmark.svg" alt="KuduNS" />
          <span className="desktop-edition">DESKTOP</span>
        </header>

        <div className="desktop-intro">
          <div className="desktop-eyebrow"><span /> CONNECTION SETUP</div>
          <h1 id="desktop-title">Connect to your KuduNS</h1>
          <p>
            Choose an on-premises server to open the existing KuduNS workspace.
            Your usual sign-in and server-side session security remain in place.
          </p>
        </div>

        <form className="server-form" onSubmit={connect}>
          <label htmlFor="server-url">KuduNS server address</label>
          <input
            id="server-url"
            name="server-url"
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            placeholder="https://kudu.example.local"
            value={serverUrl}
            onChange={(event) => {
              setServerUrl(event.target.value);
              if (!event.target.value.trim().toLowerCase().startsWith("http://")) {
                setAllowInsecureHttp(false);
              }
              setStatus("");
            }}
            required
          />
          <p className="desktop-hint">Enter the server base address, without a page path.</p>

          {isHttp && (
            <label className="http-acknowledgement">
              <input
                type="checkbox"
                checked={allowInsecureHttp}
                onChange={(event) => setAllowInsecureHttp(event.target.checked)}
              />
              <span>
                I understand HTTP is unencrypted and will use it only on a trusted
                local or isolated LAN connection.
              </span>
            </label>
          )}

          <button className="desktop-primary" type="submit" disabled={busy}>
            {busy ? "Checking server…" : "Continue to server"}
          </button>
          <p className="desktop-confirmation">
            The desktop will ask you to confirm before contacting a server.
          </p>
          <div className="desktop-status" role="status" aria-live="polite">
            {status}
          </div>
        </form>

        <section className="local-mode" aria-labelledby="local-mode-title">
          <div>
            <div className="local-mode-label">LOCAL INSTALLATION</div>
            <h2 id="local-mode-title">Run on this computer</h2>
            <p>Local mode is not enabled in this desktop milestone.</p>
          </div>
          <button
            type="button"
            className="desktop-secondary"
            aria-expanded={showLocalGuidance}
            onClick={() => setShowLocalGuidance((visible) => !visible)}
          >
            {showLocalGuidance ? "Hide requirements" : "View requirements"}
          </button>
          {showLocalGuidance && (
            <div className="local-guidance">
              <p>{localModeInfo?.message ?? "Local mode is not enabled in this desktop build."}</p>
              <ul>
                {(localModeInfo?.prerequisites ?? [
                  "PostgreSQL must be installed and managed separately.",
                  "Backend database and authentication settings must be provisioned outside the desktop.",
                  "This build does not start, adopt, or stop a backend process.",
                ]).map((prerequisite) => <li key={prerequisite}>{prerequisite}</li>)}
              </ul>
              <p>
                After starting a configured KuduNS backend yourself on loopback,
                connect to it above and acknowledge HTTP for that local connection.
              </p>
            </div>
          )}
        </section>

        <footer className="desktop-footer">
          Server addresses are not saved. Passwords and API credentials are not stored by this screen.
        </footer>
      </section>
    </main>
  );
}
