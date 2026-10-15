import { parseSizeLimit } from '../engine/limit';
import { PRESETS, limitText } from '../engine/presets';

/**
 * The "Max size" control: a number box with KB / MB buttons, the quick-size chips and the site
 * limits. One component, mounted once per tab, so the Reduce and Fine-Tune GIF tabs look and
 * behave identically while each keeps its own value.
 *
 * Changes are announced on commit (Enter, leaving the box, changing the unit, or picking a chip
 * or site limit), not on every keystroke, because the Fine-Tune tab re-encodes on each change.
 */

export interface SizeField {
  /** The limit in bytes. Throws a plain-language Error (and shows it under the box) if the text isn't a size. */
  getBytes(): number;
  /** The limit in bytes, or null if the box doesn't hold a valid size. Never shows an error or moves focus. */
  peek(): number | null;
  /** Set the box. `silent` skips the change callback, for programmatic updates such as paging to another file. */
  setBytes(bytes: number, options?: { silent?: boolean }): void;
  /** Be told when the limit is committed. */
  onChange(callback: () => void): void;
}

export interface SizeFieldStart {
  value: string;
  unit: 'kb' | 'mb';
}

const CHIPS = [
  ['100 KB', '100kb'],
  ['500 KB', '500kb'],
  ['1 MB', '1mb'],
  ['2 MB', '2mb'],
] as const;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

export function mountSizeField(container: HTMLElement, prefix: string, start: SizeFieldStart): SizeField {
  const inputId = `${prefix}-limit`;
  const errorId = `${prefix}-limit-error`;
  const unitName = `${prefix}-unit`;

  const input = el('input', { id: inputId, type: 'text', value: start.value, inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': errorId });
  const radios = (['kb', 'mb'] as const).map((u) => {
    const radio = el('input', { type: 'radio', name: unitName, value: u });
    radio.checked = u === start.unit;
    return { radio, label: el('label', { class: 'radio' }, radio, ` ${u.toUpperCase()}`) };
  });
  const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Common sizes' });
  for (const [label, value] of CHIPS) chips.append(el('button', { type: 'button', 'data-limit': value }, label));
  const errorBox = el('p', { id: errorId, class: 'error', role: 'alert' });
  errorBox.hidden = true;
  const presetBox = el('div', { class: 'chips', role: 'group', 'aria-label': 'Site size limits' });
  const presetNote = el('p', { class: 'detail preset-note' });
  presetNote.hidden = true;

  container.classList.add('sizebox');
  container.replaceChildren(
    el('div', { class: 'field' }, el('label', { for: inputId }, 'Max size'), el('div', { class: 'inline' }, input, ...radios.map((r) => r.label)), chips, errorBox),
    el('div', { class: 'presets', role: 'group', 'aria-label': 'Common limits' }, el('p', { class: 'presets-title' }, 'Common limits'), presetBox, presetNote),
  );

  const unit = () => radios.find((r) => r.radio.checked)?.radio.value ?? 'kb';
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((cb) => cb());

  function showError(message: string | null) {
    errorBox.hidden = message === null;
    errorBox.textContent = message ?? '';
    if (message === null) input.removeAttribute('aria-invalid');
    else input.setAttribute('aria-invalid', 'true');
  }

  function clearPreset() {
    presetBox.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    presetNote.hidden = true;
  }

  function setText(text: string, silent = false) {
    const match = /^\s*([\d.]+)\s*(kb|mb)\s*$/i.exec(text);
    if (!match) return;
    input.value = match[1]!;
    for (const r of radios) r.radio.checked = r.radio.value === match[2]!.toLowerCase();
    showError(null);
    if (!silent) notify();
  }

  function getBytes(): number {
    try {
      const text = input.value.trim();
      if (text === '') throw new Error('Enter a size, like 500 or 1.5.');
      if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) throw new Error(`"${text}" isn't a size. Enter a number, like 500 or 1.5.`);
      const bytes = parseSizeLimit(`${text}${unit()}`);
      showError(null);
      return bytes;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showError(message);
      input.focus();
      throw new Error(message);
    }
  }

  input.addEventListener('input', clearPreset);
  input.addEventListener('change', () => {
    // Someone may still type "1.5mb" out of habit: take the unit from the text instead of rejecting it.
    const match = /^\s*([\d.]+)\s*(kb|mb)\s*$/i.exec(input.value);
    if (match) {
      input.value = match[1]!;
      for (const r of radios) r.radio.checked = r.radio.value === match[2]!.toLowerCase();
    }
    try {
      getBytes();
    } catch {
      return; // the message is already showing
    }
    notify();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.dispatchEvent(new Event('change'));
  });
  for (const r of radios) {
    r.radio.addEventListener('change', () => {
      clearPreset();
      showError(null);
      notify();
    });
  }
  chips.querySelectorAll<HTMLButtonElement>('[data-limit]').forEach((chip) => {
    chip.addEventListener('click', () => {
      clearPreset();
      setText(chip.dataset.limit ?? '');
    });
  });

  for (const preset of PRESETS) {
    const button = el('button', { type: 'button', 'aria-pressed': 'false' }, preset.label);
    button.addEventListener('click', () => {
      clearPreset();
      setText(limitText(preset.bytes));
      button.setAttribute('aria-pressed', 'true');
      const checked = new Date(`${preset.verifiedOn}T00:00:00Z`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
      const link = el('a', { href: preset.source.url, target: '_blank', rel: 'noopener noreferrer' }, preset.source.title);
      // The box counts 1 MB as 1,048,576 bytes, so a round decimal limit shows as an odd number. Say why.
      const entered =
        parseSizeLimit(limitText(preset.bytes)) === preset.bytes
          ? ''
          : ` The size box shows ${limitText(preset.bytes)} because it counts 1 MB as 1,048,576 bytes; that keeps the result under the limit.`;
      presetNote.replaceChildren(`${preset.detail}${entered} Source: `, link, `, checked ${checked}. Limits change, so check the source if it matters.`);
      presetNote.hidden = false;
    });
    presetBox.append(button);
  }

  return {
    getBytes,
    peek() {
      const text = input.value.trim();
      if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) return null;
      try {
        return parseSizeLimit(`${text}${unit()}`);
      } catch {
        return null;
      }
    },
    setBytes(bytes, options = {}) {
      clearPreset();
      setText(limitText(bytes), options.silent ?? false);
    },
    onChange(callback) {
      listeners.add(callback);
    },
  };
}
