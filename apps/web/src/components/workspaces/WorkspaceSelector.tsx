import React, { useState, useRef, useEffect } from 'react';
import { useWorkspaces, Workspace } from '../../context/WorkspaceContext.js';
import { ChevronDown, Plus, Settings, Briefcase, Check, Shield } from 'lucide-react';

interface WorkspaceSelectorProps {
  onOpenSettings: () => void;
}

export const WorkspaceSelector: React.FC<WorkspaceSelectorProps> = ({ onOpenSettings }) => {
  const { workspaces, currentWorkspace, selectWorkspace, createWorkspace } = useWorkspaces();
  const [isOpen, setIsOpen] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;

    setCreating(true);
    setCreateError(null);
    try {
      await createWorkspace(newName.trim(), newDesc.trim() || undefined);
      setShowCreateModal(false);
      setNewName('');
      setNewDesc('');
    } catch (err: any) {
      setCreateError(err.message || 'Failed to create workspace');
    } finally {
      setCreating(false);
    }
  };

  const handleSelect = (ws: Workspace) => {
    selectWorkspace(ws);
    setIsOpen(false);
  };

  const getRoleLabel = (role: string) => {
    switch (role) {
      case 'OWNER':
        return 'Owner';
      case 'EDITOR':
        return 'Editor';
      case 'VIEWER':
        return 'Viewer';
      default:
        return role;
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-900 transition-colors duration-150 focus:outline-hidden"
      >
        <Briefcase size={16} className="text-zinc-400" />
        <span className="max-w-[120px] truncate">
          {currentWorkspace ? currentWorkspace.name : 'Select Workspace'}
        </span>
        <ChevronDown size={14} className="text-zinc-500" />
      </button>

      {isOpen && (
        <div className="absolute left-0 mt-1 z-40 w-56 rounded-lg border border-zinc-850 bg-zinc-950 p-1.5 shadow-xl animate-in fade-in-50 slide-in-from-top-1 duration-100">
          <div className="px-2 py-1.5 text-xs font-semibold text-zinc-500 uppercase tracking-wider">
            Workspaces
          </div>
          <div className="space-y-0.5 max-h-48 overflow-y-auto">
            {workspaces.map((ws) => (
              <button
                key={ws.id}
                onClick={() => handleSelect(ws)}
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100 transition-colors"
              >
                <div className="flex flex-col min-w-0">
                  <span className="font-medium truncate">{ws.name}</span>
                  <span className="text-xxs text-zinc-500 flex items-center gap-1">
                    <Shield size={10} /> {getRoleLabel(ws.role)}
                  </span>
                </div>
                {currentWorkspace?.id === ws.id && (
                  <Check size={14} className="text-zinc-400 shrink-0" />
                )}
              </button>
            ))}
          </div>

          <div className="my-1 border-t border-zinc-900"></div>

          <button
            onClick={() => {
              setShowCreateModal(true);
              setIsOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 transition-colors"
          >
            <Plus size={16} />
            Create Workspace
          </button>

          {currentWorkspace && (
            <button
              onClick={() => {
                onOpenSettings();
                setIsOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 transition-colors"
            >
              <Settings size={16} />
              Workspace Settings
            </button>
          )}
        </div>
      )}

      {/* Workspace Creation Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl animate-in fade-in-50 zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-zinc-900 pb-3">
              <h3 className="text-lg font-semibold text-zinc-100 font-heading">Create New Workspace</h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 transition-colors"
              >
                <Plus size={18} className="rotate-45" />
              </button>
            </div>

            <form onSubmit={handleCreateWorkspace} className="mt-4 space-y-4">
              {createError && (
                <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">
                  {createError}
                </div>
              )}

              <div className="space-y-1">
                <label htmlFor="ws-name" className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                  Workspace Name
                </label>
                <input
                  id="ws-name"
                  type="text"
                  required
                  placeholder="e.g., Acme Devs"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900/50 py-2 px-3 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-700 focus:outline-hidden focus:ring-1 focus:ring-zinc-700 transition-all"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="ws-desc" className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                  Description (Optional)
                </label>
                <textarea
                  id="ws-desc"
                  placeholder="What is this workspace for?"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900/50 py-2 px-3 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-700 focus:outline-hidden focus:ring-1 focus:ring-zinc-700 transition-all resize-none"
                />
              </div>

              <div className="flex justify-end gap-3 border-t border-zinc-900 pt-4">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="rounded-lg px-4 py-2 text-sm font-medium border border-zinc-800 text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100 transition-all"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating || !newName.trim()}
                  className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {creating ? 'Creating...' : 'Create Workspace'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
