// Phase 4 acceptance (spec 6.2, 10.2, 21) with the REAL PdfCraft web build: text selected in PdfCraft reaches the
// app (`pdfcraft:selection`, debounced), the app's items show in PdfCraft's own selection menus (`menu-items`,
// `menu-shown`, `menu`), the card form opens prefilled, Ctrl+Enter adds a Básico and a Cloze with the Fonte link,
// the shortcuts (Alt+C anywhere, Ctrl+Shift+N only outside PdfCraft), and "Abrir no livro" / `leitor://` deep links
// land on the page with the passage found (`pdfcraft:goto` → `pdfcraft:found`). No fixed coordinates: the text is
// located in a screenshot of the iframe; no sleeps: PdfCraft frames are awaited with `pdfcraftFrames`, and clicks and
// drags go through `pdfcraftClick`/`selectByDrag` (helpers.ts).
import type { Page } from '@playwright/test';
import {
  absNow,
  expect,
  fromHost,
  fromPdfcraft,
  importBytes,
  now,
  pdfcraftClick,
  pdfcraftFrame,
  pdfcraftFrames,
  selectByDrag,
  test,
  waitForMessage,
  type Logged,
} from './helpers';

const PHRASE = 'the windmill was finished in autumn';
const TITLE = 'Windmill test';
type Rect = [number, number, number, number];

// ---------------------------------------------------------------- the fixture PDF

/** Page fill: a light yellow no PdfCraft chrome uses, so the page is easy to find in a screenshot. */
const PAGE_RGB = [255, 240, 199] as const;
const PAGE_W = 300;
const PAGE_H = 110;
const FONT = 14;

/**
 * A small PDF of short, wide pages (so PdfCraft's first view shows them large) filled with PAGE_RGB, with dark
 * Helvetica text. Page 1: PHRASE on one line; page 2: filler; page 3: PHRASE split over two lines.
 */
function windmillPdf(): Uint8Array {
  const pages: string[][] = [
    [PHRASE],
    ['Snowball and Napoleon argued about it'],
    ['the windmill was', 'finished in autumn'],
  ];
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ');
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  const [r, g, b] = PAGE_RGB.map((c) => (c / 255).toFixed(4));
  pages.forEach((lines, i) => {
    let s = `${r} ${g} ${b} rg 0 0 ${PAGE_W} ${PAGE_H} re f\n0 0 0 rg\nBT\n/F1 ${FONT} Tf\n${FONT + 4} TL\n20 ${PAGE_H - 20 - FONT} Td\n`;
    for (const line of lines) s += `(${line}) Tj\nT*\n`;
    s += 'ET\n';
    objs[4 + 2 * i] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`;
    objs[5 + 2 * i] = `<< /Length ${s.length} >>\nstream\n${s}endstream`;
  });
  objs.push(`<< /Title (${TITLE}) /Producer (Leitor de Estudos e2e) >>`);
  const info = objs.length - 1;
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff);
}

// ---------------------------------------------------------------- locating the text on screen

interface Located {
  /** Page 1 on screen (page CSS px). */
  page: { x0: number; y0: number; x1: number; y1: number };
  /** The dark text pixels of page 1 (page CSS px). */
  text: { x0: number; y0: number; x1: number; y1: number };
}

/** Finds page 1 (the first band of PAGE_RGB pixels) and the dark text on it, in a screenshot of the iframe. */
async function locate(page: Page): Promise<Located | null> {
  const el = await pdfcraftFrame(page).frameElement();
  const box = await el.boundingBox();
  if (!box) return null;
  const png = await el.screenshot();
  const found = await page.evaluate(
    async ({ b64, rgb }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
      const [pr, pg, pb] = rgb as [number, number, number];
      const near = (i: number) =>
        Math.abs(data[i]! - pr) <= 10 && Math.abs(data[i + 1]! - pg) <= 10 && Math.abs(data[i + 2]! - pb) <= 14;
      // Rows with a run of page color; page 1 is the first band of them.
      let y0 = -1;
      let y1 = -1;
      let x0 = width;
      let x1 = -1;
      for (let y = 0; y < height; y++) {
        let count = 0;
        let left = width;
        let right = -1;
        for (let x = 0; x < width; x++) {
          if (near((y * width + x) * 4)) {
            count++;
            left = Math.min(left, x);
            right = x;
          }
        }
        if (count >= 40) {
          if (y0 < 0) y0 = y;
          y1 = y;
          x0 = Math.min(x0, left);
          x1 = Math.max(x1, right);
        } else if (y0 >= 0) break;
      }
      if (y0 < 0) return null;
      let tx0 = width;
      let ty0 = height;
      let tx1 = -1;
      let ty1 = -1;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = (y * width + x) * 4;
          if (data[i]! + data[i + 1]! + data[i + 2]! < 300) {
            tx0 = Math.min(tx0, x);
            tx1 = Math.max(tx1, x);
            ty0 = Math.min(ty0, y);
            ty1 = Math.max(ty1, y);
          }
        }
      }
      if (tx1 < 0) return null;
      return { width, page: [x0, y0, x1, y1], text: [tx0, ty0, tx1, ty1] };
    },
    { b64: png.toString('base64'), rgb: [...PAGE_RGB] },
  );
  if (!found) return null;
  const k = box.width / found.width;
  const map = ([a, b, c, d]: number[]) => ({
    x0: box.x + a! * k,
    y0: box.y + b! * k,
    x1: box.x + (c! + 1) * k,
    y1: box.y + (d! + 1) * k,
  });
  return { page: map(found.page), text: map(found.text) };
}

async function locateText(page: Page): Promise<Located> {
  let at: Located | null = null;
  await expect
    .poll(
      async () => {
        at = await locate(page);
        // The whole phrase drawn: a wide, short dark box.
        return !!at && at.text.x1 - at.text.x0 > 4 * (at.text.y1 - at.text.y0);
      },
      { timeout: 60_000, message: 'PdfCraft draws page 1 with the phrase' },
    )
    .toBe(true);
  return at!;
}

// ---------------------------------------------------------------- driving PdfCraft

const collapse = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

async function selections(page: Page, after: number): Promise<Logged[]> {
  return (await fromPdfcraft(page)).filter((m) => m.type === 'pdfcraft:selection' && m.at >= after);
}

/**
 * Drags across the phrase on page 1 (selectByDrag: frame by frame, made again once if the gesture was lost) and
 * returns the selection PdfCraft reported, with what the debounce test needs about the attempt that made it.
 */
async function selectPhrase(
  page: Page,
  uid: string,
  at: Located,
): Promise<{ msg: Logged; during: number; lastMoveAbs: number; earlyDuring: number }> {
  // PdfCraft reports changes only: start from no selection.
  if (await page.evaluate(() => window.__leitor!.state().selection !== null)) await clickBlank(page, at);
  const y = (at.text.y0 + at.text.y1) / 2;
  let during = 0;
  let lastMoveAbs = 0;
  let earlyDuring = 0;
  const msg = await selectByDrag(page, uid, at.text.x0 + 1, at.text.x1 - 1, y, (t) => t === PHRASE, {
    description: 'the phrase',
    beforeLastMove: async () => {
      lastMoveAbs = await absNow(page);
    },
    beforeRelease: async (attemptAt) => {
      const beforeUp = await now(page);
      const duringMsgs = (await selections(page, attemptAt)).filter((m) => m.at <= beforeUp);
      during = duringMsgs.length;
      // The debounce runs on PdfCraft's clock (when an egui pass sees the selection change), which the test can't
      // observe: on a slow machine (CI: 4 vCPUs, software WebGL) one drag step can take longer than the 300 ms quiet
      // period, so a message may legitimately arrive mid-drag. What holds at any speed: every message needs 300 ms
      // without a change after a new change, so two consecutive messages are at least ~300 ms apart (250 ms of
      // slack).
      earlyDuring = duringMsgs.slice(1).filter((m, i) => m.abs - duringMsgs[i]!.abs < 250).length;
    },
  });
  return { msg, during, lastMoveAbs, earlyDuring };
}

/** Clicks a blank part of page 2 (the selection bar covers the rest of page 1) and waits for the cleared selection. */
async function clickBlank(page: Page, at: Located) {
  const after = await now(page);
  const height = at.page.y1 - at.page.y0;
  await pdfcraftClick(page, at.page.x0 + 12, at.page.y1 + height * 0.85);
  await expect
    .poll(async () => (await selections(page, after)).some((m) => m.text === ''), {
      timeout: 30_000,
      message: 'cleared pdfcraft:selection',
    })
    .toBe(true);
  await expect.poll(() => page.evaluate(() => window.__leitor!.state().selection)).toBeNull();
}

type Shown = { key: string; rect: Rect }[];

/** The app's items in the latest selection menu PdfCraft showed after `after`, if any. */
async function latestShown(page: Page, after: number): Promise<Shown> {
  const m = (await fromPdfcraft(page))
    .filter((x) => x.type === 'pdfcraft:menu-shown' && x.at >= after && (x.items?.length ?? 0) > 0)
    .at(-1);
  return (m?.items ?? []) as Shown;
}

/**
 * The app's items in the next selection menu PdfCraft shows after `after`, once the menu stopped moving (an egui
 * popup may be placed again in its first frames; PdfCraft reports every move).
 */
async function menuShown(page: Page, after: number): Promise<Shown> {
  await expect
    .poll(async () => (await latestShown(page, after)).map((i) => i.key), {
      timeout: 30_000,
      message: 'pdfcraft:menu-shown with the app items',
    })
    .toEqual(['card', 'ai', 'define']);
  let items = await latestShown(page, after);
  for (let i = 0; i < 10; i++) {
    await pdfcraftFrames(page, 3);
    const again = await latestShown(page, after);
    if (JSON.stringify(again) === JSON.stringify(items)) break;
    items = again;
  }
  return items;
}

/**
 * Clicks an item PdfCraft reported in `menu-shown` (rects are CSS px relative to the iframe) and waits for its
 * `pdfcraft:menu`. Pointer move, press and release land in separate PdfCraft frames, as a real click does.
 */
async function clickItem(page: Page, items: Shown, key: string, id: string) {
  const box = (await (await pdfcraftFrame(page).frameElement()).boundingBox())!;
  const [x, y, w, h] = items.find((i) => i.key === key)!.rect;
  const after = await now(page);
  await pdfcraftClick(page, box.x + x + w / 2, box.y + y + h / 2);
  await waitForMessage(page, { type: 'pdfcraft:menu', key, id }, { after, timeout: 30_000 });
}

const form = (page: Page) => page.getByRole('form', { name: 'Novo card' });

/** Closes the card form if it is open (Esc inside it). */
async function closeForm(page: Page) {
  if ((await form(page).count()) === 0) return;
  // The panel may close it on its own (after an add) while we look: then there is nothing to press.
  await form(page)
    .getByRole('radio')
    .first()
    .press('Escape', { timeout: 5_000 })
    .catch(() => undefined);
  await expect(form(page)).toHaveCount(0);
}

async function addedNotes(page: Page) {
  return page.evaluate(() =>
    window.__leitorMock!.anki.logs.filter((l) => l.kind === 'addNote').map((l) => l.fields as string[]),
  );
}

/**
 * Studying "Default" before the import makes it Anki's current deck, so the cards made from the selection land
 * there (the form's default deck for a book without one) and studying it later shows only them.
 */
async function openWindmill(page: Page): Promise<{ uid: string; at: Located }> {
  await page.goto('/anki/estudar?deck=1');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (JSON.parse(sessionStorage.getItem('leitor.mock.anki') ?? '{}') as { currentDeckId?: number }).currentDeckId,
      ),
    )
    .toBe(1);
  const uid = await importBytes(page, '/home/jorge/Livros/Windmill test.pdf', windmillPdf());
  await waitForMessage(page, { type: 'pdfcraft:active', id: uid });
  const at = await locateText(page);
  return { uid, at };
}

// ---------------------------------------------------------------- tests

test('selection: debounced pdfcraft:selection with the text and page rects; cleared by a click', async ({ page }) => {
  const { uid, at } = await openWindmill(page);
  const sent = (await fromHost(page)).filter((m) => m.type === 'pdfcraft:menu-items');
  expect(sent.length).toBeGreaterThanOrEqual(1);
  expect(sent.at(-1)!.items).toEqual([
    { key: 'card', label: 'Criar card' },
    { key: 'ai', label: 'Criar cards com IA' },
    { key: 'define', label: 'Definir palavra' },
  ]);

  const { msg, during, lastMoveAbs, earlyDuring } = await selectPhrase(page, uid, at);
  // Debounced: never one message per frame of the drag (at most one per move), consecutive messages ~300 ms apart,
  // and the final one ~300 ms after the last move.
  expect(during).toBeLessThanOrEqual(8);
  expect(earlyDuring).toBe(0);
  expect(msg.abs - lastMoveAbs).toBeGreaterThanOrEqual(200);
  expect(msg).toMatchObject({ id: uid, page: 0 });
  expect(msg.rects!.length).toBeGreaterThanOrEqual(1);
  for (const [x, y, w, h] of msg.rects!) {
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + w).toBeLessThanOrEqual(PAGE_W + 0.5);
    expect(y + h).toBeLessThanOrEqual(PAGE_H + 0.5);
  }
  await expect
    .poll(async () => collapse(await page.evaluate(() => window.__leitor!.state().selection?.text)))
    .toBe(PHRASE);

  // A click on a blank part of the next page clears it.
  await clickBlank(page, at);
});

test("the app's items in PdfCraft's selection bar and context menu open the prefilled card form", async ({ page }) => {
  const { uid, at } = await openWindmill(page);
  const selectedAt = await now(page);
  await selectPhrase(page, uid, at);

  // The selection bar beside the text.
  const bar = await menuShown(page, selectedAt);
  await clickItem(page, bar, 'card', uid);
  await expect(form(page)).toBeVisible();
  await expect(form(page).getByLabel('Frente')).toHaveValue(PHRASE);
  await expect(form(page).getByRole('radio', { name: 'Básico' })).toBeChecked();
  await expect(page.getByTestId('card-form-fonte')).toContainText(`${TITLE}, p. 1`);
  await closeForm(page);

  // The right-click menu on the (still selected) text.
  const rightAt = await now(page);
  await pdfcraftClick(page, (at.text.x0 + at.text.x1) / 2, (at.text.y0 + at.text.y1) / 2, { button: 'right' });
  const menu = await menuShown(page, rightAt);
  await clickItem(page, menu, 'card', uid);
  await expect(form(page)).toBeVisible();
  await expect(form(page).getByLabel('Frente')).toHaveValue(PHRASE);
  await closeForm(page);

  // "Criar cards com IA" (10.3): the dialog with the selected passage; AI off says so.
  const aiAt = await now(page);
  await pdfcraftClick(page, (at.text.x0 + at.text.x1) / 2, (at.text.y0 + at.text.y1) / 2, { button: 'right' });
  await clickItem(page, await menuShown(page, aiAt), 'ai', uid);
  const ai = page.getByRole('dialog', { name: 'Criar cards com IA' });
  await expect(ai).toContainText(PHRASE);
  await expect(ai.getByTestId('ai-state')).toHaveText('IA desligada: configure em Configurações → IA.');
  await page.keyboard.press('Escape');
  await expect(ai).toHaveCount(0);

  // "Definir palavra" (12.7) on a phrase: the popover asks for a single word.
  const defineAt = await now(page);
  await pdfcraftClick(page, (at.text.x0 + at.text.x1) / 2, (at.text.y0 + at.text.y1) / 2, { button: 'right' });
  await clickItem(page, await menuShown(page, defineAt), 'define', uid);
  await expect(page.getByRole('dialog', { name: 'Definir palavra' })).toContainText('Selecione uma só palavra.');
});

test('Ctrl+Enter adds a Básico and a Cloze with the Fonte; Alt+C anywhere, Ctrl+Shift+N only outside PdfCraft', async ({
  page,
}) => {
  const { uid, at } = await openWindmill(page);
  const selectedAt = await now(page);
  await selectPhrase(page, uid, at);
  await clickItem(page, await menuShown(page, selectedAt), 'card', uid);
  await expect(form(page)).toBeVisible();
  const fonte = `leitor://livro/${uid}?pagina=1&amp;q=the%20windmill%20was%20finished%20in%20autumn`;

  // Básico: the focus is in the form (Verso); Ctrl+Enter adds.
  await form(page).getByLabel('Verso').fill('O moinho ficou pronto no outono');
  await form(page).getByLabel('Verso').press('Control+Enter');
  await expect(page.getByText('Card adicionado').first()).toBeVisible();
  await expect.poll(async () => (await addedNotes(page)).length).toBe(1);
  const basic = (await addedNotes(page))[0]!;
  expect(basic[0]).toBe(PHRASE);
  expect(basic.some((f) => f.includes(fonte) && f.includes(`${TITLE}, p. 1`))).toBe(true);
  const thisPage = page.getByRole('list', { name: /Cards desta página/ });
  await expect(thisPage.or(page.getByRole('region', { name: /Cards desta página/ })).first()).toContainText(PHRASE);
  await closeForm(page);

  // Cloze, from the panel's button (the last selection): a gap over "windmill", then Ctrl+Enter.
  await page.getByRole('button', { name: /Card da seleção/ }).click();
  await expect(form(page)).toBeVisible();
  await form(page).getByRole('radio', { name: 'Cloze' }).click();
  const texto = form(page).getByLabel('Texto', { exact: true });
  // The seed collection lacks "Cloze (Leitor)": the form offers "Preparar coleção" (spec 9).
  const prepare = form(page).getByRole('button', { name: 'Preparar coleção' });
  await expect(texto.or(prepare).first()).toBeVisible();
  if (await prepare.isVisible()) await prepare.click();
  await expect(texto).toHaveValue(PHRASE);
  await texto.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(4, 12);
  });
  await form(page).getByRole('button', { name: 'Lacuna' }).click();
  await expect(texto).toHaveValue('the {{c1::windmill}} was finished in autumn');
  await texto.press('Control+Enter');
  await expect.poll(async () => (await addedNotes(page)).length).toBe(2);
  const cloze = (await addedNotes(page))[1]!;
  expect(cloze[0]).toContain('{{c1::windmill}}');
  expect(cloze.some((f) => f.includes(fonte))).toBe(true);
  await closeForm(page);

  // Alt+C with the focus inside PdfCraft (forwarded by the reader).
  await selectPhrase(page, uid, at);
  await page.keyboard.press('Alt+c');
  await expect(form(page)).toBeVisible();
  // Prefilled (the form keeps the book's last kind, Cloze now: its first field is Texto).
  await expect(form(page).getByRole('textbox').first()).toHaveValue(PHRASE);
  await closeForm(page);

  // Ctrl+Shift+N with the focus in the panel: the app's "Card da seleção".
  await page.getByRole('button', { name: /Card da seleção/ }).focus();
  await page.keyboard.press('Control+Shift+N');
  await expect(form(page)).toBeVisible();
  await closeForm(page);

  // Ctrl+Shift+N inside PdfCraft is its "Go to page…": the app does nothing.
  await selectPhrase(page, uid, at);
  await page.keyboard.press('Control+Shift+N');
  await pdfcraftFrames(page, 6);
  await expect(form(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.getAttribute('title'))).toBe('PdfCraft');
});

test('Alt+C right after selecting uses the new selection, not the one before the 300 ms debounce', async ({ page }) => {
  const { uid, at } = await openWindmill(page);
  await selectPhrase(page, uid, at);
  // Nothing selected as far as the app knows; then a new selection of the first words and Alt+C at once.
  await clickBlank(page, at);
  const y = (at.text.y0 + at.text.y1) / 2;
  const start = at.text.x0 + 1;
  const end = at.text.x0 + (at.text.x1 - at.text.x0) * 0.4;
  await page.mouse.move(start, y);
  await pdfcraftFrames(page, 2);
  await page.mouse.down();
  await pdfcraftFrames(page, 1);
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(start + ((end - start) * i) / 4, y);
    await pdfcraftFrames(page, 1);
  }
  await page.mouse.up();
  const pressedAbs = await absNow(page);
  await page.keyboard.press('Alt+c');
  await expect(form(page)).toBeVisible();
  const text = await form(page).getByRole('textbox').first().inputValue();
  expect(collapse(text)).not.toBe('');
  expect(PHRASE.startsWith(collapse(text))).toBe(true);
  expect(collapse(text)).not.toBe(PHRASE);
  // The app asked for the selection still in the debounce, and PdfCraft answered.
  expect((await fromHost(page)).some((m) => m.type === 'pdfcraft:selection-now' && m.abs >= pressedAbs)).toBe(true);
  expect((await fromPdfcraft(page)).some((m) => m.type === 'pdfcraft:selection-sent' && m.abs >= pressedAbs)).toBe(
    true,
  );
  await closeForm(page);
});

test('"Abrir no livro" and leitor:// links go to the page and find the passage (also over two lines)', async ({
  page,
}) => {
  const { uid, at } = await openWindmill(page);
  const selectedAt = await now(page);
  await selectPhrase(page, uid, at);
  await clickItem(page, await menuShown(page, selectedAt), 'card', uid);
  await form(page).getByLabel('Verso').fill('O moinho');
  await form(page).getByLabel('Verso').press('Control+Enter');
  await expect.poll(async () => (await addedNotes(page)).length).toBe(1);
  await closeForm(page);

  // Move away from page 1 so the goto has somewhere to go.
  await page.evaluate((id) => window.__leitor!.openBook(id, { page: 2 }), uid);
  await waitForMessage(page, { type: 'pdfcraft:active', id: uid, page: 2 });

  // Study the card in the Anki tab (in-app navigation: PdfCraft keeps the book open) and open it in the book.
  await page.getByRole('navigation', { name: 'Abas' }).getByRole('link', { name: 'Anki' }).click();
  await page.getByRole('tree', { name: 'Decks' }).getByRole('button', { name: 'Default', exact: true }).click();
  await page.getByRole('button', { name: 'Mostrar resposta' }).click();
  const before = await now(page);
  const hostBefore = (await fromHost(page)).length;
  await page.getByRole('button', { name: 'Abrir no livro' }).click();
  await expect(page).toHaveURL(/\/leitor/);
  await expect
    .poll(async () => (await fromHost(page)).slice(hostBefore).filter((m) => m.type === 'pdfcraft:goto'))
    .toEqual([expect.objectContaining({ id: uid, page: 0, find: PHRASE })]);
  // Already open in PdfCraft: no bytes sent again.
  expect((await fromHost(page)).slice(hostBefore).some((m) => m.type === 'pdfcraft:open')).toBe(false);
  await waitForMessage(page, { type: 'pdfcraft:found', id: uid, page: 0, found: true }, { after: before });
  await waitForMessage(page, { type: 'pdfcraft:active', id: uid, page: 0 }, { after: before });
  await expect.poll(() => page.evaluate(() => window.__leitor!.state().page)).toBe(0);

  // The phrase split over two lines on page 3 (PdfCraft falls back to its first words).
  const before3 = await now(page);
  await page.evaluate(({ id, q }) => window.__leitor!.openBook(id, { page: 2, find: q }), { id: uid, q: PHRASE });
  await waitForMessage(page, { type: 'pdfcraft:found', id: uid, page: 2, found: true }, { after: before3 });

  // A leitor:// link opened by the system.
  await page.evaluate((id) => window.__leitor!.openBook(id, { page: 0 }), uid);
  await waitForMessage(page, { type: 'pdfcraft:active', id: uid, page: 0 }, { after: before3 });
  const beforeLink = await now(page);
  await page.evaluate(
    ({ id, q }) => window.__leitorMock!.deepLink(`leitor://livro/${id}?pagina=3&q=${encodeURIComponent(q)}`),
    { id: uid, q: PHRASE },
  );
  await waitForMessage(page, { type: 'pdfcraft:found', id: uid, page: 2, found: true }, { after: beforeLink });
  await expect.poll(() => page.evaluate(() => window.__leitor!.state().page)).toBe(2);
  await expect.poll(() => page.evaluate(() => window.__leitor!.state().found)).toMatchObject({ page: 2, found: true });
  await expect(page.getByText(/O trecho não foi encontrado/)).toHaveCount(0);
});
