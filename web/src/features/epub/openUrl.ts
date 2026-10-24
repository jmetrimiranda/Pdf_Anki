// External http(s) links of a book open in the system browser (after a confirm in the reader), through the Tauri
// opener plugin. In the browser/mock build nothing is opened: the session records the URL (test hook).
import { isTauri } from '../../lib/core/client';

export async function openExternalUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  if (!isTauri()) return;
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}
