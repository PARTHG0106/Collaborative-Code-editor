import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';
import { DEFAULT_EDITOR_PREFERENCES, useEditorPreferences } from '../hooks/useEditorPreferences';

const workspace = {
  id: 'workspace-1',
  name: 'Project Alpha',
  description: 'Our shared workspace',
  createdAt: '2026-10-01T00:00:00Z',
  currentUserRole: 'OWNER',
};

function props(overrides: Partial<React.ComponentProps<typeof SettingsPanel>> = {}) {
  return { workspace, isOwner: true, canModify: true, onSave: vi.fn(), onDelete: vi.fn(), onLeave: vi.fn(), ...overrides };
}

describe('SettingsPanel', () => {
  beforeEach(() => localStorage.clear());

  it('lets viewers personalize their editor, persists preferences, and restores defaults', () => {
    function ViewerSettings() {
      const { preferences, setPreferences } = useEditorPreferences();
      return <SettingsPanel {...props({ workspace: { ...workspace, currentUserRole: 'VIEWER' }, isOwner: false, canModify: false })} editorPreferences={preferences} onEditorPreferencesChange={setPreferences} />;
    }

    const first = render(<ViewerSettings />);
    expect(screen.getByText('Changes apply immediately and are saved only in this browser.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Tab size'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Word wrap' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show minimap' }));
    expect(JSON.parse(localStorage.getItem('syncscript-editor-preferences')!)).toEqual({ fontSize: 20, tabSize: 4, wordWrap: false, minimap: false });
    first.unmount();

    render(<ViewerSettings />);
    expect(screen.getByLabelText('Font size')).toHaveValue('20');
    expect(screen.getByLabelText('Tab size')).toHaveValue('4');
    expect(screen.getByRole('checkbox', { name: 'Word wrap' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Show minimap' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Reset editor defaults' }));
    expect(JSON.parse(localStorage.getItem('syncscript-editor-preferences')!)).toEqual(DEFAULT_EDITOR_PREFERENCES);
    expect(screen.getByLabelText('Font size')).toHaveValue('14');
    expect(screen.getByLabelText('Tab size')).toHaveValue('2');
    expect(screen.getByRole('checkbox', { name: 'Word wrap' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Show minimap' })).toBeChecked();
  });

  it('awaits the save result, trims fields, and prevents duplicate saves or cancellation while saving', async () => {
    let resolveSave!: (value: boolean) => void;
    const onSave = vi.fn(() => new Promise<boolean>((resolve) => { resolveSave = resolve; }));
    render(<SettingsPanel {...props({ onSave })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Workspace Name'), { target: { value: '  Renamed project  ' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '  New description  ' } });
    const form = screen.getByRole('form', { name: 'Workspace settings' });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('Renamed project', 'New description');
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete Workspace' })).toBeDisabled();
    fireEvent.keyDown(form, { key: 'Escape' });
    expect(screen.getByLabelText('Workspace Name')).toHaveValue('  Renamed project  ');

    await act(async () => resolveSave(true));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();
  });

  it('keeps a failed save draft visible and allows retry', async () => {
    const onSave = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<SettingsPanel {...props({ onSave })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Workspace Name'), { target: { value: 'Unsaved name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your changes are still here');
    expect(screen.getByLabelText('Workspace Name')).toHaveValue('Unsaved name');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument());
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows rejected saves and discards canceled drafts when editing again', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Connection lost'));
    render(<SettingsPanel {...props({ onSave })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Workspace Name'), { target: { value: 'Unsaved name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
    expect(screen.getByLabelText('Workspace Name')).toHaveValue('Unsaved name');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Workspace Name')).toHaveValue(workspace.name);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('starts edits with the current workspace details and rejects whitespace-only names', () => {
    const callbacks = props();
    const { rerender } = render(<SettingsPanel {...callbacks} />);
    rerender(<SettingsPanel {...callbacks} workspace={{ ...workspace, name: 'Updated by teammate', description: 'Latest details' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const name = screen.getByLabelText('Workspace Name');
    expect(name).toHaveFocus();
    expect(name).toHaveValue('Updated by teammate');
    expect(screen.getByLabelText('Description')).toHaveValue('Latest details');
    expect(name).toHaveAttribute('maxlength', '100');
    expect(screen.getByLabelText('Description')).toHaveAttribute('maxlength', '500');
    fireEvent.change(name, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('form', { name: 'Workspace settings' }));
    expect(callbacks.onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(name, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();
  });
});
