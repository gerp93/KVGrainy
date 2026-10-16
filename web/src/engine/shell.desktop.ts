import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Shell } from './shell.web';

/**
 * What the desktop app adds around the shared UI: real "Save as" and "Show in folder" instead of a
 * browser download, and files handed to the app (a right-click in Explorer, "Open with", a second launch).
 */

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
  tif: 'image/tiff', tiff: 'image/tiff', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo',
};

// ---- Save: intercept the UI's blob downloads ---------------------------------------------
// The UI makes `<a download href="blob:...">` links, which is right for a browser. Here the blob is
// remembered when it is created, and a click on such a link opens a native save dialog instead.

const blobs = new Map<string, Blob>();
const createObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (object: Blob | MediaSource) => {
  const url = createObjectURL(object);
  if (object instanceof Blob) blobs.set(url, object);
  return url;
};
const revokeObjectURL = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = (url: string) => {
  blobs.delete(url);
  revokeObjectURL(url);
};

let toast: HTMLDivElement | undefined;
let toastTimer: number | undefined;

function showToast(message: string, revealPath?: string) {
  toast?.remove();
  toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = message;
  toast.append(text);
  if (revealPath) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = 'Show in folder';
    button.addEventListener('click', () => void invoke('reveal_in_folder', { path: revealPath }));
    toast.append(button);
  }
  document.body.append(toast);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast?.remove(), 12_000);
}

document.addEventListener(
  'click',
  (event) => {
    const link = (event.target as Element | null)?.closest?.('a[download]') as HTMLAnchorElement | null;
    const blob = link ? blobs.get(link.href) : undefined;
    if (!link || !blob) return;
    event.preventDefault();
    event.stopPropagation();
    void (async () => {
      try {
        const path = await invoke<string | null>('save_file', await blob.arrayBuffer(), {
          headers: { 'x-name': encodeURIComponent(link.download || 'kvgrainy-output') },
        });
        if (path) showToast(`Saved to ${path}`, path);
      } catch (error) {
        showToast(`Could not save: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  },
  true,
);

// ---- Open: files handed to the app -------------------------------------------------------

async function toFile(path: string): Promise<File> {
  const bytes = await invoke<ArrayBuffer>('read_file', { path });
  const name = path.split(/[\\/]/).pop() ?? 'image';
  return new File([bytes], name, { type: MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? '' });
}

// ---- Updates: a link in the footer ---------------------------------------------------------

function addUpdateButton() {
  const footer = document.querySelector('footer');
  if (!footer) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn';
  button.textContent = 'Check for updates';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await invoke('check_for_updates');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      button.disabled = false;
    }
  });
  footer.append(button);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addUpdateButton);
else addUpdateButton();

export const shell: Shell = {
  nativeAnimation: true,
  onOpenFiles(callback) {
    const open = async (paths: string[]) => {
      try {
        callback(await Promise.all(paths.map(toFile)));
      } catch (error) {
        showToast(`Could not open the file: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    void invoke<string[]>('take_pending_files').then((paths) => {
      if (paths.length > 0) void open(paths);
    });
    void listen<string[]>('open-files', (event) => open(event.payload));
  },
};
