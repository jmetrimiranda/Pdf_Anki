import {
  AlignJustify,
  Bold,
  BookOpen,
  Copy,
  FolderOpen,
  Italic,
  Pencil,
  Plus,
  Search,
  Settings,
  Share2,
  Trash2,
  Underline,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Counts,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Kbd,
  Menu,
  menuItemClass,
  Notice,
  Popover,
  popoverSurface,
  PortalContainerContext,
  ProgressBar,
  SegmentedControl,
  Select,
  Skeleton,
  SkeletonLines,
  Spinner,
  Switch,
  TabPanel,
  Tabs,
  Textarea,
  Toolbar,
  ToolbarSeparator,
  Tooltip,
  tooltipSurface,
  useToast,
} from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import type { AppTheme } from '../../lib/theme';
import { mockDeckTree } from '../../lib/core/mock';
import { DeckTable } from '../anki/DeckList';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold text-muted">{title}</h2>
      {children}
    </section>
  );
}

const Row = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>
);

function Gallery({ theme }: { theme: AppTheme }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<'sumario' | 'miniaturas' | 'anotacoes'>('sumario');
  const [seg, setSeg] = useState<'claro' | 'sepia' | 'escuro'>('sepia');
  const [sw, setSw] = useState(true);
  const [dialog, setDialog] = useState<'center' | 'sheet' | null>(null);
  const toast = useToast();
  const decks = mockDeckTree().decks.slice(3, 8);

  return (
    <div
      data-theme={theme}
      data-testid={`gallery-${theme}`}
      className="relative flex min-w-0 flex-col gap-7 rounded-box border border-line bg-bg p-5 text-fg sm:p-6"
    >
      <div ref={setContainer} className="contents" />
      <PortalContainerContext.Provider value={container}>
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{theme === 'light' ? t('dev.ui.light') : t('dev.ui.dark')}</h2>
          <Badge tone="lime">{t('app.name')}</Badge>
        </header>

        <Section title={t('dev.ui.buttons')}>
          <Row>
            <Button variant="primary" icon={FolderOpen}>
              {t('library.add')}
            </Button>
            <Button>{t('common.cancel')}</Button>
            <Button variant="ghost" icon={Pencil}>
              {t('anki.rename')}
            </Button>
            <Button variant="danger" icon={Trash2}>
              {t('anki.delete')}
            </Button>
          </Row>
          <Row>
            <Button variant="primary" size="sm">
              {t('anki.study')}
            </Button>
            <Button size="sm" icon={Plus}>
              {t('anki.add')}
            </Button>
            <Button size="lg" variant="primary">
              {t('common.save')}
            </Button>
            <Button loading>{t('common.loading')}</Button>
            <Button disabled>{t('dev.ui.disabled')}</Button>
          </Row>
          <Row>
            <IconButton icon={Search} label={t('dev.ui.search')} shortcut="Ctrl+F" />
            <IconButton icon={Copy} label={t('dev.ui.copy')} variant="neutral" />
            <IconButton icon={Settings} label={t('settings.label')} active />
            <IconButton icon={Share2} label={t('dev.ui.share')} size="sm" />
          </Row>
        </Section>

        <Section title={t('dev.ui.fields')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('dev.ui.deckName')} hint={t('dev.ui.deckNameHint')}>
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} defaultValue="ROS 2 — Revisão" />}
            </Field>
            <Field label={t('dev.ui.noteType')}>
              {({ id }) => (
                <Select id={id} defaultValue="basic">
                  <option value="basic">Básico</option>
                  <option value="cloze">Omissão de palavras</option>
                  <option value="command">Comando (shell/ROS 2)</option>
                </Select>
              )}
            </Field>
            <Field label={t('dev.ui.search')}>
              {({ id }) => <Input id={id} leading={<Search size={14} />} placeholder={t('dev.ui.searchPlaceholder')} />}
            </Field>
            <Field label={t('dev.ui.path')} error={t('dev.ui.pathError')}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} defaultValue="/tmp/notas.txt" />
              )}
            </Field>
          </div>
          <Field label={t('dev.ui.front')}>
            {({ id }) => <Textarea id={id} defaultValue="Qual comando lista os tópicos ativos?" />}
          </Field>
        </Section>

        <Section title={t('dev.ui.choices')}>
          <Row className="gap-5">
            <Checkbox label={t('dev.ui.checkbox')} defaultChecked />
            <Checkbox label={t('dev.ui.checkboxOff')} />
            <Switch checked={sw} onCheckedChange={setSw} label={t('dev.ui.switch')} />
          </Row>
          <Row>
            <SegmentedControl
              label={t('dev.ui.readingTheme')}
              value={seg}
              onChange={setSeg}
              options={[
                { value: 'claro', label: t('dev.ui.theme.light') },
                { value: 'sepia', label: t('dev.ui.theme.sepia') },
                { value: 'escuro', label: t('dev.ui.theme.dark') },
              ]}
            />
          </Row>
        </Section>

        <Section title={t('dev.ui.tabs')}>
          <div>
            <Tabs
              idBase={`dev-${theme}`}
              label={t('dev.ui.sidePanel')}
              value={tab}
              onValueChange={setTab}
              items={[
                { value: 'sumario', label: t('dev.ui.tabOutline') },
                { value: 'miniaturas', label: t('dev.ui.tabThumbs') },
                { value: 'anotacoes', label: t('dev.ui.tabNotes') },
              ]}
            />
            <TabPanel idBase={`dev-${theme}`} value={tab} active className="pt-3 text-base text-muted">
              {t('dev.ui.tabContent', {
                tab: t(
                  tab === 'sumario'
                    ? 'dev.ui.tabOutline'
                    : tab === 'miniaturas'
                      ? 'dev.ui.tabThumbs'
                      : 'dev.ui.tabNotes',
                ),
              })}
            </TabPanel>
          </div>
        </Section>

        <Section title={t('dev.ui.cards')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Card title="Animal Farm" actions={<IconButton icon={Settings} label={t('settings.label')} size="sm" />}>
              <div className="flex items-center justify-between">
                <Counts newCount={12} learnCount={4} reviewCount={7} />
                <Button size="sm" variant="primary">
                  {t('anki.study')}
                </Button>
              </div>
            </Card>
            <Card title={t('dev.ui.vocab')}>
              <ProgressBar value={94} label={t('dev.ui.coverage')} showValue />
              <p className="mt-2 text-xs text-muted">{t('dev.ui.coverageHint')}</p>
            </Card>
          </div>
          <Row>
            <Badge>{t('dev.ui.badgeNeutral')}</Badge>
            <Badge tone="lime">{t('dev.ui.badgeLime')}</Badge>
            <Badge tone="new">{t('anki.col.new')}</Badge>
            <Badge tone="learn">{t('anki.col.learn')}</Badge>
            <Badge tone="review">{t('anki.col.review')}</Badge>
            <Badge tone="error">{t('dev.ui.badgeError')}</Badge>
          </Row>
          <Row className="gap-4">
            <Counts newCount={12} learnCount={4} reviewCount={7} />
            <Counts newCount={0} learnCount={17} reviewCount={1002} />
          </Row>
        </Section>

        <Section title={t('dev.ui.tree')}>
          <Card padded={false} className="px-3 pt-1 pb-2">
            <DeckTable decks={decks} compact />
          </Card>
        </Section>

        <Section title={t('dev.ui.toolbar')}>
          <div className="rounded-ctl border border-line px-1.5 py-1">
            <Toolbar label={t('dev.ui.toolbar')}>
              <IconButton icon={Bold} label={t('dev.ui.bold')} active />
              <IconButton icon={Italic} label={t('dev.ui.italic')} />
              <IconButton icon={Underline} label={t('dev.ui.underline')} />
              <ToolbarSeparator />
              <IconButton icon={AlignJustify} label={t('dev.ui.align')} />
              <span className="flex-1" />
              <span className="text-base tabular">37 / 112</span>
            </Toolbar>
          </div>
        </Section>

        <Section title={t('dev.ui.floating')}>
          {/* Static copies so both themes show the surfaces without interaction. */}
          <div className="flex flex-wrap items-start gap-4">
            <div className={cn(tooltipSurface, 'static animate-none')}>
              <span className="inline-flex items-center gap-2">
                {t('dev.ui.search')} <Kbd>Ctrl+F</Kbd>
              </span>
            </div>
            <div className={cn(popoverSurface, 'w-52 animate-none p-1')} role="presentation">
              <div className={cn(menuItemClass, 'bg-hover')}>
                <Pencil size={15} className="text-muted" /> {t('anki.rename')}
              </div>
              <div className={menuItemClass}>
                <Plus size={15} className="text-muted" /> {t('anki.add')}
              </div>
              <div className="mx-1 my-1 h-px bg-line" />
              <div className={cn(menuItemClass, 'text-error')}>
                <Trash2 size={15} /> {t('anki.delete')}
              </div>
            </div>
          </div>
          <Row>
            <Tooltip content={t('dev.ui.tooltipText')}>
              <Button size="sm">{t('dev.ui.tooltip')}</Button>
            </Tooltip>
            <Popover trigger={<Button size="sm">{t('dev.ui.popover')}</Button>}>
              <p className="text-base">{t('dev.ui.popoverText')}</p>
            </Popover>
            <Menu
              align="start"
              trigger={<Button size="sm">{t('dev.ui.menu')}</Button>}
              items={[
                { label: t('anki.study'), icon: BookOpen, onSelect: () => {} },
                { label: t('anki.rename'), icon: Pencil, shortcut: 'F2', onSelect: () => {} },
                { kind: 'separator' },
                { label: t('anki.delete'), icon: Trash2, danger: true, onSelect: () => {} },
              ]}
            />
            <Button size="sm" onClick={() => setDialog('center')}>
              {t('dev.ui.dialog')}
            </Button>
            <Button size="sm" onClick={() => setDialog('sheet')}>
              {t('dev.ui.sheet')}
            </Button>
          </Row>
          <Dialog
            open={dialog !== null}
            onOpenChange={(o) => !o && setDialog(null)}
            variant={dialog ?? 'center'}
            title={t('dev.ui.dialogTitle')}
            description={t('dev.ui.dialogText')}
            footer={
              <>
                <Button variant="ghost" onClick={() => setDialog(null)}>
                  {t('common.cancel')}
                </Button>
                <Button variant="danger" onClick={() => setDialog(null)}>
                  {t('anki.delete')}
                </Button>
              </>
            }
          />
        </Section>

        <Section title={t('dev.ui.notices')}>
          <Notice tone="error" onRetry={() => {}}>
            {t('dev.ui.noticeError')}
          </Notice>
          <Notice tone="success" onDismiss={() => {}}>
            {t('dev.ui.noticeSuccess')}
          </Notice>
          <Notice tone="info">{t('dev.ui.noticeInfo')}</Notice>
          <Row>
            <Button size="sm" onClick={() => toast.show(t('dev.ui.toastText'), { tone: 'success' })}>
              {t('dev.ui.toast')}
            </Button>
            <Button size="sm" onClick={() => toast.show(t('dev.ui.noticeError'), { tone: 'error', onRetry: () => {} })}>
              {t('dev.ui.toastError')}
            </Button>
          </Row>
        </Section>

        <Section title={t('dev.ui.loading')}>
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <SkeletonLines lines={3} />
            <Skeleton rounded="box" className="h-20 w-16" />
          </div>
          <Row className="gap-4 text-base text-muted">
            <span className="inline-flex items-center gap-2">
              <Spinner /> {t('dev.ui.searching')}
            </span>
          </Row>
          <ProgressBar value={37} label={t('dev.ui.progress')} showValue />
          <ProgressBar label={t('dev.ui.progressIndeterminate')} />
        </Section>

        <Section title={t('dev.ui.empty')}>
          <div className="rounded-box border border-dashed border-line">
            <EmptyState
              icon={BookOpen}
              title={t('library.empty')}
              description={t('library.emptyHint')}
              action={
                <Button variant="primary" icon={FolderOpen}>
                  {t('library.add')}
                </Button>
              }
            />
          </div>
        </Section>

        <Section title={t('dev.ui.keys')}>
          <Row>
            <Kbd>Ctrl</Kbd>
            <Kbd>Shift</Kbd>
            <Kbd>A</Kbd>
            <span className="text-xs text-muted">{t('shortcuts.anki')}</span>
          </Row>
        </Section>
      </PortalContainerContext.Provider>
    </div>
  );
}

export function DevUiPage() {
  return (
    <div className="h-full overflow-auto bg-surface">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-6 sm:px-6">
        <header>
          <h1 className="text-lg font-semibold">{t('dev.ui.title')}</h1>
          <p className="text-xs text-muted">{t('dev.ui.subtitle')}</p>
        </header>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <Gallery theme="light" />
          <Gallery theme="dark" />
        </div>
      </div>
    </div>
  );
}
