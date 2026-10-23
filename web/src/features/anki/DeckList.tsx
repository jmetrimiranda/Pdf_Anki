import {
  BookOpenCheck,
  Download,
  FolderInput,
  FolderPlus,
  Pencil,
  Plus,
  Settings,
  Settings2,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Count, Menu, Tree, type MenuEntry, type TreeNode } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import type { DeckNode, StudiedToday } from '../../lib/core/types';
import { formatNumber } from '../../lib/format';

/** What the deck row menu asks the page to do (spec 8.2). */
export type DeckAction = 'study' | 'add' | 'subdeck' | 'rename' | 'move' | 'options' | 'export' | 'delete';

function toTree(decks: DeckNode[]): TreeNode<DeckNode>[] {
  return decks.map((d) => ({ id: String(d.id), data: d, children: toTree(d.children) }));
}

/** Ids of the decks shown open (have subdecks and are not collapsed). */
export function expandedIds(decks: DeckNode[], out: string[] = []): string[] {
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

function deckMenu(deck: DeckNode, act: ((a: DeckAction) => void) | undefined): MenuEntry[] {
  const item = (label: string, icon: LucideIcon, a: DeckAction): MenuEntry => ({
    label,
    icon,
    disabled: !act || (a === 'options' && deck.filtered),
    onSelect: () => act?.(a),
  });
  return [
    item(t('anki.study'), BookOpenCheck, 'study'),
    item(t('anki.add'), Plus, 'add'),
    item(t('anki.deck.subdeck'), FolderPlus, 'subdeck'),
    { kind: 'separator' },
    item(t('anki.rename'), Pencil, 'rename'),
    item(t('anki.deck.move'), FolderInput, 'move'),
    item(t('anki.options'), Settings2, 'options'),
    item(t('anki.deck.exportApkg'), Download, 'export'),
    { kind: 'separator' },
    { ...item(t('anki.delete'), Trash2, 'delete'), danger: true } as MenuEntry,
  ];
}

function DeckActions({
  deck,
  visible,
  open,
  onOpenChange,
  onAction,
}: {
  deck: DeckNode;
  visible: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: ((a: DeckAction) => void) | undefined;
}) {
  const button = useRef<HTMLButtonElement>(null);
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
      items={deckMenu(deck, onAction)}
      trigger={
        <button
          ref={button}
          type="button"
          tabIndex={-1}
          aria-label={t('anki.deckActions', { name: deck.name })}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-ctl text-muted hover:bg-active hover:text-fg data-[state=open]:opacity-100 coarse:size-10',
            !visible && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 coarse:opacity-100',
          )}
        >
          <Settings size={15} aria-hidden />
        </button>
      }
    />
  );
}

/**
 * The deck list (spec 8.2, like Anki's): name, New/Learn/Due counts and a gear menu per deck. Clicking a name
 * studies it; expanding/collapsing is reported through `onCollapsedChange` (persisted in the collection).
 */
export function DeckTable({
  decks,
  currentDeckId,
  compact = false,
  onAction,
  onCollapsedChange,
}: {
  decks: DeckNode[];
  currentDeckId?: number;
  compact?: boolean;
  onAction?: (action: DeckAction, deck: DeckNode) => void;
  onCollapsedChange?: (deck: DeckNode, collapsed: boolean) => void;
}) {
  const nodes = useMemo(() => toTree(decks), [decks]);
  const fromData = useMemo(() => expandedIds(decks).join(','), [decks]);
  const [expanded, setExpanded] = useState(() => new Set(fromData ? fromData.split(',') : []));
  // New data from the core (another window, an import): its collapse state wins.
  useEffect(() => setExpanded(new Set(fromData ? fromData.split(',') : [])), [fromData]);
  const byId = useMemo(() => {
    const map = new Map<string, DeckNode>();
    const walk = (ds: DeckNode[]) =>
      ds.forEach((d) => {
        map.set(String(d.id), d);
        walk(d.children);
      });
    walk(decks);
    return map;
  }, [decks]);
  const [menuFor, setMenuFor] = useState<number | null>(null);

  function onExpandedChange(next: Set<string>) {
    for (const id of new Set([...expanded, ...next])) {
      const deck = byId.get(id);
      if (deck && expanded.has(id) !== next.has(id)) onCollapsedChange?.(deck, !next.has(id));
    }
    setExpanded(next);
  }

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
        className="mt-1.5 flex flex-col gap-px"
        label={t('anki.deckTree')}
        nodes={nodes}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        rowClassName="h-9 pl-2 pr-1 coarse:h-11 has-[[data-current]]:bg-active"
        getLabel={({ data: d }) =>
          `${d.name}, ${t('anki.countsLabel', { n: d.newCount, l: d.learnCount, r: d.reviewCount })}`
        }
        onActivate={onAction ? ({ data: d }) => onAction('study', d) : undefined}
        onMenu={({ data: d }) => setMenuFor(d.id)}
        renderRow={({ data: d }) => {
          const current = d.id === currentDeckId;
          return (
            <div className={cn(cols)} data-current={current || undefined}>
              {onAction ? (
                <button
                  type="button"
                  tabIndex={-1}
                  title={d.fullName}
                  onClick={() => onAction('study', d)}
                  className={cn(
                    'min-w-0 truncate rounded-[4px] pl-1 text-left hover:underline hover:underline-offset-2',
                    current && 'font-semibold',
                  )}
                >
                  {d.name}
                </button>
              ) : (
                <span className="truncate pl-1" title={d.fullName}>
                  {d.name}
                </span>
              )}
              <Count kind="new" value={d.newCount} className="text-right" />
              <Count kind="learn" value={d.learnCount} className="text-right" />
              <Count kind="review" value={d.reviewCount} className="text-right" />
              <span className="flex justify-end">
                <DeckActions
                  deck={d}
                  visible={compact || current}
                  open={menuFor === d.id}
                  onOpenChange={(o) => setMenuFor(o ? d.id : null)}
                  onAction={onAction ? (a) => onAction(a, d) : undefined}
                />
              </span>
            </div>
          );
        }}
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
