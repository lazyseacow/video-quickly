export const credentialService = 'video-quickly-electron';

export function credentialEntry(Entry, key, platform = process.platform) {
  if (typeof key !== 'string' || !key.length || key.length > 512 || key.includes('\0')) throw new Error('凭据引用无效。');
  // Do not use withTarget: its current binding writes a placeholder on creation.
  return new Entry(credentialService, key, platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined);
}

export function createCredentialHost(Entry, platform = process.platform) {
  let previous = Promise.resolve();
  return (method, params) => {
    const operation = previous.then(async () => {
      if (!['host.secret.get', 'host.secret.set', 'host.secret.delete'].includes(method)) throw new Error('不支持的系统操作。');
      if (method === 'host.secret.set' && (typeof params?.value !== 'string' || params.value.length > 1_000_000)) throw new Error('凭据内容无效。');
      try {
        const entry = credentialEntry(Entry, params?.key, platform);
        if (method === 'host.secret.get') return await entry.getPassword();
        if (method === 'host.secret.set') await entry.setPassword(params.value);
        else await entry.deleteCredential();
        return null;
      } catch {
        // The native error can contain an account or secret; keep it out of IPC/logs.
        throw new Error('系统凭据操作失败，请检查系统钥匙串是否已解锁并允许本次访问。');
      }
    });
    // Serialize native calls across worker threads; a failure must not poison
    // the next operation, while its original caller still receives the error.
    previous = operation.catch(() => undefined);
    return operation;
  };
}
