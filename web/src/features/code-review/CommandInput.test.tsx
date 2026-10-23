import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandInput } from './CommandInput';
import { HISTORY_KEY, historyOf, pushHistory } from './history';

beforeEach(() => localStorage.removeItem(HISTORY_KEY));

function Harness({ onSubmit }: { onSubmit: () => void }) {
  const [v, setV] = useState('');
  return <CommandInput value={v} onChange={setV} onSubmit={onSubmit} />;
}

describe('CommandInput', () => {
  it('Enter and Ctrl+Enter submit; ↑/↓ browse the history and come back to the draft', async () => {
    pushHistory('command', 'ros2 topic list');
    pushHistory('command', 'ros2 node list');
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSubmit={onSubmit} />);
    const input = screen.getByLabelText('Digite o comando') as HTMLInputElement;
    await user.type(input, 'ros2 b');
    await user.keyboard('{ArrowUp}');
    expect(input.value).toBe('ros2 node list');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(input.value).toBe('ros2 topic list');
    await user.keyboard('{ArrowDown}');
    expect(input.value).toBe('ros2 node list');
    await user.keyboard('{ArrowDown}');
    expect(input.value).toBe('ros2 b');
    await user.keyboard('{Enter}');
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('history: per role, no consecutive duplicates, the last 100; corrupt storage is ignored', () => {
    pushHistory('command', 'a');
    pushHistory('command', 'a');
    pushHistory('command', '  ');
    pushHistory('program', 'print(1)');
    expect(historyOf('command')).toEqual(['a']);
    expect(historyOf('program')).toEqual(['print(1)']);
    for (let i = 0; i < 150; i++) pushHistory('command', `c${i}`);
    expect(historyOf('command')).toHaveLength(100);
    expect(historyOf('command').at(-1)).toBe('c149');
    localStorage.setItem(HISTORY_KEY, '{nope');
    expect(historyOf('command')).toEqual([]);
  });
});
