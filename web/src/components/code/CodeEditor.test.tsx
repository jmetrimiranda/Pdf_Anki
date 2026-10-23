import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CodeEditor, CodeEditorFallback, loadCodeMirror } from './CodeEditor';

beforeAll(() => {
  const rects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects ??= rects;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

function Controlled({
  onSubmit,
  initial = 'x = 1',
  readOnly = false,
}: {
  onSubmit: () => void;
  initial?: string;
  readOnly?: boolean;
}) {
  const [v, setV] = useState(initial);
  return (
    <>
      <CodeEditor
        value={v}
        onChange={setV}
        language="python"
        ariaLabel="Seu código"
        onSubmit={onSubmit}
        readOnly={readOnly}
      />
      <output data-testid="value">{v}</output>
      <button type="button" onClick={() => setV('novo')}>
        trocar
      </button>
    </>
  );
}

describe('CodeEditor', () => {
  it('loads CodeMirror lazily, keeps the value in both directions and submits with Ctrl+Enter', async () => {
    const onSubmit = vi.fn();
    render(<Controlled onSubmit={onSubmit} />);
    const root = screen.getByTestId('code-editor');
    // The fallback is there at once…
    expect(root.getAttribute('data-state')).toBe('loading');
    expect((screen.getByTestId('code-editor-fallback') as HTMLTextAreaElement).value).toBe('x = 1');
    // …and CodeMirror replaces it.
    await waitFor(() => expect(root.getAttribute('data-state')).toBe('ready'));
    const content = screen.getByTestId('code-editor-content');
    expect(content.getAttribute('aria-label')).toBe('Seu código');
    expect(content.textContent).toContain('x = 1');
    fireEvent.click(screen.getByText('trocar'));
    await waitFor(() => expect(screen.getByTestId('code-editor-content').textContent).toContain('novo'));
    // The view's own edits reach onChange.
    const cm = await loadCodeMirror();
    expect(cm.createEditor).toBeTypeOf('function');
    fireEvent.keyDown(content, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('the fallback: Ctrl+Enter submits, Tab indents with spaces, read-only', () => {
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    const { rerender } = render(
      <CodeEditorFallback value="a" onChange={onChange} ariaLabel="código" onSubmit={onSubmit} tabSize={4} />,
    );
    const box = screen.getByLabelText('código') as HTMLTextAreaElement;
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    box.setSelectionRange(1, 1);
    fireEvent.keyDown(box, { key: 'Tab' });
    expect(onChange).toHaveBeenCalledWith('a    ');
    rerender(<CodeEditorFallback value="a" onChange={onChange} ariaLabel="código" readOnly />);
    expect((screen.getByLabelText('código') as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it('read-only editors cannot be edited', async () => {
    render(<Controlled onSubmit={() => undefined} readOnly />);
    await waitFor(() => expect(screen.getByTestId('code-editor').getAttribute('data-state')).toBe('ready'));
    expect(screen.getByTestId('code-editor-content').getAttribute('contenteditable')).toBe('false');
    await act(async () => undefined);
  });
});
