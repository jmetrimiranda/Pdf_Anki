/**
 * User-facing diff messages (pt-BR, spec 11.3). This is the only place outside
 * `web/src/i18n` allowed to hold UI text, because the checker produces the
 * messages itself and must run without the web app. Keep them all in this map.
 */
const q = (s: string): string => `\`${s}\``;

export const MESSAGES = {
  emptyAnswer: 'resposta vazia',
  missingSudo: 'faltou sudo',
  extraSudo: 'sudo a mais',
  requiredSudo: 'faltou sudo (obrigatório)',
  missingRequired: (item: string) => `faltou ${q(item)} (obrigatório)`,
  typo: (got: string, expected: string) => `erro de digitação em ${q(got)} (esperado ${q(expected)})`,
  argumentOrder: 'ordem dos argumentos',
  redirectOrder: 'ordem dos redirecionamentos',
  programDiffers: (expected: string, got: string) => `programa diferente: esperado ${q(expected)}, veio ${q(got)}`,
  missingProgram: (expected: string) => `faltou o programa ${q(expected)}`,
  subcommandDiffers: (expected: string, got: string) =>
    `subcomando diferente: esperado ${q(expected)}, veio ${q(got)}`,
  missingSubcommand: (expected: string) => `faltou o subcomando ${q(expected)}`,
  extraSubcommand: (got: string) => `subcomando a mais: ${q(got)}`,
  missingOption: (option: string) => `faltou a opção ${q(option)}`,
  extraOption: (option: string) => `opção a mais: ${q(option)}`,
  optionValue: (option: string, expected: string, got: string) =>
    `valor diferente em ${q(option)}: esperado ${q(expected)}, veio ${q(got)}`,
  missingArgument: (expected: string) => `faltou o argumento ${q(expected)}`,
  extraArgument: (got: string) => `argumento a mais: ${q(got)}`,
  argumentValue: (expected: string, got: string) => `argumento diferente: esperado ${q(expected)}, veio ${q(got)}`,
  missingVariable: (variable: string) => `faltou a variável ${q(variable)}`,
  extraVariable: (variable: string) => `variável a mais: ${q(variable)}`,
  variableValue: (expected: string, got: string) => `variável diferente: esperado ${q(expected)}, veio ${q(got)}`,
  missingRedirect: (redirect: string) => `faltou o redirecionamento ${q(redirect)}`,
  extraRedirect: (redirect: string) => `redirecionamento a mais: ${q(redirect)}`,
  redirectDiffers: (expected: string, got: string) =>
    `redirecionamento diferente: esperado ${q(expected)}, veio ${q(got)}`,
  missingSegment: (segment: string) => `faltou o comando ${q(segment)}`,
  extraSegment: (segment: string) => `comando a mais: ${q(segment)}`,
  operatorDiffers: (expected: string, got: string) => `operador diferente: esperado ${q(expected)}, veio ${q(got)}`,
  missingRosArgs: 'faltou a seção `--ros-args`',
  extraRosArgs: 'seção `--ros-args` a mais',
  differentCommand: 'comando diferente',
} as const;
