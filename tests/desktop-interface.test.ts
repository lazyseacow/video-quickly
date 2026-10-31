import { describe, expect, it } from 'vitest';
import { interfacePlatform, pathExample, primaryModifier, shortcutLabel } from '../apps/desktop/src/lib/desktop';

describe('desktop interface platform roles', () => {
  it('prefers the actual native host and falls back to the browser only for preview', () => {
    expect(interfacePlatform('darwin', 'Win32')).toBe('darwin');
    expect(interfacePlatform('win32', 'MacIntel')).toBe('win32');
    expect(interfacePlatform(undefined, 'MacIntel')).toBe('darwin');
    expect(interfacePlatform(undefined, 'Win32')).toBe('win32');
    expect(interfacePlatform(undefined, 'Linux x86_64')).toBe('linux');
  });

  it('uses Windows Control and Mac Command consistently for hints and canvas modifiers', () => {
    expect(primaryModifier('win32')).toEqual({ key: 'Control', label: 'Ctrl' });
    expect(primaryModifier('darwin')).toEqual({ key: 'Meta', label: '⌘' });
    expect(shortcutLabel('S', false, 'win32')).toBe('Ctrl S');
    expect(shortcutLabel('Z', true, 'darwin')).toBe('⌘ Shift Z');
  });

  it('keeps path examples on the selected platform without rewriting user values', () => {
    expect(pathExample('image', 'win32')).toBe('D:\\materials\\scene.png');
    expect(pathExample('export', 'darwin')).toBe('/Users/you/Movies/我的视频.mp4');
    expect(pathExample('tool', 'win32')).toBe('D:\\tools\\my-tool.exe');
    expect(pathExample('tool', 'darwin')).toBe('/Users/you/tools/my-tool');
    expect(pathExample('backup', 'darwin')).not.toContain('D:');
    expect(pathExample('skill', 'darwin')).not.toContain('\\');
  });
});
