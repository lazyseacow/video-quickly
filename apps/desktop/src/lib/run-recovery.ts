/** Frozen inputs cannot be repaired by resuming the same failed production. */
export function isConfigurationFailure(message: string | undefined): boolean {
  return Boolean(message && /请选择|请先|配置|提示词|JSON|分镜结果|结果校验失败|所选模型不可用|模型.*(?:选择|参数|凭据|协议|类型|不匹配|不兼容|已移除|不存在)|(?:缺少|缺失|无可用|未配置|不支持).*模型|(?:输入|内容|字段|标题).*不能为空/i.test(message));
}
