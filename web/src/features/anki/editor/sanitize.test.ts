import { describe, expect, it } from 'vitest';
import { editorToFieldHtml, fieldToEditorFragment, htmlToText, MEDIA_ATTR, sanitizeHtml } from './sanitize';

describe('sanitizer', () => {
  it('removes scripts, handlers and javascript: URLs', () => {
    const out = sanitizeHtml(
      '<p onclick="steal()">hi<script>alert(1)</script></p><img src="x.png" onerror="steal()">' +
        '<a href="javascript:steal()">link</a><a href="JaVaScRiPt:x">y</a><iframe src="https://evil"></iframe>' +
        '<svg><script>x</script></svg><style>body{}</style><object data="x"></object>',
    );
    expect(out).not.toMatch(/script|onclick|onerror|javascript|iframe|svg|style>|object/i);
    expect(out).toContain('<p>hi</p>');
    expect(out).toContain('<img src="x.png">');
    expect(out).toContain('<a>link</a>');
  });

  it('keeps the allowed formatting', () => {
    const html =
      '<b>b</b><i>i</i><u>u</u><strong>s</strong><em>e</em><code>c</code><pre>p</pre><br><div>d</div>' +
      '<span>s</span><sub>1</sub><sup>2</sup><ul><li>a</li></ul><ol><li>b</li></ol>' +
      '<a href="https://ankiweb.net">w</a><a href="leitor://livro/abc?pagina=3">l</a><img src="https://x/y.png">';
    expect(sanitizeHtml(html)).toBe(html);
  });

  it('drops dangerous styles and unknown wrappers but keeps their text', () => {
    expect(sanitizeHtml('<span style="color: red">ok</span>')).toBe('<span style="color: red">ok</span>');
    expect(sanitizeHtml('<span style="background:url(https://evil)">x</span>')).toBe('<span>x</span>');
    expect(sanitizeHtml('<font color="red"><h1>title</h1></font>')).toBe('title');
    expect(sanitizeHtml('<img src="data:image/png;base64,AAA"><img src="//evil/x.png"><img src="file:///etc/x">')).toBe(
      '',
    );
    expect(sanitizeHtml('<!-- comment -->text')).toBe('text');
  });

  it('never runs anything while parsing', () => {
    (window as unknown as { pwned?: boolean }).pwned = false;
    sanitizeHtml('<img src=x onerror="window.pwned=true"><script>window.pwned=true</script>');
    expect((window as unknown as { pwned?: boolean }).pwned).toBe(false);
  });

  it('shows media through the media URL and restores the stored name on save', () => {
    const editor = document.createElement('div');
    editor.appendChild(
      fieldToEditorFragment(
        'casa<br><img src="fixture%20image.png"><img src="https://x/r.png">',
        (n) => `card://m/${n}`,
      ),
    );
    const imgs = editor.querySelectorAll('img');
    expect(imgs[0]!.getAttribute('src')).toBe('card://m/fixture image.png');
    expect(imgs[0]!.getAttribute(MEDIA_ATTR)).toBe('fixture%20image.png');
    // Remote images are not fetched by the editor.
    expect(imgs[1]!.hasAttribute('src')).toBe(false);
    expect(editorToFieldHtml(editor)).toBe('casa<br><img src="fixture%20image.png"><img src="https://x/r.png">');
  });

  it('stores an emptied field as empty', () => {
    const editor = document.createElement('div');
    editor.innerHTML = '<br>';
    expect(editorToFieldHtml(editor)).toBe('');
    editor.innerHTML = '<code>\u200bx</code>';
    expect(editorToFieldHtml(editor)).toBe('<code>x</code>');
  });

  it('extracts text for previews', () => {
    expect(htmlToText('<b>a</b>  <script>x</script><div>b</div>')).toBe('a b');
  });
});
