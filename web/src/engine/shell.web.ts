/** What the host app adds around the shared UI. The browser needs nothing: links download, drops work. */
export interface Shell {
  /** Called with files the host opens (a second launch, "Open with"). Desktop only. */
  onOpenFiles?(callback: (files: File[]) => void): void;
}

export const shell: Shell = {};
