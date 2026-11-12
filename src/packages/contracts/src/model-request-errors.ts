type RequestFailure = { reason: string; guidance: string };

const httpFailures: Record<number, readonly [string, string]> = {
  400: ['模型服务拒绝了请求参数', '核对模型、接口协议与生成参数'],
  401: ['模型服务鉴权失败', '检查模型连接配置中的 API 密钥是否正确且有效'],
  402: ['模型服务要求付费', '核对供应商账户余额或套餐'],
  403: ['模型服务拒绝访问', '检查模型连接配置中的密钥权限与模型访问范围'],
  404: ['模型服务找不到请求的接口或资源', '核对服务地址、模型 ID 或任务是否有效'],
  405: ['模型服务不支持当前请求方式', '核对服务地址和接口协议'],
  406: ['模型服务无法提供所需的响应格式', '核对模型协议和输出格式'],
  407: ['网络代理要求身份验证', '检查代理的登录状态和授权'],
  408: ['模型服务等待请求超时', '检查网络和请求内容大小'],
  409: ['请求与服务端当前任务状态冲突', '核对服务端的原任务'],
  410: ['请求的接口或资源已停用', '核对供应商当前支持的接口和资源'],
  413: ['请求内容超过模型服务的大小限制', '缩短原文或减少参考素材'],
  414: ['请求地址超过模型服务的长度限制', '核对服务地址'],
  415: ['模型服务不支持请求的内容格式', '核对接口协议和参考素材格式'],
  422: ['模型服务无法处理请求内容', '核对模型、生成参数与输入格式'],
  429: ['模型服务触发了限流或额度限制', '核对请求频率和用量额度'],
  500: ['模型服务内部出错', '检查供应商服务状态'],
  502: ['模型服务网关异常', '检查中转服务或供应商服务状态'],
  503: ['模型服务暂时不可用', '检查供应商服务状态'],
  504: ['模型服务网关等待上游响应超时', '检查中转服务或供应商服务状态'],
};

function httpFailure(status: number): RequestFailure {
  const [reason, guidance] = httpFailures[status] ?? ['模型服务返回了错误', '核对供应商服务状态和接口要求'];
  return { reason: `${reason}（HTTP ${status}）`, guidance };
}

export function modelHttpErrorMessage(status: number): string {
  const { reason, guidance } = httpFailure(status);
  return `${reason}。请${guidance}。`;
}

function networkFailure(code: string): RequestFailure | undefined {
  switch (code) {
    case 'ECONNRESET':
      return { reason: `网络连接被重置（${code}）`, guidance: '检查网络或代理连接是否稳定' };
    case 'ECONNABORTED': case 'EPIPE': case 'UND_ERR_SOCKET': case 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH':
      return { reason: `网络连接意外中断（${code}）`, guidance: '检查网络或代理连接是否稳定' };
    case 'ENOTFOUND': case 'EAI_AGAIN':
      return { reason: `服务域名解析失败（${code}）`, guidance: '核对服务地址及当前 DNS 或代理连接' };
    case 'ECONNREFUSED':
      return { reason: `服务拒绝了网络连接（${code}）`, guidance: '核对服务地址和端口，确认服务已启动' };
    case 'ENETDOWN': case 'ENETUNREACH': case 'EHOSTDOWN': case 'EHOSTUNREACH':
      return { reason: `当前网络无法到达服务（${code}）`, guidance: '检查网络或代理连接' };
    case 'UND_ERR_CONNECT_TIMEOUT':
      return { reason: `连接服务超时（${code}）`, guidance: '检查服务地址、网络或代理连接' };
    case 'UND_ERR_BODY_TIMEOUT':
      return { reason: `读取服务响应超时（${code}）`, guidance: '检查网络连接和供应商服务状态' };
    case 'ETIMEDOUT': case 'UND_ERR_HEADERS_TIMEOUT':
      return { reason: `等待服务响应超时（${code}）`, guidance: '检查网络连接和供应商服务状态' };
    case 'ERR_TLS_CERT_ALTNAME_INVALID': case 'CERT_HAS_EXPIRED': case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN': case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE': case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return { reason: `无法验证服务的 TLS 证书（${code}）`, guidance: '核对服务地址、系统时间和代理证书' };
    default:
      return undefined;
  }
}

export class ModelServiceResponseError extends Error {
  constructor(issue: 'empty' | 'format', options?: ErrorOptions) {
    super(issue === 'empty' ? '模型服务返回了空响应' : '模型服务返回的响应格式无效', options);
    this.name = 'ModelServiceResponseError';
  }
}

export function parseModelServiceJson(text: string): unknown {
  if (!text.trim()) throw new ModelServiceResponseError('empty');
  try { return JSON.parse(text); }
  catch (error) { throw new ModelServiceResponseError('format', { cause: error }); }
}

/** Render only known classifications. Provider bodies and raw network messages can contain secrets. */
export function modelRequestFailure(error: unknown, depth = 0): RequestFailure | undefined {
  if (!(error instanceof Error) || depth > 3) return undefined;
  if (error instanceof ModelServiceResponseError) return { reason: error.message, guidance: '核对服务地址、接口协议及供应商返回格式' };
  const status = ('status' in error ? error.status : undefined) ?? ('statusCode' in error ? error.statusCode : undefined);
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) return httpFailure(status);
  const network = 'code' in error && typeof error.code === 'string' ? networkFailure(error.code) : undefined;
  if (network) return network;
  if (error.name === 'TimeoutError') return { reason: '等待服务响应超时', guidance: '检查网络连接和供应商服务状态' };
  const cause = modelRequestFailure(error.cause, depth + 1);
  if (cause) return cause;
  if (error instanceof AggregateError) {
    for (const nested of error.errors.slice(0, 3)) {
      const failure = modelRequestFailure(nested, depth + 1);
      if (failure) return failure;
    }
  }
  if (error instanceof TypeError && error.message === 'fetch failed') return { reason: '无法连接服务', guidance: '检查服务地址、网络或代理连接' };
  return undefined;
}
