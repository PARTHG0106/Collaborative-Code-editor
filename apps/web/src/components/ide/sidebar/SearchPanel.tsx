import React, { useState, useMemo, useDeferredValue, useRef } from 'react';
import { X } from 'lucide-react';
import { FileSystemItem } from '../hooks/useFileSystem';
import { getFilePath } from '../filePaths';

interface SearchPanelProps {
  files: FileSystemItem[];
  onOpenFile: (file: FileSystemItem, lineNumber?: number) => void;
}

export const SearchPanel: React.FC<SearchPanelProps> = ({ files, onOpenFile }) => {
  const [query, setQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const deferredQuery = useDeferredValue(query);
  const search = useMemo(() => {
    const results: { file: FileSystemItem; matches: { line: number; text: string }[] }[] = [];
    if (!deferredQuery.trim()) return { results, count: 0, error: '' };
    let pattern: RegExp | undefined;
    try { if (useRegex) pattern = new RegExp(deferredQuery, 'i'); }
    catch { return { results, count: 0, error: 'Invalid regular expression. Check brackets and special characters.' }; }
    let count = 0;
    const needle = deferredQuery.toLowerCase();
    for (const file of files) {
      if (file.type !== 'FILE' || !file.content) continue;
      const matches: { line: number; text: string }[] = [];
      for (const [index, line] of file.content.split('\n').entries()) {
        if (pattern ? pattern.test(line) : line.toLowerCase().includes(needle)) {
          matches.push({ line: index + 1, text: line.trim() });
          count++;
          if (count >= 200) break;
        }
      }
      if (matches.length) results.push({ file, matches });
      if (count >= 200) break;
    }
    return { results, count, error: '' };
  }, [deferredQuery, files, useRegex]);

  return (
    <>
      <div className="ide-sidebar-header"><span className="ide-sidebar-title">Search</span></div>
      <div className="ide-search-panel">
        <div className="ide-search-inputs">
          <div className="ide-search-row">
            <input ref={inputRef} autoFocus className="ide-input" aria-label="Search file contents" aria-invalid={!!search.error} aria-describedby="file-search-status" placeholder="Search file contents…" value={query} onChange={event => setQuery(event.target.value)} />
            {query && <button className="ide-icon-btn" aria-label="Clear search" onClick={() => { setQuery(''); inputRef.current?.focus(); }}><X size={14} /></button>}
            <button className="ide-icon-btn" title="Use regular expression" aria-label="Use regular expression" aria-pressed={useRegex} onClick={() => setUseRegex(value => !value)} style={{ color: useRegex ? 'var(--ide-accent)' : undefined }}>.*</button>
          </div>
          <p id="file-search-status" role={search.error ? 'alert' : 'status'} className="ide-help-text">
            {search.error || (!query.trim() ? 'Find text across this workspace. Select a result to jump to its line.' : search.count === 0 ? 'No results found. Try a different search.' : `${search.count}${search.count >= 200 ? '+' : ''} matching ${search.count === 1 ? 'line' : 'lines'} in ${search.results.length} ${search.results.length === 1 ? 'file' : 'files'}${search.count >= 200 ? ' · Narrow your search to see more.' : ''}`)}
          </p>
        </div>
        <div className="ide-search-results ide-sidebar-body" aria-busy={query !== deferredQuery}>
          {search.results.map(({ file, matches }) => (
            <div key={file.id} className="ide-search-file-group">
              <button type="button" className="ide-search-file-name" onClick={() => onOpenFile(file)} title={getFilePath(file, files)}>{getFilePath(file, files)} ({matches.length})</button>
              {matches.map(match => (
                <button type="button" key={match.line} className="ide-search-match" onClick={() => onOpenFile(file, match.line)} title={match.text} aria-label={`${getFilePath(file, files)}, line ${match.line}: ${match.text.substring(0, 120)}`}>
                  <span style={{ color: 'var(--ide-text-muted)', marginRight: 8 }}>{match.line}</span>{match.text.substring(0, 120) || '(empty line)'}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
};
