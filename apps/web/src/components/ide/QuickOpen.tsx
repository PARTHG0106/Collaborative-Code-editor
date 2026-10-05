import React, { useEffect, useMemo, useRef, useState } from 'react';
import { File, Search, X } from 'lucide-react';
import type { FileSystemItem } from './hooks/useFileSystem';
import { getFilePath } from './filePaths';

interface QuickOpenProps {
  files: FileSystemItem[];
  openFileIds: string[];
  onSelect: (file: FileSystemItem) => void;
  onClose: () => void;
}

export function QuickOpen({ files, openFileIds, onSelect, onClose }: QuickOpenProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return files.filter(file => file.type === 'FILE')
      .map(file => ({ file, path: getFilePath(file, files) }))
      .filter(({ path }) => words.every(word => path.toLowerCase().includes(word)))
      .sort((a, b) => Number(openFileIds.includes(b.file.id)) - Number(openFileIds.includes(a.file.id)) || a.path.localeCompare(b.path));
  }, [query, files, openFileIds]);
  const visibleResults = results.slice(0, 100);
  const selectedIndex = Math.min(selected, Math.max(0, visibleResults.length - 1));

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    document.getElementById(`quick-file-${selectedIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedIndex, query]);

  return (
    <div className="ide-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="quick-open-title" className="ide-quick-open" onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); onClose(); }
        if (event.key === 'Tab') {
          const controls = dialogRef.current?.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"])');
          if (!controls?.length) return;
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
        <div className="ide-quick-open-heading">
          <h2 id="quick-open-title">Open a file</h2>
          <button className="ide-icon-btn" aria-label="Close quick open" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="ide-quick-open-search">
          <Search size={16} aria-hidden="true" />
          <input ref={inputRef} role="combobox" aria-label="Find a file by name or path" aria-controls="quick-open-results" aria-expanded="true" aria-autocomplete="list" aria-activedescendant={visibleResults.length ? `quick-file-${selectedIndex}` : undefined} placeholder="Search by file name or folder…" value={query} onChange={event => { setQuery(event.target.value); setSelected(0); }} onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const direction = event.key === 'ArrowDown' ? 1 : -1;
              setSelected((selectedIndex + direction + visibleResults.length) % (visibleResults.length || 1));
            } else if (event.key === 'Enter' && visibleResults[selectedIndex]) {
              event.preventDefault(); onClose(); onSelect(visibleResults[selectedIndex].file);
            }
          }} />
        </div>
        <div id="quick-open-results" role="listbox" aria-label="Workspace files" className="ide-quick-open-results">
          {visibleResults.map(({ file, path }, index) => (
            <button key={file.id} id={`quick-file-${index}`} type="button" role="option" aria-selected={selectedIndex === index} tabIndex={-1} className="ide-quick-open-result" onMouseMove={() => setSelected(index)} onClick={() => { onClose(); onSelect(file); }}>
              <File size={15} aria-hidden="true" />
              <span><strong>{file.name}</strong><small>{path}</small></span>
              {openFileIds.includes(file.id) && <small>Open</small>}
            </button>
          ))}
        </div>
        <div className="ide-quick-open-footer" role="status">
          {results.length === 0 ? (files.some(file => file.type === 'FILE') ? 'No matching files. Try a different name.' : 'Create or upload a file from the Explorer to get started.') : `${results.length} ${results.length === 1 ? 'file' : 'files'}${results.length > 100 ? ' · Showing first 100; narrow your search' : ''} · ↑↓ to choose · Enter to open · Esc to close`}
        </div>
      </div>
    </div>
  );
}
