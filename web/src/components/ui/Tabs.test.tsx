import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { TabPanel, Tabs } from './Tabs';

type V = 'a' | 'b' | 'c' | 'd';

function Harness() {
  const [value, setValue] = useState<V>('a');
  return (
    <>
      <Tabs
        idBase="t"
        label="Painel"
        value={value}
        onValueChange={setValue}
        items={[
          { value: 'a', label: 'Sumário' },
          { value: 'b', label: 'Miniaturas' },
          { value: 'c', label: 'Desligada', disabled: true },
          { value: 'd', label: 'Anotações' },
        ]}
      />
      <TabPanel idBase="t" value={value} active>
        painel {value}
      </TabPanel>
    </>
  );
}

describe('Tabs', () => {
  it('marks the active tab and links it to its panel', () => {
    render(<Harness />);
    const tab = screen.getByRole('tab', { name: 'Sumário' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(tab.tabIndex).toBe(0);
    expect(screen.getByRole('tab', { name: 'Miniaturas' }).tabIndex).toBe(-1);
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    expect(tab.getAttribute('aria-controls')).toBe(panel.id);
  });

  it('moves with arrow keys, skipping disabled tabs and wrapping', () => {
    render(<Harness />);
    const first = screen.getByRole('tab', { name: 'Sumário' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Miniaturas' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Miniaturas' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Anotações' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Sumário' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Anotações' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(screen.getByRole('tabpanel').textContent).toBe('painel a');
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(screen.getByRole('tabpanel').textContent).toBe('painel d');
  });
});
