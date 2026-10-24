import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { useToast } from '../../components/ui';
import { t } from '../../i18n';
import { core, CoreError, type AddedBook } from '../../lib/core/client';
import { leitor } from '../leitor';

export function errorMessage(err: unknown): string {
  return err instanceof CoreError || err instanceof Error ? err.message : t('errors.unexpected');
}

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Book formats the library takes (spec 6.6, 7.1); anything else is refused before reaching the core. */
export function isBookPath(path: string): boolean {
  return /\.(pdf|epub)$/i.test(fileNameOf(path));
}

/** The toast text for one successful import. */
export function outcomeMessage(added: AddedBook): string {
  const titulo = added.book.title;
  switch (added.outcome) {
    case 'created':
      return t('library.added', { titulo });
    case 'existing':
      return t('library.alreadyThere');
    case 'restored':
      return t('library.restored', { titulo });
    case 'newVersion':
      return t('library.newVersion', { titulo });
    case 'otherVersion':
      return t('library.keptCurrent', { titulo });
  }
}

/** A pending "Substituir a versão atual?" question (spec 6.6: a stamped file that differs from the current version). */
export interface ReplacePrompt {
  book: AddedBook['book'];
  answer: (replace: boolean) => void;
}

/**
 * Import flow shared by "Adicionar livro", drag and drop and "Abrir com" (spec 6.6): adds each path
 * with a progress toast, reports every failure in pt-BR, refreshes the library and optionally opens
 * the last imported book in the Leitor.
 */
export function useBookImport() {
  const toast = useToast();
  const queryClient = useQueryClient();
  // Imports run one after the other even when triggered from several places.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [replacePrompt, setReplacePrompt] = useState<ReplacePrompt | null>(null);

  /** Asks before an imported copy replaces the current version: it may be older and lack newer annotations. */
  const askReplace = useCallback(
    (book: AddedBook['book']) =>
      new Promise<boolean>((resolve) => {
        setReplacePrompt({
          book,
          answer: (replace) => {
            setReplacePrompt(null);
            resolve(replace);
          },
        });
      }),
    [],
  );

  const run = useCallback(
    async (paths: string[], openLast: boolean) => {
      if (!paths.length) return;
      const progressId = toast.show(t('library.adding', { nome: fileNameOf(paths[0]!) }), { durationMs: 0 });
      const added: AddedBook[] = [];
      for (const [i, path] of paths.entries()) {
        const nome = fileNameOf(path);
        if (!isBookPath(path)) {
          toast.show(t('library.addFailed', { nome, mensagem: t('ocr.library.unsupported') }), { tone: 'error' });
          continue;
        }
        if (paths.length > 1) {
          toast.show(t('library.addingMany', { i: i + 1, n: paths.length, nome }), { id: progressId, durationMs: 0 });
        }
        try {
          let result = await core.libraryAdd(path);
          if (result.outcome === 'otherVersion' && (await askReplace(result.book))) {
            result = await core.libraryAdd(path, { replace: true });
          }
          added.push(result);
        } catch (err) {
          toast.show(t('library.addFailed', { nome, mensagem: errorMessage(err) }), { tone: 'error' });
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['library'] });

      if (added.length === 0) toast.dismiss(progressId);
      else if (added.length === 1) toast.show(outcomeMessage(added[0]!), { id: progressId, tone: 'success' });
      else {
        const created = added.filter((a) => a.outcome !== 'existing' && a.outcome !== 'otherVersion').length;
        toast.show(created ? t('library.addedMany', { n: created }) : t('library.alreadyThere'), {
          id: progressId,
          tone: 'success',
        });
      }

      // Not awaited: opening waits for PdfCraft, and later imports must not queue behind it. The Leitor shows its
      // own open errors; only a rejection (core failure) needs a toast here.
      const last = added[added.length - 1];
      if (openLast && last) {
        leitor.openBook(last.book.bookUid).catch((err: unknown) => {
          toast.show(t('library.openFailed', { titulo: last.book.title, mensagem: errorMessage(err) }), {
            tone: 'error',
          });
        });
      }
    },
    [toast, queryClient, askReplace],
  );

  const importPaths = useCallback(
    (paths: string[], opts: { openLast?: boolean } = {}) => {
      const next = queue.current.then(() => run(paths, !!opts.openLast));
      queue.current = next.catch(() => undefined);
      return next;
    },
    [run],
  );

  const addBooks = useCallback(async () => {
    try {
      const paths = await core.pickBookFiles();
      await importPaths(paths);
    } catch (err) {
      toast.show(t('library.actionFailed', { mensagem: errorMessage(err) }), { tone: 'error' });
    }
  }, [importPaths, toast]);

  return { importPaths, addBooks, replacePrompt };
}
