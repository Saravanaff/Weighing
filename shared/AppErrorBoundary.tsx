import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Shown in the crash panel so support can tell the two clients apart. */
  appName: string;
}

interface State {
  error: Error | null;
  info: string | null;
}

/**
 * A React render error used to blank the whole page: a kiosk on a shop floor
 * would just show white with no way back except a hidden refresh. This catches
 * it, shows what happened, and offers the two actions that actually work on a
 * terminal — retry the render, or clear the stored scale/alert preferences.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.appName} crashed:`, error, info.componentStack);
    this.setState({ info: info.componentStack ?? null });
  }

  private reset = () => {
    this.setState({ error: null, info: null });
  };

  private clearStateAndReload = () => {
    // A bad stored preference can be what crashed the app on every boot, so
    // clear them before reloading rather than re-throwing straight into the
    // same error. The in-progress cart is left alone: it holds real weighed
    // material, and losing it is worse than a repeat crash.
    try {
      window.localStorage.removeItem('naveen.alertsEnabled');
      window.localStorage.removeItem('naveen.fontScale');
    } catch {
      // storage unavailable; reload anyway
    }
    window.location.reload();
  };

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash-screen" role="alert">
        <div className="crash-panel">
          <div className="crash-title">Something went wrong</div>
          <p className="crash-app">{this.props.appName} stopped unexpectedly.</p>
          <p className="crash-message">{error.message || String(error)}</p>
          {info ? <pre className="crash-stack">{info.trim()}</pre> : null}
          <div className="crash-actions">
            <button type="button" className="btn btn-primary" onClick={this.reset}>
              TRY AGAIN
            </button>
            <button type="button" className="btn btn-secondary" onClick={this.clearStateAndReload}>
              RESET &amp; RELOAD
            </button>
          </div>
          <p className="crash-hint">
            Weighing in progress? Cancel the weighing, then reload before starting a new
            bill, so nothing is half recorded.
          </p>
        </div>
      </div>
    );
  }
}
