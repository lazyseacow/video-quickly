import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applicationId, externalWebUrl, fileInside, pathDialogOptions, rendererIsTrusted, serveFile, validRuntimeRequest, workspaceDirectory, workspaceName } from '../apps/desktop/electron/platform.mjs';
import { createCredentialHost, credentialEntry } from '../apps/desktop/electron/credentials.mjs';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-electron-platform-')); directories.push(directory);
  const root = join(directory, 'workspace'); await mkdir(root);
  const path = join(root, '真实素材.mp4'); await writeFile(path, '0123456789');
  return { directory, root, path };
}

describe('Electron workspace and media boundary', () => {
  it('creates a separate workspace without reading or rewriting the former bundle-identifier directory', () => {
    const home = join(tmpdir(), '旧用户');
    expect(workspaceDirectory({ platform: 'darwin', home, environment: {} })).toBe(join(home, 'Library', 'Application Support', workspaceName));
    expect(workspaceDirectory({ platform: 'linux', home, environment: {} })).toBe(join(home, '.local', 'share', workspaceName));
    expect(workspaceDirectory({ environment: { VIDEO_QUICKLY_DATA_DIR: join(home, 'isolated') } })).toBe(join(home, 'isolated'));
    expect(workspaceDirectory({ platform: 'darwin', home, environment: {} })).not.toContain(applicationId);
    if (process.platform === 'win32') expect(workspaceDirectory({ platform: 'win32', home, environment: { APPDATA: home } })).toBe(join(home, workspaceName));
  });

  it('serves real media ranges, suffixes, headers and empty files without buffering the whole movie', async () => {
    const { root, path } = await fixture();
    const read = (range?: string, method = 'GET') => serveFile(root, path, new Request('video-quickly://app/__asset', { method, headers: range ? { Range: range } : {} }));
    const full = await read(); expect(full.status).toBe(200); expect(full.headers.get('content-type')).toBe('video/mp4'); expect(await full.text()).toBe('0123456789');
    const partial = await read('bytes=2-5'); expect(partial.status).toBe(206); expect(partial.headers.get('content-range')).toBe('bytes 2-5/10'); expect(partial.headers.get('content-length')).toBe('4'); expect(await partial.text()).toBe('2345');
    expect(await (await read('bytes=-3')).text()).toBe('789');
    expect(await (await read('bytes=8-')).text()).toBe('89');
    expect(await (await read('bytes=8-100')).text()).toBe('89');
    const head = await read(undefined, 'HEAD'); expect(head.headers.get('content-length')).toBe('10'); expect(await head.text()).toBe('');
    const empty = join(root, 'empty.mp4'); await writeFile(empty, '');
    const response = await serveFile(root, empty, new Request('video-quickly://app/__asset')); expect(response.headers.get('content-length')).toBe('0'); expect(await response.text()).toBe('');
  });

  it('rejects invalid ranges and non-read methods', async () => {
    const { root, path } = await fixture();
    for (const Range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=1-2,3-4', 'bytes=99999999999999999999-', 'nonsense']) {
      const result = await serveFile(root, path, new Request('video-quickly://app/__asset', { headers: { Range } }));
      expect(result.status, Range).toBe(416); expect(result.headers.get('content-range')).toBe('bytes */10');
    }
    expect((await serveFile(root, path, new Request('video-quickly://app/__asset', { method: 'POST' }))).status).toBe(405);
  });

  it('refuses missing files and lexical traversal outside the workspace', async () => {
    const { directory, root } = await fixture(); const secret = join(directory, 'outside.txt'); await writeFile(secret, 'outside');
    await expect(fileInside(root, secret)).rejects.toThrow('工作区');
    expect((await serveFile(root, secret, new Request('video-quickly://app/__asset'))).status).toBe(404);
    expect((await serveFile(root, join(root, 'missing.mp4'), new Request('video-quickly://app/__asset'))).status).toBe(404);
  });

  it.skipIf(process.platform === 'win32')('resolves symlinks before authorizing a media file', async () => {
    const { directory, root } = await fixture(); const outside = join(directory, 'outside.mp4'); await writeFile(outside, 'outside');
    const link = join(root, 'linked.mp4'); await symlink(outside, link);
    await expect(fileInside(root, link)).rejects.toThrow('工作区');
  });
});

describe('Electron IPC boundaries', () => {
  it('opens research and voice references only as ordinary external web URLs', () => {
    expect(externalWebUrl('https://example.com/research?q=1')).toBe('https://example.com/research?q=1');
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ms-settings:privacy', 'video-quickly://app/', 'https://user:secret@example.com/', 'not a url']) expect(externalWebUrl(url)).toBeUndefined();
  });
  it('requires the owned main frame and the exact application or development origin', () => {
    const mainFrame = { url: 'video-quickly://app/' }, contents = { mainFrame };
    expect(rendererIsTrusted({ sender: contents, senderFrame: mainFrame }, contents)).toBe(true);
    expect(rendererIsTrusted({ sender: {}, senderFrame: mainFrame }, contents)).toBe(false);
    expect(rendererIsTrusted({ sender: contents, senderFrame: { ...mainFrame } }, contents)).toBe(false);
    mainFrame.url = 'https://example.com'; expect(rendererIsTrusted({ sender: contents, senderFrame: mainFrame }, contents)).toBe(false);
    mainFrame.url = 'http://127.0.0.1:1420/'; expect(rendererIsTrusted({ sender: contents, senderFrame: mainFrame }, contents, 'http://127.0.0.1:1420')).toBe(true);
    expect(rendererIsTrusted({ sender: contents, senderFrame: mainFrame }, contents, 'http://127.0.0.1:1421')).toBe(false);
  });

  it('validates selectors and preserves a save basename and cancellation-capable dialog contract', () => {
    expect(pathDialogOptions({ mode: 'save', title: '导出', defaultPath: '成片.mp4', extensions: ['mp4'] })).toEqual({ mode: 'save', options: { title: '导出', defaultPath: '成片.mp4', filters: [{ name: '导出文件', extensions: ['mp4'] }] } });
    expect(() => pathDialogOptions({ mode: 'shell', title: 'wrong' })).toThrow();
    expect(() => pathDialogOptions({ mode: 'file', title: 'wrong', extensions: ['../sqlite'] })).toThrow();
    expect(() => pathDialogOptions({ mode: 'file', title: 'wrong', defaultPath: '\0bad' })).toThrow();
    expect(validRuntimeRequest({ method: 'project.get', params: { projectId: 'p' } })).toEqual({ method: 'project.get', params: { projectId: 'p' } });
    expect(() => validRuntimeRequest({ method: 'host.secret.get', params: { key: 'never' } })).toThrow();
    expect(() => validRuntimeRequest({ method: '__proto__' })).toThrow();
  });
});

describe('isolated desktop credential storage', () => {
  it('constructs read-only service/account entries and never calls the binding withTarget placeholder path', () => {
    class Entry { constructor(public service: string, public account: string, public options?: unknown) {} static withTarget() { throw new Error('must never construct a placeholder'); } }
    for (const platform of ['darwin', 'win32']) expect(credentialEntry(Entry, 'model-reference', platform)).toMatchObject({ service: 'video-quickly-electron', account: 'model-reference' });
    expect(credentialEntry(Entry, 'model-reference', 'linux')).toMatchObject({ options: { linux: { store: 'secret-service' } } });
    expect(() => credentialEntry(Entry, '')).toThrow();
  });

  it('serializes credential work, preserves missing vs unavailable and redacts native errors', async () => {
    const entries = new Map<string, string>(); let active = 0, maximum = 0;
    class Entry {
      constructor(_service: string, public key: string) {}
      async getPassword() { active++; maximum = Math.max(active, maximum); await new Promise(resolve => setTimeout(resolve, 1)); active--; if (this.key === 'locked') throw new Error('native-account-and-secret'); return entries.get(this.key) ?? null; }
      async setPassword(value: string) { entries.set(this.key, value); }
      async deleteCredential() { return entries.delete(this.key); }
    }
    const host = createCredentialHost(Entry, 'win32');
    expect(await host('host.secret.get', { key: 'test' })).toBeNull();
    await host('host.secret.set', { key: 'test', value: 'isolated-test-value' });
    expect(await Promise.all([host('host.secret.get', { key: 'test' }), host('host.secret.get', { key: 'test' })])).toEqual(['isolated-test-value', 'isolated-test-value']); expect(maximum).toBe(1);
    await expect(host('host.secret.get', { key: 'locked' })).rejects.toThrow('系统凭据操作失败');
    expect(await host('host.secret.get', { key: 'test' })).toBe('isolated-test-value');
    await host('host.secret.delete', { key: 'test' }); expect(await host('host.secret.get', { key: 'test' })).toBeNull();
    await expect(host('host.execute', { key: 'test' })).rejects.toThrow('不支持');
  });
});
