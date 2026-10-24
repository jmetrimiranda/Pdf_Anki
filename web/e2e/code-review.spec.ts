// Code cards in the study screen (spec 11.2, 11.5, 21 Phase 5) against the mock core: the command card of the ROS
// deck (typo → Quase + diff + Difícil preselected → Enter; correct → Bom), Contestar, a user type with the Comando
// role, the mini-review with a code card, C++ testes/saida/timeout/compile error/no compiler, and screenshots
// (light, dark, 390 px) in test-results/screens/codigo-*.png.
import type { Page } from '@playwright/test';
import {
  ankiLogs,
  expect,
  fakeFrame,
  fakePdfcraft,
  setCppAvailable,
  shot,
  stubPdfcraft,
  suspendCards,
  test,
  type LeitorMockHandle,
} from './fixtures';

type MockWindow = { __leitorMock: LeitorMockHandle };

/** Like fixtures' setTheme, but only in the app's top window: the sandboxed card frame has no localStorage. */
async function setAppTheme(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((t) => {
    if (window !== window.top) return;
    try {
      localStorage.setItem('leitor.theme', t);
    } catch {
      // Not persisted.
    }
  }, theme);
}

const studyUrl = (deck: string, codigo?: string) =>
  `/anki/estudar?nome=${encodeURIComponent(deck)}${codigo !== undefined ? `&codigo=${encodeURIComponent(codigo)}` : ''}`;
const study = (page: Page) => page.getByTestId('study-page');
const panel = (page: Page) => page.getByTestId('code-panel');
const verdict = (page: Page) => page.getByTestId('code-verdict');
const commandInput = (page: Page) => page.getByTestId('code-command-input');
const rating = (page: Page, name: RegExp) => page.getByRole('button', { name });

async function shown(page: Page, side: 'question' | 'answer') {
  await expect(study(page)).toHaveAttribute('data-shown', side);
}

async function answers(page: Page) {
  return (await ankiLogs(page)).filter((l) => l.kind === 'answer');
}

/** Opens a deck with only the cards that do NOT match `suspend` (a mock Anki search). */
async function openDeck(page: Page, deck: string, suspend?: string, codigo?: string) {
  await page.goto('/anki');
  if (suspend) await suspendCards(page, suspend);
  await page.goto(studyUrl(deck, codigo));
}

async function typeInEditor(page: Page, text: string) {
  const editor = panel(page).getByTestId('code-editor');
  await expect(editor).toHaveAttribute('data-state', 'ready');
  await editor.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
}

test.describe('command cards', () => {
  test.beforeEach(async ({ page }) => {
    await stubPdfcraft(page);
  });

  test('typo → Quase, the diff, Difícil preselected → Enter answers it and shows the next card', async ({ page }) => {
    await page.goto(studyUrl('ROS 2 — Revisão'));
    await shown(page, 'question');
    // The frame shows only the Pergunta; the app's input replaces Anki's type box.
    const card = page.frameLocator('iframe[title="Card"]');
    await expect(card.getByText('Ver a transformação entre os frames world e turtle1')).toBeVisible();
    await expect(card.locator('#typeans')).toHaveCount(0);
    await expect(commandInput(page)).toBeFocused();
    const first = await study(page).getAttribute('data-card-id');

    // Study keys typed in the input are just text.
    await commandInput(page).pressSequentially('ros2 run tf2_ros tf2_eco world turtle1');
    expect(await answers(page)).toHaveLength(0);
    await page.keyboard.press('Control+Enter');
    await expect(verdict(page)).toHaveText('Quase');
    await shown(page, 'answer');
    await expect(page.getByTestId('code-token-diff')).toContainText('tf2_eco');
    await expect(page.getByTestId('code-diff-messages')).toContainText('digitação');
    await expect(page.getByTestId('code-reference')).toHaveText('ros2 run tf2_ros tf2_echo world turtle1');
    const hard = rating(page, /^Difícil/);
    await expect(hard).toHaveAttribute('data-suggested', 'true');
    await expect(hard).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await answers(page)).map((a) => a.rating)).toEqual([2]);
    await shown(page, 'question');
    await expect(study(page)).not.toHaveAttribute('data-card-id', first ?? '');
  });

  test('correct → Correto and Bom preselected; history ↑ brings the last command back', async ({ page }) => {
    await page.goto(studyUrl('ROS 2 — Revisão'));
    await shown(page, 'question');
    await commandInput(page).fill('ros2   run tf2_ros  tf2_echo "world" turtle1');
    await commandInput(page).press('Enter');
    await expect(verdict(page)).toHaveText('Correto');
    await expect(rating(page, /^Bom/)).toHaveAttribute('data-suggested', 'true');
    await expect(page.getByRole('button', { name: 'Contestar' })).toHaveCount(0);
    await expect(rating(page, /^Bom/)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await answers(page)).map((a) => a.rating)).toEqual([3]);
    await shown(page, 'question');
    await commandInput(page).press('ArrowUp');
    await expect(commandInput(page)).toHaveValue('ros2   run tf2_ros  tf2_echo "world" turtle1');
  });

  test('Contestar: my answer becomes Correto (aceito por você) and goes to Aceitas', async ({ page }) => {
    await page.goto(studyUrl('ROS 2 — Revisão'));
    await shown(page, 'question');
    const mine = 'ros2 run tf2_ros tf2_echo world turtle1 --ros-args -r __node:=eco';
    await commandInput(page).fill(mine);
    await commandInput(page).press('Enter');
    await expect(verdict(page)).not.toHaveText('Correto');
    await page.getByRole('button', { name: 'Contestar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Aceitar minha resposta' });
    await expect(dialog.getByLabel('Adicionar às respostas aceitas')).toBeChecked();
    await dialog.getByTestId('code-contest-confirm').click();
    await expect(verdict(page)).toHaveText('Correto (aceito por você)');
    await expect(rating(page, /^Bom/)).toHaveAttribute('data-suggested', 'true');
    const log = (await ankiLogs(page)).find((l) => l.kind === 'codeAcceptAnswer');
    expect(log).toMatchObject({ answer: mine, target: 'field' });
    const fields = await page.evaluate(
      (id) => (window as unknown as MockWindow).__leitorMock.anki.noteFields(id),
      log!.noteId as number,
    );
    expect(fields['Aceitas']).toContain('__node:=eco');
  });

  test('a user type with the Comando role is studied interactively; extras go to code_note_extra', async ({ page }) => {
    await openDeck(page, 'ROS 2 — Revisão', 'deck:"ROS 2 — Revisão" -note:"ROS 2 · Digite o comando"');
    await shown(page, 'question');
    // Without the role: the type's own front, no code panel.
    await expect(page.frameLocator('iframe[title="Card"]').locator('textarea#cmd')).toHaveCount(1);
    await expect(panel(page)).toHaveCount(0);

    await page.evaluate(() =>
      (window as unknown as MockWindow).__leitorMock.anki.mapCommand('ROS 2 · Digite o comando', {
        question: 'Frente',
        answer: 'Comando',
        notes: 'Explicação',
      }),
    );
    await page.reload();
    await shown(page, 'question');
    await expect(page.frameLocator('iframe[title="Card"]').locator('textarea#cmd')).toHaveCount(0);
    await commandInput(page).fill('ros2 run tf2_ros tf2_echo world turtle1 -h');
    await commandInput(page).press('Enter');
    await expect(verdict(page)).toBeVisible();
    // The answer side is the type's own back (with its Explicação, so the panel doesn't repeat it).
    await shown(page, 'answer');
    await expect(page.frameLocator('iframe[title="Card"]').locator('pre.cmd')).toContainText('tf2_echo');
    await expect(page.getByTestId('code-notes')).toHaveCount(0);
    await page.getByRole('button', { name: 'Contestar' }).click();
    await page.getByTestId('code-contest-confirm').click();
    await expect(verdict(page)).toHaveText('Correto (aceito por você)');
    const log = (await ankiLogs(page)).find((l) => l.kind === 'codeAcceptAnswer');
    expect(log).toMatchObject({ target: 'extra' });
    const extra = await page.evaluate(
      (id) => (window as unknown as MockWindow).__leitorMock.anki.codeExtra(id),
      log!.noteId as number,
    );
    expect(extra.accepted).toEqual(['ros2 run tf2_ros tf2_echo world turtle1 -h']);
  });

  test('"Pedir avaliação da IA" with AI off points to the settings and never answers the card', async ({ page }) => {
    await page.goto(studyUrl('ROS 2 — Revisão'));
    await shown(page, 'question');
    await commandInput(page).fill('ls -la');
    await commandInput(page).press('Enter');
    await expect(verdict(page)).toHaveText('Errado');
    await expect(rating(page, /^De novo/)).toHaveAttribute('data-suggested', 'true');
    await page.getByRole('button', { name: 'Pedir avaliação da IA' }).click();
    await expect(page.getByTestId('ai-error')).toHaveAttribute('data-code', 'ai_disabled');
    await expect(page.getByRole('button', { name: 'Abrir Configurações → IA' })).toBeVisible();
    expect(await answers(page)).toHaveLength(0);
  });
});

test.describe('C++ cards (mock core)', () => {
  test.beforeEach(async ({ page }) => {
    await stubPdfcraft(page);
  });

  test('testes: Correto with the tests list; a wrong answer fails them; a compile error', async ({ page }) => {
    await openDeck(page, 'Programação', 'deck:Programação -quadrado');
    await shown(page, 'question');
    await expect(panel(page).getByTestId('code-editor')).toHaveAttribute('data-language', 'cpp');
    await typeInEditor(page, 'int quadrado(int x) { return x * x; }');
    await page.keyboard.press('Control+Enter');
    await expect(verdict(page)).toHaveText('Correto');
    await expect(page.getByTestId('code-tests-summary')).toHaveText('2 de 2 testes passaram');
    await expect(rating(page, /^Bom/)).toHaveAttribute('data-suggested', 'true');

    await page.goto(studyUrl('Programação', 'int quadrado(int x) { return x + x; }'));
    await expect(verdict(page)).toHaveText('Errado');
    await expect(page.getByTestId('code-tests-summary')).toHaveText('0 de 2 testes passaram');

    await page.goto(studyUrl('Programação', 'int quadrado(int x) { SYNTAX_ERROR }'));
    await expect(verdict(page)).toHaveText('Errado');
    await expect(page.getByTestId('code-compile')).toContainText("expected ';'");
  });

  test('saida: the output compared line by line', async ({ page }) => {
    await openDeck(page, 'Programação', 'deck:Programação -mundo');
    await shown(page, 'question');
    await typeInEditor(page, '#include <iostream>\nint main() { std::cout << "Olá, mundo!\\n"; }');
    await page.getByRole('button', { name: 'Verificar' }).click();
    await expect(verdict(page)).toHaveText('Correto');
    await expect(page.getByTestId('code-output')).toContainText('A saída é igual à esperada.');

    await page.goto(studyUrl('Programação', '#include <iostream>\nint main() { std::cout << "Oi, mundo!\\n"; }'));
    await expect(verdict(page)).toHaveText('Errado');
    await expect(page.getByTestId('code-line-diff')).toContainText('Oi, mundo!');
  });

  test('a run past the time limit is Errado with "Tempo esgotado"; without a compiler, estrutura', async ({ page }) => {
    await openDeck(page, 'Programação', 'deck:Programação -quadrado');
    await page.goto(studyUrl('Programação', 'int quadrado(int x) { while (true) {} return x; }'));
    await expect(verdict(page)).toHaveText('Errado');
    await expect(page.getByTestId('code-notice')).toHaveText('Tempo esgotado (10 s)');

    await setCppAvailable(page, false);
    await page.goto(studyUrl('Programação', 'int quadrado(int x) {\n  // x²\n  return x*x;\n}'));
    await expect(verdict(page)).toHaveText('Equivalente');
    await expect(page.getByTestId('code-notice')).toHaveText(
      'Sem compilador de C++ neste computador: comparando a estrutura.',
    );
  });
});

test.describe('mini-review', () => {
  test.beforeEach(async ({ page }) => {
    await fakePdfcraft(page);
  });

  test('a code card in "Revisar aqui": the panel adapts to the book panel width', async ({ page }) => {
    await page.goto('/biblioteca');
    await page.waitForFunction(() => !!(window as unknown as Partial<MockWindow>).__leitorMock);
    const uid = await page.evaluate(() => {
      const m = (window as unknown as MockWindow).__leitorMock;
      m.anki.moveCards('tf2_echo note:"Código · Comando"', 'Livros::Animal Farm');
      return m.books.find((b) => b.title === 'Animal Farm')!.bookUid;
    });
    await page.goto(`/leitor?livro=${uid}`);
    await fakeFrame(page);
    const bookPanel = page.getByTestId('book-panel');
    await expect(bookPanel).toHaveAttribute('data-open', 'true');
    await bookPanel
      .getByRole('button', { name: /^Revisar aqui/ })
      .first()
      .click();
    const mini = page.getByRole('region', { name: 'Revisão rápida' });
    const input = mini.getByTestId('code-command-input');
    await expect(input).toBeVisible();
    const box = await mini.getByTestId('code-panel').boundingBox();
    const outer = await mini.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(outer!.width + 1);
    await input.fill('ros2 run tf2_ros tf2_echo world turtle1');
    await input.press('Enter');
    await expect(mini.getByTestId('code-verdict')).toHaveText('Correto');
    await expect(mini.getByRole('button', { name: /^Bom/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await answers(page)).map((a) => a.rating)).toEqual([3]);
  });
});

for (const theme of ['light', 'dark'] as const) {
  test(`code review screenshots (${theme})`, async ({ page }, info) => {
    await stubPdfcraft(page);
    await setAppTheme(page, theme);
    await page.goto(studyUrl('ROS 2 — Revisão'));
    await shown(page, 'question');
    await page.waitForTimeout(150);
    await page.screenshot({ path: shot(`codigo-comando-pergunta-${theme}`, info.project.name) });
    await commandInput(page).fill('ros2 run tf2_ros tf2_eco world turtle1');
    await commandInput(page).press('Enter');
    await expect(verdict(page)).toHaveText('Quase');
    await shown(page, 'answer');
    await page.waitForTimeout(150);
    await page.screenshot({ path: shot(`codigo-comando-quase-${theme}`, info.project.name) });

    await openDeck(page, 'Programação', 'deck:Programação -quadrado', 'int quadrado(int x) { return x + x; }');
    await expect(verdict(page)).toHaveText('Errado');
    await page.waitForTimeout(150);
    await page.screenshot({ path: shot(`codigo-cpp-testes-${theme}`, info.project.name) });

    // A phone-sized window: the panel stacks under the card and scrolls.
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(studyUrl('Programação', 'int quadrado(int x) { return x + x; }'));
    await expect(verdict(page)).toHaveText('Errado');
    const body = page.getByTestId('study-body');
    const overflow = await body.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.waitForTimeout(150);
    await page.screenshot({ path: shot(`codigo-cpp-390-${theme}`, info.project.name) });
  });
}
