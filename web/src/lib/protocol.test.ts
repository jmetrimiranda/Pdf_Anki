import { describe, expect, it } from 'vitest';
import { detectUrlStyle, protocolUrl } from './protocol';

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
      expect(protocolUrl('pdf', 'cover/a', detectUrlStyle(ua))).toBe('pdf://localhost/cover/a');
    }
  });

  it('uses http://scheme.localhost on Windows and Android', () => {
    for (const ua of [UA.windows, UA.android]) {
      expect(detectUrlStyle(ua)).toBe('http');
      expect(protocolUrl('anki', 'x', detectUrlStyle(ua))).toBe('http://anki.localhost/x');
    }
  });

  it('builds library cover URLs', () => {
    expect(protocolUrl('pdf', 'cover/abc?v=2', 'scheme')).toBe('pdf://localhost/cover/abc?v=2');
    expect(protocolUrl('pdf', 'cover/abc?v=2', 'http')).toBe('http://pdf.localhost/cover/abc?v=2');
  });

  it('strips leading slashes', () => {
    expect(protocolUrl('card', '//media/a.png', 'scheme')).toBe('card://localhost/media/a.png');
  });
});
