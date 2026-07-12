export interface SecurityReport {
  warnings: string[];
  blocked: string[];
  safe: boolean;
}

/** Static analysis to detect dangerous patterns before execution */
export function analyzeCode(code: string, language: string): SecurityReport {
  const warnings: string[] = [];
  const blocked: string[] = [];

  const dangerousPatterns: Record<string, { regex: RegExp; msg: string; block: boolean }[]> = {
    javascript: [
      { regex: /while\s*\(\s*true\s*\)/g, msg: 'Infinite loop detected: while(true)', block: false },
      { regex: /for\s*\(\s*;\s*;\s*\)/g, msg: 'Infinite loop detected: for(;;)', block: false },
      { regex: /eval\s*\(/g, msg: 'Usage of eval() is discouraged', block: false },
      { regex: /import\s*\(/g, msg: 'Dynamic imports in worker are blocked', block: true },
    ],
    typescript: [
      { regex: /while\s*\(\s*true\s*\)/g, msg: 'Infinite loop detected: while(true)', block: false },
      { regex: /for\s*\(\s*;\s*;\s*\)/g, msg: 'Infinite loop detected: for(;;)', block: false },
      { regex: /eval\s*\(/g, msg: 'Usage of eval() is discouraged', block: false },
    ],
    python: [
      { regex: /while\s+True\s*:/g, msg: 'Infinite loop detected: while True:', block: false },
      { regex: /os\.system/g, msg: 'Usage of os.system is unsafe', block: true },
      { regex: /subprocess/g, msg: 'Subprocess spawning is unsafe', block: true },
      { regex: /exec\s*\(/g, msg: 'Dynamic exec() is discouraged', block: false },
      { regex: /__import__/g, msg: 'Dynamic __import__ is discouraged', block: false },
      { regex: /os\.fork/g, msg: 'Fork operations are strictly forbidden', block: true },
    ],
  };

  const patterns = dangerousPatterns[language] || [];
  for (const pattern of patterns) {
    if (pattern.regex.test(code)) {
      if (pattern.block) {
        blocked.push(pattern.msg);
      } else {
        warnings.push(pattern.msg);
      }
    }
  }

  // Hard block fork bombs across all languages
  if (/fork\s*\(/.test(code)) {
    blocked.push('Fork operations are not allowed');
  }

  return { warnings, blocked, safe: blocked.length === 0 };
}
