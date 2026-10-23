/**
 * Step 3 (spec 11.3): split a command line into segments on `|`, `&&`, `||`
 * and `;` (plus a lone `&` and newlines, which behave like `;`), outside
 * quotes, `$(…)`, `${…}` and backticks. Escaped characters never split.
 */

export type Operator = '|' | '&&' | '||' | ';' | '&';

export interface SplitCommand {
  segments: string[];
  operators: Operator[];
}

export function splitSegments(command: string): SplitCommand {
  const segments: string[] = [];
  const operators: Operator[] = [];
  let current = '';
  let quote: '"' | "'" | '`' | null = null;
  let depth = 0; // nesting of $( … ) and ${ … }
  const closers: string[] = [];
  const s = command;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    const next = s.charAt(i + 1);
    if (quote) {
      current += c;
      if (c === '\\' && quote !== "'" && i + 1 < s.length) {
        current += next;
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      current += c + next;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      current += c;
      continue;
    }
    if (c === '$' && (next === '(' || next === '{')) {
      depth++;
      closers.push(next === '(' ? ')' : '}');
      current += c + next;
      i++;
      continue;
    }
    if (depth > 0) {
      if (c === '(') {
        depth++;
        closers.push(')');
      } else if (c === closers[closers.length - 1]) {
        depth--;
        closers.pop();
      }
      current += c;
      continue;
    }
    let op: Operator | null = null;
    let width = 1;
    if (c === '|') {
      if (next === '|') {
        op = '||';
        width = 2;
      } else {
        op = '|';
      }
    } else if (c === '&') {
      const prev = s.charAt(i - 1);
      if (next === '&') {
        op = '&&';
        width = 2;
      } else if (next !== '>' && prev !== '>' && prev !== '<') {
        op = '&';
      }
    } else if (c === ';' || c === '\n') {
      op = ';';
    }
    if (op) {
      segments.push(current.trim());
      operators.push(op);
      current = '';
      i += width - 1;
      continue;
    }
    current += c;
  }
  segments.push(current.trim());
  // A trailing `;` (or blank line) with nothing after it is not a separator.
  while (segments.length > 1 && segments[segments.length - 1] === '' && operators[operators.length - 1] === ';') {
    segments.pop();
    operators.pop();
  }
  return { segments, operators };
}
