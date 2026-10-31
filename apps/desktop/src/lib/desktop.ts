export interface PathDialogOptions {
  mode: 'file' | 'directory' | 'save';
  title: string;
  defaultPath?: string;
  extensions?: string[];
}

interface DesktopBridge {
  readonly platform: string;
  rpc(method: string, params: unknown): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
  assetUrl(path: string): Promise<string>;
  pickPath(options: PathDialogOptions): Promise<string | null>;
  revealFile(path: string): Promise<void>;
}

declare global { interface Window { videoQuickly?: DesktopBridge; } }

export function desktopBridge() { return window.videoQuickly; }
export function isNativeDesktop() { return Boolean(desktopBridge()); }
