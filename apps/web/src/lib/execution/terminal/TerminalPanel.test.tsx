import React, { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TerminalPanel } from './TerminalPanel';

const mocks = vi.hoisted(() => ({ instances: [] as Array<{ dispose: ReturnType<typeof vi.fn>; fit: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> }> }));
vi.mock('./TerminalManager', () => ({
  TerminalManager: class {
    dispose = vi.fn(() => this.container.replaceChildren());
    fit = vi.fn();
    focus = vi.fn();
    constructor(private container: HTMLElement) {
      const input = document.createElement('textarea');
      input.setAttribute('aria-label', 'Terminal input');
      container.append(input);
      mocks.instances.push(this);
    }
  },
}));

describe('TerminalPanel lifecycle', () => {
  beforeEach(() => {
    mocks.instances.length = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const props = () => ({
    visible: false, onClose: vi.fn(), executionTarget: null, isRunning: false,
    status: 'ready' as const, onRestart: vi.fn(), onTerminalReady: vi.fn(), onTerminalDispose: vi.fn(),
  });

  it('opens lazily and retains the same terminal DOM and scrollback when hidden and reopened', () => {
    const callbacks = props();
    const view = render(<TerminalPanel {...callbacks} />);
    expect(mocks.instances).toHaveLength(0);
    view.rerender(<TerminalPanel {...callbacks} visible />);
    const input = screen.getByRole('textbox', { name: 'Terminal input' });
    expect(mocks.instances).toHaveLength(1);
    expect(callbacks.onTerminalReady).toHaveBeenCalledTimes(1);
    view.rerender(<TerminalPanel {...callbacks} />);
    expect(input).not.toBeVisible();
    expect(mocks.instances[0].dispose).not.toHaveBeenCalled();
    view.rerender(<TerminalPanel {...callbacks} visible />);
    expect(screen.getByRole('textbox', { name: 'Terminal input' })).toBe(input);
    expect(mocks.instances).toHaveLength(1);
    view.unmount();
    expect(mocks.instances[0].dispose).toHaveBeenCalledTimes(1);
    expect(callbacks.onTerminalDispose).toHaveBeenCalledWith(mocks.instances[0]);
  });

  it('cleans up StrictMode replay and the final mounted terminal', () => {
    const callbacks = props();
    const view = render(<StrictMode><TerminalPanel {...callbacks} visible /></StrictMode>);
    expect(mocks.instances).toHaveLength(2);
    expect(mocks.instances[0].dispose).toHaveBeenCalledTimes(1);
    expect(mocks.instances[1].dispose).not.toHaveBeenCalled();
    expect(screen.getAllByRole('textbox', { name: 'Terminal input' })).toHaveLength(1);
    view.unmount();
    expect(mocks.instances[1].dispose).toHaveBeenCalledTimes(1);
  });

  it('offers an accessible restart action after exit without destroying the terminal view', () => {
    const callbacks = props();
    render(<TerminalPanel {...callbacks} visible status="exited" />);
    expect(screen.getByRole('status')).toHaveTextContent('Shell exited');
    fireEvent.click(screen.getByRole('button', { name: 'Restart terminal' }));
    expect(callbacks.onRestart).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Hide terminal' }));
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
    expect(mocks.instances[0].dispose).not.toHaveBeenCalled();
  });
});
