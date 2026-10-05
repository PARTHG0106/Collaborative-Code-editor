import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RightPanel } from './RightPanel';

const person = { id: 'me', name: 'Me', email: 'me@example.test' };
const message = (id: string, time: number) => ({ id, userId: 'other', user: { name: 'Teammate' }, message: `Message ${id}`, createdAt: new Date(time).toISOString() });
const baseProps: React.ComponentProps<typeof RightPanel> = {
  collapsed: false, workspaceId: 'workspace', chatMessages: [], typingUsers: [], chatInput: '',
  onChatInputChange: () => {}, onSendMessage: () => {}, activeCollaborators: [person],
  isConnected: true, presenceReady: true, currentUserId: 'me',
};

describe('workspace chat', () => {
  it('keeps a disconnected draft editable and prevents sending until workspace presence is ready', () => {
    const send = vi.fn();
    const change = vi.fn();
    const { rerender } = render(<RightPanel {...baseProps} chatInput="Draft" isConnected={false} presenceReady={false} onSendMessage={send} onChatInputChange={change} />);
    const input = screen.getByRole('textbox', { name: 'Message to workspace' });
    expect(input).toBeEnabled();
    expect(input).toHaveValue('Draft');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Draft while offline' } });
    expect(change).toHaveBeenCalledWith('Draft while offline');
    rerender(<RightPanel {...baseProps} chatInput="Draft" presenceReady={false} onSendMessage={send} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    rerender(<RightPanel {...baseProps} chatInput="  Draft  " onSendMessage={send} />);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('Draft');
  });

  it('shows delivery failures beside the retained draft and disables duplicate submissions while sending', () => {
    const send = vi.fn();
    const { rerender } = render(<RightPanel {...baseProps} chatInput="Keep this" isSendingChat onSendMessage={send} />);
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    rerender(<RightPanel {...baseProps} chatInput="Keep this" chatSendError="Message was not sent. Please retry." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Message was not sent');
    expect(screen.getByRole('textbox')).toHaveValue('Keep this');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('preserves the reading position when new messages arrive, then jumps on request', () => {
    const first = message('first', 1000);
    const next = message('next', 2000);
    const { rerender } = render(<RightPanel {...baseProps} chatMessages={[first]} />);
    const log = screen.getByRole('log');
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    rerender(<RightPanel {...baseProps} chatMessages={[first, next]} />);
    expect(log.scrollTop).toBe(100);
    expect(screen.getByRole('button', { name: /1 new message.*Jump to latest/ })).toBeInTheDocument();
    rerender(<RightPanel {...baseProps} chatMessages={[message('history', 0), first, next]} />);
    expect(screen.getByRole('button', { name: /1 new message.*Jump to latest/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Jump to latest/ }));
    expect(log.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).not.toBeInTheDocument();
    rerender(<RightPanel {...baseProps} chatMessages={[first, next, message('last', 3000)]} />);
    expect(log.scrollTop).toBe(1000);
  });

  it('reports actual chat visibility while changing tabs with the keyboard or collapsing the panel', () => {
    const visibility = vi.fn();
    const { rerender } = render(<RightPanel {...baseProps} onChatVisibilityChange={visibility} />);
    expect(visibility).toHaveBeenLastCalledWith(true);
    const chatTab = screen.getByRole('tab', { name: 'Chat' });
    fireEvent.keyDown(chatTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Online (1)' })).toHaveFocus();
    expect(visibility).toHaveBeenLastCalledWith(false);
    rerender(<RightPanel {...baseProps} onChatVisibilityChange={visibility} unreadMessages={2} />);
    expect(screen.getByLabelText('2 unread messages')).toHaveTextContent('2');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Online (1)' }), { key: 'Home' });
    expect(visibility).toHaveBeenLastCalledWith(true);
    rerender(<RightPanel {...baseProps} onChatVisibilityChange={visibility} collapsed />);
    expect(visibility).toHaveBeenLastCalledWith(false);
  });

  it('offers a history retry without misrepresenting an unavailable conversation as empty', () => {
    const retry = vi.fn();
    const { rerender } = render(<RightPanel {...baseProps} chatHistoryLoading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading chat history');
    expect(screen.queryByText('Start the conversation')).not.toBeInTheDocument();
    rerender(<RightPanel {...baseProps} chatHistoryError="Could not load chat history." onRetryChatHistory={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load chat history.');
    expect(screen.queryByText('Start the conversation')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry chat history' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
