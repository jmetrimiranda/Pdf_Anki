// Configurações → Sobre: the app version and the credits of the bundled data and programs (spec 12.2: WordNet
// CC BY 4.0, the frequency list and the stopwords as built by scripts/build-wordnet.sh; the OCR models CC BY-SA 4.0;
// Anki AGPL-3.0; PdfCraft MIT/Apache-2.0; foliate-js MIT with zip.js BSD-3-Clause and fflate MIT (the EPUB reader,
// pinned in scripts/fetch-foliate.sh); Pyodide MPL-2.0; CodeMirror MIT).
import { useQuery } from '@tanstack/react-query';
import { BookOpenText } from 'lucide-react';
import { Badge, Card, Skeleton } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import type { VocabDataSource } from '../../lib/core/types';
import { FFLATE_VERSION, FOLIATE_COMMIT, ZIPJS_VERSION } from '../epub/version';
import { vocabQ } from '../vocab/queries';
import tauriConf from '../../../../src-tauri/app/tauri.conf.json';

interface Credit {
  name: string;
  use: MessageKey;
  license: string | null;
  /** From the data pack (`vocab_data_info`): the pinned source. */
  detail?: string | null;
  missing?: boolean;
}

/** "wordfreq (…) 3.1.1": the data set's name and release. */
export function sourceDetail(src: VocabDataSource | null | undefined): string | null {
  return src ? `${src.name} ${src.version.length > 12 ? src.version.slice(0, 7) : src.version}` : null;
}

function CreditRow({ credit }: { credit: Credit }) {
  return (
    <li className="flex flex-col gap-0.5 py-3 first:pt-0 last:pb-0" data-testid="about-credit">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-base font-semibold">{credit.name}</span>
        {credit.license && <Badge>{credit.license}</Badge>}
        {credit.missing && <Badge tone="warning">{t('settings.about.vocabMissing')}</Badge>}
      </div>
      <p className="text-base text-muted">{t(credit.use)}</p>
      {credit.detail && <p className="text-xs text-muted">{credit.detail}</p>}
    </li>
  );
}

export function AboutSettings() {
  const data = useQuery(vocabQ.dataInfo());
  const info = data.data;
  const missing = !!info && !info.available;
  const vocab: Credit[] = [
    {
      name: t('settings.about.wordnet'),
      use: 'settings.about.wordnetUse',
      license: info?.wordnet?.license ?? 'CC-BY-4.0',
      detail: sourceDetail(info?.wordnet),
      missing,
    },
    {
      name: t('settings.about.frequency'),
      use: 'settings.about.frequencyUse',
      license: info?.frequency?.license ?? null,
      detail: sourceDetail(info?.frequency),
      missing,
    },
    {
      name: t('settings.about.stopwords'),
      use: 'settings.about.stopwordsUse',
      license: info?.stopwords?.license ?? null,
      detail: sourceDetail(info?.stopwords),
      missing,
    },
  ];
  const programs: Credit[] = [
    // CC BY-SA asks for the author: Robert Knight's ocrs-models (src-tauri/resources/ocr-models/ATTRIBUTION.txt).
    {
      name: t('settings.about.ocr'),
      use: 'settings.about.ocrUse',
      license: 'CC BY-SA 4.0',
      detail: 'ocrs-models · Robert Knight',
    },
    { name: t('settings.about.anki'), use: 'settings.about.ankiUse', license: 'AGPL-3.0' },
    { name: t('settings.about.pdfcraft'), use: 'settings.about.pdfcraftUse', license: 'MIT / Apache-2.0' },
    {
      name: t('settings.about.foliate'),
      use: 'settings.about.foliateUse',
      license: 'MIT',
      detail: t('settings.about.foliateCommit', { sha: FOLIATE_COMMIT.slice(0, 7) }),
    },
    { name: t('settings.about.zipjs'), use: 'settings.about.zipjsUse', license: 'BSD-3-Clause', detail: ZIPJS_VERSION },
    { name: t('settings.about.fflate'), use: 'settings.about.fflateUse', license: 'MIT', detail: FFLATE_VERSION },
    { name: t('settings.about.pyodide'), use: 'settings.about.pyodideUse', license: 'MPL-2.0' },
    { name: t('settings.about.codemirror'), use: 'settings.about.codemirrorUse', license: 'MIT' },
  ];
  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold">{t('settings.about.title')}</h2>
      </header>
      <Card>
        <div className="flex items-start gap-3">
          <BookOpenText size={20} aria-hidden className="mt-0.5 shrink-0 text-lime-dark" />
          <div className="min-w-0">
            <p className="text-base font-semibold">{t('app.name')}</p>
            <p className="text-base text-muted" data-testid="about-version">
              {t('settings.about.version', { versao: tauriConf.version })}
            </p>
            <p className="mt-1 text-base text-muted">{t('settings.about.tagline')}</p>
          </div>
        </div>
      </Card>
      <Card title={t('settings.about.credits')}>
        <p className="-mt-2 mb-3 text-xs text-muted">{t('settings.about.creditsHint')}</p>
        {data.isPending ? (
          <Skeleton className="h-24" />
        ) : (
          <ul className="divide-y divide-line" aria-label={t('settings.about.credits')}>
            {[...vocab, ...programs].map((c) => (
              <CreditRow key={c.name} credit={c} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
