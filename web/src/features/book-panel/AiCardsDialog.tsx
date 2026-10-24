// "Criar cards com IA" (spec 10.3, Appendix C.4): the type and how many → the estimated cost → the proposals with
// checkboxes → "Adicionar selecionados" into the deck the card form would use, each card with the Fonte of the
// selection. Only the passage is sent (no title, no page); nothing is saved until the user adds.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button, Checkbox, Dialog, Field, Input, SegmentedControl, useToast } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { core } from '../../lib/core/client';
import { q } from '../../lib/core/queries';
import type { AiCardKind, AiCardProposal, BookCardKind } from '../../lib/core/types';
import { AiStateHint } from '../ai/AiStateHint';
import { AiErrorNotice, useAiCall } from '../ai/useAiCall';
import { errorMessage } from '../anki/decks/DeckDialogs';
import { DeckPicker } from '../anki/shared/DeckPicker';
import { bookCardsKey, bookPanelKey, bookPanelPageKey } from './BookPanelContent';
import { defaultDeck, KINDS, noteFields, type CardSelection } from './CardForm';
import { fonteHtml, fonteHtmlSection, fonteQuery } from './fonte';
import { usd } from '../settings/AiSettings';

const AI_KINDS: AiCardKind[] = ['basico', 'cloze', 'comando', 'programa'];

/** The app card type of each AI kind, and the field each answer field fills. */
const TARGET: Record<AiCardKind, { kind: BookCardKind; fields: Record<string, string> }> = {
  basico: { kind: 'basic', fields: { frente: 'Frente', verso: 'Verso' } },
  cloze: { kind: 'cloze', fields: { texto: 'Texto' } },
  comando: { kind: 'codeCommand', fields: { pergunta: 'Pergunta', resposta: 'Resposta', observacao: 'Observação' } },
  programa: { kind: 'codeProgram', fields: { pergunta: 'Pergunta', linguagem: 'Linguagem', resposta: 'Resposta' } },
};

/** The note's field values by name (the card form's names), from a proposal. */
export function proposalValues(kind: AiCardKind, p: AiCardProposal): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [from, to] of Object.entries(TARGET[kind].fields)) values[to] = p.fields[from] ?? '';
  if (kind === 'programa') values.Modo = 'estrutura';
  return values;
}

export function AiCardsDialog({
  bookUid,
  title,
  selection,
  onClose,
}: {
  bookUid: string;
  title: string;
  selection: CardSelection;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const ai = useAiCall();
  const [kind, setKind] = useState<AiCardKind>('basico');
  const [count, setCount] = useState('3');
  const n = Math.max(1, Math.min(10, Math.trunc(Number(count)) || 1));
  const [proposals, setProposals] = useState<{ kind: AiCardKind; cards: AiCardProposal[] } | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<'propose' | 'add' | null>(null);
  const [deckId, setDeckId] = useState<number | null>(null);

  const info = useQuery({
    queryKey: bookPanelPageKey(bookUid, selection.page),
    queryFn: () => core.bookPanelInfo(bookUid, selection.page),
  });
  const notetypes = useQuery(q.notetypes());
  const defaults = useQuery({ queryKey: ['anki', 'addDefaults', null], queryFn: () => core.ankiAddDefaults(null) });
  const estimate = useQuery({
    queryKey: ['ai', 'estimate', 'cards', selection.text, kind, n],
    queryFn: () => core.aiEstimate({ feature: 'cards', text: selection.text, kind, n }),
    staleTime: 0,
    retry: false,
  });
  const target = TARGET[proposals?.kind ?? kind];
  const effectiveDeck =
    deckId ?? (info.data ? defaultDeck(target.kind, info.data, defaults.data?.deckId ?? null) : null);

  async function propose() {
    setBusy('propose');
    setError(null);
    try {
      const cards = await ai.run((confirmed) => core.aiCardsFromText(selection.text, kind, n, confirmed));
      if (cards) {
        setProposals({ kind, cards });
        setChosen(new Set(cards.map((_, i) => i)));
        void qc.invalidateQueries({ queryKey: ['ai', 'usage'] });
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    if (!proposals || effectiveDeck === null) return;
    const notetype = notetypes.data?.find((nt) => nt.appType === KINDS[target.kind].appType);
    if (!notetype) {
      toast.show(t('bookPanel.ai.prepare'), { tone: 'error' });
      return;
    }
    const page1 = selection.page + 1;
    const fonte =
      selection.unit === 'chapter'
        ? fonteHtmlSection(bookUid, title, page1, selection.label ?? null, selection.cfi ?? null, fonteQuery(selection.text))
        : fonteHtml(bookUid, title, page1, fonteQuery(selection.text));
    setBusy('add');
    let added = 0;
    try {
      for (const [i, card] of proposals.cards.entries()) {
        if (!chosen.has(i)) continue;
        const values = proposalValues(proposals.kind, card);
        const fields = noteFields(target.kind, notetype, values, fonte);
        // The command's Observação is not in the card form: set it by name.
        const obs = notetype.fields.findIndex((f) => f.name === 'Observação');
        if (obs >= 0 && values['Observação']) fields[obs] = values['Observação'];
        await core.ankiNoteAdd({
          notetypeId: notetype.id,
          deckId: effectiveDeck,
          fields,
          tags: [...new Set(['leitor', 'ia', ...card.tags])],
        });
        added += 1;
      }
      toast.show(added === 1 ? t('bookPanel.ai.addedOne') : t('bookPanel.ai.added', { n: added }), {
        tone: 'success',
      });
      void qc.invalidateQueries({ queryKey: bookCardsKey(bookUid) });
      void qc.invalidateQueries({ queryKey: bookPanelKey(bookUid) });
      void qc.invalidateQueries({ queryKey: ['anki'] });
      onClose();
    } catch (e) {
      toast.show(t('bookPanel.ai.addFailed', { erro: errorMessage(e) }), { tone: 'error' });
      if (added > 0) onClose();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && busy === null && onClose()}
      title={t('bookPanel.ai.title')}
      description={t('bookPanel.ai.body')}
      className="sm:w-[min(640px,calc(100vw-32px))]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
            {t('common.cancel')}
          </Button>
          {proposals ? (
            <Button
              variant="primary"
              loading={busy === 'add'}
              disabled={chosen.size === 0 || effectiveDeck === null}
              onClick={() => void add()}
              data-testid="ai-cards-add"
            >
              {t('bookPanel.ai.add', { n: chosen.size })}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={Sparkles}
              loading={busy === 'propose'}
              onClick={() => void propose()}
              data-testid="ai-cards-propose"
            >
              {t('bookPanel.ai.propose')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 pb-2">
        <blockquote className="max-h-28 overflow-auto rounded-ctl border border-line bg-surface px-2.5 py-1.5 text-sm">
          {selection.text}
        </blockquote>
        {!proposals && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted">{t('bookPanel.ai.kind')}</span>
              <SegmentedControl<AiCardKind>
                label={t('bookPanel.ai.kind')}
                size="sm"
                value={kind}
                onChange={setKind}
                options={AI_KINDS.map((k) => ({ value: k, label: t(`bookPanel.ai.kind.${k}` as MessageKey) }))}
              />
            </div>
            <Field label={t('bookPanel.ai.count')}>
              {({ id }) => (
                <Input
                  id={id}
                  inputMode="numeric"
                  className="w-20"
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                />
              )}
            </Field>
          </div>
        )}
        {!proposals && estimate.data && (
          <p className="text-xs text-muted" data-testid="ai-cards-estimate">
            {t('ai.cost', { custo: usd(estimate.data.worstUsd) })}
          </p>
        )}
        <AiStateHint fn="enrich" />
        {proposals &&
          (proposals.cards.length === 0 ? (
            <p className="text-base text-muted">{t('bookPanel.ai.none')}</p>
          ) : (
            <>
              <p className="text-xs text-muted">{t('bookPanel.ai.proposals')}</p>
              <ul className="flex flex-col gap-2" data-testid="ai-cards-list">
                {proposals.cards.map((card, i) => (
                  <li key={i} className="flex items-start gap-2 rounded-ctl border border-line px-2.5 py-2">
                    <Checkbox
                      checked={chosen.has(i)}
                      label={<span className="sr-only">{t('bookPanel.ai.pick', { n: i + 1 })}</span>}
                      onChange={(e) =>
                        setChosen((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(i);
                          else next.delete(i);
                          return next;
                        })
                      }
                    />
                    <dl className="min-w-0 flex-1 text-sm">
                      {Object.entries(proposalValues(proposals.kind, card))
                        .filter(([, v]) => v.trim() !== '')
                        .map(([name, v]) => (
                          <div key={name} className="flex gap-2">
                            <dt className="w-20 shrink-0 text-xs text-muted">{name}</dt>
                            <dd className="min-w-0 flex-1 break-words whitespace-pre-wrap">{v}</dd>
                          </div>
                        ))}
                    </dl>
                  </li>
                ))}
              </ul>
              <DeckPicker label={t('bookPanel.form.deck')} value={effectiveDeck} onChange={setDeckId} />
            </>
          ))}
        {error !== null && <AiErrorNotice error={error} onDismiss={() => setError(null)} onOpenSettings={onClose} />}
      </div>
      {ai.dialog}
    </Dialog>
  );
}
