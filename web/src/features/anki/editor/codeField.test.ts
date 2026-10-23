import { describe, expect, it } from 'vitest';
import { codeToHtml, htmlToCode, isCodeField } from './codeField';

describe('code fields (spec 11.1)', () => {
  const samples = [
    'ros2 topic list',
    'if a < b && c > d:\n    print("x & y")',
    'a\tb\t\tc',
    'trailing spaces   \nnext line  ',
    'first\n\n\nafter empty lines\n',
    '\n\nleading empty lines',
    '&lt; stays literal &amp; too',
    '<script>alert(1)</script>',
    '',
    'unicode: ação → ✓',
  ];

  it.each(samples)('round trips %j', (text) => {
    expect(htmlToCode(codeToHtml(text))).toBe(text);
  });

  it('escapes HTML and turns newlines into <br>', () => {
    expect(codeToHtml('a < b & c > d\nnext')).toBe('a &lt; b &amp; c &gt; d<br>next');
    expect(codeToHtml('x\r\ny')).toBe('x<br>y');
  });

  it("reads fields written by Anki's editor (<div> lines, &nbsp;)", () => {
    expect(htmlToCode('<div>ros2 run turtlesim</div><div>turtlesim_node</div>')).toBe(
      'ros2 run turtlesim\nturtlesim_node',
    );
    expect(htmlToCode('<div>a</div><div><br></div><div>b</div>')).toBe('a\n\nb');
    expect(htmlToCode('first<div>second</div>')).toBe('first\nsecond');
    expect(htmlToCode('a&nbsp;&nbsp;b<br/>c<br />d')).toBe('a  b\nc\nd');
    expect(htmlToCode('<b>bold</b> &#60;tag&#x3E;')).toBe('bold <tag>');
  });

  it('knows which fields are code', () => {
    expect(isCodeField('Código · Comando', 'Resposta')).toBe(true);
    expect(isCodeField('Código · Comando', 'Pergunta')).toBe(false);
    expect(isCodeField('Código · Programa', 'Testes')).toBe(true);
    expect(isCodeField('Básico', 'Resposta')).toBe(false);
  });
});
