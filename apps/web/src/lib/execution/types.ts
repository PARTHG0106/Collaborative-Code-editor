// ===== Execution Types =====

export type ExecutionTarget = 'browser' | 'local-agent' | 'remote';

export interface RuntimeCallbacks {
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
  onRequestInput?: () => void;
  onExit: (code: number) => void;
}

export interface ExecutionCapability {
  target: ExecutionTarget;
  available: boolean;
  languages: string[];
  label: string;
}

// ===== Socket Event Constants =====
export const EXEC_EVENTS = {
  START:          'execution:start',
  STDIN:          'execution:stdin',
  CANCEL:         'execution:cancel',
  WATCH:          'execution:watch',
  UNWATCH:        'execution:unwatch',
  STDOUT:         'execution:stdout',
  STDERR:         'execution:stderr',
  WAITING_INPUT:  'execution:waiting-input',
  COMPLETED:      'execution:completed',
  FAILED:         'execution:failed',
  STATUS:         'execution:status',
  AGENT_CONNECTED:    'agent:connected',
  AGENT_DISCONNECTED: 'agent:disconnected',
} as const;
