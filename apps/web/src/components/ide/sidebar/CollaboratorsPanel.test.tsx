import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CollaboratorsPanel } from './CollaboratorsPanel';

const owner = { userId: 'me', name: 'Owner', email: 'owner@example.test', role: 'OWNER' as const, joinedAt: '' };
const editor = { userId: 'editor', name: 'Teammate', email: 'editor@example.test', role: 'EDITOR' as const, joinedAt: '' };
const props: React.ComponentProps<typeof CollaboratorsPanel> = {
  members: [owner, editor], currentUserId: 'me', currentUserRole: 'OWNER',
  activeCollaborators: [{ id: 'me', name: owner.name, email: owner.email }], presenceReady: true,
  canModify: true, onInvite: () => {}, onChangeRole: () => {}, onRemoveMember: () => {},
};

describe('collaborator management', () => {
  it('preserves invitation details after failure and prevents duplicate submissions while pending', async () => {
    let finish!: (success: boolean) => void;
    const invite = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const { rerender } = render(<CollaboratorsPanel {...props} onInvite={invite} />);
    const email = screen.getByRole('textbox', { name: 'Collaborator email' });
    fireEvent.change(email, { target: { value: 'teammate@example.test' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Invitation role' }), { target: { value: 'VIEWER' } });
    expect(screen.getByText('Viewers can read files and participate in chat.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(screen.getByRole('button', { name: 'Inviting…' })).toBeDisabled();
    fireEvent.submit(email.closest('form')!);
    expect(invite).toHaveBeenCalledOnce();
    expect(invite).toHaveBeenCalledWith('teammate@example.test', 'VIEWER');
    await act(async () => finish(false));
    expect(email).toHaveValue('teammate@example.test');
    rerender(<CollaboratorsPanel {...props} onInvite={async () => true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    await waitFor(() => expect(email).toHaveValue(''));
  });

  it('does not offer owners an unsupported leave action and labels each member action', () => {
    const { rerender } = render(<CollaboratorsPanel {...props} />);
    expect(screen.queryByRole('button', { name: 'Leave workspace' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Teammate' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Role for Teammate' })).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
    rerender(<CollaboratorsPanel {...props} currentUserId="editor" currentUserRole="EDITOR" presenceReady={false} />);
    expect(screen.getByRole('button', { name: 'Leave workspace' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Teammate' })).not.toBeInTheDocument();
    expect(screen.queryByText('Offline')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Online status is temporarily unavailable');
  });

  it('blocks overlapping role changes and removals until the member update completes', async () => {
    let finish!: () => void;
    const changeRole = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<CollaboratorsPanel {...props} onChangeRole={changeRole} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Role for Teammate' }), { target: { value: 'VIEWER' } });
    expect(screen.getByRole('combobox', { name: 'Role for Teammate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Teammate' })).toBeDisabled();
    await act(async () => finish());
    expect(screen.getByRole('button', { name: 'Remove Teammate' })).toBeEnabled();
    expect(changeRole).toHaveBeenCalledOnce();
    expect(changeRole).toHaveBeenCalledWith('editor', 'VIEWER');
  });
});
