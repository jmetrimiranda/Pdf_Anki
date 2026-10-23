// The popover over a highlighted word (spec 12.7): `pdfcraft:mark-click` → the lemma, its status, a definition (the
// user's note, else WordNet; AI in a later phase), the family it derives from, and "Adicionar ao deck do livro",
// "Já sei", "Nome próprio". Shown over the PdfCraft iframe where the word is; same surface as "Definir palavra".
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button, SkeletonLines, useToast } from '../../components/ui';
import { cn } from '../../lib/cn';
import { t } from '../../i18n';
import { core } from '../../lib/core/client';
import type { VocabOverride } from '../../lib/core/types';
import { errorMessage } from '../anki/decks/DeckDialogs';
import { AnchoredPopover } from '../book-panel/PanelDialogs';
import type { MarkClick } from './controller';
import { leitor } from './instance';

/** The PdfCraft iframe, where the focus goes back when the popover closes. */
function pdfcraftFrame(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('iframe[title="PdfCraft"]');
}

/** After a change in the core: fresh marks, panel, report and the book's cards. */
export function vocabChanged(qc: QueryClient, uid: string) {
  leitor.refreshVocab(uid);
  void qc.invalidateQueries({ queryKey: ['bookPanel', uid] });
  void qc.invalidateQueries({ queryKey: ['bookCards', uid] });
  void qc.invalidateQueries({ queryKey: ['vocabDefine'] });
  void qc.invalidateQueries({
    predicate: (q) =>
      typeof q.queryKey[0] === 'string' && /^vocab/.test(q.queryKey[0]) && q.queryKey[0] !== 'vocabDefine',
  });
}

export function VocabPopover({ click, onClose }: { click: MarkClick | null; onClose: () => void }) {
  return (
    <AnchoredPopover
      anchor={click?.anchor ?? null}
      onClose={onClose}
      label={t('vocabReading.popover')}
      testId="vocab-anchor"
      returnFocus={pdfcraftFrame}
    >
      {click && <VocabBody key={`${click.id}:${click.page}:${click.index}`} click={click} onClose={onClose} />}
    </AnchoredPopover>
  );
}

type Action = 'add' | 'known' | 'proper';

function VocabBody({ click, onClose }: { click: MarkClick; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { mark, id: uid, page } = click;
  const [busy, setBusy] = useState<Action | null>(null);
  // A phrase (phrasal verb) is defined by the form it has on the page.
  const word = /\s/.test(mark.lemma) ? mark.form : mark.lemma;
  const def = useQuery({
    queryKey: ['vocabDefine', word, uid],
    queryFn: () => core.vocabDefine(word, uid),
    staleTime: 0,
  });

  const run = async (action: Action) => {
    if (busy) return;
    setBusy(action);
    try {
      if (action === 'add') {
        const added = await core.vocabAddWord(uid, mark.lemma, page, mark.form);
        toast.show(t('vocabReading.added', { deck: added.deckName }), { tone: 'success' });
        void qc.invalidateQueries({ queryKey: ['anki'] });
      } else {
        const status: VocabOverride = action;
        await core.vocabOverrideSet([mark.lemma], status);
        toast.show(
          t(action === 'known' ? 'vocabReading.markedKnown' : 'vocabReading.markedProper', { lema: mark.lemma }),
          {
            tone: 'success',
          },
        );
      }
      vocabChanged(qc, uid);
      onClose();
    } catch (e) {
      toast.show(t('vocabReading.actionFailed', { erro: errorMessage(e) }), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const d = def.data;
  const showForm = mark.form.toLowerCase() !== mark.lemma.toLowerCase();
  const definition = d?.note?.definition || d?.wordnetDefinition || null;
  const fromNote = !!d?.note?.definition;
  return (
    <div data-testid="vocab-popover" className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-md font-semibold break-words">{mark.lemma}</p>
          {showForm && <p className="text-xs text-muted">{t('vocabReading.form', { forma: mark.form })}</p>}
        </div>
        <StatusBadge status={mark.status} />
      </div>
      {def.isPending ? (
        <SkeletonLines lines={2} />
      ) : def.isError ? (
        <p className="text-base text-muted">{t('vocabReading.defineFailed')}</p>
      ) : definition ? (
        <div className="flex flex-col gap-0.5 rounded-ctl bg-surface px-2.5 py-2">
          <p data-testid="vocab-definition" className="text-base break-words">
            {definition}
          </p>
          <p className="truncate text-xs text-muted">
            {fromNote ? t('vocabReading.fromDeck', { deck: d!.note!.deckName }) : t('vocabReading.fromWordnet')}
          </p>
        </div>
      ) : (
        <p className="text-base text-muted">{t('vocabReading.noDefinition')}</p>
      )}
      {d?.family && (
        <p data-testid="vocab-family" className="text-base">
          {t('vocabReading.family', {
            familia: `${d.family.lemma}${d.family.status === 'known' ? ' ✓' : ''}`,
          })}
        </p>
      )}
      <p className="text-2xs text-muted">{t('vocabReading.aiSoon')}</p>
      <div className="flex flex-col gap-1.5 border-t border-line pt-2">
        {mark.status === 'unknown' && (
          <Button
            size="sm"
            variant="primary"
            icon={Plus}
            className="w-full"
            disabled={busy !== null}
            onClick={() => void run('add')}
          >
            {t('vocabReading.add')}
          </Button>
        )}
        <div className="flex gap-1.5">
          <Button size="sm" className="flex-1" disabled={busy !== null} onClick={() => void run('known')}>
            {t('vocabReading.known')}
          </Button>
          <Button size="sm" className="flex-1" disabled={busy !== null} onClick={() => void run('proper')}>
            {t('vocabReading.proper')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** "desconhecida" in coral, "aprendendo" in amber: the colors of the underlines (spec 4). */
function StatusBadge({ status }: { status: MarkClick['mark']['status'] }) {
  const unknown = status === 'unknown';
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-2xs font-semibold whitespace-nowrap',
        unknown
          ? 'bg-[color-mix(in_srgb,var(--vocab-unknown)_14%,transparent)] text-(--vocab-unknown)'
          : 'bg-[color-mix(in_srgb,var(--vocab-learning)_14%,transparent)] text-(--vocab-learning)',
      )}
    >
      {unknown ? t('vocabReading.status.unknown') : t('vocabReading.status.learning')}
    </span>
  );
}
