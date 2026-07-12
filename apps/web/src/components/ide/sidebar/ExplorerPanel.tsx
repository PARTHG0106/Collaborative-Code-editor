import React, { useState } from 'react';
import {
  Folder, File, FilePlus, FolderPlus, ChevronDown, ChevronRight,
  Edit2, Trash2, Upload, FolderUp
} from 'lucide-react';
import { FileSystemItem } from './hooks/useFileSystem';

interface ExplorerPanelProps {
  files: FileSystemItem[];
  filesLoading: boolean;
  activeFileId: string | null;
  expandedFolders: Set<string>;
  canModify: boolean;
  onSelectFile: (file: FileSystemItem) => void;
  onToggleFolder: (id: string) => void;
  onCreateFile: (name: string, type: 'FILE' | 'FOLDER', parentId: string | null, content?: string) => Promise<any>;
  onRenameFile: (id: string, name: string) => void;
  onDeleteFile: (id: string) => void;
}

export const ExplorerPanel: React.FC<ExplorerPanelProps> = ({
  files, filesLoading, activeFileId, expandedFolders, canModify,
  onSelectFile, onToggleFolder, onCreateFile, onRenameFile, onDeleteFile
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [newItemType, setNewItemType] = useState<'FILE' | 'FOLDER' | null>(null);
  const [newItemParentId, setNewItemParentId] = useState<string | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingName, setRenamingName] = useState('');
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const isTextFile = (file: File) => {
    const textExtensions = ['.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx', '.html', '.css', '.scss', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.sql', '.sh', '.yml', '.yaml', '.xml', '.env', '.gitignore'];
    if (file.type.startsWith('text/')) return true;
    if (file.name) {
      const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
      if (textExtensions.includes(ext)) return true;
    }
    if (file.type && !file.type.startsWith('text/') && !file.type.includes('json') && !file.type.includes('javascript')) {
      return false;
    }
    return true;
  };

  const readFileContent = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.onerror = (e) => reject(e);
      if (isTextFile(file)) {
        reader.readAsText(file);
      } else {
        reader.readAsDataURL(file);
      }
    });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const filesToUpload = e.target.files;
    if (!filesToUpload) return;
    
    Array.from(filesToUpload).forEach(async (file) => {
      try {
        const text = await readFileContent(file);
        const activeItem = files.find(f => f.id === activeFileId);
        let parentId = null;
        if (activeItem) {
          parentId = activeItem.type === 'FOLDER' ? activeItem.id : activeItem.parentId;
        }
        await onCreateFile(file.name, 'FILE', parentId, text);
      } catch (err) {
        console.error(`Failed to upload ${file.name}:`, err);
      }
    });
    
    // Clear input so same files can be uploaded again if needed
    e.target.value = '';
  };

  const getActiveFolderId = () => {
    const activeItem = files.find(f => f.id === activeFileId);
    if (activeItem) {
      return activeItem.type === 'FOLDER' ? activeItem.id : activeItem.parentId;
    }
    return null;
  };

  const processDirectoryHandle = async (dirHandle: any, parentId: string | null) => {
    try {
      const newFolder = await onCreateFile(dirHandle.name, 'FOLDER', parentId);
      if (!newFolder) return;

      for await (const entry of dirHandle.values()) {
        try {
          if (entry.kind === 'file') {
            const file = await entry.getFile();
            const text = await readFileContent(file);
            await onCreateFile(file.name, 'FILE', newFolder.id, text);
          } else if (entry.kind === 'directory') {
            await processDirectoryHandle(entry, newFolder.id);
          }
        } catch (err) {
          console.error(`Failed to process entry ${entry.name}:`, err);
        }
      }
    } catch (err) {
      console.error(`Failed to create folder ${dirHandle.name}:`, err);
    }
  };

  const handleFolderUpload = async () => {
    try {
      // @ts-ignore
      const dirHandle = await window.showDirectoryPicker();
      await processDirectoryHandle(dirHandle, getActiveFolderId());
    } catch (err) {
      console.error('Folder upload cancelled or failed', err);
    }
  };

  const processEntry = async (entry: any, parentId: string | null) => {
    try {
      if (entry.isFile) {
        entry.file(async (file: File) => {
          try {
            const text = await readFileContent(file);
            await onCreateFile(file.name, 'FILE', parentId, text);
          } catch (err) {
            console.error(`Failed to save file ${file.name}:`, err);
          }
        });
      } else if (entry.isDirectory) {
        const newFolder = await onCreateFile(entry.name, 'FOLDER', parentId);
        if (!newFolder) return;
        
        const dirReader = entry.createReader();
        dirReader.readEntries(async (entries: any[]) => {
          for (const childEntry of entries) {
            await processEntry(childEntry, newFolder.id);
          }
        });
      }
    } catch (err) {
      console.error(`Failed to process entry ${entry.name}:`, err);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const items = e.dataTransfer.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i].webkitGetAsEntry();
      if (item) {
        await processEntry(item, getActiveFolderId());
      }
    }
  };

  const startCreate = (type: 'FILE' | 'FOLDER', parentId: string | null) => {
    setNewItemType(type);
    setNewItemParentId(parentId);
    setNewItemName('');
  };

  const commitCreate = () => {
    if (newItemName.trim() && newItemType) {
      onCreateFile(newItemName.trim(), newItemType, newItemParentId);
    }
    setNewItemType(null);
  };

  const renderInlineInput = () => (
    <div className="ide-tree-node" style={{ paddingLeft: 12 }}>
      <div className="ide-tree-node-info">
        {newItemType === 'FILE' ? <File size={14} style={{ color: 'var(--ide-accent)' }} /> : <Folder size={14} style={{ color: 'var(--ide-warning)' }} />}
        <input
          className="ide-tree-inline-input"
          value={newItemName}
          onChange={e => setNewItemName(e.target.value)}
          autoFocus
          placeholder={newItemType === 'FILE' ? 'file.txt' : 'folder_name'}
          onKeyDown={e => {
            if (e.key === 'Enter') commitCreate();
            if (e.key === 'Escape') setNewItemType(null);
          }}
          onBlur={() => setTimeout(() => setNewItemType(null), 150)}
        />
      </div>
    </div>
  );

  const renderTree = (parentId: string | null, depth: number): React.ReactNode => {
    const items = files.filter(f => f.parentId === parentId);
    return items.map(item => {
      const isFolder = item.type === 'FOLDER';
      const isExpanded = expandedFolders.has(item.id);
      const isSelected = activeFileId === item.id;

      return (
        <div key={item.id}>
          <div
            className={`ide-tree-node ${isSelected ? 'selected' : ''}`}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            onClick={() => isFolder ? onToggleFolder(item.id) : onSelectFile(item)}
          >
            <div className="ide-tree-node-info">
              {isFolder ? (
                <>
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Folder size={14} style={{ color: 'var(--ide-warning)' }} />
                </>
              ) : (
                <File size={14} style={{ color: 'var(--ide-accent)', marginLeft: 14 }} />
              )}
              {renamingId === item.id ? (
                <input
                  className="ide-tree-inline-input"
                  value={renamingName}
                  onChange={e => setRenamingName(e.target.value)}
                  autoFocus
                  onClick={e => e.stopPropagation()}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && renamingName.trim()) {
                      onRenameFile(item.id, renamingName.trim());
                      setRenamingId(null);
                    }
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  onBlur={() => setRenamingId(null)}
                />
              ) : (
                <span className="ide-tree-node-name">{item.name}</span>
              )}
            </div>

            {canModify && renamingId !== item.id && (
              <div className="ide-tree-node-actions" onClick={e => e.stopPropagation()}>
                {isFolder && (
                  <>
                    <button className="ide-icon-btn" title="New File" onClick={() => { onToggleFolder(item.id); startCreate('FILE', item.id); }}>
                      <FilePlus size={12} />
                    </button>
                    <button className="ide-icon-btn" title="New Folder" onClick={() => { onToggleFolder(item.id); startCreate('FOLDER', item.id); }}>
                      <FolderPlus size={12} />
                    </button>
                  </>
                )}
                <button className="ide-icon-btn" title="Rename" onClick={() => { setRenamingId(item.id); setRenamingName(item.name); }}>
                  <Edit2 size={12} />
                </button>
                <button className="ide-icon-btn danger" title="Delete" onClick={() => { if (window.confirm('Delete this item?')) onDeleteFile(item.id); }}>
                  <Trash2 size={12} />
                </button>
              </div>
            )}
          </div>

          {isFolder && isExpanded && newItemType && newItemParentId === item.id && (
            <div style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}>
              {renderInlineInput()}
            </div>
          )}
          {isFolder && isExpanded && renderTree(item.id, depth + 1)}
        </div>
      );
    });
  };

  return (
    <>
      <div className="ide-sidebar-header">
        <span className="ide-sidebar-title">Explorer</span>
        {canModify && (
          <div className="ide-sidebar-actions">
            <button className="ide-icon-btn" title="New File" onClick={() => startCreate('FILE', null)}>
              <FilePlus size={14} />
            </button>
            <button className="ide-icon-btn" title="New Folder" onClick={() => startCreate('FOLDER', null)}>
              <FolderPlus size={14} />
            </button>
            <button className="ide-icon-btn" title="Upload Files" onClick={() => fileInputRef.current?.click()}>
              <Upload size={14} />
            </button>
            <button className="ide-icon-btn" title="Upload Folder" onClick={handleFolderUpload}>
              <FolderUp size={14} />
            </button>
          </div>
        )}
      </div>
      <input 
        type="file" 
        multiple 
        ref={fileInputRef} 
        style={{ display: 'none' }} 
        onChange={handleFileUpload} 
      />
      <div 
        className="ide-sidebar-body"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          border: isDragging ? '2px dashed var(--ide-accent)' : 'none',
          backgroundColor: isDragging ? 'var(--ide-hover)' : 'transparent'
        }}
      >
        {filesLoading ? (
          <div className="ide-tree-empty">Loading files...</div>
        ) : (
          <>
            {newItemType && newItemParentId === null && renderInlineInput()}
            {files.length === 0 && !newItemType ? (
              <div className="ide-tree-empty">
                No files yet. Create a file to start coding.
              </div>
            ) : (
              renderTree(null, 0)
            )}
          </>
        )}
      </div>
    </>
  );
};
