import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { FolderOpen } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, Dialog, Field, Input } from '../../components/ui';
import { t } from '../../i18n';
import { core, CoreError } from '../../lib/core/client';
import { q } from '../../lib/core/queries';
import { openDocTab } from '../../lib/tabs';

const MOCK_PATH = '/home/jorge/Livros/ROS 2 na prática.pdf';

/**
 * Phase 0 file picker: the path is typed in. The native dialog needs tauri-plugin-dialog
 * on the Rust side (see docs/progresso.md).
 */
export function OpenFileDialog({
  open,
  onOpenChange,
  sheet,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sheet: boolean;
}) {
  const [path, setPath] = useState(core.kind === 'mock' ? MOCK_PATH : '');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (p: string) => core.docOpenPath(p),
    onSuccess: (info) => {
      queryClient.setQueryData(q.docInfo(info.docId).queryKey, info);
      const fallback =
        path
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.pdf$/i, '') ?? info.docId;
      openDocTab({ docId: info.docId, title: info.title || fallback });
      onOpenChange(false);
      void navigate({ to: '/doc/$docId', params: { docId: info.docId } });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (path.trim()) mutation.mutate(path.trim());
  }

  const error = mutation.error
    ? mutation.error instanceof CoreError
      ? mutation.error.message
      : t('errors.unexpected')
    : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) mutation.reset();
        onOpenChange(o);
      }}
      title={t('open.title')}
      description={t('open.description')}
      variant={sheet ? 'sheet' : 'center'}
    >
      <form id="open-file" onSubmit={submit} className="flex flex-col gap-4 pb-3">
        <Field label={t('open.pathLabel')} hint={t('open.pathHint')} error={error}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              autoFocus
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={path}
              placeholder={t('open.pathPlaceholder')}
              onChange={(e) => setPath(e.target.value)}
              spellCheck={false}
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            icon={FolderOpen}
            loading={mutation.isPending}
            disabled={!path.trim()}
          >
            {t('open.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
