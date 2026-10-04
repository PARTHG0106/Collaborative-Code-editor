import React, { useRef, useEffect } from 'react';
import { Terminal as TerminalIcon, X, Globe, Monitor, Cpu, RotateCcw } from 'lucide-react';
import { TerminalManager } from './TerminalManager';
import { TerminalStatus } from './TerminalSession';
import { ExecutionTarget } from '../types';
import '@xterm/xterm/css/xterm.css';

interface TerminalPanelProps {
  visible: boolean;
  onClose: () => void;
  executionTarget: ExecutionTarget | null;
  isRunning: boolean;
  status: TerminalStatus;
  onRestart: () => void;
  onTerminalReady: (manager: TerminalManager) => void;
  onTerminalDispose: (manager: TerminalManager) => void;
}

const TARGET_CONFIG: Record<ExecutionTarget, { icon: React.ReactNode; label: string; color: string }> = {
  browser:       { icon: <Globe size={10} />,   label: 'Browser',  color: '#5E8B68' },
  'local-agent': { icon: <Monitor size={10} />, label: 'Local',    color: '#5D7FB5' },
  remote:        { icon: <Cpu size={10} />,     label: 'CPU Remote',color: '#B19764' },
  'gpu-worker':  { icon: <Cpu size={10} />,     label: 'GPU Remote',color: '#9F5BBA' },
};

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  visible, onClose, executionTarget, isRunning, status, onRestart, onTerminalReady, onTerminalDispose,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<TerminalManager | null>(null);
  const readyCallbackRef = useRef(onTerminalReady);
  const disposeCallbackRef = useRef(onTerminalDispose);
  readyCallbackRef.current = onTerminalReady;
  disposeCallbackRef.current = onTerminalDispose;

  useEffect(() => {
    if (visible && containerRef.current && !managerRef.current) {
      managerRef.current = new TerminalManager(containerRef.current);
      readyCallbackRef.current(managerRef.current);
    }
  }, [visible]);

  useEffect(() => () => {
    const manager = managerRef.current;
    if (!manager) return;
    disposeCallbackRef.current(manager);
    manager.dispose();
    managerRef.current = null;
  }, []);

  // Re-fit when visibility changes
  useEffect(() => {
    if (visible && managerRef.current) {
      const frame = requestAnimationFrame(() => {
        managerRef.current?.fit();
        managerRef.current?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [visible]);

  const targetInfo = executionTarget ? TARGET_CONFIG[executionTarget] : null;
  const statusLabel = {
    connecting: 'Starting shell...', ready: 'Connected', disconnected: 'Disconnected',
    exited: 'Shell exited', error: 'Shell unavailable',
  }[status];

  return (
    <div aria-hidden={!visible} style={{
      height: '30%', minHeight: '160px', maxHeight: '50%',
      borderTop: '1px solid var(--ide-border)',
      display: visible ? 'flex' : 'none', flexDirection: 'column',
      background: '#111312',
    }}>
      {/* Terminal Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', padding: '4px 12px',
        borderBottom: '1px solid var(--ide-border)',
        background: 'var(--ide-surface)', fontSize: '11px',
        color: 'var(--ide-text-muted)', flexShrink: 0,
        userSelect: 'none',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <TerminalIcon size={12} />
            <span style={{ fontWeight: 600, letterSpacing: '0.5px' }}>TERMINAL</span>
          </div>

          <span role="status" aria-live="polite">{statusLabel}</span>

          {/* Execution target badge */}
          {targetInfo && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              padding: '1px 8px', borderRadius: '10px', fontSize: '10px',
              background: targetInfo.color + '22', color: targetInfo.color,
              border: `1px solid ${targetInfo.color}44`,
            }}>
              {targetInfo.icon}
              {targetInfo.label}
              {isRunning && (
                <span style={{
                  width: '5px', height: '5px', borderRadius: '50%',
                  background: targetInfo.color, display: 'inline-block',
                  animation: 'pulse 1s infinite',
                }} />
              )}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {(status === 'exited' || status === 'error') && (
            <button className="ide-icon-btn" onClick={onRestart} aria-label="Restart terminal" title="Restart terminal" disabled={isRunning}>
              <RotateCcw size={14} />
            </button>
          )}
          <button
            className="ide-icon-btn"
            onClick={onClose}
            aria-label="Hide terminal"
            title="Hide terminal (Ctrl+`)"
            style={{ padding: '2px' }}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Terminal Body */}
      <div ref={containerRef} style={{ flex: 1, overflow: 'hidden', padding: '4px 0 0 4px' }} />
    </div>
  );
};
