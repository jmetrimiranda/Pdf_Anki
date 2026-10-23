// Code cards authoring (spec 11.7, 10.2) against the mock core: "Adicionar" a Código · Programa (Python, testes)
// gated by "Testar resposta de referência" (real Pyodide in a worker), and "Criar card" from a command selected in
// the (fake) PdfCraft opening Código · Comando without the prompt. Screenshots: test-results/screens/codigo-adicionar*.
import type { Page } from '@playwright/test';
import {
  ankiLogs,
  expect,
  fakeFrame,
  fakeMenu,
  fakePdfcraft,
  fakeTurn,
  fullShot,
  setTheme,
  shot,
  test,
} from './fixtures';

test.beforeEach(async ({ page }) => {
  await fakePdfcraft(page);
});

async function chooseNotetype(page: Page, name: string) {
  await page.getByRole('button', { name: /^Tipo de nota/ }).click();
  await page.getByRole('combobox', { name: 'Buscar tipo de nota' }).fill(name);
  await page.getByRole('option', { name, exact: true }).click();
  await expect(page.getByRole('button', { name: `Tipo de nota ${name}`, exact: true })).toBeVisible();
}

/** Types into a CodeMirror editor (one insert, so the editor does not auto-indent what is pasted). */
async function typeCode(page: Page, label: string, code: string) {
  const editor = page.getByRole('textbox', { name: label, exact: true });
  await editor.click();
  await page.keyboard.insertText(code);
}

const addLogs = async (page: Page) => (await ankiLogs(page)).filter((l) => l.kind === 'addNote');

async function fillProgram(page: Page) {
  await page.goto('/anki/adicionar');
  await chooseNotetype(page, 'Código · Programa');
  await page.getByRole('textbox', { name: 'Pergunta' }).click();
  await page.keyboard.type('Função que soma os pares de uma lista');
  await expect(page.getByRole('combobox', { name: 'Linguagem' })).toHaveValue('python');
  await page.getByRole('combobox', { name: 'Modo' }).selectOption('testes');
  await expect(page.getByTestId('code-editor').first()).toHaveAttribute('data-state', 'ready');
  await typeCode(page, 'Resposta', 'def soma_pares(xs):\n    return sum(x for x in xs if x % 2 == 0)');
  await typeCode(page, 'Testes', 'assert soma_pares([1, 2, 3, 4]) == 6\nassert soma_pares([]) == 0');
}

test('adds a Código · Programa (Python, testes) only after the reference passes', async ({ page }) => {
  test.setTimeout(120_000);
  await fillProgram(page);
  const add = page.getByRole('button', { name: 'Adicionar', exact: true });
  await expect(add).toBeDisabled();
  await expect(page.getByText('Teste a resposta de referência antes de salvar.')).toBeVisible();

  await page.getByRole('button', { name: 'Testar resposta de referência' }).click();
  await expect(page.getByText('A resposta de referência passou.')).toBeVisible({ timeout: 90_000 });
  await expect(add).toBeEnabled();

  // A code edit asks for the test again.
  await page.getByRole('textbox', { name: 'Resposta', exact: true }).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('#');
  await expect(add).toBeDisabled();
  await expect(page.getByText('O código mudou: teste de novo antes de salvar.')).toBeVisible();
  await page.keyboard.press('Backspace');
  await page.getByRole('button', { name: 'Testar resposta de referência' }).click();
  await expect(page.getByText('A resposta de referência passou.')).toBeVisible({ timeout: 30_000 });
  await add.click();
  await expect(page.getByText('Card adicionado')).toBeVisible();
  const fields = (await addLogs(page)).at(-1)!.fields as string[];
  expect(fields.slice(0, 4)).toEqual([
    'Função que soma os pares de uma lista',
    'python',
    'testes',
    'def soma_pares(xs):<br>    return sum(x for x in xs if x % 2 == 0)',
  ]);
  expect(fields[6]).toBe('assert soma_pares([1, 2, 3, 4]) == 6<br>assert soma_pares([]) == 0');
});

test('C++ saida: a Setup without a trailing newline still compiles with the answer', async ({ page }) => {
  await page.goto('/anki/adicionar');
  await chooseNotetype(page, 'Código · Programa');
  await page.getByRole('textbox', { name: 'Pergunta' }).click();
  await page.keyboard.type('Imprimir 5');
  await page.getByRole('combobox', { name: 'Linguagem' }).selectOption('cpp');
  await page.getByRole('combobox', { name: 'Modo' }).selectOption('saida');
  await expect(page.getByTestId('code-editor').first()).toHaveAttribute('data-state', 'ready');
  await typeCode(page, 'Setup', '#include <iostream>');
  await typeCode(page, 'Resposta', 'int main() { std::cout << "5\\n"; }');
  await page.getByRole('textbox', { name: 'SaidaEsperada', exact: true }).fill('5');
  await page.getByRole('button', { name: 'Testar resposta de referência' }).click();
  await expect(page.getByText('A resposta de referência passou.')).toBeVisible();
  const run = (await ankiLogs(page)).filter((l) => l.kind === 'codeRunCpp').at(-1);
  expect(run).toBeTruthy();
});

test('a command selected in the reader opens Código · Comando without the prompt', async ({ page }) => {
  await page.goto('/biblioteca');
  await page.getByTestId('book-title').filter({ hasText: 'Animal Farm' }).click();
  await expect(page).toHaveURL(/\/leitor/);
  await fakeFrame(page);
  await fakeTurn(page, 0);
  await fakeMenu(page, 'card', { page: 0, text: '$ ros2 run turtlesim turtlesim_node' });
  const form = page.getByRole('form', { name: 'Novo card' });
  await expect(form).toBeVisible();
  const prepare = form.getByRole('button', { name: 'Preparar coleção' });
  if (await prepare.isVisible()) await prepare.click();
  await expect(form.getByRole('radio', { name: 'Código · Comando' })).toHaveAttribute('aria-checked', 'true');
  await expect(form.getByRole('textbox', { name: 'Pergunta' })).toBeFocused();
  await expect(form.getByRole('textbox', { name: 'Resposta', exact: true })).toHaveText(
    'ros2 run turtlesim turtlesim_node',
  );
  await form.getByRole('textbox', { name: 'Pergunta' }).fill('Abrir o simulador turtlesim');
  await expect(form.getByRole('button', { name: 'Adicionar' })).toBeDisabled();
  await form.getByRole('button', { name: 'Testar' }).click();
  await expect(form.getByText('A resposta de referência passou.')).toBeVisible();
  await form.getByRole('textbox', { name: 'Pergunta' }).press('Control+Enter');
  await expect(page.getByText('Card adicionado')).toBeVisible();
  const fields = (await addLogs(page)).at(-1)!.fields as string[];
  expect(fields.slice(0, 2)).toEqual(['Abrir o simulador turtlesim', 'ros2 run turtlesim turtlesim_node']);
});

for (const theme of ['light', 'dark'] as const) {
  test(`screenshots of Adicionar with a code note (${theme})`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await setTheme(page, theme);
    await fillProgram(page);
    await page.getByRole('button', { name: 'Testar resposta de referência' }).click();
    await expect(page.getByText('A resposta de referência passou.')).toBeVisible({ timeout: 90_000 });
    await fullShot(page, shot(`codigo-adicionar-${theme}`, info.project.name));
  });
}

test('Adicionar with a code note at 390 px', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/anki/adicionar');
  await chooseNotetype(page, 'Código · Comando');
  await page.getByRole('textbox', { name: 'Pergunta' }).click();
  await page.keyboard.type('Listar os tópicos ativos');
  await expect(page.getByTestId('code-editor').first()).toHaveAttribute('data-state', 'ready');
  await typeCode(page, 'Resposta', 'ros2 topic list');
  await page.getByRole('button', { name: 'Testar resposta de referência' }).click();
  await expect(page.getByText('A resposta de referência passou.')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await fullShot(page, shot('codigo-adicionar-390', info.project.name));
});
