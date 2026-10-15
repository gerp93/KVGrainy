import { DERIVED_VARS, REQUIRED_TOKENS, deriveColors, parseRgb, type Tokens } from './themecolors';
import data from './visual-assault-themes.json';

/**
 * The theme switcher: Dark, Light and Neon (this site's own), plus a fourth control that drops down
 * the VisualAssault themes. Picking one adds its `<id>-theme` class to <body> (that is how the vendored
 * stylesheet applies a theme), reads the colours it defines, and sets this site's variables from them.
 * The choice is remembered, with the derived colours, so the page can paint in them before it loads.
 */

const BUILT_IN = ['dark', 'light', 'neon'];
const STORE = 'kvgrainy-theme';
const STORE_VA = 'kvgrainy-va';
const OPTIONAL_TOKENS = ['primary-action-text'];

const root = document.documentElement;
const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')];
const select = document.getElementById('theme-more') as HTMLSelectElement;
const wrap = select.parentElement!;

const builtInNames = new Set(buttons.map((b) => b.textContent!.trim().toLowerCase()));

function remember(choice: string, derived?: object) {
  try {
    localStorage.setItem(STORE, choice);
    if (derived) localStorage.setItem(STORE_VA, JSON.stringify(derived));
    else localStorage.removeItem(STORE_VA);
  } catch {
    /* storage blocked: the choice just won't persist */
  }
}

/** Remove everything a VisualAssault theme added, so a built-in theme shows exactly as before. */
function clearVisualAssault() {
  for (const name of DERIVED_VARS) root.style.removeProperty(name);
  root.style.colorScheme = '';
  for (const cls of [...document.body.classList]) if (cls.endsWith('-theme')) document.body.classList.remove(cls);
}

function showSelection(builtIn: string | null, vaId: string | null) {
  for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.themeChoice === builtIn));
  select.value = vaId ?? '';
  wrap.classList.toggle('active', vaId !== null);
}

export function applyBuiltIn(id: string, save = true) {
  clearVisualAssault();
  root.setAttribute('data-theme', id);
  showSelection(id, null);
  if (save) remember(id);
}

/**
 * The active theme's tokens as numbers. The stylesheet's text can't be trusted to be `rgb(...)`: the build
 * minifies it and rewrites colours (`rgb(0, 0, 0)` becomes `#000`). So each token is handed to the browser as a
 * `color` and read back, which always comes out normalised. A token the theme doesn't define stays absent.
 */
function readTokens(): Tokens {
  const style = getComputedStyle(document.body);
  const probe = document.createElement('span');
  probe.hidden = true;
  document.body.append(probe);
  const tokens: Tokens = {};
  for (const name of [...REQUIRED_TOKENS, ...OPTIONAL_TOKENS]) {
    if (style.getPropertyValue(`--color-${name}`).trim() === '') continue; // not defined by this theme
    probe.style.color = '';
    probe.style.color = `var(--color-${name})`;
    const parsed = parseRgb(getComputedStyle(probe).color);
    if (parsed) tokens[name] = parsed;
  }
  probe.remove();
  return tokens;
}

export function applyVisualAssault(id: string, save = true): boolean {
  if (!data.themes.some((t) => t.id === id)) return false;
  clearVisualAssault();
  document.body.classList.add(`${id}-theme`);
  const tokens = readTokens();
  let derived;
  try {
    derived = deriveColors(tokens);
  } catch (err) {
    console.error(`Could not apply the ${id} theme:`, err);
    clearVisualAssault();
    return false;
  }
  root.setAttribute('data-theme', 'va');
  for (const [name, value] of Object.entries(derived.vars)) root.style.setProperty(name, value);
  root.style.colorScheme = derived.scheme;
  showSelection(null, id);
  if (save) remember(`va:${id}`, { id, tag: data.tag, ...derived });
  return true;
}

// ---- Build the dropdown ------------------------------------------------------------------

const placeholder = document.createElement('option');
placeholder.value = '';
placeholder.textContent = 'More themes';
placeholder.disabled = true;
placeholder.hidden = true;
select.append(placeholder);
const group = document.createElement('optgroup');
group.label = 'Visual Assault';
for (const theme of data.themes) {
  const option = document.createElement('option');
  option.value = theme.id;
  // VisualAssault has its own "Neon"; don't let it pass for this site's Neon button.
  option.textContent = builtInNames.has(theme.name.toLowerCase()) ? `${theme.name} (VA)` : theme.name;
  group.append(option);
}
select.append(group);

select.addEventListener('change', () => {
  if (select.value) applyVisualAssault(select.value);
});
for (const button of buttons) button.addEventListener('click', () => applyBuiltIn(button.dataset.themeChoice ?? 'dark'));

// ---- Restore the saved choice -------------------------------------------------------------

let saved: string | null = null;
try {
  saved = localStorage.getItem(STORE);
} catch {
  /* storage blocked */
}
if (saved?.startsWith('va:')) {
  // Recompute from the stylesheet that is loaded now, in case the pinned VisualAssault tag has moved on.
  if (!applyVisualAssault(saved.slice(3), false)) applyBuiltIn('dark', false);
} else {
  applyBuiltIn(BUILT_IN.includes(saved ?? '') ? saved! : (root.getAttribute('data-theme') ?? 'dark'), false);
}
