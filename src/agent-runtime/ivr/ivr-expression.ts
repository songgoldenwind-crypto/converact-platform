/**
 * Safe expression evaluation for set_var nodes (SV-1).
 * Whitelist: + - * / ( ), upper, lower, substr, len — no eval().
 */

function substituteVars(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
    const trimmed = key.trim();
    return variables[trimmed] ?? `{{${trimmed}}}`;
  });
}

const ALLOWED_FUNCS = new Set(['upper', 'lower', 'substr', 'len']);

function splitArgs(raw: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of raw) {
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function evaluateArithmetic(expr: string): number {
  let pos = 0;
  const s = expr.replace(/\s+/g, '');

  function parseNum(): number {
    const m = /^-?\d+(\.\d+)?/.exec(s.slice(pos));
    if (!m) throw new Error('expected number in expression');
    pos += m[0].length;
    return parseFloat(m[0]);
  }

  function parseFactor(): number {
    if (s[pos] === '(') {
      pos++;
      const v = parseAdd();
      if (s[pos] !== ')') throw new Error('expected ) in expression');
      pos++;
      return v;
    }
    return parseNum();
  }

  function parseMul(): number {
    let v = parseFactor();
    while (pos < s.length && (s[pos] === '*' || s[pos] === '/')) {
      const op = s[pos++];
      const r = parseFactor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }

  function parseAdd(): number {
    let v = parseMul();
    while (pos < s.length && (s[pos] === '+' || s[pos] === '-')) {
      const op = s[pos++];
      const r = parseMul();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  const result = parseAdd();
  if (pos !== s.length) throw new Error('invalid arithmetic expression');
  return result;
}

function evaluateFuncArg(raw: string): string | number {
  const trimmed = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return parseFloat(trimmed);
  if (/^[+\-*/().\d\s]+$/.test(trimmed) && /[+\-*/]/.test(trimmed)) {
    return evaluateArithmetic(trimmed);
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function evaluateValue(input: string): string | number {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('empty expression');

  const funcMatch = /^([a-z]+)\((.*)\)$/i.exec(trimmed);
  if (funcMatch) {
    const name = funcMatch[1].toLowerCase();
    if (!ALLOWED_FUNCS.has(name)) throw new Error(`unknown function: ${name}`);
    const args = splitArgs(funcMatch[2]).map((a) => evaluateFuncArg(a));
    if (name === 'upper') return String(args[0]).toUpperCase();
    if (name === 'lower') return String(args[0]).toLowerCase();
    if (name === 'len') return String(args[0]).length;
    if (name === 'substr') {
      const s = String(args[0]);
      const start = Math.trunc(Number(args[1]));
      if (args[2] === undefined) return s.slice(start);
      return s.slice(start, start + Math.trunc(Number(args[2])));
    }
  }

  if (/^[+\-*/().\d\s]+$/.test(trimmed) && /[+\-*/]/.test(trimmed)) {
    return evaluateArithmetic(trimmed);
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return parseFloat(trimmed);

  if (/^[a-zA-Z_][\w]*$/.test(trimmed)) {
    throw new Error(`unknown identifier: ${trimmed}`);
  }

  return trimmed;
}

export function evaluateIvrExpression(expr: string, variables: Record<string, string>): string {
  const substituted = substituteVars(expr.trim(), variables);
  return String(evaluateValue(substituted));
}
