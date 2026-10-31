import { expect, it } from 'vitest';
import { assertDarwinNodeSelfContained, assertDarwinBinarySelfContained } from '../scripts/node-portability.mjs';

it('accepts a self-contained Darwin Node that only links system libraries', () => {
  expect(() => assertDarwinNodeSelfContained('/tmp/node:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)\n\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 2600.0.0)')).not.toThrow();
});
it('rejects developer-specific and unresolved relative dylibs rather than silently copying them into a release', () => {
  for (const library of ['@rpath/libnode.137.dylib', '/opt/homebrew/opt/libuv/lib/libuv.1.dylib', '/Users/developer/custom/libnode.dylib']) {
    expect(() => assertDarwinNodeSelfContained(`/tmp/node:\n\t${library} (compatibility version 1.0.0, current version 1.0.0)`)).toThrow('开发机动态库');
  }
  expect(() => assertDarwinNodeSelfContained('unexpected tool output')).toThrow('无法核对');
});

it('distinguishes a native module install-name identity from linked dependencies', () => {
  const own = '@rpath/koffi.node';
  const system = '/usr/lib/libSystem.B.dylib';
  const output = `module.node:\n\t${own} (compatibility version 0.0.0, current version 0.0.0)\n\t${system} (compatibility version 1.0.0, current version 1.0.0)`;
  expect(() => assertDarwinBinarySelfContained(output, 'module', own)).not.toThrow();
  expect(() => assertDarwinBinarySelfContained(output + '\n\t/opt/homebrew/lib/libexternal.dylib (compatibility version 1.0.0, current version 1.0.0)', 'module', own)).toThrow('开发机动态库');
});
