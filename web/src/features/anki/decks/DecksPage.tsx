import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Archive, Blocks, ChevronDown, DatabaseBackup, Ellipsis, Import, Package, Plus, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, EmptyState, IconButton, Menu, Notice, Skeleton, useToast } from '../../../components/ui';
import { t } from '../../../i18n';
import { core } from '../../../lib/core/client';
import { q } from '../../../lib/core/queries';
import type { DeckNode } from '../../../lib/core/types';
import { formatNumber } from '../../../lib/format';
import { DeckTable, studiedTodayText, type DeckAction } from '../DeckList';
import { useAnkiImport } from '../import/AnkiImportProvider';
import {
  BackupsDialog,
  DeckNameDialog,
  DeleteDeckDialog,
  errorMessage,
  ExportDeckDialog,
  MoveDeckDialog,
  parentIdOf,
  subdeckName,
} from './DeckDialogs';

function DeckSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label={t('common.loading')} className="flex flex-col gap-3 pt-2">
      <Skeleton className="h-4 w-full" />
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className={i % 3 ? 'h-3.5 w-2/5' : 'h-3.5 w-1/2'} />
          <span className="flex-1" />
          <Skeleton className="h-3.5 w-8" />
          <Skeleton className="h-3.5 w-8" />
          <Skeleton className="h-3.5 w-8" />
        </div>
      ))}
    </div>
  );
}

type Dialogs =
  | { kind: 'create' }
  | { kind: 'subdeck'; deck: DeckNode }
  | { kind: 'rename'; deck: DeckNode }
  | { kind: 'move'; deck: DeckNode }
  | { kind: 'export'; deck: DeckNode }
  | { kind: 'delete'; deck: DeckNode }
  | { kind: 'backups' };

/** File name for the save dialog: the deck's own name without characters file systems refuse. */
export function apkgFileName(deck: DeckNode): string {
  return `${deck.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'deck'}.apkg`;
}

/** The deck list screen (spec 8.2): decks with counts and actions, import/export, backups, "Preparar coleção". */
export function DecksPage() {
  const tree = useQuery(q.deckTree());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const imports = useAnkiImport();
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const close = (o: boolean) => {
    if (!o) setDialog(null);
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['anki'] });

  async function done(message: string) {
    setDialog(null);
    await refresh();
    toast.show(message, { tone: 'success' });
  }

  const collapse = useMutation({
    mutationFn: ({ deck, collapsed }: { deck: DeckNode; collapsed: boolean }) =>
      core.ankiDeckSetCollapsed(deck.id, collapsed),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['anki', 'deckTree'] }),
    onError: (err) => toast.show(errorMessage(err), { tone: 'error' }),
  });

  function onAction(action: DeckAction, deck: DeckNode) {
    switch (action) {
      case 'study':
        void navigate({ to: '/anki/estudar', search: { deck: deck.id } });
        break;
      case 'add':
        void navigate({ to: '/anki/adicionar', search: { deck: deck.id } });
        break;
      case 'options':
        if (!deck.filtered) void navigate({ to: '/anki/opcoes/$deckId', params: { deckId: String(deck.id) } });
        break;
      default:
        setDialog({ kind: action, deck });
    }
  }

  async function prepare() {
    try {
      const report = await core.ankiPrepareCollection();
      await refresh();
      toast.show(
        report.created.length
          ? t('anki.prepare.created', { tipos: report.created.join(', ') })
          : t('anki.prepare.nothing'),
        { tone: 'success', durationMs: 6000 },
      );
    } catch (err) {
      toast.show(t('anki.prepare.failed', { mensagem: errorMessage(err) }), { tone: 'error' });
    }
  }

  async function backupNow() {
    const id = toast.show(t('anki.backups.running'), { durationMs: 0 });
    try {
      const info = await core.ankiBackupNow();
      await queryClient.invalidateQueries({ queryKey: ['anki', 'backups'] });
      toast.show(t('anki.backups.done', { arquivo: info.fileName }), { tone: 'success', id });
    } catch (err) {
      toast.show(t('anki.backups.failed', { mensagem: errorMessage(err) }), { tone: 'error', id });
    }
  }

  const data = tree.data;
  const empty = !!data && data.decks.length === 0;

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-4 pt-4 pb-10 sm:px-6">
        <div className="flex items-center justify-end gap-1.5">
          <Button variant="ghost" size="sm" icon={Plus} onClick={() => setDialog({ kind: 'create' })}>
            {t('anki.deck.create')}
          </Button>
          <Menu
            label={t('anki.import.menu')}
            items={[
              { label: t('anki.import.apkg'), icon: Package, onSelect: () => void imports.pickPackage() },
              { label: t('anki.import.colpkg'), icon: Archive, onSelect: () => void imports.pickPackage() },
            ]}
            trigger={
              <Button variant="ghost" size="sm" icon={Import} iconRight={ChevronDown}>
                {t('anki.import.menu')}
              </Button>
            }
          />
          <Menu
            label={t('anki.more')}
            items={[
              { label: t('anki.prepare.action'), icon: Wand2, onSelect: () => void prepare() },
              { kind: 'separator' },
              { label: t('anki.backups.now'), icon: DatabaseBackup, onSelect: () => void backupNow() },
              { label: t('anki.backups.list'), icon: Archive, onSelect: () => setDialog({ kind: 'backups' }) },
            ]}
            trigger={<IconButton icon={Ellipsis} label={t('anki.more')} size="sm" tooltip={false} />}
          />
        </div>

        {tree.isError && (
          <Notice tone="error" onRetry={() => void tree.refetch()}>
            {errorMessage(tree.error) || t('anki.loadError')}
          </Notice>
        )}
        <Card padded={false} className="px-3 pt-2 pb-3 sm:px-4">
          {tree.isPending ? (
            <DeckSkeleton />
          ) : data && !empty ? (
            <DeckTable
              decks={data.decks}
              currentDeckId={data.currentDeckId}
              onAction={onAction}
              onCollapsedChange={(deck, collapsed) => collapse.mutate({ deck, collapsed })}
            />
          ) : (
            <EmptyState
              icon={Blocks}
              title={t('anki.empty')}
              description={t('anki.emptyHint')}
              action={
                <Button variant="primary" icon={Import} onClick={() => void imports.pickPackage()}>
                  {t('anki.import')}
                </Button>
              }
            />
          )}
        </Card>
        {data && (
          <p className="text-center text-base text-muted" data-testid="studied-today">
            {studiedTodayText(data.studiedToday)}
          </p>
        )}
      </div>

      {dialog?.kind === 'create' && (
        <DeckNameDialog
          open
          onOpenChange={close}
          title={t('anki.deck.createTitle')}
          hint={t('anki.deck.nameHint')}
          confirmLabel={t('anki.deck.createConfirm')}
          onSubmit={async (name) => {
            await core.ankiDeckCreate(name);
            await done(t('anki.deck.created', { name }));
          }}
        />
      )}
      {dialog?.kind === 'subdeck' && (
        <DeckNameDialog
          open
          onOpenChange={close}
          title={t('anki.deck.subdeckTitle', { name: dialog.deck.name })}
          description={t('anki.deck.subdeckDescription', { name: dialog.deck.fullName })}
          confirmLabel={t('anki.deck.createConfirm')}
          onSubmit={async (name) => {
            const full = subdeckName(dialog.deck.fullName, name);
            await core.ankiDeckCreate(full);
            await done(t('anki.deck.created', { name: full }));
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <DeckNameDialog
          open
          onOpenChange={close}
          title={t('anki.deck.renameTitle')}
          initial={dialog.deck.fullName}
          hint={t('anki.deck.nameHint')}
          confirmLabel={t('common.save')}
          onSubmit={async (name) => {
            await core.ankiDeckRename(dialog.deck.id, name);
            await done(t('anki.deck.renamed', { name }));
          }}
        />
      )}
      {dialog?.kind === 'move' && data && (
        <MoveDeckDialog
          deck={dialog.deck}
          initialParent={parentIdOf(dialog.deck, data.decks)}
          onOpenChange={close}
          onSubmit={async (parentId) => {
            await core.ankiDeckMove([dialog.deck.id], parentId);
            await done(t('anki.deck.moved', { name: dialog.deck.name }));
          }}
        />
      )}
      {dialog?.kind === 'export' && (
        <ExportDeckDialog
          deck={dialog.deck}
          onOpenChange={close}
          onSubmit={async (opts) => {
            const path = await core.pickExportPath(apkgFileName(dialog.deck), 'apkg');
            if (!path) return;
            const result = await core.ankiExport(dialog.deck.id, path, opts);
            setDialog(null);
            toast.show(
              result.notes === 1
                ? t('anki.export.doneOne')
                : t('anki.export.done', { n: formatNumber(result.notes, 0) }),
              { tone: 'success' },
            );
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteDeckDialog
          deck={dialog.deck}
          onOpenChange={close}
          onConfirm={async () => {
            const { cardsDeleted } = await core.ankiDeckDelete(dialog.deck.id);
            await done(t('anki.deck.deleted', { name: dialog.deck.name, n: formatNumber(cardsDeleted, 0) }));
          }}
        />
      )}
      {dialog?.kind === 'backups' && <BackupsDialog onOpenChange={close} />}
    </div>
  );
}
