import { Component } from 'react';
import { btn, card } from './ui.jsx';

/** Catches render errors in one section so the rest of the page keeps working. Resets when resetKey changes. */
export default class ErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(prev) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className={`${card} text-center`}>
        <p className="font-bold">Something went wrong</p>
        <p className="mt-1 text-sm text-pine-soft">This section hit a snag. Your data is safe.</p>
        <button type="button" onClick={() => window.location.reload()} className={`${btn.base} ${btn.coral} ${btn.small} mt-4`}>
          Reload
        </button>
      </div>
    );
  }
}
