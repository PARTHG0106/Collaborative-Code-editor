import React, { useEffect, useRef, useState } from 'react';
import { Edit2, Check, X, Trash2, LogOut } from 'lucide-react';
import { DEFAULT_EDITOR_PREFERENCES, type EditorPreferences } from '../hooks/useEditorPreferences';

interface SettingsPanelProps {
  workspace: { id: string; name: string; description: string | null; createdAt: string; currentUserRole: string };
  isOwner: boolean;
  canModify: boolean;
  onSave: (name: string, desc: string) => void | boolean | Promise<void | boolean>;
  onDelete: () => void;
  onLeave: () => void;
  editorPreferences?: EditorPreferences;
  onEditorPreferencesChange?: (next: EditorPreferences) => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  workspace, isOwner, canModify, onSave, onDelete, onLeave,
  editorPreferences = DEFAULT_EDITOR_PREFERENCES, onEditorPreferencesChange,
}) => {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(workspace.name);
  const [desc, setDesc] = useState(workspace.description || '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savePendingRef = useRef(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditingRef = useRef(false);

  useEffect(() => {
    if (wasEditingRef.current && !editing) editButtonRef.current?.focus();
    wasEditingRef.current = editing;
  }, [editing]);

  const startEditing = () => {
    setName(workspace.name);
    setDesc(workspace.description || '');
    setSaveError(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    if (savePendingRef.current) return;
    setName(workspace.name);
    setDesc(workspace.description || '');
    setSaveError(null);
    setEditing(false);
  };

  const saveWorkspace = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing || !canModify || !name.trim() || savePendingRef.current) return;
    savePendingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await onSave(name.trim(), desc.trim());
      if (result === false) {
        setSaveError('Could not save workspace settings. Your changes are still here; please try again.');
      } else {
        setEditing(false);
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save workspace settings. Please try again.');
    } finally {
      savePendingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <>
      <div className="ide-sidebar-header">
        <span className="ide-sidebar-title">Settings</span>
      </div>
      <div className="ide-settings-panel ide-sidebar-body">
        {onEditorPreferencesChange && (
          <fieldset className="flex flex-col gap-3 border-0 p-0 m-0" aria-describedby="editor-preferences-description">
            <legend className="ide-settings-label mb-2">Editor preferences</legend>
            <p id="editor-preferences-description" className="text-xs text-[var(--ide-text-secondary)]">Changes apply immediately and are saved only in this browser.</p>
            <div className="ide-settings-group">
              <label className="ide-settings-label" htmlFor="editor-font-size">Font size</label>
              <select id="editor-font-size" className="ide-input" value={editorPreferences.fontSize} onChange={(event) => onEditorPreferencesChange({ ...editorPreferences, fontSize: Number(event.target.value) })}>
                {[12, 14, 16, 18, 20, 22, 24].map((size) => <option key={size} value={size}>{size} px</option>)}
              </select>
            </div>
            <div className="ide-settings-group">
              <label className="ide-settings-label" htmlFor="editor-tab-size">Tab size</label>
              <select id="editor-tab-size" className="ide-input" value={editorPreferences.tabSize} onChange={(event) => onEditorPreferencesChange({ ...editorPreferences, tabSize: Number(event.target.value) })}>
                {[2, 4, 8].map((size) => <option key={size} value={size}>{size} spaces</option>)}
              </select>
            </div>
            <label className="flex items-center justify-between gap-3 text-[var(--ide-text)] text-xs">
              Word wrap
              <input type="checkbox" className="accent-[var(--ide-accent)]" checked={editorPreferences.wordWrap} onChange={(event) => onEditorPreferencesChange({ ...editorPreferences, wordWrap: event.target.checked })} />
            </label>
            <label className="flex items-center justify-between gap-3 text-[var(--ide-text)] text-xs">
              Show minimap
              <input type="checkbox" className="accent-[var(--ide-accent)]" checked={editorPreferences.minimap} onChange={(event) => onEditorPreferencesChange({ ...editorPreferences, minimap: event.target.checked })} />
            </label>
            <button type="button" className="ide-btn" onClick={() => onEditorPreferencesChange({ ...DEFAULT_EDITOR_PREFERENCES })}>Reset editor defaults</button>
          </fieldset>
        )}

        <form onSubmit={saveWorkspace} className="flex flex-col gap-4" aria-label="Workspace settings" aria-busy={saving} onKeyDown={(event) => { if (editing && event.key === 'Escape') { event.preventDefault(); cancelEditing(); } }}>
        <h2 className="ide-settings-label">Workspace settings</h2>
        <div className="ide-settings-group">
          <label className="ide-settings-label" htmlFor={editing ? 'settings-workspace-name' : undefined}>Workspace Name</label>
          {editing ? (
            <input id="settings-workspace-name" className="ide-input" value={name} onChange={e => setName(e.target.value)} required maxLength={100} disabled={saving} autoFocus />
          ) : (
            <span className="ide-settings-value">{workspace.name}</span>
          )}
        </div>
        <div className="ide-settings-group">
          <label className="ide-settings-label" htmlFor={editing ? 'settings-workspace-description' : undefined}>Description</label>
          {editing ? (
            <textarea id="settings-workspace-description" className="ide-input" value={desc} onChange={e => setDesc(e.target.value)} rows={3} maxLength={500} disabled={saving} style={{ resize: 'vertical' }} />
          ) : (
            <span className="ide-settings-value">{workspace.description || 'No description'}</span>
          )}
        </div>
        <div className="ide-settings-group">
          <span className="ide-settings-label">Created</span>
          <span className="ide-settings-value">{new Date(workspace.createdAt).toLocaleDateString()}</span>
        </div>
        <div className="ide-settings-group">
          <span className="ide-settings-label">Your Role</span>
          <span className="ide-settings-value" style={{ textTransform: 'capitalize' }}>{workspace.currentUserRole.toLowerCase()}</span>
        </div>

        {saveError && <p role="alert" className="text-xs text-[var(--ide-danger)]">{saveError}</p>}

        {canModify && (
          <div style={{ display: 'flex', gap: 6 }}>
            {editing ? (
              <>
                <button type="submit" className="ide-btn primary" disabled={saving || !name.trim()}>
                  <Check size={12} /> {saving ? 'Saving...' : 'Save'}
                </button>
                <button type="button" className="ide-btn" onClick={cancelEditing} disabled={saving}>
                  <X size={12} /> Cancel
                </button>
              </>
            ) : (
              <button type="button" ref={editButtonRef} className="ide-btn" onClick={startEditing}>
                <Edit2 size={12} /> Edit
              </button>
            )}
          </div>
        )}
        </form>

        <div style={{ marginTop: 'auto', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {isOwner ? (
            <button type="button" className="ide-btn danger" onClick={onDelete} disabled={saving} style={{ width: '100%' }}>
              <Trash2 size={12} /> Delete Workspace
            </button>
          ) : (
            <button type="button" className="ide-btn danger" onClick={onLeave} disabled={saving} style={{ width: '100%' }}>
              <LogOut size={12} /> Leave Workspace
            </button>
          )}
        </div>
      </div>
    </>
  );
};
