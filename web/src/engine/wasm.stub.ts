// The desktop build runs the core natively through Tauri, so it ships no WebAssembly core. The stills
// worker still imports it for the web build; this stub keeps that import resolvable and fails loudly
// if anything ever reaches it.
const unavailable = (): never => {
  throw new Error('The WebAssembly core is not part of the desktop build; stills run natively.');
};
export default unavailable;
export const initPanicHook = unavailable;
export const searchFormat = unavailable;
export const bestEffort = unavailable;
export const Source = { fromRgba: unavailable };
