import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mcpServerSchema, type MCPServer } from '@video-quickly/contracts';
export { mcpServerSchema };
export type McpServer = MCPServer;

export async function connectMcp(server: McpServer, secret?: string) {
  const client = new Client({ name: 'video-quickly', version: '0.1.0' }, { capabilities: {} });
  const transport = server.transport === 'stdio'
    ? new StdioClientTransport({ command: server.command!, args: server.args, stderr: 'pipe', env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}), ...(secret && server.credentialEnvName ? { [server.credentialEnvName]: secret } : {}) } })
    : new StreamableHTTPClientTransport(new URL(server.url!), { requestInit: secret ? { headers: { Authorization: `Bearer ${secret}` } } : undefined });
  // Servers can print sensitive diagnostics. Drain without forwarding or storing
  // them so a full stderr pipe cannot stall protocol messages.
  if (transport instanceof StdioClientTransport) transport.stderr?.on('data', (chunk: unknown) => { void chunk; });
  try {
    await client.connect(transport, { timeout: 15_000 });
    const result = await client.listTools(undefined, { timeout: 15_000 });
    return { client, tools: result.tools, async close() { await client.close(); } };
  } catch (error) { await client.close(); throw error; }
}
