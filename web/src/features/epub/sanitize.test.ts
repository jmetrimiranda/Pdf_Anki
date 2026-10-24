import { describe, expect, it } from 'vitest';
import { isDangerousUrl, isRemoteUrl, isScriptType, sanitizeCss, sanitizeMarkup } from './sanitize';

const XHTML = 'application/xhtml+xml';

function xhtml(body: string, head = '') {
  return `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink"><head><title>t</title>${head}</head><body>${body}</body></html>`;
}

function parse(markup: string, type = XHTML): Document {
  return new DOMParser().parseFromString(markup, type as DOMParserSupportedType);
}

describe('EPUB sanitizer', () => {
  it('removes scripts (inline, external, SVG, inside foreignObject) and keeps the text', () => {
    const out = sanitizeMarkup(
      xhtml(
        `<p>Keep me</p><script>parent.__pwned=1</script><script src="evil.js"></script>
         <svg xmlns="http://www.w3.org/2000/svg"><script>parent.__pwned=2</script>
         <foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><script>parent.__pwned=3</script></div></foreignObject></svg>`,
        '<script>parent.__pwned=0</script>',
      ),
      XHTML,
    );
    const doc = parse(out);
    expect(doc.getElementsByTagName('script').length).toBe(0);
    expect(doc.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'script').length).toBe(0);
    expect(out).not.toContain('__pwned');
    expect(doc.body.textContent).toContain('Keep me');
  });

  it('keeps the element count with placeholders so CFIs of the rest stay the same', () => {
    const before = parse(xhtml('<p>a</p><script>x()</script><p id="b">b</p>'));
    const after = parse(sanitizeMarkup(xhtml('<p>a</p><script>x()</script><p id="b">b</p>'), XHTML));
    const index = (d: Document) => Array.from(d.body.children).indexOf(d.getElementById('b')!);
    expect(index(after)).toBe(index(before));
    expect(after.querySelector('[data-leitor-removed="script"]')?.hasAttribute('hidden')).toBe(true);
  });

  it('drops frames, objects, embeds, applets, base, meta refresh, forms actions and bad links', () => {
    const out = sanitizeMarkup(
      xhtml(
        `<iframe srcdoc="&lt;script&gt;x&lt;/script&gt;"></iframe><frame src="x"/><object data="x.swf"></object>
         <embed src="x"/><applet code="x"></applet><portal src="x"></portal><template><script>x</script></template>
         <form action="javascript:x()"><button formaction="javascript:y()">go</button></form>`,
        `<base href="http://evil.invalid/"/><meta http-equiv="refresh" content="0;url=javascript:x()"/>
         <link rel="import" href="x.html"/><link rel="prefetch" href="x"/><link rel="stylesheet" href="http://evil.invalid/a.css"/>
         <link rel="stylesheet" href="book.css"/><meta charset="utf-8"/>`,
      ),
      XHTML,
    );
    const doc = parse(out);
    for (const tag of ['iframe', 'frame', 'object', 'embed', 'applet', 'base', 'portal', 'template']) {
      expect(doc.getElementsByTagName(tag).length, tag).toBe(0);
    }
    expect(doc.querySelector('meta[http-equiv]')).toBeNull();
    expect(doc.querySelectorAll('link').length).toBe(1);
    expect(doc.querySelector('link')?.getAttribute('href')).toBe('book.css');
    expect(doc.querySelector('form')?.hasAttribute('action')).toBe(false);
    expect(doc.querySelector('button')?.hasAttribute('formaction')).toBe(false);
    expect(doc.querySelector('meta[charset]')).not.toBeNull();
  });

  it('removes every on* attribute (any case, any element)', () => {
    const out = sanitizeMarkup(
      xhtml(
        `<p onclick="x()" ONMOUSEOVER="y()">a</p><img src="a.png" onerror="parent.__pwned=1"/>
         <svg xmlns="http://www.w3.org/2000/svg" onload="x()"><rect onfocusin="x()"/></svg>`,
      ).replace('<body>', '<body onload="parent.__pwned=1">'),
      XHTML,
    );
    expect(out).not.toMatch(/\son\w+=/i);
    expect(parse(out).querySelector('img')?.getAttribute('src')).toBe('a.png');
  });

  it('neutralises javascript:, vbscript: and data:text/html URLs; keeps data: images and plain links', () => {
    const out = sanitizeMarkup(
      xhtml(
        `<a id="js" href="javascript:parent.__pwned=1">x</a><a id="js2" href=" JaVa&#x09;Script:alert(1)">x</a>
         <a id="vb" href="vbscript:x">x</a><a id="data" href="data:text/html,&lt;script&gt;x&lt;/script&gt;">x</a>
         <img id="png" src="data:image/png;base64,iVBORw0KGgo="/><a id="ok" href="chapter2.xhtml#n1">x</a>
         <a id="web" href="https://example.org/">web</a>
         <svg xmlns="http://www.w3.org/2000/svg"><a id="svgjs" xlink:href="javascript:x()"><text>t</text></a>
         <image id="remote" xlink:href="http://evil.invalid/x.png"/></svg>`,
      ),
      XHTML,
    );
    const doc = parse(out);
    const href = (id: string) => doc.getElementById(id)?.getAttribute('href') ?? null;
    expect(href('js')).toBeNull();
    expect(href('js2')).toBeNull();
    expect(href('vb')).toBeNull();
    expect(href('data')).toBeNull();
    expect(doc.getElementById('png')?.getAttribute('src')).toMatch(/^data:image\/png/);
    expect(href('ok')).toBe('chapter2.xhtml#n1');
    expect(href('web')).toBe('https://example.org/');
    expect(doc.getElementById('svgjs')?.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBeNull();
    expect(doc.getElementById('remote')?.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBeNull();
  });

  it('removes SVG <set>/<animate> that rewrite an href or an event', () => {
    const out = sanitizeMarkup(
      xhtml(`<svg xmlns="http://www.w3.org/2000/svg"><a><set attributeName="href" to="javascript:x()"/>
        <animate attributeName="xlink:href" values="javascript:x()"/><set attributeName="onmouseover" to="x()"/>
        <animate id="safe" attributeName="opacity" from="0" to="1"/></a></svg>`),
      XHTML,
    );
    const doc = parse(out);
    const svg = 'http://www.w3.org/2000/svg';
    expect(doc.getElementsByTagNameNS(svg, 'set').length).toBe(0);
    expect(doc.getElementsByTagNameNS(svg, 'animate').length).toBe(1);
    expect(doc.getElementById('safe')).not.toBeNull();
  });

  it('blocks remote resources: src, srcset, poster, CSS url() and @import', () => {
    const out = sanitizeMarkup(
      xhtml(
        `<img id="a" src="http://evil.invalid/p.png"/><img id="b" src="//evil.invalid/p.png"/>
         <img id="c" srcset="a.png 1x, https://evil.invalid/b.png 2x"/><video id="v" poster="https://evil.invalid/p.png"></video>
         <p id="s" style="background:url('http://evil.invalid/bg.png')">x</p><img id="ok" src="../images/figure.png"/>`,
        `<style>@import url("https://evil.invalid/a.css"); body { background: url(https://evil.invalid/b.png) } p { background: url(local.png) }</style>`,
      ),
      XHTML,
    );
    const doc = parse(out);
    expect(doc.getElementById('a')?.hasAttribute('src')).toBe(false);
    expect(doc.getElementById('b')?.hasAttribute('src')).toBe(false);
    expect(doc.getElementById('c')?.hasAttribute('srcset')).toBe(false);
    expect(doc.getElementById('v')?.hasAttribute('poster')).toBe(false);
    expect(doc.getElementById('s')?.getAttribute('style')).not.toContain('evil');
    expect(doc.getElementById('ok')?.getAttribute('src')).toBe('../images/figure.png');
    const css = doc.querySelector('style')?.textContent ?? '';
    expect(css).not.toContain('evil');
    expect(css).toContain('url(local.png)');
  });

  it('cleans CSS files and blob URLs pass', () => {
    expect(sanitizeCss('a{background:url("http://x/y.png")}')).toBe('a{background:url("")}');
    expect(sanitizeCss('@import "https://x/a.css"; p{}')).toBe(' p{}');
    expect(sanitizeCss('a{background:url(blob:http://localhost/123)}')).toContain('blob:');
    expect(sanitizeCss('a{width:expression(alert(1))}')).not.toContain('expression(');
  });

  it('sanitizes HTML (not XHTML) documents too', () => {
    const out = sanitizeMarkup(
      '<!DOCTYPE html><html><head><script>x()</script></head><body onload="x()"><p>t</p><img src=x onerror=y()></body></html>',
      'text/html',
    );
    expect(out).not.toContain('<script');
    expect(out).not.toMatch(/onload|onerror/);
    expect(out).toContain('<p>t</p>');
  });

  it('returns an empty document for malformed XHTML instead of the raw markup', () => {
    const out = sanitizeMarkup('<html><body><p>unclosed<script>parent.__pwned=1</script>', XHTML);
    expect(out).not.toContain('__pwned');
    expect(parse(out).querySelector('parsererror')).toBeNull();
  });

  it('classifies URLs and types', () => {
    expect(isDangerousUrl('javascript:x')).toBe(true);
    expect(isDangerousUrl('  java\nscript:x')).toBe(true);
    expect(isDangerousUrl('data:image/svg+xml,<svg onload=x()>')).toBe(true);
    expect(isDangerousUrl('data:image/jpeg;base64,AAAA')).toBe(false);
    expect(isDangerousUrl('text/ch1.xhtml')).toBe(false);
    expect(isRemoteUrl('https://a')).toBe(true);
    expect(isRemoteUrl('//a/b')).toBe(true);
    expect(isRemoteUrl('file:///etc/passwd')).toBe(true);
    expect(isRemoteUrl('blob:http://localhost/1')).toBe(false);
    expect(isScriptType('application/javascript')).toBe(true);
    expect(isScriptType('text/ecmascript')).toBe(true);
    expect(isScriptType('application/xhtml+xml')).toBe(false);
  });
});
