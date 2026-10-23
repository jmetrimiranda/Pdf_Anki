import { t } from '../../../i18n';

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Pages whose last part is a file path: it travels as ONE percent-encoded segment (Anki reads `params.path`). */
const PATH_PAGES = ['import-anki-package', 'image-occlusion'] as const;

/**
 * The Anki route for `/anki/pagina/<splat>`, or null when it is not one the app opens there (spec 8.3):
 * `congrats`, `change-notetype/<ntid>[/<ntid>]`, `import-anki-package/<path>`, `image-occlusion/<path or note id>`.
 * The router may hand the splat decoded or not, so path pages are decoded once and re-encoded.
 */
export function ankiPageRoute(splat: string): string | null {
  const clean = splat.replace(/^\/+/, '');
  if (clean === 'congrats') return 'congrats';
  const nt = /^change-notetype\/(\d+)(?:\/(\d+))?\/?$/.exec(clean);
  if (nt) return nt[2] ? `change-notetype/${nt[1]}/${nt[2]}` : `change-notetype/${nt[1]}`;
  for (const page of PATH_PAGES) {
    if (clean.startsWith(`${page}/`)) {
      const arg = safeDecode(clean.slice(page.length + 1));
      return arg ? `${page}/${encodeURIComponent(arg)}` : null;
    }
  }
  return null;
}

/** The `/anki/pagina/$` splat for a page that takes a file path (navigate with `params: { _splat }`). */
export function ankiPathPage(page: (typeof PATH_PAGES)[number], path: string): string {
  return `${page}/${encodeURIComponent(path)}`;
}

/** Header title of an Anki page frame. */
export function ankiPageTitle(route: string): string {
  const page = route.split('/')[0];
  switch (page) {
    case 'graphs':
      return t('anki.page.graphs');
    case 'deck-options':
      return t('anki.page.deckOptions');
    case 'card-info':
      return t('anki.page.cardInfo');
    case 'congrats':
      return t('anki.page.congrats');
    case 'change-notetype':
      return t('anki.page.changeNotetype');
    case 'import-anki-package':
      return t('anki.page.importPackage');
    case 'image-occlusion':
      return t('anki.page.imageOcclusion');
    default:
      return t('tabs.anki');
  }
}
