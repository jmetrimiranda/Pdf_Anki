import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installDomStubs } from '../../lib/testing/dom';
import { AnchoredPopover } from './PanelDialogs';
import { renderWithProviders } from './testing';

beforeAll(() => installDomStubs());

const anchor = { x: 100, y: 120, width: 80, height: 20 };

function setup(returnFocus?: () => HTMLElement | null) {
  const onClose = vi.fn();
  renderWithProviders(
    <AnchoredPopover anchor={anchor} onClose={onClose} label="Palavra" testId="t-anchor" returnFocus={returnFocus}>
      <p>conteúdo</p>
    </AnchoredPopover>,
  );
  return onClose;
}

describe('AnchoredPopover', () => {
  afterEach(() => document.querySelectorAll('iframe').forEach((f) => f.remove()));

  it('closes with the × button', () => {
    const onClose = setup();
    fireEvent.click(screen.getByTestId('t-anchor-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes with Esc pressed inside the PdfCraft iframe, without consuming the key', () => {
    const frame = document.createElement('iframe');
    frame.title = 'PdfCraft';
    document.body.appendChild(frame);
    const onClose = setup(() => frame);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    frame.contentWindow!.document.dispatchEvent(esc);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(esc.defaultPrevented).toBe(false);
    // Other keys typed in PdfCraft don't close it.
    frame.contentWindow!.document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stops listening to the iframe once closed', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const onClose = vi.fn();
    const { rerender } = renderWithProviders(
      <AnchoredPopover anchor={anchor} onClose={onClose} label="Palavra" testId="t-anchor" returnFocus={() => frame}>
        <p>conteúdo</p>
      </AnchoredPopover>,
    );
    rerender(
      <AnchoredPopover anchor={null} onClose={onClose} label="Palavra" testId="t-anchor" returnFocus={() => frame}>
        <p>conteúdo</p>
      </AnchoredPopover>,
    );
    frame.contentWindow!.document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
