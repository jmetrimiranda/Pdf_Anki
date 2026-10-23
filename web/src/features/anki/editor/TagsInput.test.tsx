import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { addTags, splitTags, tagSuggestions, TagsInput } from './TagsInput';

function Harness({ initial = [] as string[], suggestions = [] as string[] }) {
  const [tags, setTags] = useState(initial);
  return (
    <>
      <TagsInput value={tags} onChange={setTags} suggestions={suggestions} label="Tags" />
      <output data-testid="tags">{tags.join('|')}</output>
    </>
  );
}

const value = () => screen.getByTestId('tags').textContent;

describe('tags input', () => {
  it('helpers split, dedupe and suggest', () => {
    expect(splitTags('  a b\tc ')).toEqual(['a', 'b', 'c']);
    expect(addTags(['Ros2'], ['ros2', 'x'])).toEqual(['Ros2', 'x']);
    expect(tagSuggestions(['livro::animal-farm', 'ros2', 'animal'], 'ani', [])).toEqual([
      'animal',
      'livro::animal-farm',
    ]);
    expect(tagSuggestions(['ros2'], 'ros', ['ros2'])).toEqual([]);
  });

  it('Space and Enter turn text into chips, Backspace removes the last one', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['velha']} />);
    const input = screen.getByRole('combobox', { name: 'Tags' });
    await user.type(input, 'ros2 livro::cap1{Enter}');
    expect(value()).toBe('velha|ros2|livro::cap1');
    await user.type(input, '{Backspace}');
    expect(value()).toBe('velha|ros2');
    await user.click(screen.getByRole('button', { name: 'Remover a tag velha' }));
    expect(value()).toBe('ros2');
  });

  it('autocompletes from the known tags', async () => {
    const user = userEvent.setup();
    render(<Harness suggestions={['livro::animal-farm', 'oxford', 'ros2']} />);
    const input = screen.getByRole('combobox', { name: 'Tags' });
    await user.type(input, 'ox');
    expect(screen.getByRole('option', { name: 'oxford' })).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(value()).toBe('oxford');
    await user.type(input, 'li');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(value()).toBe('oxford|livro::animal-farm');
  });

  it('pasting several words makes several tags; leaving the field keeps the last word', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Tags' });
    await user.click(input);
    await user.paste('a b c');
    expect(value()).toBe('a|b');
    await user.tab();
    expect(value()).toBe('a|b|c');
  });
});
