import React, { useId, useState } from 'react';
import { Play, Plus, Trash2, ChevronUp, ChevronDown, Square } from 'lucide-react';
import Editor from '@monaco-editor/react';
import DOMPurify from 'dompurify';

export interface CellOutput {
  type: 'stdout' | 'stderr' | 'display_data' | 'execute_result' | 'error';
  text?: string;
  data?: Record<string, unknown>; // MIME bundles may contain text arrays or JSON values.
  traceback?: string[];
  executionCount?: number | null;
  ename?: string;
  evalue?: string;
  original?: Record<string, unknown>;
}

export interface NotebookCell {
  id: string;
  type: 'code' | 'markdown' | 'raw';
  source: string;
  outputs: CellOutput[];
  executionCount: number | null;
  isRunning: boolean;
  original?: Record<string, unknown>;
}

interface NotebookRendererProps {
  cells: NotebookCell[];
  onCellChange: (id: string, source: string) => void;
  onRunCell: (id: string) => void;
  onRunAll: () => void;
  onAddCell: (afterId: string, type: 'code' | 'markdown') => void;
  onDeleteCell: (id: string) => void;
  onMoveCell: (id: string, direction: 'up' | 'down') => void;
  theme: 'dark' | 'light';
  readOnly?: boolean;
  isExecuting?: boolean;
  onStop?: () => void;
  inputText?: string;
  onInputTextChange?: (value: string) => void;
}

function mimeText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(part => typeof part === 'string')) return value.join('');
  return undefined;
}

function renderOutput(output: CellOutput) {
  if (output.type === 'display_data' || output.type === 'execute_result') {
    const png = mimeText(output.data?.['image/png']);
    const html = mimeText(output.data?.['text/html']);
    if (png) return <img src={`data:image/png;base64,${png}`} alt="output" style={{ maxWidth: '100%', background: '#fff' }} />;
    if (html) return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html, { USE_PROFILES: { html: true } }) }}
      style={{ background: '#fff', color: '#000', padding: '8px' }} />;
  }
  const content = output.type === 'error'
    ? output.traceback?.join('\n') || [output.ename, output.evalue].filter(Boolean).join(': ')
    : mimeText(output.data?.['text/plain']) ?? output.text;
  return <pre style={{ margin: 0, whiteSpace: 'pre-wrap',
    color: output.type === 'stderr' || output.type === 'error' ? 'var(--ide-danger)' : 'var(--ide-text)',
  }}>{content}</pre>;
}

export const NotebookRenderer: React.FC<NotebookRendererProps> = ({
  cells, onCellChange, onRunCell, onRunAll,
  onAddCell, onDeleteCell, onMoveCell, theme, readOnly = false, isExecuting = false, onStop,
  inputText = '', onInputTextChange,
}) => {
  const [focusedCell, setFocusedCell] = useState<string | null>(null);
  const inputHelpId = useId();
  const busy = isExecuting || cells.some(cell => cell.isRunning);

  return (
    <div style={{
      padding: '16px', maxWidth: '900px', margin: '0 auto',
      fontFamily: 'var(--ide-font)', width: '100%', height: '100%', overflowY: 'auto'
    }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '8px', marginBottom: '16px',
        padding: '8px 12px', borderRadius: '6px',
        background: 'var(--ide-surface)', border: '1px solid var(--ide-border)',
        position: 'sticky', top: 0, zIndex: 10
      }}>
        <button disabled={readOnly || busy} className="ide-btn" onClick={onRunAll}
          style={{ display: 'flex', alignItems: 'center', gap: '4px', height: '28px', padding: '0 12px' }}>
          <Play size={12} /> Run All
        </button>
        {busy && <>
          {onStop && <button className="ide-btn" onClick={onStop}>
            <Square size={12} /> Stop
          </button>}
          <span role="status" style={{ alignSelf: 'center' }}>Running cell…</span>
        </>}
        <button disabled={readOnly} className="ide-btn"
          style={{ display: 'flex', alignItems: 'center', gap: '4px', height: '28px', padding: '0 12px', background: 'transparent', border: '1px solid var(--ide-border)' }}
          onClick={() => onAddCell(cells[cells.length - 1]?.id || '', 'code')}>
          <Plus size={12} /> Code
        </button>
        <button disabled={readOnly} className="ide-btn"
          style={{ display: 'flex', alignItems: 'center', gap: '4px', height: '28px', padding: '0 12px', background: 'transparent', border: '1px solid var(--ide-border)' }}
          onClick={() => onAddCell(cells[cells.length - 1]?.id || '', 'markdown')}>
          <Plus size={12} /> Markdown
        </button>
        <details style={{ marginLeft: 'auto', minWidth: 0, maxWidth: '100%' }}>
          <summary style={{ cursor: 'pointer', padding: '5px 0', fontSize: '12px' }}>Python input</summary>
          <div style={{ width: '260px', maxWidth: '100%', paddingTop: '4px' }}>
            <textarea
              aria-label="Python input lines"
              aria-describedby={inputHelpId}
              value={inputText}
              onChange={event => { if (!readOnly) onInputTextChange?.(event.target.value); }}
              readOnly={readOnly || !onInputTextChange}
              rows={3}
              spellCheck={false}
              style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', padding: '6px 8px',
                border: '1px solid var(--ide-border)', borderRadius: '4px',
                background: 'var(--ide-editor-bg)', color: 'var(--ide-text)', fontFamily: 'var(--ide-font-mono)', fontSize: '12px' }}
            />
            <p id={inputHelpId} style={{ margin: '4px 0 0', color: 'var(--ide-text-muted)', fontSize: '11px', lineHeight: 1.4 }}>
              One line for each input() call. Used from the beginning on each run.
            </p>
          </div>
        </details>
      </div>

      {/* Cells */}
      {cells.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--ide-text-muted)' }}>
          No cells in this notebook. Click + Code to start.
        </div>
      )}

      {cells.map(cell => (
        <div key={cell.id}
          onClick={() => setFocusedCell(cell.id)}
          style={{
            marginBottom: '12px', borderRadius: '6px',
            border: `1px solid ${focusedCell === cell.id
              ? 'var(--ide-accent)' : 'var(--ide-border)'}`,
            background: 'var(--ide-editor-bg)',
            boxShadow: focusedCell === cell.id ? '0 0 0 1px var(--ide-accent)' : 'none',
            transition: 'border-color 0.2s',
          }}
        >
          {/* Cell Header */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px',
            borderBottom: '1px solid var(--ide-border)', fontSize: '11px',
            color: 'var(--ide-text-muted)', background: 'var(--ide-surface)',
          }}>
            <span style={{ width: '60px', fontFamily: 'var(--ide-font-mono)' }}>
              {cell.type === 'code'
                ? `[${cell.executionCount ?? ' '}]`
                : cell.type === 'raw' ? 'raw' : 'md'}
            </span>
            <div style={{ flex: 1 }} />
            {cell.type === 'code' && (
              <button className="ide-icon-btn" onClick={(e) => { e.stopPropagation(); onRunCell(cell.id); }}
                disabled={readOnly || busy}
                title="Run cell"
                style={{ marginRight: '4px', color: cell.isRunning ? 'var(--ide-accent)' : undefined }}>
                {cell.isRunning ? <span style={{ animation: 'pulse 1s infinite' }}>⏳</span> : <Play size={12} />}
              </button>
            )}
            <button disabled={readOnly} className="ide-icon-btn" onClick={(e) => { e.stopPropagation(); onMoveCell(cell.id, 'up'); }} title="Move up">
              <ChevronUp size={12} />
            </button>
            <button disabled={readOnly} className="ide-icon-btn" onClick={(e) => { e.stopPropagation(); onMoveCell(cell.id, 'down'); }} title="Move down">
              <ChevronDown size={12} />
            </button>
            <button disabled={readOnly} className="ide-icon-btn" onClick={(e) => { e.stopPropagation(); onDeleteCell(cell.id); }} title="Delete cell"
              style={{ color: 'var(--ide-danger)' }}>
              <Trash2 size={12} />
            </button>
          </div>

          {/* Cell Editor */}
          <div style={{ minHeight: '60px', padding: '8px 0' }}>
            <Editor
              height={`${Math.max(60, (cell.source.split('\n').length || 1) * 20)}px`}
              language={cell.type === 'code' ? 'python' : cell.type === 'raw' ? 'plaintext' : 'markdown'}
              theme={theme === 'dark' ? 'vs-dark' : 'vs'}
              value={cell.source}
              onChange={(val, event) => {
                if (!readOnly && !event?.isFlush && !event?.isEolChange) onCellChange(cell.id, val || '');
              }}
              options={{
                readOnly,
                minimap: { enabled: false }, lineNumbers: 'off',
                scrollBeyondLastLine: false, folding: false,
                fontSize: 13, padding: { top: 0, bottom: 0 },
                automaticLayout: true, wordWrap: 'on',
                overviewRulerLanes: 0, hideCursorInOverviewRuler: true,
                scrollbar: { vertical: 'hidden', horizontal: 'hidden', alwaysConsumeMouseWheel: false },
                renderLineHighlight: 'none',
                mouseWheelZoom: false,
              }}
            />
          </div>

          {/* Cell Outputs */}
          {cell.outputs.length > 0 && (
            <div style={{
              padding: '8px 12px', borderTop: '1px solid var(--ide-border)',
              fontFamily: 'var(--ide-font-mono)', fontSize: '12px',
              maxHeight: '400px', overflowY: 'auto', background: 'var(--ide-bg-darker)',
            }}>
              {cell.outputs.map((output, oi) => (
                <div key={oi} style={{ marginBottom: oi < cell.outputs.length - 1 ? '8px' : 0 }}>
                  {renderOutput(output)}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
