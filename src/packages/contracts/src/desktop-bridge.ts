export interface PathDialogOptions {
  mode: 'file' | 'directory' | 'save';
  title: string;
  defaultPath?: string;
  extensions?: string[];
}

export interface DesktopBridge {
  readonly platform: string;
  rpc(method: string, params: unknown): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
  assetUrl(path: string): Promise<string>;
  pickPath(options: PathDialogOptions): Promise<string | null>;
  revealFile(path: string): Promise<void>;
  waitForNativeFullscreenEntry?(): Promise<void>;
}
