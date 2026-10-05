import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';
import { RightPanel } from './RightPanel';

const self = { id: 'self', name: 'Self', email: 'self@example.com' };
const scrollIntoView = HTMLElement.prototype.scrollIntoView;

function Presence({ connected, ready }: { connected: boolean; ready: boolean }) {
  return <>
    <TopBar workspaceName="Workspace" collaboratorCount={1} isConnected={connected} presenceReady={ready}
      userName="Self" onBack={() => {}} rightPanelOpen onToggleRightPanel={() => {}} />
    <RightPanel collapsed={false} chatMessages={[]} typingUsers={[]} chatInput=""
      onChatInputChange={() => {}} onSendMessage={() => {}} currentUserId="self"
      activeCollaborators={[self]} isConnected={connected} presenceReady={ready} />
  </>;
}

describe('workspace presence display', () => {
  beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
  afterEach(() => { HTMLElement.prototype.scrollIntoView = scrollIntoView; });

  it('distinguishes unavailable presence from zero users until a fresh list arrives', () => {
    const { rerender } = render(<Presence connected={false} ready={false} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Online (—)' }));
    expect(screen.getByLabelText('Online count unavailable')).toHaveTextContent('—');
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting');
    expect(screen.queryByText('self@example.com')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Online (0)' })).not.toBeInTheDocument();

    rerender(<Presence connected ready={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading online users');
    expect(screen.queryByText('self@example.com')).not.toBeInTheDocument();

    rerender(<Presence connected ready />);
    expect(screen.getByRole('tab', { name: 'Online (1)' })).toBeInTheDocument();
    expect(screen.getByLabelText('1 online')).toHaveTextContent('1');
    expect(screen.getByText('self@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    rerender(<Presence connected={false} ready={false} />);
    expect(screen.getByLabelText('Online count unavailable')).toHaveTextContent('—');
    expect(screen.queryByText('self@example.com')).not.toBeInTheDocument();
  });
});
