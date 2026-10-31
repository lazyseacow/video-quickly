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

export function desktopBridge() { return typeof window === 'undefined' ? undefined : window.videoQuickly; }
export function isNativeDesktop() { return Boolean(desktopBridge()); }

type InterfacePlatform = 'win32' | 'darwin' | 'linux';
export function interfacePlatform(nativePlatform = desktopBridge()?.platform, browserPlatform = typeof navigator === 'undefined' ? '' : navigator.platform): InterfacePlatform {
  if (nativePlatform === 'win32' || nativePlatform === 'darwin' || nativePlatform === 'linux') return nativePlatform;
  return /^Mac/i.test(browserPlatform) ? 'darwin' : /^Win/i.test(browserPlatform) ? 'win32' : 'linux';
}

export function primaryModifier(platform = interfacePlatform()) {
  return platform === 'darwin' ? { key: 'Meta', label: '⌘' } as const : { key: 'Control', label: 'Ctrl' } as const;
}
export function shortcutLabel(key: string, shift = false, platform = interfacePlatform()) {
  return `${primaryModifier(platform).label}${shift ? ' Shift' : ''} ${key}`;
}

type PathExample = 'image' | 'video' | 'export' | 'backup' | 'skill' | 'tool';
export function pathExample(kind: PathExample, platform = interfacePlatform()) {
  if (platform === 'win32') return {
    image: 'D:\\materials\\scene.png', video: 'D:\\materials\\scene.mp4', export: 'D:\\Videos\\我的视频.mp4',
    backup: 'D:\\Backups\\我的视频项目', skill: 'D:\\skills\\history-handdrawn-video', tool: 'D:\\tools\\my-tool.exe',
  }[kind];
  const home = platform === 'darwin' ? '/Users/you' : '/home/you';
  return {
    image: `${home}/Pictures/scene.png`, video: `${home}/Movies/scene.mp4`, export: `${home}/Movies/我的视频.mp4`,
    backup: `${home}/Documents/我的视频项目`, skill: `${home}/Documents/skills/history-handdrawn-video`, tool: `${home}/tools/my-tool`,
  }[kind];
}
