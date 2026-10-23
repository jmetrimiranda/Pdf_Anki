import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../components/ui';
import { BookPanel } from './BookPanel';

const render = (ui: ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

describe('BookPanel', () => {
  it('takes its full width beside PdfCraft in a wide window', () => {
    render(<BookPanel open theme="light" bookTitle="Livro" onToggle={() => {}} />);
    const panel = screen.getByTestId('book-panel');
    expect(panel.style.width).toBe('320px');
    expect(panel.dataset.overlay).toBe('false');
  });

  it('floats over PdfCraft in a compact window, keeping only the rail in the flow', () => {
    const onToggle = vi.fn();
    const { container } = render(<BookPanel open overlay theme="dark" bookTitle="Livro" onToggle={onToggle} />);
    const panel = screen.getByTestId('book-panel');
    expect(panel.dataset.overlay).toBe('true');
    expect(panel.className).toContain('absolute');
    expect(panel.style.width).toContain('min(320px');
    const spacer = container.firstElementChild as HTMLElement;
    expect(spacer.style.width).toBe('40px');
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
