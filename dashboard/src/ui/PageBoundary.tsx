import { Component, type ReactNode } from 'react';

/** A failed route download leaves a recoverable screen instead of a blank dashboard. */
export class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <section role="alert">
        <p>This page could not load. Check your connection and try again.</p>
        <button onClick={() => location.reload()}>Reload page</button>
      </section>
    ) : (
      this.props.children
    );
  }
}
