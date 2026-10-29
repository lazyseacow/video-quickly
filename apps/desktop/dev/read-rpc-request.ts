/** Decode streaming UTF-8 without corrupting a character split across network chunks. */
export async function readRpcRequest(chunks: AsyncIterable<Uint8Array>, maximumBytes = 16_000_000): Promise<unknown> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let body = '', size = 0;
  for await (const chunk of chunks) {
    size += chunk.byteLength;
    if (size > maximumBytes) throw new Error('请求内容超过 16 MB，请拆分资料或项目。');
    body += decoder.decode(chunk, { stream: true });
  }
  body += decoder.decode();
  return JSON.parse(body);
}
