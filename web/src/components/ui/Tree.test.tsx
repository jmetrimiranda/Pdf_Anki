import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Tree, type TreeNode } from './Tree';

const nodes: TreeNode<string>[] = [
  {
    id: 'a',
    data: 'Oxford',
    children: [
      { id: 'a1', data: 'Oxford 3000' },
      { id: 'a2', data: 'Oxford 5000' },
    ],
  },
  {
    id: 'b',
    data: 'Vocabulário',
    children: [{ id: 'b1', data: 'Livros', children: [{ id: 'b11', data: 'Teste' }] }],
  },
  { id: 'c', data: '5000 palavras' },
];

const names = () => screen.getAllByRole('treeitem').map((el) => el.textContent);

function setup(onActivate = vi.fn()) {
  render(
    <Tree
      label="Decks"
      nodes={nodes}
      defaultExpanded={['a']}
      onActivate={onActivate}
      renderRow={(n) => <span>{n.data}</span>}
    />,
  );
  return onActivate;
}

describe('Tree', () => {
  it('renders expanded nodes with aria levels', () => {
    setup();
    expect(names()).toEqual(['Oxford', 'Oxford 3000', 'Oxford 5000', 'Vocabulário', '5000 palavras']);
    const items = screen.getAllByRole('treeitem');
    expect(items[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(items[1]!.getAttribute('aria-level')).toBe('2');
    expect(items[3]!.getAttribute('aria-expanded')).toBe('false');
    expect(items[4]!.hasAttribute('aria-expanded')).toBe(false);
  });

  it('toggles with the chevron button', () => {
    setup();
    fireEvent.click(screen.getAllByRole('button', { name: 'Recolher' })[0]!);
    expect(names()).toEqual(['Oxford', 'Vocabulário', '5000 palavras']);
    fireEvent.click(screen.getAllByRole('button', { name: 'Expandir' })[1]!);
    expect(names()).toEqual(['Oxford', 'Vocabulário', 'Livros', '5000 palavras']);
  });

  it('supports keyboard navigation', () => {
    const onActivate = setup();
    const first = screen.getAllByRole('treeitem')[0]!;
    expect(first.tabIndex).toBe(0);
    first.focus();
    const key = (k: string) => fireEvent.keyDown(document.activeElement!, { key: k });
    key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Oxford 3000');
    key('ArrowLeft'); // leaf → parent
    expect(document.activeElement?.textContent).toBe('Oxford');
    key('ArrowLeft'); // collapse
    expect(names()).toHaveLength(3);
    key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Vocabulário');
    key('ArrowRight'); // expand
    key('ArrowRight'); // enter
    expect(document.activeElement?.textContent).toBe('Livros');
    key('End');
    expect(document.activeElement?.textContent).toBe('5000 palavras');
    key('Enter');
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }));
    key('Home');
    expect(document.activeElement?.textContent).toBe('Oxford');
  });

  it('names rows with getLabel and opens the row menu with Shift+F10 or the menu key', () => {
    const onMenu = vi.fn();
    render(
      <Tree
        label="Decks"
        nodes={nodes}
        getLabel={(n) => `${n.data}, 3 novos`}
        onMenu={onMenu}
        renderRow={(n) => <span>{n.data}</span>}
      />,
    );
    const first = screen.getByRole('treeitem', { name: 'Oxford, 3 novos' });
    expect(first.getAttribute('aria-keyshortcuts')).toBe('Shift+F10');
    fireEvent.keyDown(first, { key: 'F10' });
    expect(onMenu).not.toHaveBeenCalled();
    fireEvent.keyDown(first, { key: 'F10', shiftKey: true });
    fireEvent.keyDown(first, { key: 'ContextMenu' });
    expect(onMenu).toHaveBeenCalledTimes(2);
    expect(onMenu).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });
});
