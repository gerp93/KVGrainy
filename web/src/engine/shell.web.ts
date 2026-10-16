/** What the host app adds around the shared UI. The browser needs nothing: links download, drops work. */
export interface Shell {
  /** True when the host fits GIFs, animated WebP and APNG natively (desktop). Otherwise the page decodes frames and searches in TypeScript. */
  nativeAnimation?: boolean;
  /** Called with files the host opens (a second launch, "Open with"). Desktop only. */
  onOpenFiles?(callback: (files: File[]) => void): void;
}

export const shell: Shell = {};
