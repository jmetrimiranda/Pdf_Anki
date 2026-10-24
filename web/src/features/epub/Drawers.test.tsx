// Keyboard behaviour of the EPUB reader's drawers: focus moves in on open (the current TOC row, the first
// annotation) and Escape closes them.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../components/ui';
import type { EpubAnnotation } from '../../lib/core/types';
import { installDomStubs } from '../../lib/testing/dom';
import { AnnotationsDrawer, TocDrawer } from './Drawers';
import type { TocNode } from './session';

beforeAll(() => installDomStubs());

const node = (id: number, label: string, children: TocNode[] = []): TocNode => ({
  id,
  label,
  href: `c${id}.xhtml`,
  children,
});

describe('EPUB drawers', () => {
  it('the TOC focuses the current row and closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <TooltipProvider>
        <TocDrawer
          toc={[node(1, 'Part I', [node(2, 'Chapter I'), node(3, 'Chapter II')]), node(4, 'Part II')]}
          currentId={3}
          onGo={() => {}}
          onClose={onClose}
        />
      </TooltipProvider>,
    );
    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute('role')).toBe('treeitem');
    expect(focused.textContent).toContain('Chapter II');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toContain('Part II');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the TOC without a current place focuses its first row; an empty TOC its close button', () => {
    const { unmount } = render(
      <TooltipProvider>
        <TocDrawer toc={[node(1, 'One'), node(2, 'Two')]} currentId={null} onGo={() => {}} onClose={() => {}} />
      </TooltipProvider>,
    );
    expect(document.activeElement?.textContent).toContain('One');
    unmount();
    render(
      <TooltipProvider>
        <TocDrawer toc={[]} currentId={null} onGo={() => {}} onClose={() => {}} />
      </TooltipProvider>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fechar' }));
  });

  it('the annotations drawer focuses its first item', () => {
    const a = (uid: string, text: string): EpubAnnotation =>
      ({
        uid,
        kind: 'highlight',
        text,
        color: '#fff000',
        comment: null,
        cfi: `epubcfi(/6/2!/4/${uid})`,
      }) as EpubAnnotation;
    render(
      <TooltipProvider>
        <AnnotationsDrawer
          annotations={[a('1', 'First passage'), a('2', 'Second passage')]}
          sectionOf={() => null}
          sectionTitle={() => null}
          onGo={() => {}}
          onDelete={() => {}}
          onClose={() => {}}
        />
      </TooltipProvider>,
    );
    expect(document.activeElement?.textContent).toContain('First passage');
  });
});
