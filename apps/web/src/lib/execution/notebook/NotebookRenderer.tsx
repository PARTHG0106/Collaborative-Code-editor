import React, { useState } from 'react';
import { Play, Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import Editor from '@monaco-editor/react';

export interface CellOutput {
  type: 'stdout' | 'stderr' | 'display_data' | 'execute_result' | 'error';
  text?: string;
  data?: Record<string, string>; // mime-type -> content
  traceback?: string[];
}

export interface NotebookCell {
  id: string;
  type: 'code' | 'markdown';
  source: string;
  outputs: CellOutput[];
  executionCount: number | null;
  isRunning: boolean;
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
}

export const NotebookRenderer: React.FC<NotebookRendererProps> = ({
  cells, onCellChange, onRunCell, onRunAll,
  onAddCell, onDeleteCell, onMoveCell, theme,
}) => {
  const [focusedCell, setFocusedCell] = useState<string | null>(null);

  return (
    <div style={{
      padding: '16px', maxWidth: '900px', margin: '0 auto',
      fontFamily: 'var(--ide-font)', width: '100%', height: '100%', overflowY: 'auto'
    }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px',
        padding: '8px 12px', borderRadius: '6px',
        background: 'var(--ide-surface)', border: '1px solid var(--ide-border)',
        position: 'sticky', top: 0, zIndex: 10
      }}>
        <button className="ide-btn" onClick={onRunAll}
          style={{ display: 'flex', alignItems: 'center', gap: '4px', height: '28px', padding: '0 12px' }}>
          <Play size={12} /> Run All
        </button>
        <button className="ide-btn"
          style={{ display: 'flex', alignItems: 'center', gap: '4px', height: '28px', padding: '0 12px', background: 'transparent', border: '1px solid var(--ide-border)' }}
          onClick={() => onAddCell(cells[cells.length - 1]?.id || '', 'code')}>
          <Plus size={12} /> Code
        </button>
        <button className="ide-btn"
          style={{ display: 'flex', alignItems: 'center', gap: '4px', height: '28px', padding: '0 12px', background: 'transparent', border: '1px solid var(--ide-border)' }}
          onClick={() => onAddCell(cells[cells.length - 1]?.id || '', 'markdown')}>
          <Plus size={12} /> Markdown
        </button>
      </div>

      {/* Cells */}
      {cells.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--ide-text-muted)' }}>
          No cells in this notebook. Click + Code to start.
        </div>
      )}

      {cells.map((cell, idx) => (
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
                : 'md'}
            </span>
            <div style={{ flex: 1 }} />
            {cell.type === 'code' && (
              <button className="ide-icon-btn" onClick={(e) => { e.stopPropagation(); onRunCell(cell.id); }}
                disabled={cell.isRunning}
                title="Run cell"
                style={{ marginRight: '4px', color: cell.isRunning ? 'var(--ide-accent)' : undefined }}>
                {cell.isRunning ? <span style={{ animation: 'pulse 1s infinite' }}>⏳</span> : <Play size={12} />}
              </button>
            )}
            <button className="ide-icon-btn" onClick={(e) => { e.stopPropagation(); onMoveCell(cell.id, 'up'); }} title="Move up">
              <ChevronUp size={12} />
            </button>
            <button className="ide-icon-btn" onClick={(e) => { e.stopPropagation(); onMoveCell(cell.id, 'down'); }} title="Move down">
              <ChevronDown size={12} />
            </button>
            <button className="ide-icon-btn" onClick={(e) => { e.stopPropagation(); onDeleteCell(cell.id); }} title="Delete cell"
              style={{ color: 'var(--ide-danger)' }}>
              <Trash2 size={12} />
            </button>
          </div>

          {/* Cell Editor */}
          <div style={{ minHeight: '60px', padding: '8px 0' }}>
            <Editor
              height={`${Math.max(60, (cell.source.split('\n').length || 1) * 20)}px`}
              language={cell.type === 'code' ? 'python' : 'markdown'}
              theme={theme === 'dark' ? 'vs-dark' : 'vs'}
              value={cell.source}
              onChange={(val) => onCellChange(cell.id, val || '')}
              options={{
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
                  {output.type === 'stdout' && (
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--ide-text)' }}>{output.text}</pre>
                  )}
                  {output.type === 'stderr' && (
                    <pre style={{ margin: 0, color: 'var(--ide-danger)', whiteSpace: 'pre-wrap' }}>
                      {output.text}
                    </pre>
                  )}
                  {output.type === 'error' && (
                    <pre style={{ margin: 0, color: 'var(--ide-danger)', whiteSpace: 'pre-wrap' }}>
                      {output.traceback?.join('\n')}
                    </pre>
                  )}
                  {output.type === 'display_data' && output.data?.['image/png'] && (
                    <img src={`data:image/png;base64,${output.data['image/png']}`}
                      alt="output" style={{ maxWidth: '100%', background: '#fff' }} />
                  )}
                  {output.type === 'display_data' && output.data?.['text/html'] && (
                    <div dangerouslySetInnerHTML={{ __html: output.data['text/html'] }}
                      style={{ background: '#fff', color: '#000', padding: '8px' }} />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
