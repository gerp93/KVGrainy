import { loadSource, optimizeAnimation, optimizeImage, type Source } from '../engine/engine';
import { isVideoFile, loadAnimatedImage, loadVideoFrames, type FrameSource } from '../engine/frames';
import { formatBytes, parseSizeLimit } from '../engine/limit';
import { mountSizeField } from './sizefield';
import { addToTuner, isTuneMode, openInTuner } from './tuner';
import type { Effort } from '../engine/search';
import { FORMAT_INFO, type Format, type OutputFormat, type OptimizeResult } from '../engine/types';

/** What a dropped file turned out to be once decoded: a still, or frames to fit as a GIF. */
type Loaded = { kind: 'still'; source: Source } | FrameSource;

const MEDIA_FILE = /\.(jpe?g|png|webp|gif|bmp|avif|mp4|m4v|mov|webm|mkv|avi)$/i;

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) if (value !== undefined) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

// ---- Theme: Dark / Light / Neon plus the Visual Assault dropdown (see themes.ts) ---------------

import './themes';

// ---- Settings ----------------------------------------------------------------------------

// The same size control the Fine-Tune GIF tab uses, with its own value.
const reduceSize = mountSizeField($('reduce-size'), 'reduce', { value: '500', unit: 'kb' });
// The size guides link here as /?limit=100kb; anything that isn't a size is ignored.
try {
  const wanted = new URLSearchParams(location.search).get('limit');
  if (wanted) reduceSize.setBytes(parseSizeLimit(wanted), { silent: true });
} catch {
  /* not a size: keep the default */
}
const formatSelect = $<HTMLSelectElement>('format');
const effortSelect = $<HTMLSelectElement>('effort');

function readSettings(): { limit: number; format?: Format; effort: Effort } | null {
  try {
    return {
      limit: reduceSize.getBytes(), // shows its own message under the box when the text isn't a size
      format: (formatSelect.value || undefined) as Format | undefined,
      effort: effortSelect.value as Effort,
    };
  } catch {
    return null;
  }
}

// ---- Queue -------------------------------------------------------------------------------

/**
 * Cards live in one of two lists. The Queue holds what is running and what is waiting, in the
 * order it will be (or is being) processed. Finished holds everything that has ended, whether it
 * worked, didn't fit, was cancelled or failed, newest first.
 */
type Stage = 'queue' | 'finished';

const jobs = $<HTMLElement>('jobs');
const lists: Record<Stage, HTMLOListElement> = { queue: $('queue-list'), finished: $('finished-list') };
const panels: Record<Stage, HTMLElement> = { queue: $('panel-queue'), finished: $('panel-finished') };
const tabs: Record<Stage, HTMLButtonElement> = { queue: $('tab-queue'), finished: $('tab-finished') };
const counts: Record<Stage, HTMLElement> = { queue: $('count-queue'), finished: $('count-finished') };
const empties: Record<Stage, HTMLElement> = { queue: $('empty-queue'), finished: $('empty-finished') };
const panelBar = panels.finished.querySelector<HTMLElement>('.panel-bar')!;
let activeTab: Stage = 'queue';
let queuedBefore = 0;

function showTab(stage: Stage, focus = false) {
  activeTab = stage;
  for (const s of ['queue', 'finished'] as const) {
    const on = s === stage;
    tabs[s].setAttribute('aria-selected', String(on));
    tabs[s].tabIndex = on ? 0 : -1;
    panels[s].hidden = !on;
  }
  if (focus) tabs[stage].focus();
}

function refreshTabs() {
  for (const s of ['queue', 'finished'] as const) {
    const n = lists[s].children.length;
    counts[s].textContent = String(n);
    empties[s].hidden = n > 0;
  }
  panelBar.hidden = lists.finished.children.length === 0;
  // When the last waiting file finishes, show the results rather than an empty queue.
  const waiting = lists.queue.children.length;
  if (queuedBefore > 0 && waiting === 0 && activeTab === 'queue' && lists.finished.children.length > 0) showTab('finished');
  queuedBefore = waiting;
}

function place(card: HTMLElement, stage: Stage) {
  jobs.hidden = false;
  // Queue keeps processing order (oldest first); Finished shows the latest result first.
  if (stage === 'queue') lists.queue.append(card);
  else lists.finished.prepend(card);
  refreshTabs();
}

for (const stage of ['queue', 'finished'] as const) {
  tabs[stage].addEventListener('click', () => showTab(stage));
  tabs[stage].addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      showTab(e.key === 'ArrowRight' || e.key === 'End' ? 'finished' : 'queue', true);
    }
  });
}

let queue: Promise<void> = Promise.resolve();
/** Every card's cleanup, so "Clear finished" can drop them without reaching into each one. */
const disposers = new Map<HTMLElement, () => void>();

$<HTMLButtonElement>('clear-finished').addEventListener('click', () => {
  for (const card of [...lists.finished.children]) disposers.get(card as HTMLElement)?.();
});

function enqueue(files: File[]) {
  const images = files.filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/') || MEDIA_FILE.test(f.name));
  if (images.length === 0) return;
  const settings = readSettings();
  if (!settings) return;
  showTab('queue');
  for (const file of images) {
    const card = createCard(file, settings);
    card.enqueue();
  }
}

interface Settings {
  limit: number;
  format?: Format;
  effort: Effort;
}

function createCard(file: File, settings: Settings) {
  const title = h('h2', {}, file.name);
  // Shown once the card has finished; a card that is waiting has its own Remove, a running one Cancel.
  const dismiss = h('button', { type: 'button', class: 'card-x', 'aria-label': `Remove ${file.name}`, title: 'Remove', hidden: '' }, '✕');
  const meta = h('p', { class: 'meta' }, formatBytes(file.size));
  const body = h('div');
  const root = h('li', { class: 'card' }, h('div', { class: 'card-head' }, title, dismiss), meta, body);
  const originalUrl = URL.createObjectURL(file);
  const isVideo = isVideoFile(file);
  let loaded: Loaded | undefined;
  let controller = new AbortController();
  let outputUrl: string | undefined;
  let removed = false;

  const setBody = (...nodes: (Node | string)[]) => body.replaceChildren(...nodes);
  const setNote = (text: string) => {
    const note = body.querySelector('.note');
    if (note) note.textContent = text;
  };
  const revokeOutput = () => {
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputUrl = undefined;
  };

  function showSearching(status: string) {
    controller = new AbortController();
    const bar = h('div');
    const track = h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar);
    const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
    cancel.addEventListener('click', () => controller.abort());
    setBody(h('p', { class: 'note' }, status), h('div', { class: 'row' }, track, cancel));
    return (fraction: number) => {
      const pct = Math.round(fraction * 100);
      bar.style.width = `${pct}%`;
      track.setAttribute('aria-valuenow', String(pct));
    };
  }

  function retryRow(label: string) {
    const again = h('button', { type: 'button', class: 'btn' }, label);
    again.addEventListener('click', () => {
      const next = readSettings();
      if (!next) return;
      Object.assign(settings, next);
      showTab('queue');
      enqueue();
    });
    return again;
  }

  /** Drop this card and everything it holds (blob URLs, decoded frames). Nothing is kept anywhere else. */
  function dispose() {
    removed = true;
    revokeOutput();
    URL.revokeObjectURL(originalUrl);
    loaded = undefined;
    disposers.delete(root);
    root.remove();
    refreshTabs();
  }
  disposers.set(root, dispose);
  dismiss.addEventListener('click', dispose);

  /** Open this animation in the Fine-Tune GIF tab, with the size limit carried over. */
  function fineTuneButton() {
    const button = h('button', { type: 'button', class: 'btn' }, 'Fine-tune');
    button.addEventListener('click', () => void openInTuner(file, settings.limit));
    return button;
  }

  /** Put this card at the back of the queue, showing that it is waiting its turn. */
  function enqueue() {
    removed = false;
    dismiss.hidden = true;
    const remove = h('button', { type: 'button', class: 'btn' }, 'Remove');
    remove.addEventListener('click', dispose);
    setBody(h('p', { class: 'note' }, 'Waiting for its turn…'), h('div', { class: 'row' }, remove));
    place(root, 'queue');
    queue = queue.then(() => run());
  }

  function download(bytes: Uint8Array, format: OutputFormat, label: string, primary: boolean) {
    const blob = new Blob([bytes as BlobPart], { type: FORMAT_INFO[format].mime });
    revokeOutput();
    outputUrl = URL.createObjectURL(blob);
    const stem = file.name.replace(/\.[^.]+$/, '') || 'image';
    return {
      url: outputUrl,
      link: h('a', { class: primary ? 'btn primary' : 'btn', href: outputUrl, download: `${stem}_kvgrainy.${FORMAT_INFO[format].extension}` }, label),
    };
  }

  /** Decode the file once: a video or animated image becomes frames, anything else a still. */
  async function load(): Promise<Loaded> {
    if (isVideo) return loadVideoFrames(file, setNote);
    const animation = await loadAnimatedImage(file, setNote);
    return animation ?? { kind: 'still', source: await loadSource(file) };
  }

  /** Animations can come out as GIF (the default) or animated WebP. Nothing else here can animate. */
  const animationOutput = (): 'gif' | 'webp' => (settings.format === 'webp' ? 'webp' : 'gif');

  function search(current: Loaded, setProgress: (fraction: number) => void): Promise<OptimizeResult> {
    return current.kind === 'still'
      ? optimizeImage(current.source, settings, setProgress, controller.signal)
      : optimizeAnimation(current, settings.limit, animationOutput(), setProgress, setNote, controller.signal);
  }

  /** Take this card's turn, then move it to Finished however it ended. */
  async function run() {
    if (removed) return;
    await process();
    // The decoded pixels are the heavy part (hundreds of MB for a long clip). Let go of them now;
    // "Run again" decodes the file afresh.
    loaded = undefined;
    if (removed) return;
    dismiss.hidden = false;
    place(root, 'finished');
  }

  async function process() {
    revokeOutput();
    const started = performance.now();
    const setProgress = showSearching(isVideo ? 'Reading the clip…' : 'Reading the image…');
    try {
      loaded ??= await load();
      const width = loaded.kind === 'still' ? loaded.source.raster.width : loaded.width;
      const height = loaded.kind === 'still' ? loaded.source.raster.height : loaded.height;
      const animated = loaded.kind === 'animation';
      meta.textContent = [
        formatBytes(file.size),
        `${width}×${height}`,
        loaded.kind === 'animation' ? `${loaded.frames.length} frames · ${(loaded.delays.reduce((a, b) => a + b, 0) / 1000).toFixed(1)}s` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      setProgress(0);
      setNote(animated ? `Fitting the animation as ${animationOutput() === 'webp' ? 'an animated WebP' : 'a GIF'}…` : 'Searching for the best fit…');
      const result = await search(loaded, setProgress);
      const seconds = ((performance.now() - started) / 1000).toFixed(1);

      if (!result.ok) {
        const parts: (Node | string)[] = [
          h('p', { class: 'note bad' }, `Nothing fits under ${formatBytes(result.limit)}. The smallest we could get is ${formatBytes(result.smallest)}. Try a larger limit or a ${animated ? 'shorter clip' : 'smaller image'}.`),
        ];
        const row = h('div', { class: 'row' });
        if (result.bestEffort) row.append(download(result.bestEffort.bytes, result.bestEffort.format, `Download the smallest (${formatBytes(result.smallest)})`, false).link);
        row.append(retryRow('Try again with these settings'));
        parts.push(row);
        setBody(...parts);
        return;
      }

      const { candidate } = result;
      const info = FORMAT_INFO[candidate.format];
      const { url, link } = download(candidate.bytes, candidate.format, `Download ${info.label}`, true);
      const saved = Math.round((1 - candidate.bytes.length / file.size) * 100);
      const newW = Math.max(1, Math.round(width * candidate.scale));
      const newH = Math.max(1, Math.round(height * candidate.scale));
      const detail = [
        info.label,
        candidate.format === 'gif' ? `${candidate.colors} colors` : candidate.quality !== undefined ? `quality ${candidate.quality}` : 'lossless',
        candidate.scale < 1 ? `resized to ${newW}×${newH} (${Math.round(candidate.scale * 100)}%)` : 'full size',
        candidate.frameStep && candidate.frameStep > 1 ? `every ${candidate.frameStep === 2 ? '2nd' : `${candidate.frameStep}th`} frame` : '',
        `${seconds}s`,
      ]
        .filter(Boolean)
        .join(' · ');
      // A GIF is nearly always bigger than the video it came from, so that comparison says nothing.
      const growth = candidate.bytes.length >= file.size && !isVideo;
      const notes: HTMLElement[] = [];
      if (loaded.kind === 'animation') {
        if (loaded.note) notes.push(h('p', { class: 'detail' }, loaded.note));
        if (loaded.hasAlpha && candidate.format === 'gif') notes.push(h('p', { class: 'detail' }, 'GIF has no partial transparency, so transparent areas were filled with white.'));
        // The Format menu was set to something an animation can't be saved as. Say so rather than ignore it.
        if (settings.format && settings.format !== 'webp') {
          notes.push(h('p', { class: 'detail' }, `You chose ${FORMAT_INFO[settings.format].label}, but ${FORMAT_INFO[settings.format].label} can't hold an animation, so this is a GIF. Choose WebP for an animated WebP.`));
        }
      }
      setBody(
        compare(originalUrl, url, width, height, isVideo),
        h(
          'p',
          { class: 'stats' },
          `${formatBytes(file.size)} → ${formatBytes(candidate.bytes.length)} `,
          h('span', { class: growth ? '' : 'saved' }, growth ? '(no smaller than the original)' : `(−${saved}%)`),
        ),
        h('p', { class: 'detail' }, detail),
        ...notes,
        h('div', { class: 'row' }, link, retryRow('Run again'), ...(animated ? [fineTuneButton()] : [])),
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setBody(h('p', { class: 'note' }, 'Cancelled.'), h('div', { class: 'row' }, retryRow('Start again')));
      } else {
        setBody(h('p', { class: 'note bad' }, err instanceof Error ? err.message : String(err)));
      }
    }
  }

  return { root, enqueue };
}

/** Before/after view: the original underneath, the result on top, revealed by dragging. */
function compare(beforeUrl: string, afterUrl: string, width: number, height: number, beforeIsVideo: boolean): HTMLElement {
  let before: HTMLElement;
  if (beforeIsVideo) {
    const video = h('video', { class: 'before', src: beforeUrl, muted: '', loop: '', autoplay: '', playsinline: '', 'aria-label': 'Original' });
    video.muted = true;
    before = video;
  } else {
    before = h('img', { class: 'before', src: beforeUrl, alt: 'Original' });
  }
  const after = h('img', { class: 'after', src: afterUrl, alt: 'Reduced version' });
  const handle = h('div', { class: 'handle' });
  const slider = h('input', { type: 'range', min: '0', max: '100', value: '50', 'aria-label': 'Compare original and reduced version' });
  const box = h('div', { class: 'compare' }, before, after, handle, h('span', { class: 'tag l' }, 'Original'), h('span', { class: 'tag r' }, 'Reduced'), slider);
  box.style.setProperty('--ratio', `${width} / ${height}`);
  const update = () => box.style.setProperty('--pos', `${slider.value}%`);
  slider.addEventListener('input', update);
  update();
  return box;
}

// ---- Input: drop, pick, paste ------------------------------------------------------------

const drop = $<HTMLLabelElement>('drop');
const fileInput = $<HTMLInputElement>('file');

fileInput.addEventListener('change', () => {
  enqueue([...(fileInput.files ?? [])]);
  fileInput.value = '';
});
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  drop.addEventListener(type, () => drop.classList.remove('over'));
}
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  enqueue([...(e.dataTransfer?.files ?? [])]);
});
// Dropping on the page outside the zone shouldn't navigate away to the image.
window.addEventListener('dragover', (e) => e.preventDefault());
// Files dropped or pasted anywhere else on the page go to whichever tab is showing.
window.addEventListener('drop', (e) => {
  if (e.target instanceof Node && drop.contains(e.target)) return;
  e.preventDefault();
  const files = [...(e.dataTransfer?.files ?? [])];
  if (isTuneMode()) addToTuner(files);
  else enqueue(files);
});
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length === 0) return;
  if (isTuneMode()) addToTuner(files);
  else enqueue(files);
});
