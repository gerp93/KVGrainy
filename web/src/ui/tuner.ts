import { isVideoFile, loadAnimatedImage, loadVideoFrames, probeAnimation, type Animation, type FrameSource, type VideoOptions } from '../engine/frames';
import { formatBytes } from '../engine/limit';
import { PRIORITY_LABELS, effectiveIndex, type GifConfig, type Priority } from '../engine/tuner';
import { TunerClient } from '../engine/tuner-client';
import { buildZip } from '../engine/zip';
import { mountSizeField } from './sizefield';

/**
 * The "Fine-Tune GIF" tab, a port of the desktop app's tab of the same name, extended to several
 * files. Add up to {@link MAX_FILES} animations; nothing runs on its own. Page through them (or
 * click one) to tune with a live animated preview, and/or press "Run on all" to apply the settings
 * to every file at once and download the lot as a zip.
 *
 * "Same settings for every file" (on by default) makes priority and quality global. Untick it and
 * each file remembers its own, so you can tune them one by one and then run them all.
 */

const MAX_FILES = 20;

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

// ---- Mode tabs (Reduce | Fine-Tune GIF) -------------------------------------------------

type Mode = 'reduce' | 'tune';
const modeTabs: Record<Mode, HTMLButtonElement> = { reduce: $('mode-reduce'), tune: $('mode-tune') };
const modePanels: Record<Mode, HTMLElement> = { reduce: $('panel-mode-reduce'), tune: $('panel-mode-tune') };

export function showMode(mode: Mode, focus = false) {
  document.documentElement.dataset.mode = mode;
  for (const m of ['reduce', 'tune'] as const) {
    const on = m === mode;
    modeTabs[m].setAttribute('aria-selected', String(on));
    modeTabs[m].tabIndex = on ? 0 : -1;
    modePanels[m].hidden = !on;
  }
  if (focus) modeTabs[mode].focus();
}

export const isTuneMode = () => !modePanels.tune.hidden;

for (const mode of ['reduce', 'tune'] as const) {
  modeTabs[mode].addEventListener('click', () => showMode(mode));
  modeTabs[mode].addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      showMode(e.key === 'ArrowRight' || e.key === 'End' ? 'tune' : 'reduce', true);
    }
  });
}

// ---- Elements ---------------------------------------------------------------------------

const dropZone = $<HTMLLabelElement>('tune-drop');
const fileInput = $<HTMLInputElement>('tune-input');
const batchBox = $<HTMLElement>('tune-batch');
const review = document.querySelector<HTMLElement>('#panel-mode-tune .review')!;
const dropHome = $<HTMLElement>('tune-drop-home');
const listDropSlot = $<HTMLElement>('tune-drop-list-slot');
const dropTitle = $<HTMLElement>('tune-drop-title');
const dropHint = $<HTMLElement>('tune-drop-hint');
const countText = $<HTMLParagraphElement>('tune-count');
const notice = $<HTMLParagraphElement>('tune-notice');
const runNote = $<HTMLParagraphElement>('tune-run-note');
const list = $<HTMLOListElement>('tune-list');
const runButton = $<HTMLButtonElement>('tune-run');
const cancelButton = $<HTMLButtonElement>('tune-cancel');
const zipButton = $<HTMLButtonElement>('tune-zip');
const clearButton = $<HTMLButtonElement>('tune-clear');
const videoBox = $<HTMLElement>('tune-video');
const fpsInput = $<HTMLInputElement>('tune-fps');
const startInput = $<HTMLInputElement>('tune-start');
const endInput = $<HTMLInputElement>('tune-end');
const reloadButton = $<HTMLButtonElement>('tune-reload');
const sharedBox = $<HTMLInputElement>('tune-shared');
const sharedNote = $<HTMLParagraphElement>('tune-shared-note');
const prioritySelect = $<HTMLSelectElement>('tune-priority');
const slider = $<HTMLInputElement>('tune-quality');
const maxLabel = $<HTMLSpanElement>('tune-max-label');
const pager = $<HTMLDivElement>('tune-pager');
const prevButton = $<HTMLButtonElement>('tune-prev');
const nextButton = $<HTMLButtonElement>('tune-next');
const position = $<HTMLSpanElement>('tune-position');
const fileLabel = $<HTMLParagraphElement>('tune-file');
const preview = $<HTMLDivElement>('tune-preview');
const info = $<HTMLParagraphElement>('tune-info');
const busyNote = $<HTMLParagraphElement>('tune-busy');
const saveLink = $<HTMLAnchorElement>('tune-save');

// The same size control as the Reduce tab, here with the other settings, starting at the desktop tab's 300 KB.
const DEFAULT_LIMIT = 300 * 1024;
const tuneSize = mountSizeField($('tune-size'), 'tune', { value: '300', unit: 'kb' });

for (const [priority, label] of Object.entries(PRIORITY_LABELS)) {
  const option = document.createElement('option');
  option.value = priority;
  option.textContent = label;
  prioritySelect.append(option);
}

// ---- State ------------------------------------------------------------------------------

interface Result {
  bytes: Uint8Array;
  url: string;
  config: GifConfig;
}

interface Meta {
  frameCount: number;
  width: number;
  height: number;
  firstDelay: number;
  isVideo: boolean;
  note?: string;
  sourceSeconds?: number;
}

type State = 'idle' | 'reading' | 'ready' | 'working' | 'done' | 'error';

interface Item {
  id: number;
  file: File;
  state: State;
  meta?: Meta;
  options?: VideoOptions;
  /** This file's own settings, used when "same settings" is off. */
  limit: number;
  priority: Priority;
  quality: number;
  result?: Result;
  message?: string;
  /** What the file's header says, read as soon as it is added. */
  probe: Promise<Animation>;
  /** A single image: flagged in the list straight away and left out of runs and paging. */
  notAnimated?: boolean;
  /** Frees whatever the row's thumbnail holds (a video's temporary URL). */
  releaseThumb?: () => void;
  li: HTMLLIElement;
  statusEl: HTMLElement;
  actionsEl: HTMLElement;
}

const items: Item[] = [];
let nextId = 1;
let selected: Item | undefined;
let client: TunerClient | undefined;
let maxFeasible = 0;
let ladderLength = 1;
let limitBytes = 0;
let loadToken = 0;
let boundsToken = 0;
let debounce: number | undefined;
let busy = 0;
let running = false;
let cancelRequested = false;
let activeClient: TunerClient | undefined;

const shared = () => sharedBox.checked;
const currentPriority = () => prioritySelect.value as Priority;
const currentQuality = () => Number(slider.value);

function setBusy(delta: number) {
  busy = Math.max(0, busy + delta);
  busyNote.hidden = busy === 0;
}

function stem(file: File): string {
  return file.name.replace(/\.[^.]+$/, '') || 'animation';
}

/** The settings a file is processed with: the shared controls, or its own. */
function settingsFor(item: Item): { priority: Priority; quality: number } {
  return shared() ? { priority: currentPriority(), quality: currentQuality() } : { priority: item.priority, quality: item.quality };
}

// ---- Rows -------------------------------------------------------------------------------

const ordinal = (n: number) => (n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);

/** Every row leads with the file's original size, so there is always something to compare the result to. */
function statusText(item: Item): string {
  const original = formatBytes(item.file.size);
  switch (item.state) {
    case 'idle':
      return `${original} · Waiting`;
    case 'reading':
      return `${original} · Reading…`;
    case 'working':
      return `${original} · Working…`;
    case 'error':
      return `${original} · ${item.message ?? 'Failed'}`;
    case 'done': {
      const r = item.result!;
      const step = r.config.frameStep > 1 ? ` · every ${ordinal(r.config.frameStep)} frame` : '';
      return `${original} → ${formatBytes(r.bytes.length)} · scale ${r.config.scale.toFixed(2)} · ${r.config.colors} colors${step}`;
    }
    default: {
      const m = item.meta;
      return m ? `${original} · ${m.frameCount} frames · ${m.width}×${m.height}` : original;
    }
  }
}

function renderRow(item: Item) {
  item.li.classList.toggle('current', item === selected);
  item.li.setAttribute('aria-current', item === selected ? 'true' : 'false');
  item.statusEl.textContent = statusText(item);
  item.statusEl.classList.toggle('bad', item.state === 'error');
  item.actionsEl.replaceChildren();
  if (item.result) {
    const save = document.createElement('a');
    save.className = 'btn';
    save.href = item.result.url;
    save.download = `${stem(item.file)}_kvgrainy.gif`;
    save.textContent = 'Save';
    item.actionsEl.append(save);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'card-x';
  remove.textContent = '✕';
  remove.title = 'Remove';
  remove.setAttribute('aria-label', `Remove ${item.file.name}`);
  remove.disabled = running;
  remove.addEventListener('click', () => removeItem(item));
  item.actionsEl.append(remove);
}

function updateToolbar() {
  // Nothing to preview or list until a file is added. Until then the drop zone is the big target; afterwards it
  // becomes a small strip at the top of the list, so more files can be added without it taking over the page.
  const hasFiles = items.length > 0;
  review.hidden = !hasFiles;
  batchBox.hidden = !hasFiles;
  const slot = hasFiles ? listDropSlot : dropHome;
  if (dropZone.parentElement !== slot) slot.append(dropZone);
  dropZone.classList.toggle('compact', hasFiles);
  dropTitle.textContent = hasFiles ? 'Drop more GIFs here' : 'Drop GIFs or short clips here';
  dropHint.textContent = hasFiles ? 'or click to add' : 'or paste, or click to choose. Nothing runs until you press Run on all.';
  const done = items.filter((i) => i.result).length;
  // Single images are flagged in the list but take no part in runs, counts or paging.
  const ok = usable();
  const stills = items.length - ok.length;
  countText.textContent = running
    ? `Working on ${Math.min(ok.findIndex((i) => i.state === 'working') + 1, ok.length)} of ${ok.length}…`
    : `${items.length} file${items.length === 1 ? '' : 's'}${done ? ` · ${done} done` : ''}${stills ? ` · ${stills} not animated` : ''}`;
  // With shared settings the button runs everything. With per-file settings the files you tuned already have
  // their results, so it only finishes the others; redoing the tuned ones would be pointless.
  const remaining = ok.filter((i) => !i.result);
  if (shared()) {
    runButton.textContent = 'Run on all';
    runButton.disabled = running || ok.length === 0;
    runNote.textContent = 'Run on all applies the size, priority and quality above to every file.';
  } else {
    runButton.textContent = remaining.length > 0 && remaining.length < ok.length ? `Run the other ${remaining.length}` : 'Run on all';
    runButton.disabled = running || remaining.length === 0;
    runNote.textContent =
      'Each file uses its own settings. Tune files one by one (their results are kept), then run the ones you have not opened yet.';
  }
  cancelButton.hidden = !running;
  zipButton.hidden = running || done === 0;
  clearButton.disabled = running;
  const index = selected && !selected.notAnimated ? ok.indexOf(selected) : -1;
  pager.hidden = ok.length < 2;
  position.textContent = `${index >= 0 ? index + 1 : '–'} of ${ok.length}`;
  prevButton.disabled = running || ok.length === 0 || index === 0;
  nextButton.disabled = running || ok.length === 0 || index === ok.length - 1;
  prioritySelect.disabled = running;
  sharedBox.disabled = running;
  slider.disabled = running || !client;
  for (const item of items) renderRow(item);
}

/**
 * A small still picture of the file for its row: the first frame of an image or animation (drawn once
 * onto a canvas, so a long list of GIFs doesn't all play at once), or a video's first frame.
 */
async function makeThumbnail(file: File): Promise<{ node: HTMLElement; release: () => void } | null> {
  try {
    if (isVideoFile(file)) {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.src = `${url}#t=0.1`; // a frame just past the start, so it isn't black
      return { node: video, release: () => URL.revokeObjectURL(url) };
    }
    const bitmap = await createImageBitmap(file);
    const size = 96; // drawn at twice its displayed size, for sharp screens
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    const scale = Math.max(size / bitmap.width, size / bitmap.height); // fill the square, cropping the overflow
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
    bitmap.close();
    return { node: canvas, release: () => {} };
  } catch {
    return null; // the row just has no picture
  }
}

function createRow(file: File): Item {
  const li = document.createElement('li');
  li.className = 'tune-row';
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'tune-pick';
  const name = document.createElement('span');
  name.className = 'tune-name';
  name.textContent = file.name;
  const statusEl = document.createElement('span');
  statusEl.className = 'tune-status';
  pick.append(name, statusEl);
  const actionsEl = document.createElement('span');
  actionsEl.className = 'tune-actions';
  const thumb = document.createElement('span');
  thumb.className = 'tune-thumb';
  thumb.setAttribute('aria-hidden', 'true'); // the name beside it says everything the picture does
  li.append(thumb, pick, actionsEl);
  const item: Item = {
    id: nextId++,
    file,
    state: 'idle',
    limit: tuneSize.peek() ?? DEFAULT_LIMIT,
    priority: currentPriority(),
    quality: currentQuality(),
    probe: probeAnimation(file),
    li,
    statusEl,
    actionsEl,
  };
  void item.probe.then((kind) => {
    if (kind === 'still' && items.includes(item)) markNotAnimated(item);
  });
  void makeThumbnail(file).then((made) => {
    if (!made) return;
    if (!items.includes(item)) return made.release(); // removed before it finished
    item.releaseThumb = made.release;
    thumb.replaceChildren(made.node);
  });
  pick.addEventListener('click', () => {
    if (!running) void select(item);
  });
  return item;
}

const NOT_ANIMATED = 'Not animated. Use the Reduce tab for stills.';
const usable = () => items.filter((i) => !i.notAnimated);

/** Flag a single image the moment we know, instead of at the end of a run. */
function markNotAnimated(item: Item) {
  clearResult(item);
  item.notAnimated = true;
  item.state = 'error';
  item.message = NOT_ANIMATED;
  if (item === selected) showNotAnimated(item);
  updateToolbar();
}

function showNotAnimated(item: Item) {
  loadToken++; // anything still reading this file is moot
  client?.dispose();
  client = undefined;
  clearPreview('That file is a single image, not an animation.');
  fileLabel.textContent = `${item.file.name} (not animated)`;
  info.textContent = '';
  videoBox.hidden = true;
}

// ---- Results ----------------------------------------------------------------------------

function clearResult(item: Item) {
  if (item.result) URL.revokeObjectURL(item.result.url);
  item.result = undefined;
  if (item.state === 'done') item.state = item.meta ? 'ready' : 'idle';
}

function setResult(item: Item, bytes: Uint8Array, config: GifConfig) {
  if (item.result) URL.revokeObjectURL(item.result.url);
  item.result = { bytes, config, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/gif' })) };
  item.state = 'done';
  item.message = undefined;
}

/** Results go stale when the limit or settings change. The selected file is recomputed straight away. */
function invalidate(which: Item[]) {
  for (const item of which) clearResult(item);
  updateToolbar();
}

// ---- Selecting and previewing -----------------------------------------------------------

async function decode(item: Item, onStatus: (text: string) => void): Promise<FrameSource | null> {
  return isVideoFile(item.file) ? loadVideoFrames(item.file, onStatus, item.options) : loadAnimatedImage(item.file, onStatus);
}

function metaOf(source: FrameSource, file: File): Meta {
  return {
    frameCount: source.frames.length,
    width: source.width,
    height: source.height,
    firstDelay: source.delays[0] ?? 100,
    isVideo: isVideoFile(file),
    note: source.note,
    sourceSeconds: source.sourceSeconds,
  };
}

function clearPreview(message: string) {
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = message;
  preview.replaceChildren(empty);
  saveLink.removeAttribute('href');
  saveLink.setAttribute('aria-disabled', 'true');
}

function applyControls(priority: Priority, quality: number) {
  prioritySelect.value = priority;
  slider.value = String(quality);
}

/** Make `item` the one in the live preview: decode it and tune it with the shared or its own settings. */
async function select(item: Item) {
  const token = ++loadToken;
  selected = item;
  client?.dispose();
  client = undefined;
  if (!shared()) {
    applyControls(item.priority, item.quality);
    tuneSize.setBytes(item.limit, { silent: true });
  }
  if (item.notAnimated) {
    showNotAnimated(item);
    updateToolbar();
    return;
  }
  clearPreview('Reading the file…');
  info.textContent = '';
  fileLabel.textContent = item.file.name;
  videoBox.hidden = !isVideoFile(item.file);
  item.state = item.result ? 'done' : 'reading';
  updateToolbar();
  setBusy(1);
  try {
    // The header says whether it is worth decoding at all.
    if ((await item.probe) === 'still') {
      if (token === loadToken) markNotAnimated(item);
      return;
    }
    const source = await decode(item, (text) => (info.textContent = text));
    if (token !== loadToken) return;
    if (!source) {
      item.state = 'error';
      item.notAnimated = true;
      item.message = NOT_ANIMATED;
      clearPreview('That file is a single image, not an animation.');
      fileLabel.textContent = `${item.file.name} (not animated)`;
      return;
    }
    item.meta = metaOf(source, item.file);
    if (item.state === 'reading') item.state = 'ready';
    fileLabel.textContent = `${item.file.name}  (${item.meta.frameCount} frames, ${item.meta.width}x${item.meta.height}, original ${formatBytes(item.file.size)})`;
    if (item.meta.isVideo) {
      fpsInput.value = String(item.options?.fps ?? 12);
      startInput.value = String(item.options?.start ?? 0);
      endInput.value = item.options?.end !== undefined ? String(item.options.end) : item.meta.sourceSeconds ? item.meta.sourceSeconds.toFixed(2) : '';
    }
    client = new TunerClient(source);
    info.textContent = item.meta.note ?? '';
    updateToolbar();
    await recomputeBounds();
  } catch (err) {
    if (token !== loadToken) return;
    item.state = 'error';
    item.message = err instanceof Error ? err.message : String(err);
    clearPreview('Could not read that file.');
    info.textContent = item.message;
  } finally {
    setBusy(-1);
    updateToolbar();
  }
}

/** Find the best config that still fits the limit; the slider's far-right end always maps to it. */
async function recomputeBounds() {
  const item = selected;
  const mine = client;
  if (!mine || !item) return;
  try {
    // The box shows this file's size: the shared one, or its own when settings are per file.
    limitBytes = tuneSize.getBytes();
  } catch (err) {
    info.textContent = `Invalid size limit: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  const token = ++boundsToken;
  setBusy(1);
  try {
    const index = await mine.bounds(currentPriority(), limitBytes);
    if (token !== boundsToken || mine !== client) return;
    maxFeasible = index;
    ladderLength = mine.ladder(currentPriority()).length;
    maxLabel.textContent = index === 0 ? 'Max = original quality' : 'Max (best that fits limit)';
    await refreshPreview();
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) info.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    setBusy(-1);
  }
}

async function refreshPreview() {
  debounce = undefined;
  const mine = client;
  const item = selected;
  if (!mine || !item) return;
  const priority = currentPriority();
  const index = effectiveIndex(currentQuality(), maxFeasible, ladderLength);
  const config = mine.ladder(priority)[index]!;
  setBusy(1);
  try {
    const bytes = await mine.encode(priority, index);
    if (!bytes || mine !== client || item !== selected) return; // replaced by a newer slider position
    showResult(item, bytes, config);
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) info.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    setBusy(-1);
  }
}

function showResult(item: Item, bytes: Uint8Array, config: GifConfig) {
  setResult(item, bytes, config);
  const result = item.result!;
  const img = document.createElement('img');
  img.src = result.url;
  img.alt = 'Fine-tuned GIF preview';
  preview.replaceChildren(img);

  const delay = item.meta?.firstDelay ?? 100;
  const fps = delay ? 1000 / (delay * config.frameStep) : 0;
  const over = bytes.length > limitBytes ? '  (over the limit: nothing fits, this is the smallest)' : '';
  info.textContent =
    `${formatBytes(bytes.length)} / ${formatBytes(limitBytes)} limit${over}  |  original ${formatBytes(item.file.size)}  |  ` +
    `scale=${config.scale.toFixed(2)}  colors=${config.colors}  frame step=${config.frameStep} (~${fps.toFixed(1)}fps)`;

  saveLink.href = result.url;
  saveLink.download = `${stem(item.file)}_kvgrainy.gif`;
  saveLink.setAttribute('aria-disabled', 'false');
  updateToolbar();
}

// ---- Adding and removing files ----------------------------------------------------------

/** A message about the list itself (a cap, skipped files). It has its own line so the preview's info can't overwrite it. */
function say(text: string) {
  notice.textContent = text;
  notice.hidden = false;
}

const MEDIA_EXT = /\.(gif|webp|png|apng|avif|jpe?g|bmp|tiff?|mp4|m4v|mov|webm|mkv|avi)$/i;

/** Stage files. Nothing runs; the first one added is previewed. Returns the rows it added. */
export function addToTuner(files: File[], limit?: number): Item[] {
  notice.hidden = true;
  if (running) {
    say('A run is in progress. Add more files when it finishes.');
    return [];
  }
  // Any picture or clip gets a row, so a still is flagged in the list instead of silently vanishing.
  const candidates = files.filter((f) => f.type.startsWith('video/') || f.type.startsWith('image/') || MEDIA_EXT.test(f.name));
  const room = MAX_FILES - items.length;
  const accepted = candidates.slice(0, Math.max(0, room));
  const added: Item[] = [];
  for (const file of accepted) {
    const item = createRow(file);
    if (limit) item.limit = limit;
    items.push(item);
    list.append(item.li);
    added.push(item);
  }
  const notAnimationTypes = files.length - candidates.length;
  const overCap = candidates.length - accepted.length;
  const parts: string[] = [];
  if (overCap > 0) parts.push(`Up to ${MAX_FILES} files at a time, so ${overCap} ${overCap === 1 ? 'was' : 'were'} not added.`);
  if (notAnimationTypes > 0) parts.push(`${notAnimationTypes} file${notAnimationTypes === 1 ? '' : 's'} skipped: they aren't pictures or clips.`);
  if (parts.length > 0) say(parts.join(' '));
  updateToolbar();
  if (added.length > 0 && !selected) void select(added[0]!);
  return added;
}

function removeItem(item: Item) {
  if (running) return;
  const index = items.indexOf(item);
  clearResult(item);
  item.releaseThumb?.();
  items.splice(index, 1);
  item.li.remove();
  if (item === selected) {
    client?.dispose();
    client = undefined;
    selected = undefined;
    const next = items[Math.min(index, items.length - 1)];
    if (next) void select(next);
    else {
      clearPreview('Add a GIF to preview it here.');
      fileLabel.textContent = 'Nothing selected. Click a file in the list to preview it here.';
      info.textContent = '';
      videoBox.hidden = true;
    }
  }
  updateToolbar();
}

/** Open one file in the tuner (the Fine-tune button on a finished Reduce card), carrying its limit over. */
export async function openInTuner(file: File, limit?: number) {
  showMode('tune');
  // With shared settings the size is global, so it moves for everyone (and the file on screen is redone);
  // with per-file settings only the new file gets it.
  if (limit && shared()) tuneSize.setBytes(limit);
  const [added] = addToTuner([file], limit);
  if (added && selected !== added) await select(added);
}

// ---- Run on all -------------------------------------------------------------------------

async function runAll() {
  if (running || usable().length === 0) return;
  // One size for everyone when settings are shared; otherwise each file uses its own, below.
  let sharedLimit = 0;
  if (shared()) {
    try {
      sharedLimit = tuneSize.getBytes();
    } catch {
      return;
    }
  }
  // Shared settings: redo everyone with them. Per-file settings: the files you tuned already have their results,
  // so only the ones without one are run (with their own settings).
  const targets = shared() ? usable() : usable().filter((i) => !i.result);
  if (targets.length === 0) return;
  running = true;
  cancelRequested = false;
  const keepSelected = selected;
  for (const item of targets) {
    clearResult(item);
    item.state = 'idle';
  }
  updateToolbar();

  for (const item of targets) {
    if (cancelRequested) break;
    item.state = 'working';
    updateToolbar();
    let own: TunerClient | undefined;
    try {
      let c = item === keepSelected ? client : undefined;
      if (!c) {
        const source = await decode(item, (text) => (item.statusEl.textContent = text));
        if (cancelRequested) break;
        if (!source) {
          // The header didn't say, but the decoder found a single frame.
          item.notAnimated = true;
          item.state = 'error';
          item.message = NOT_ANIMATED;
          continue;
        }
        item.meta = metaOf(source, item.file);
        c = own = new TunerClient(source);
      }
      activeClient = c;
      const { priority, quality } = settingsFor(item);
      const limit = shared() ? sharedLimit : item.limit;
      const best = await c.bounds(priority, limit);
      const ladder = c.ladder(priority);
      const index = effectiveIndex(quality, best, ladder.length);
      const bytes = await c.encode(priority, index);
      if (!bytes) throw new Error('Replaced');
      setResult(item, bytes, ladder[index]!);
    } catch (err) {
      if (cancelRequested || (err instanceof DOMException && err.name === 'AbortError')) {
        item.state = item.meta ? 'ready' : 'idle';
        break;
      }
      item.state = 'error';
      item.message = err instanceof Error ? err.message : String(err);
    } finally {
      own?.dispose();
      activeClient = undefined;
    }
  }

  running = false;
  // Cancelling disposed whatever was in use; bring the preview back if it was the selected file's.
  for (const item of items) if (item.state === 'working') item.state = item.meta ? 'ready' : 'idle';
  updateToolbar();
  if (keepSelected && items.includes(keepSelected) && !client) await select(keepSelected);
}

runButton.addEventListener('click', () => void runAll());
cancelButton.addEventListener('click', () => {
  cancelRequested = true;
  if (activeClient) {
    if (activeClient === client) client = undefined;
    activeClient.dispose();
  }
});

zipButton.addEventListener('click', () => {
  const done = items.filter((i) => i.result);
  if (done.length === 0) return;
  const zip = buildZip(done.map((i) => ({ name: `${stem(i.file)}_kvgrainy.gif`, data: i.result!.bytes })));
  const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'kvgrainy-gifs.zip';
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

clearButton.addEventListener('click', () => {
  if (running) return;
  for (const item of [...items]) removeItem(item);
});

// ---- Controls ---------------------------------------------------------------------------

/** After the shared or per-file settings change, results that used the old ones are stale. */
function settingsChanged() {
  const stale = shared() ? items.filter((i) => i !== selected) : [];
  invalidate(stale);
}

prioritySelect.addEventListener('change', () => {
  if (selected && !shared()) selected.priority = currentPriority();
  settingsChanged();
  void recomputeBounds();
});

// Moving the slider waits 200 ms for it to settle before encoding, as the desktop app does.
slider.addEventListener('input', () => {
  if (selected && !shared()) selected.quality = currentQuality();
  settingsChanged();
  if (debounce !== undefined) window.clearTimeout(debounce);
  debounce = window.setTimeout(() => void refreshPreview(), 200);
});

sharedBox.addEventListener('change', () => {
  if (!shared()) {
    // Everyone starts from what is on screen, then can be tuned apart.
    const limit = tuneSize.peek() ?? DEFAULT_LIMIT;
    for (const item of items) {
      item.priority = currentPriority();
      item.quality = currentQuality();
      item.limit = limit;
    }
    sharedNote.textContent = 'Each file keeps its own size, priority and quality. Page through the files to set them one by one.';
  } else {
    sharedNote.textContent = 'Size, priority and quality apply to all files. Untick to set them for each file on its own.';
    // The file on screen becomes the model for the rest.
    invalidate(items.filter((i) => i !== selected));
  }
  updateToolbar(); // the Run button and its hint depend on this switch
});

tuneSize.onChange(() => {
  if (running) return; // takes effect on the next run
  // Per-file settings: this file's own size. Shared settings: everyone's, so the others go stale.
  if (selected && !shared()) selected.limit = tuneSize.peek() ?? selected.limit;
  settingsChanged();
  void recomputeBounds();
});

/** Prev / Next step through the animations only; from a flagged single image they land on the nearest one. */
function page(delta: number) {
  if (running || !selected) return;
  const ok = usable();
  const at = selected.notAnimated ? -1 : ok.indexOf(selected);
  const next = at >= 0 ? ok[at + delta] : delta > 0 ? ok[0] : ok[ok.length - 1];
  if (next) void select(next);
}
prevButton.addEventListener('click', () => page(-1));
nextButton.addEventListener('click', () => page(1));

reloadButton.addEventListener('click', () => {
  const item = selected;
  if (!item || running) return;
  const number = (el: HTMLInputElement) => (el.value.trim() === '' ? undefined : Number(el.value));
  const fps = number(fpsInput);
  const start = number(startInput);
  const end = number(endInput);
  if ([fps, start, end].some((n) => n !== undefined && !Number.isFinite(n))) {
    info.textContent = 'Frames per second, start and end must be numbers.';
    return;
  }
  item.options = { fps, start, end };
  clearResult(item);
  void select(item);
});

// ---- Adding files: drop, pick, paste ----------------------------------------------------

fileInput.addEventListener('change', () => {
  addToTuner([...(fileInput.files ?? [])]);
  fileInput.value = '';
});
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
for (const type of ['dragenter', 'dragover']) {
  dropZone.addEventListener(type, (e) => {
    e.preventDefault();
    dropZone.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) dropZone.addEventListener(type, () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation(); // the page-level handler would add these to the Reduce tab as well
  addToTuner([...(e.dataTransfer?.files ?? [])]);
});

saveLink.addEventListener('click', (e) => {
  if (saveLink.getAttribute('aria-disabled') === 'true') e.preventDefault();
});

updateToolbar();
