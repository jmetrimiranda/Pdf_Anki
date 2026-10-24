/** Like `core_ai::is_local_url`: `localhost` or a loopback address (the custom AI server on this computer). */
export function isLocalUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}
