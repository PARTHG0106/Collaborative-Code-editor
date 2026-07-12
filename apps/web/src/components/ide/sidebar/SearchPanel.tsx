import React, { useState, useMemo } from 'react';
import { Search, X, ToggleLeft, ToggleRight } from 'lucide-react';
import { FileSystemItem } from '../hooks/useFileSystem';

interface SearchPanelProps {
  files: FileSystemItem[];
  onOpenFile: (file: FileSystemItem, lineNumber?: number) => void;
}

export const SearchPanel: React.FC<SearchPanelProps> = ({ files, onOpenFile }) => {
  const [query, setQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const out: { file: FileSystemItem; matches: { line: number; text: string }[] }[] = [];

    files.filter(f => f.type === 'FILE' && f.content).forEach(file => {
      const lines = (file.content || '').split('\n');
      const matches: { line: number; text: string }[] = [];

      lines.forEach((line: string, i: number) => {
        try {
          const found = useRegex
            ? new RegExp(query, 'i').test(line)
            : line.toLowerCase().includes(query.toLowerCase());
          if (found) matches.push({ line: i + 1, text: line.trim() });
        } catch { /* invalid regex */ }
      });

      if (matches.length > 0) out.push({ file, matches });
    });
    return out;
  }, [query, files, useRegex]);

  return (
    <>
      <div className="ide-sidebar-header">
        <span className="ide-sidebar-title">Search</span>
      </div>
      <div className="ide-search-panel">
        <div className="ide-search-inputs">
          <div className="ide-search-row">
            <input
              className="ide-input"
              placeholder="Search files..."
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            <button
              className={`ide-icon-btn ${useRegex ? '' : ''}`}
              title="Toggle Regex"
              onClick={() => setUseRegex(!useRegex)}
              style={{ color: useRegex ? 'var(--ide-accent)' : undefined }}
            >
              .*
            </button>
          </div>
        </div>
        <div className="ide-search-results ide-sidebar-body">
          {query.trim() && results.length === 0 && (
            <div className="ide-tree-empty">No results found</div>
          )}
          {results.map(({ file, matches }) => (
            <div key={file.id} className="ide-search-file-group">
              <div className="ide-search-file-name" onClick={() => onOpenFile(file)}>
                {file.name} ({matches.length})
              </div>
              {matches.slice(0, 10).map((m, i) => (
                <div key={i} className="ide-search-match" onClick={() => onOpenFile(file, m.line)}>
                  <span style={{ color: 'var(--ide-text-muted)', marginRight: 8 }}>{m.line}</span>
                  {m.text.substring(0, 80)}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
};
