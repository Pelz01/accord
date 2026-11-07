import { Component, type ReactNode } from 'react';

export class LoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="load-recovery">
        <a href="/" className="load-recovery-brand" aria-label="Accord home">
          <img src="/brand/accord-mark.svg" alt="" width="31" height="31" />
          accord.
        </a>
        <section role="alert">
          <h1>Accord couldn’t finish loading.</h1>
          <p>Reload the page to try again.</p>
          <button
            className="button primary"
            onClick={() => {
              const url = new URL(window.location.href);
              url.searchParams.set('_accord_reload', String(Date.now()));
              window.location.replace(url.toString());
            }}
          >
            Reload Accord
          </button>
        </section>
      </main>
    );
  }
}
