import { Component, type ReactNode } from 'react';
export default class ErrorBoundary extends Component<
  { children: ReactNode; onRecover?: () => void; resetKey?: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(previous: { resetKey?: string }) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey)
      this.setState({ failed: false });
  }
  componentDidCatch(error: Error) {
    console.error('Trestl view failed', error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty-state" role="alert">
        <h2>This view couldn’t be displayed</h2>
        <p>Your saved work is safe. Try opening the view again.</p>
        <button
          className="button primary"
          onClick={() => {
            this.setState({ failed: false });
            this.props.onRecover?.();
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
