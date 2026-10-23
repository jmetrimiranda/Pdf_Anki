import type { Page } from '@playwright/test';
import { ankiLogs, expect, setTheme, shot, stubPdfcraft, test } from './fixtures';

// "Adicionar" (spec 8.2) against the mock core: notetype picker, rich fields, cloze with Ctrl+Shift+C, pasted
// images, tags and the duplicate warning. Screenshots: test-results/screens/anki-add-*.png.

// 1×1 PNG.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test.beforeEach(async ({ page }) => {
  await stubPdfcraft(page);
  // Images pasted in the mock are "stored" by name only: serve any of them as the PNG above.
  await page.route('**/__card/colado-*', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG_BASE64, 'base64') }),
  );
});

async function chooseNotetype(page: Page, name: string) {
  await page.getByRole('button', { name: /^Tipo de nota/ }).click();
  await page.getByRole('combobox', { name: 'Buscar tipo de nota' }).fill(name);
  await page.getByRole('option', { name, exact: true }).click();
  await expect(page.getByRole('button', { name: `Tipo de nota ${name}`, exact: true })).toBeVisible();
}

async function pasteImage(page: Page, fieldName: string) {
  const field = page.getByRole('textbox', { name: fieldName });
  await field.click();
  await field.evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: dt });
    el.dispatchEvent(ev);
  }, PNG_BASE64);
}

const addLogs = async (page: Page) => (await ankiLogs(page)).filter((l) => l.kind === 'addNote');

test('adds a Basic note with Ctrl+Enter and keeps notetype, deck and tags', async ({ page }) => {
  await page.goto('/anki/adicionar');
  await chooseNotetype(page, 'Básico');
  await page.getByLabel('Deck').selectOption({ label: 'Oxford::Oxford 3000' });
  await page.getByRole('textbox', { name: 'Frente' }).click();
  await page.keyboard.type('sunflower');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type(' bold');
  await page.getByRole('textbox', { name: 'Verso' }).click();
  await page.keyboard.type('girassol');
  await page.getByRole('combobox', { name: 'Tags' }).fill('plantas');
  await page.keyboard.press('Space');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByText('Card adicionado')).toBeVisible();

  const log = (await addLogs(page)).at(-1)!;
  expect((log.fields as string[])[0]).toMatch(/^sunflower<(b|strong)>(\s|&nbsp;)bold<\/(b|strong)>$/);
  expect(log.fields).toHaveLength(2);
  expect((log.fields as string[])[1]).toBe('girassol');
  expect(log.tags).toEqual(['plantas']);
  // Fields cleared, the rest kept; focus back on the first field.
  await expect(page.getByRole('textbox', { name: 'Frente' })).toHaveText('');
  await expect(page.getByRole('textbox', { name: 'Frente' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Remover a tag plantas' })).toBeVisible();
  await expect(page.getByLabel('Deck')).toHaveValue(String(log.deckId));
});

test('cloze with Ctrl+Shift+C numbers the clozes', async ({ page }) => {
  await page.goto('/anki/adicionar');
  await chooseNotetype(page, 'Omissão de palavras');
  const text = page.getByRole('textbox', { name: 'Texto' });
  await text.click();
  await page.keyboard.type('O ');
  await page.keyboard.press('ControlOrMeta+Shift+KeyC');
  await page.keyboard.type('verbo');
  await page.keyboard.press('End');
  await page.keyboard.type(' concorda com o ');
  await page.keyboard.press('ControlOrMeta+Shift+KeyC');
  await page.keyboard.type('sujeito');
  await page.keyboard.press('End');
  await page.keyboard.type(' e ');
  // Alt variant: same number as the last one.
  await page.keyboard.press('ControlOrMeta+Shift+Alt+KeyC');
  await page.keyboard.type('número');
  await expect(text).toHaveText(/^O\s\{\{c1::verbo\}\}\sconcorda\scom\so\s\{\{c2::sujeito\}\}\se\s\{\{c2::número\}\}$/);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByText('2 cards adicionados')).toBeVisible();
});

test('a pasted image becomes media; duplicates are only a warning', async ({ page }) => {
  await page.goto('/anki/adicionar');
  await chooseNotetype(page, 'Básico');
  await pasteImage(page, 'Frente');
  const img = page.getByRole('textbox', { name: 'Frente' }).locator('img');
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute('data-anki-src', /^colado-\d{8}-\d{6}\.png$/);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  expect((await ankiLogs(page)).some((l) => l.kind === 'mediaAdd')).toBe(true);
  await page.keyboard.type('sol');
  await page.getByRole('textbox', { name: 'Verso' }).click();
  await page.keyboard.type('sun');
  await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
  await expect(page.getByText('Card adicionado')).toBeVisible();
  const front = ((await addLogs(page)).at(-1)!.fields as string[])[0]!;
  // The field stores the bare media name, not the display URL.
  expect(front).toMatch(/^<img src="colado-\d{8}-\d{6}\.png">sol$/);

  // Duplicate first field: a notice, and adding still works.
  await page.getByRole('textbox', { name: 'Frente' }).click();
  await page.keyboard.type('kitchen');
  await expect(page.getByText(/Já existe uma nota deste tipo/)).toBeVisible();
  await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
  await expect.poll(async () => (await addLogs(page)).length).toBe(2);
});

test('pasted HTML is sanitized', async ({ page }) => {
  await page.goto('/anki/adicionar');
  await chooseNotetype(page, 'Básico');
  const front = page.getByRole('textbox', { name: 'Frente' });
  await front.click();
  await front.evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData(
      'text/html',
      '<b onclick="window.__x=1">ok</b><script>window.__x=1</script><img src="https://evil.example/x.png" onerror="window.__x=1">',
    );
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: dt });
    el.dispatchEvent(ev);
  });
  await expect(front.locator('b')).toHaveText('ok');
  expect(await front.evaluate((el) => el.innerHTML)).not.toMatch(/onclick|script|onerror/);
  // Remote images are kept in the field but never fetched by the editor.
  await expect(front.locator('img')).not.toHaveAttribute('src', /.*/);
  expect(await page.evaluate(() => (window as unknown as { __x?: number }).__x)).toBeUndefined();
});

for (const theme of ['light', 'dark'] as const) {
  test(`add screen screenshots (${theme})`, async ({ page }, info) => {
    await setTheme(page, theme);
    await page.goto('/anki/adicionar');
    await chooseNotetype(page, 'Básico (Leitor)');
    await page.getByRole('textbox', { name: 'Frente' }).click();
    await page.keyboard.type('What did the animals build on the knoll?');
    await page.getByRole('textbox', { name: 'Verso' }).click();
    await page.keyboard.type('A ');
    await page.keyboard.press('ControlOrMeta+b');
    await page.keyboard.type('windmill');
    await page.getByRole('combobox', { name: 'Tags' }).fill('livro::animal-farm ');
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    await page.screenshot({ path: shot(`anki-add-${theme}`, info.project.name) });

    await page.getByRole('button', { name: /^Tipo de nota/ }).click();
    await expect(page.getByRole('group', { name: 'Do Leitor' })).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: shot(`anki-add-notetypes-${theme}`, info.project.name) });
    await page.keyboard.press('Escape');

    await chooseNotetype(page, 'Código · Comando');
    await page.getByRole('textbox', { name: 'Pergunta' }).click();
    await page.keyboard.type('Listar os nós ativos');
    await page.getByRole('textbox', { name: 'Resposta' }).fill('ros2 node list\nros2 node info /talker');
    await page.setViewportSize({ width: 720, height: 900 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: shot(`anki-add-code-narrow-${theme}`, info.project.name) });
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.getByText('Card adicionado')).toBeVisible();
    const log = (await addLogs(page)).at(-1)!;
    expect((log.fields as string[])[1]).toBe('ros2 node list<br>ros2 node info /talker');
  });
}
