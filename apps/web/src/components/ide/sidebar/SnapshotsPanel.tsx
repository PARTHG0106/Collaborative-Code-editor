import React from 'react';
import { Save, Loader2 } from 'lucide-react';

interface SnapshotsPanelProps {
  activeFileId: string | null;
  activeFileName: string | null;
  versions: any[];
  loading: boolean;
  actionLoading: boolean;
  onCreateSnapshot: () => void;
  onPreview: (content: string) => void;
  onRestore: (versionId: string) => void;
}

export const SnapshotsPanel: React.FC<SnapshotsPanelProps> = ({
  activeFileId, activeFileName, versions, loading, actionLoading,
  onCreateSnapshot, onPreview, onRestore
}) => {
  return (
    <>
      <div className="ide-sidebar-header">
        <span className="ide-sidebar-title">Snapshots</span>
      </div>
      <div style={{ padding: 12, borderBottom: '1px solid var(--ide-border)' }}>
        {activeFileId ? (
          <>
            <div style={{ fontSize: 11, color: 'var(--ide-text-muted)', marginBottom: 8 }}>
              File: {activeFileName}
            </div>
            <button className="ide-btn primary" style={{ width: '100%' }} onClick={onCreateSnapshot} disabled={actionLoading}>
              <Save size={12} /> Create Snapshot
            </button>
          </>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--ide-text-muted)', textAlign: 'center' }}>
            Open a file to manage snapshots
          </div>
        )}
      </div>
      <div className="ide-sidebar-body">
        {loading ? (
          <div className="ide-tree-empty"><Loader2 size={16} className="animate-spin" style={{ margin: '0 auto' }} /></div>
        ) : versions.length === 0 ? (
          <div className="ide-tree-empty">No snapshots yet</div>
        ) : (
          versions.map(v => (
            <div key={v.id} className="ide-snapshot-item">
              <div className="ide-snapshot-header">
                <span className="ide-snapshot-badge">v{v.version}</span>
                <span className="ide-snapshot-time">
                  {new Date(v.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div className="ide-snapshot-author">By {v.user?.name || 'System'}</div>
              <div className="ide-snapshot-actions">
                <button className="ide-btn" style={{ flex: 1, fontSize: 10, padding: '3px 6px' }} onClick={() => onPreview(v.content)}>
                  View
                </button>
                <button className="ide-btn primary" style={{ flex: 1, fontSize: 10, padding: '3px 6px' }} onClick={() => onRestore(v.id)} disabled={actionLoading}>
                  Restore
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
};
