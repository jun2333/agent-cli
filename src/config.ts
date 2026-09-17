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
  /**
   * 状态栏 tick 最多重绘的行数（V-3 的用户裁决：放宽到 2）。
   * 1 = 只重绘状态栏；2 = 状态栏 + 内容区中"当前运行中的工具行"（两者都是单行原位更新，
   * 都不触发整区重绘/滚动）。切回 1 即严格满足"动画只重绘状态栏 1 行"的原始 NFR。
   */
  statusTickMaxRows: 2,
  /**
   * 工具输出双阈值截断（D19/AC-11）：**只作用于文本**，`ContentPart[]` 的 image_url 部件
   * 豁免、不计入（V-4 用户拍板）。单位：行 = 行尾切分元素数；字节 = utf8 字节数
   * （阈值/标注/计数三者同源，见 tools/truncate.ts）。
   */
  toolOutputMaxLines: 1000,
  toolOutputMaxBytes: 50 * 1024,
  /** 后台任务的内存环形缓冲上限（D18：最近 2000 行 / 256KB；日志文件不截断） */
  taskBufferMaxLines: 2000,
  taskBufferMaxBytes: 256 * 1024,
  /** kill 时 SIGTERM → 宽限 → SIGKILL 的宽限期（AC-13：顽固子进程必须被收掉） */
  taskKillGraceMs: 2000,
  /** `~/.agent-cli/tasks/` 的日志保留天数（D18） */
  taskLogRetentionDays: 7,
  /** hook 子进程超时（D33：到点 SIGKILL 按失败处理；测试经注入调小做真实超时冒烟） */
  hookTimeoutMs: 10_000,
}
