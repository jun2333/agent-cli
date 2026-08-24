// 项目根目录（启动时的工作目录），作为工具执行的 cwd 和路径安全基座
// 像 Claude CLI 一样：在哪个目录启动 agent-cli，工具就作用于哪个目录
export const projectRoot = process.cwd()

export const config = {
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
  chatModel: process.env.CHAT_MODEL || 'qwen3:8b',
  maxIterations: 5,
  bashTimeoutMs: 60000,
}
