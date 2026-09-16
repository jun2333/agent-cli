import { describe, it, expect, beforeEach } from 'vitest'
import {
  listChatModels,
  getCapabilities,
  primeCapabilities,
  setModelsDeps,
  resetModelsDeps,
} from './models.js'
import type { ModelsDeps } from './models.js'

/** 模拟 `ollama list` 的真实输出格式（表头 + NAME/ID/SIZE/MODIFIED 四列） */
const LIST_OUTPUT = `NAME                    ID              SIZE      MODIFIED
qwen3:8b                500a1f067a9f    5.2 GB    2 weeks ago
qwen3-vl:8b-thinking    a1b2c3d4e5f6    6.1 GB    3 days ago
bge-m3                  d4e5f6a1b2c3    1.2 GB    3 weeks ago
`

/** 模拟各模型的 /api/show capabilities（bge-m3 是 embedding 类，无 completion） */
const CAPS: Record<string, string[]> = {
  'qwen3:8b': ['completion', 'tools', 'thinking'],
  'qwen3-vl:8b-thinking': ['completion', 'vision', 'tools', 'thinking'],
  'bge-m3': ['embedding'],
}

/** 注入假依赖：绝不真跑 ollama / 真连网络 */
function useFakeDeps(overrides: Partial<ModelsDeps> = {}) {
  setModelsDeps({
    listModels: async () => LIST_OUTPUT,
    showModel: async (model: string) => {
      const caps = CAPS[model]
      if (!caps) throw new Error(`model '${model}' not found`)
      return { capabilities: caps }
    },
    ...overrides,
  })
}

beforeEach(() => {
  resetModelsDeps()
})

describe('models：清单解析与 embedding 过滤', () => {
  it('解析 ollama list 并过滤掉不含 completion 的 embedding 模型', async () => {
    useFakeDeps()
    const models = await listChatModels()
    expect(models.map((m) => m.name)).toEqual(['qwen3:8b', 'qwen3-vl:8b-thinking'])
  })

  it('解析 SIZE 列（"5.2 GB" → 字节数）', async () => {
    useFakeDeps()
    const models = await listChatModels()
    expect(models[0].sizeBytes).toBe(5583457485) // 5.2 * 1024^3
    expect(models[1].sizeBytes).toBe(6549825126) // 6.1 * 1024^3
  })

  it('表头行不会被当成模型名', async () => {
    useFakeDeps()
    const models = await listChatModels()
    expect(models.some((m) => m.name === 'NAME')).toBe(false)
  })

  it('体积与单位粘在一起（"1.2GB"）也能解析', async () => {
    useFakeDeps({ listModels: async () => 'NAME  ID  SIZE  MODIFIED\nm:1b  abc  1.2GB  1 day ago\n' })
    const models = await listChatModels()
    expect(models[0].sizeBytes).toBe(Math.round(1.2 * 1024 ** 3))
  })

  it('模型名里的 "8b" 不会被误当成体积', async () => {
    useFakeDeps({
      listModels: async () => 'NAME  ID  SIZE  MODIFIED\nllama3.1:8b  abc123  4.7 GB  1 day ago\n',
    })
    const models = await listChatModels()
    expect(models[0].name).toBe('llama3.1:8b')
    expect(models[0].sizeBytes).toBe(Math.round(4.7 * 1024 ** 3))
  })

  it('空输出返回空列表', async () => {
    useFakeDeps({ listModels: async () => '' })
    expect(await listChatModels()).toEqual([])
  })
})

describe('models：畸形 ollama list 输出', () => {
  /**
   * 用给定 stdout 跑一遍清单解析。
   * showModel 对任何名字都返回 completion —— 这样"垃圾行是否进了清单"由解析层决定，
   * 不会被"探测失败保守保留"或 embedding 过滤掩盖。
   */
  function parse(stdout: string) {
    useFakeDeps({
      listModels: async () => stdout,
      showModel: async () => ({ capabilities: ['completion'] }),
    })
    return listChatModels()
  }

  it('垃圾行（首列不是合法模型名）不会被当成模型', async () => {
    const models = await parse(`NAME  ID  SIZE  MODIFIED
Error: could not connect to ollama
Warning: 1 model skipped
qwen3:8b  abc  5.2 GB  1 day ago
`)
    expect(models.map((m) => m.name)).toEqual(['qwen3:8b'])
  })

  it('缺列的行：只有名字的丢弃，有 NAME+ID 的保留且体积为 0', async () => {
    const models = await parse(`NAME  ID  SIZE  MODIFIED
qwen3:8b
qwen3-vl:8b-thinking  a1b2c3d4e5f6
`)
    expect(models.map((m) => m.name)).toEqual(['qwen3-vl:8b-thinking'])
    expect(models[0].sizeBytes).toBe(0)
  })

  it('CRLF 换行、多余空行与行首空白都不影响解析', async () => {
    const models = await parse(
      'NAME  ID  SIZE  MODIFIED\r\n\r\nqwen3:8b  abc  5.2 GB  1 day ago\r\n   bge-m3  def  1.2 GB  3 weeks ago\r\n\r\n',
    )
    expect(models.map((m) => m.name)).toEqual(['qwen3:8b', 'bge-m3'])
    expect(models[0].sizeBytes).toBe(Math.round(5.2 * 1024 ** 3))
  })

  it('表头大小写变化会被跳过', async () => {
    const models = await parse('name  id  size  modified\nqwen3:8b  abc  5.2 GB  1 day ago\n')
    expect(models.map((m) => m.name)).toEqual(['qwen3:8b'])
  })

  it('只有表头、或表头退化为单列 NAME 时都返回空列表（表头不当模型）', async () => {
    expect(await parse('NAME  ID  SIZE  MODIFIED\n')).toEqual([])
    expect(await parse('NAME\n')).toEqual([])
  })

  it('体积列畸形时体积为 0，模型名保留且不抛异常', async () => {
    const models = await parse(`NAME  ID  SIZE  MODIFIED
qwen3:8b  abc  n/a  1 day ago
qwen3-vl:8b-thinking  def  1.2.3 GB  2 days ago
bge-m3  ghi  5.2 XB  3 days ago
`)
    expect(models.map((m) => m.name)).toEqual(['qwen3:8b', 'qwen3-vl:8b-thinking', 'bge-m3'])
    expect(models.map((m) => m.sizeBytes)).toEqual([0, 0, 0])
  })

  it('任何畸形输出都不会产出空名', async () => {
    const models = await parse(`NAME  ID  SIZE  MODIFIED
   
	 
:8b  abc  5.2 GB  1 day ago
/model  abc  1 GB  1 day ago
`)
    expect(models.every((m) => m.name !== '')).toBe(true)
    expect(models.map((m) => m.name)).toEqual([])
  })
})

describe('models：能力探测', () => {
  it('解析 capabilities 的四个布尔位', async () => {
    useFakeDeps()
    const caps = await getCapabilities('qwen3-vl:8b-thinking')
    expect(caps).toEqual({ completion: true, vision: true, tools: true, thinking: true })
  })

  it('无 vision 的模型 vision 为 false', async () => {
    useFakeDeps()
    const caps = await getCapabilities('qwen3:8b')
    expect(caps?.vision).toBe(false)
    expect(caps?.thinking).toBe(true)
  })

  it('探测失败返回 null（能力未知）', async () => {
    useFakeDeps({ showModel: async () => { throw new Error('connect ECONNREFUSED') } })
    expect(await getCapabilities('qwen3:8b')).toBeNull()
  })

  it('响应缺 capabilities 字段时返回 null', async () => {
    useFakeDeps({ showModel: async () => ({ details: {} }) })
    expect(await getCapabilities('qwen3:8b')).toBeNull()
  })

  it('探测失败的模型在清单中保守保留（不隐藏）', async () => {
    useFakeDeps({ showModel: async () => { throw new Error('timeout') } })
    const models = await listChatModels()
    expect(models.map((m) => m.name)).toEqual(['qwen3:8b', 'qwen3-vl:8b-thinking', 'bge-m3'])
    expect(models.every((m) => m.capabilities === null)).toBe(true)
  })

  it('ollama list 失败时返回空列表且不抛异常', async () => {
    useFakeDeps({ listModels: async () => { throw new Error('ollama: command not found') } })
    await expect(listChatModels()).resolves.toEqual([])
  })
})

describe('models：进程内缓存', () => {
  it('primeCapabilities 预取后 getCapabilities 不再请求', async () => {
    let calls = 0
    useFakeDeps({
      showModel: async (model: string) => {
        calls++
        return { capabilities: CAPS[model] }
      },
    })
    await primeCapabilities(['qwen3:8b'])
    expect(calls).toBe(1)
    await getCapabilities('qwen3:8b')
    await getCapabilities('qwen3:8b')
    expect(calls).toBe(1)
  })

  it('探测失败不写入缓存，后续调用会重试', async () => {
    let calls = 0
    useFakeDeps({
      showModel: async () => {
        calls++
        throw new Error('timeout')
      },
    })
    await getCapabilities('qwen3:8b')
    await getCapabilities('qwen3:8b')
    expect(calls).toBe(2)
  })

  it('resetModelsDeps 清空缓存', async () => {
    let calls = 0
    useFakeDeps({
      showModel: async (model: string) => {
        calls++
        return { capabilities: CAPS[model] }
      },
    })
    await getCapabilities('qwen3:8b')
    resetModelsDeps()
    useFakeDeps({
      showModel: async (model: string) => {
        calls++
        return { capabilities: CAPS[model] }
      },
    })
    await getCapabilities('qwen3:8b')
    expect(calls).toBe(2)
  })
})
