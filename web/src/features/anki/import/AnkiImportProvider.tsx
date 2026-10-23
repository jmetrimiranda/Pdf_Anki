import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useToast } from '../../../components/ui';
import { t } from '../../../i18n';
import { core } from '../../../lib/core/client';
import { errorMessage } from '../decks/DeckDialogs';
import { ankiPathPage } from '../pages/routes';
import { ApkgConfirmDialog, ColpkgFlow } from './ImportDialogs';

export type OpenPathGroup =
  { kind: 'books'; paths: string[] } | { kind: 'apkg'; path: string } | { kind: 'colpkg'; path: string };

/** Extension of a path, lowercase, without the dot. */
export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Splits "Abrir com"/dropped paths by type, keeping their order: Anki packages one by one, runs of other files
 * (PDFs; anything else gets the library's "formato não suportado") as one book import.
 */
export function splitOpenPaths(paths: string[]): OpenPathGroup[] {
  const out: OpenPathGroup[] = [];
  for (const path of paths) {
    const ext = extensionOf(path);
    if (ext === 'apkg' || ext === 'colpkg') {
      out.push({ kind: ext, path });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.kind === 'books') last.paths.push(path);
    else out.push({ kind: 'books', paths: [path] });
  }
  return out;
}

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

interface AnkiImportApi {
  /** "Importar" menu: the core's open dialog, then the Anki import page (.apkg) or the replace flow (.colpkg). */
  pickPackage: () => Promise<void>;
  /** "Substituir a coleção" with double confirmation and a backup first (spec 8.5). */
  importColpkg: (path: string) => Promise<void>;
  /** A .apkg opened with the app: confirm, then import it directly. */
  importApkg: (path: string) => Promise<void>;
  /** "Abrir com"/drop: PDFs go to `importBooks`, packages to their flows, in order. */
  openPaths: (paths: string[], importBooks: (paths: string[]) => Promise<void>) => Promise<void>;
}

const AnkiImportContext = createContext<AnkiImportApi>({
  pickPackage: async () => {},
  importColpkg: async () => {},
  importApkg: async () => {},
  openPaths: async (paths, importBooks) => importBooks(paths),
});

export const useAnkiImport = () => useContext(AnkiImportContext);

interface Job {
  kind: 'apkg' | 'colpkg';
  path: string;
  done: () => void;
}

/** Hosts the import dialogs (one at a time, queued) for the decks screen and for files opened with the app. */
export function AnkiImportProvider({ children }: { children: ReactNode }) {
  const [job, setJob] = useState<Job | null>(null);
  const queue = useRef<Job[]>([]);
  const busy = useRef(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  const next = useCallback(() => {
    const j = queue.current.shift() ?? null;
    busy.current = !!j;
    setJob(j);
  }, []);

  const enqueue = useCallback(
    (kind: Job['kind'], path: string) =>
      new Promise<void>((resolve) => {
        queue.current.push({ kind, path, done: resolve });
        if (!busy.current) next();
      }),
    [next],
  );

  const finish = useCallback(
    (imported: boolean) => {
      const j = job;
      if (imported) {
        void queryClient.invalidateQueries({ queryKey: ['anki'] });
        void navigate({ to: '/anki' });
      }
      next();
      j?.done();
    },
    [job, next, navigate, queryClient],
  );

  const importColpkg = useCallback((path: string) => enqueue('colpkg', path), [enqueue]);
  const importApkg = useCallback((path: string) => enqueue('apkg', path), [enqueue]);

  const pickPackage = useCallback(async () => {
    try {
      const path = await core.ankiPickPackage();
      if (!path) return;
      if (extensionOf(path) === 'colpkg') await importColpkg(path);
      else void navigate({ to: '/anki/pagina/$', params: { _splat: ankiPathPage('import-anki-package', path) } });
    } catch (err) {
      toast.show(t('anki.import.failed', { mensagem: errorMessage(err) }), { tone: 'error' });
    }
  }, [importColpkg, navigate, toast]);

  const openPaths = useCallback(
    async (paths: string[], importBooks: (paths: string[]) => Promise<void>) => {
      for (const group of splitOpenPaths(paths)) {
        if (group.kind === 'books') await importBooks(group.paths);
        else if (group.kind === 'apkg') await importApkg(group.path);
        else await importColpkg(group.path);
      }
    },
    [importApkg, importColpkg],
  );

  const api = useMemo(
    () => ({ pickPackage, importColpkg, importApkg, openPaths }),
    [pickPackage, importColpkg, importApkg, openPaths],
  );

  return (
    <AnkiImportContext.Provider value={api}>
      {children}
      {job?.kind === 'colpkg' && <ColpkgFlow key={job.path} path={job.path} onFinished={finish} />}
      {job?.kind === 'apkg' && <ApkgConfirmDialog key={job.path} path={job.path} onFinished={finish} />}
    </AnkiImportContext.Provider>
  );
}
