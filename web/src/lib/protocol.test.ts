import { describe, expect, it } from 'vitest';
import { detectUrlStyle, pdfRenderUrl, protocolUrl } from './protocol';

const UA = {
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  ios: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Edg/140.0',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile',
};

describe('protocolUrl', () => {
  it('uses scheme://localhost on Linux, macOS and iOS', () => {
    for (const ua of [UA.linux, UA.mac, UA.ios]) {
      expect(detectUrlStyle(ua)).toBe('scheme');
      expect(protocolUrl('pdf', 'render/a/0', detectUrlStyle(ua))).toBe('pdf://localhost/render/a/0');
    }
  });

  it('uses http://scheme.localhost on Windows and Android', () => {
    for (const ua of [UA.windows, UA.android]) {
      expect(detectUrlStyle(ua)).toBe('http');
      expect(protocolUrl('anki', 'x', detectUrlStyle(ua))).toBe('http://anki.localhost/x');
    }
  });

  it('strips leading slashes', () => {
    expect(protocolUrl('card', '//media/a.png', 'scheme')).toBe('card://localhost/media/a.png');
  });
});

describe('pdfRenderUrl', () => {
  it('builds the spec 6.2 route', () => {
    expect(pdfRenderUrl('doc 1', 0, { scale: 1.5, theme: 'sepia' }, 'scheme')).toBe(
      'pdf://localhost/render/doc%201/0?escala=1.5&tema=sepia',
    );
    expect(pdfRenderUrl('d', 3, { scale: 2, tile: [0, 10.5, 100, 200] }, 'http')).toBe(
      'http://pdf.localhost/render/d/3?escala=2&bloco=0,10.5,100,200',
    );
    expect(pdfRenderUrl('d', 0, { scale: 0.6, theme: 'escuro', preview: true }, 'scheme')).toBe(
      'pdf://localhost/render/d/0?escala=0.6&tema=escuro&previa=1',
    );
  });
});
