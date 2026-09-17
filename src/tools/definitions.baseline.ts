/**
 * AC-41 基线快照：**重构前**（B2 之前）src/tools/index.ts 的 `toolDefinitions` 真实产出。
 *
 * 来源（可复核）：
 * - 生成方式：仓库根的一次性脚本 `dump-defs.mts` 直接 import 重构前的 `toolDefinitions`
 *   并 `JSON.stringify` 落盘（即本文件的内容 = 重构前运行时序列化结果，非人工抄写）；
 * - 交叉核对：`git show HEAD:src/tools/index.ts` 的 12 段 schema 数组与 B2 开工时工作树逐字相同
 *   （B1 只改了 `ToolResult` 类型与 `classifyToolResult`，未触碰 schema）。
 * - 规范化 JSON（无缩进）的 sha256：`232d2aa7005983c4fa9b99e5df777c46257928e0a7282865f0e52100f262e2f9`
 *
 * 口径（用户拍板 D-4）：基线只覆盖**重构前的 12 个工具**；AC-41 断言
 * 「`buildDefinitions()` 前 12 项逐字深相等 + 名字序列一致 + 新增工具追加在末尾」。
 * 后续批次（B3/B6）追加 `ask_user`/`bash_output`/`kill_task` 时**不得**修改本文件。
 */
import type { OpenAI } from 'openai'

export const BASELINE_DEFINITIONS = [
  {
    "type": "function",
    "function": {
      "name": "bash",
      "description": "在项目目录下执行 shell 命令，返回 stdout、stderr 和退出码。用于编译、测试、运行、git 操作等。",
      "parameters": {
        "type": "object",
        "properties": {
          "command": {
            "type": "string",
            "description": "要执行的 shell 命令"
          }
        },
        "required": [
          "command"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "read",
      "description": "读取项目内文件的完整内容。路径相对于项目根目录。",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "相对项目根的文件路径，如 src/index.ts"
          }
        },
        "required": [
          "path"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "write",
      "description": "写入或覆盖项目内文件，自动创建父目录。用于创建新文件或整文件重写。",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "相对项目根的文件路径，如 src/hello.ts"
          },
          "content": {
            "type": "string",
            "description": "要写入的完整文件内容"
          }
        },
        "required": [
          "path",
          "content"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "edit",
      "description": "精确替换项目内文件的一段文本。用于小范围修改，比 write 整文件重写更省 token。old_string 必须在文件中唯一。",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "相对项目根的文件路径"
          },
          "old_string": {
            "type": "string",
            "description": "要被替换的原文，必须精确匹配且唯一"
          },
          "new_string": {
            "type": "string",
            "description": "替换后的内容"
          }
        },
        "required": [
          "path",
          "old_string",
          "new_string"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "list_dir",
      "description": "列出项目内目录的条目（文件/子目录）。路径相对于项目根目录，默认当前目录。",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "相对项目根的目录路径，默认 ."
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "glob",
      "description": "按 glob 模式查找项目内文件，返回匹配的文件路径列表。用于定位文件，如 **/*.ts、src/**/*.vue。",
      "parameters": {
        "type": "object",
        "properties": {
          "pattern": {
            "type": "string",
            "description": "glob 模式，相对于项目根目录"
          }
        },
        "required": [
          "pattern"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "grep",
      "description": "在项目文件中搜索文本/正则，返回匹配的文件和行。用于定位\"某函数/某关键词在哪\"。",
      "parameters": {
        "type": "object",
        "properties": {
          "pattern": {
            "type": "string",
            "description": "要搜索的正则表达式或关键词"
          },
          "path": {
            "type": "string",
            "description": "搜索起始目录（相对项目根），默认整个项目"
          }
        },
        "required": [
          "pattern"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "web_search",
      "description": "在互联网上搜索信息，返回相关结果的标题、链接和摘要。当用户问题需要实时/最新信息、或超出你的知识范围时调用。",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "搜索关键词"
          }
        },
        "required": [
          "query"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "view_image",
      "description": "读取并理解**尚未在对话中显示**的图片文件（需要当前模型支持视觉）。路径可为项目内的图片文件，或 ~/.agent-cli/images/ 下的图片（用户 Ctrl+V 粘贴的图片存放在这里）。⚠️ 若图片已随用户消息附带（你能直接看到图），请直接基于它回答，**不要**调用本工具，也不要凭空猜测路径。",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "图片路径，如 docs/shot.png 或 ~/.agent-cli/images/20260916-112233-123.png"
          }
        },
        "required": [
          "path"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "read_memory",
      "description": "读取长期记忆：无 topic 返回记忆索引（类型 + 每条一句话摘要）；有 topic 返回对应类型记忆的完整内容。",
      "parameters": {
        "type": "object",
        "properties": {
          "topic": {
            "type": "string",
            "description": "记忆类型名（如 preferences/project），可选；缺省返回索引"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "append_memory",
      "description": "向指定类型的长期记忆追加一条内容，并自动更新记忆索引。用于记录用户偏好、项目约定等。",
      "parameters": {
        "type": "object",
        "properties": {
          "topic": {
            "type": "string",
            "description": "记忆类型名（如 preferences/project）"
          },
          "content": {
            "type": "string",
            "description": "要追加的记忆内容（一句话）"
          },
          "summary": {
            "type": "string",
            "description": "可选的一句话摘要；缺省用 content 前 40 字"
          }
        },
        "required": [
          "topic",
          "content"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "write_memory",
      "description": "覆盖指定类型的长期记忆内容，并自动重建记忆索引。用于修正/重写某类记忆。",
      "parameters": {
        "type": "object",
        "properties": {
          "topic": {
            "type": "string",
            "description": "记忆类型名（如 preferences/project）"
          },
          "content": {
            "type": "string",
            "description": "覆盖后的完整内容（可多行，每行一条记忆）"
          }
        },
        "required": [
          "topic",
          "content"
        ]
      }
    }
  }
] as const satisfies readonly OpenAI.Chat.Completions.ChatCompletionTool[]

/** 基线里的工具名序列（与 definitions 顺序一致），供 AC-41 的顺序断言使用 */
export const BASELINE_TOOL_NAMES = BASELINE_DEFINITIONS.map((d) => d.function.name)

/** 基线规范化 JSON 的 sha256（生成时打印；测试用它做字节级比对） */
export const BASELINE_SHA256 = '232d2aa7005983c4fa9b99e5df777c46257928e0a7282865f0e52100f262e2f9'
