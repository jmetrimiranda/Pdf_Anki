import { BookOpenCheck, Download, Ellipsis, Pencil, Plus, Settings2, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Count, Menu, Tree, type TreeNode } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import type { DeckNode, StudiedToday } from '../../lib/core/types';
import { formatNumber } from '../../lib/format';

function toTree(decks: DeckNode[]): TreeNode<DeckNode>[] {
  return decks.map((d) => ({ id: String(d.id), data: d, children: toTree(d.children) }));
}

function expandedIds(decks: DeckNode[], out: string[] = []): string[] {
  for (const d of decks) {
    if (d.children.length && !d.collapsed) out.push(String(d.id));
    expandedIds(d.children, out);
  }
  return out;
}

const cols =
  'grid grid-cols-[minmax(0,1fr)_64px_92px_72px_36px] items-center max-sm:grid-cols-[minmax(0,1fr)_44px_44px_52px_36px]';

function ColHead({ full, short }: { full: string; short: string }) {
  return (
    <span className="text-right">
      <span className="max-sm:hidden">{full}</span>
      <span className="sm:hidden">{short}</span>
    </span>
  );
}

function DeckActions({
  deck,
  compact,
  open,
  onOpenChange,
}: {
  deck: DeckNode;
  compact: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  // Deck actions arrive with Phase 2; the menu is here so the layout is final.
  const soon = { disabled: true, onSelect: () => {} };
  return (
    <Menu
      open={open}
      onOpenChange={onOpenChange}
      // The trigger is not in the tab order; give focus back to its row so the tree keys keep working.
      onCloseAutoFocus={(e) => {
        const row = button.current?.closest<HTMLElement>('[role=treeitem]');
        if (row) {
          e.preventDefault();
          row.focus();
        }
      }}
      label={t('anki.deckActions', { name: deck.name })}
      items={[
        { label: t('anki.study'), icon: BookOpenCheck, ...soon },
        { label: t('anki.add'), icon: Plus, ...soon },
        { kind: 'separator' },
        { label: t('anki.rename'), icon: Pencil, ...soon },
        { label: t('anki.options'), icon: Settings2, ...soon },
        { label: t('anki.export'), icon: Download, ...soon },
        { kind: 'separator' },
        { label: t('anki.delete'), icon: Trash2, danger: true, ...soon },
      ]}
      trigger={
        <button
          ref={button}
          type="button"
          tabIndex={-1}
          aria-label={t('anki.deckActions', { name: deck.name })}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-ctl text-muted hover:bg-active hover:text-fg data-[state=open]:opacity-100 coarse:size-10',
            !compact && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
          )}
        >
          <Ellipsis size={16} aria-hidden />
        </button>
      }
    />
  );
}

export function DeckTable({ decks, compact = false }: { decks: DeckNode[]; compact?: boolean }) {
  const nodes = useMemo(() => toTree(decks), [decks]);
  const initial = useMemo(() => expandedIds(decks), [decks]);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  return (
    <div className="text-base">
      <div className={cn(cols, 'h-9 border-b border-line pr-1 pl-2 text-xs font-semibold text-muted')} aria-hidden>
        <span className="pl-6">{t('anki.col.deck')}</span>
        <ColHead full={t('anki.col.new')} short={t('anki.col.newShort')} />
        <ColHead full={t('anki.col.learn')} short={t('anki.col.learnShort')} />
        <ColHead full={t('anki.col.review')} short={t('anki.col.reviewShort')} />
        <span />
      </div>
      <Tree
        key={initial.join(',')}
        className="mt-1.5 flex flex-col gap-px"
        label={t('anki.deckTree')}
        nodes={nodes}
        defaultExpanded={initial}
        rowClassName="h-9 pl-2 pr-1 coarse:h-11"
        getLabel={({ data: d }) =>
          `${d.name}, ${t('anki.countsLabel', { n: d.newCount, l: d.learnCount, r: d.reviewCount })}`
        }
        onMenu={({ data: d }) => setMenuFor(d.id)}
        renderRow={({ data: d }) => (
          <div className={cn(cols)}>
            <span className="truncate pl-1" title={d.fullName}>
              {d.name}
            </span>
            <Count kind="new" value={d.newCount} className="text-right" />
            <Count kind="learn" value={d.learnCount} className="text-right" />
            <Count kind="review" value={d.reviewCount} className="text-right" />
            <span className="flex justify-end">
              <DeckActions
                deck={d}
                compact={compact}
                open={menuFor === d.id}
                onOpenChange={(o) => setMenuFor(o ? d.id : null)}
              />
            </span>
          </div>
        )}
      />
    </div>
  );
}

export function studiedTodayText(s: StudiedToday): string {
  if (s.cards <= 0) return t('anki.studiedNone');
  return t('anki.studied', {
    cards: formatNumber(s.cards, 0),
    cardsWord: s.cards === 1 ? t('anki.card') : t('anki.cards'),
    minutes: formatNumber(s.seconds / 60),
    perCard: formatNumber(s.seconds / s.cards),
  });
}
