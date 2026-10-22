import { ptBR, type Messages } from './pt-BR';

export type MessageKey = keyof Messages;

/** Looks up a pt-BR string and fills `{name}` placeholders. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const template: string = ptBR[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export { ptBR };
