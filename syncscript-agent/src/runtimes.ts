import { execSync } from 'child_process';

interface RuntimeDef {
  name: string;
  commands: string[];   // try each in order
  versionFlag: string;
  language: string;
}

const RUNTIMES: RuntimeDef[] = [
  { name: 'Node.js',  commands: ['node'],           versionFlag: '--version', language: 'javascript' },
  { name: 'Python',   commands: ['python3','python'],versionFlag: '--version', language: 'python' },
  { name: 'GCC',      commands: ['gcc'],             versionFlag: '--version', language: 'c' },
  { name: 'G++',      commands: ['g++'],             versionFlag: '--version', language: 'cpp' },
  { name: 'Java',     commands: ['javac'],           versionFlag: '-version',  language: 'java' },
  { name: 'Go',       commands: ['go'],              versionFlag: 'version',   language: 'go' },
  { name: 'Rust',     commands: ['cargo'],           versionFlag: '--version', language: 'rust' },
  { name: 'PHP',      commands: ['php'],             versionFlag: '--version', language: 'php' },
  { name: 'Ruby',     commands: ['ruby'],            versionFlag: '--version', language: 'ruby' },
  { name: '.NET',     commands: ['dotnet'],          versionFlag: '--version', language: 'csharp' },
  { name: 'Kotlin',   commands: ['kotlinc'],         versionFlag: '-version',  language: 'kotlin' },
  { name: 'TypeScript',commands: ['npx'],            versionFlag: '--version', language: 'typescript' },
];

export interface DetectedRuntime {
  language: string;
  name: string;
  command: string;
  version: string;
}

export function detectRuntimes(): DetectedRuntime[] {
  const detected: DetectedRuntime[] = [];
  const seen = new Set<string>();

  for (const rt of RUNTIMES) {
    if (seen.has(rt.language)) continue;

    for (const cmd of rt.commands) {
      try {
        const output = execSync(`${cmd} ${rt.versionFlag}`, {
          stdio: 'pipe', timeout: 5000, encoding: 'utf-8',
        }).trim().split('\n')[0];

        detected.push({
          language: rt.language,
          name: rt.name,
          command: cmd,
          version: output,
        });
        seen.add(rt.language);
        break; // found working command, skip alternates
      } catch {
        // not installed, try next command
      }
    }
  }

  return detected;
}
