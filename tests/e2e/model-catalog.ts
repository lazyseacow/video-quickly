import { createServer } from 'node:http';

export async function modelCatalog(ids: readonly string[]) {
  const server = createServer({ keepAliveTimeout: 0 }, (request, response) => {
    if (request.method !== 'GET' || !new URL(request.url ?? '/', 'http://localhost').pathname.endsWith('/models')) {
      response.writeHead(404); response.end(); return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: ids.map(id => ({ id })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('模型目录服务未启动');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
