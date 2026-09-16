// 项目根目录（启动时的工作目录），作为工具执行的 cwd 和路径安全基座
// 像 Claude CLI 一样：在哪个目录启动 agent-cli，工具就作用于哪个目录
export const projectRoot = process.cwd()

export const config = {
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
  // 默认模型：必须是支持 vision + tools + thinking 的多模态模型（design.md D3）。
  // 本机 Metal 预算 10.7 GiB 装不下两个 8B 模型，故视觉能力与主模型同源（单模型方案）。
  // 注意：qwen3-vl 的默认 tag 是 thinking 权重，instruct 版不支持思考，两者不可混用。
  chatModel: process.env.CHAT_MODEL || 'qwen3-vl:8b-thinking',
  maxIterations: 5,
  bashTimeoutMs: 60000,
}
