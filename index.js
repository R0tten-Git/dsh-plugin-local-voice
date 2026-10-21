/**
 * Host half of the voice-shortcut bundle.
 *
 * Two jobs:
 *  1. (original) host-side anchor for the Client shortcut — `apply` used to be a no-op.
 *  2. (new) registers a local `qwen3-asr-local` speech-to-text provider, so the
 *     shipped voice-input microphone transcribes with this machine's Qwen3-ASR
 *     (MLX) instead of the bundled SenseVoice recognizer.
 *
 * The recognizer is a separate Python process (`qwen3_worker.py`) that loads the
 * MLX model once and answers newline-delimited JSON over stdin/stdout. It is
 * spawned lazily on the first transcription and stopped after an idle period, so
 * simply having DSH open costs no extra memory.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Loader identity for this plugin row. */
export const name = 'dsh-plugin-local-voice'
/** The speech registry must exist before this plugin can register a recognizer. */
export const inject = ['speechToText', 'llm']

/** Provider id referenced by `cordis.patch.yml` as the default recognizer. */
export const PROVIDER_ID = 'qwen3-asr-local'

/** 供离线单测使用：校对逻辑可以脱离 Host 单独跑。 */
export { verifyText }

/** Language codes offered in the picker; `auto` lets the model detect. */
const LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']

const PYTHON =
  process.env.QWEN3_ASR_PYTHON ?? join(homedir(), '.local/venvs/mlx-audio/bin/python')
const MODEL =
  process.env.QWEN3_ASR_MODEL ?? join(homedir(), 'models/Qwen3-ASR-1.7B-8bit')
const WORKER = fileURLToPath(new URL('./qwen3_worker.py', import.meta.url))
const PREPARE = fileURLToPath(new URL('./scripts/prepare_model.py', import.meta.url))

/**
 * 模型来源，只用于"缺模型时给用户的提示"——真正下载由 prepare_model.py 完成。
 * 国内默认魔搭（直链，无需装 SDK）；海外可换 hf / hf-mirror。
 */
const MODEL_SOURCE = process.env.LIVE_STT_MODEL_SOURCE ?? 'modelscope'

/** Model load happens on first use; leave plenty of room for a cold disk. */
const READY_TIMEOUT_MS = 180_000
/** One utterance; the service's own inference timeout is 120s. */
const REQUEST_TIMEOUT_MS = 120_000
/** Free the model after this much silence. */
const IDLE_MS = 300_000

/**
 * 两次调用间隔超过这个值，就当作"机器刚睡醒"处理：主动换新进程。
 * 合盖睡眠会让 Metal 上下文失效，旧进程看着还活着、实际已经不能用。
 */
const WAKE_GAP_MS = 90_000

/** 只有传输层的失败才值得重启重试；模型层面的报错重试也是白搭。 */
function isTransportFailure(error) {
  const message = String(error?.message ?? error)
  return /worker|管道|pipe|EPIPE|closed|不可用|超时|已退出/u.test(message)
}

/**
 * 逐句 LLM 校对（默认关，设 LIVE_STT_LLM_VERIFY=on 开启）。
 *
 * 当前默认关：hotwords 已经把主要同音问题压住了，而逐句校对要付延迟、调用量
 * 和"模型改写"三份代价。等真的遇到明显不准时再打开，代码一直在这儿。
 *
 * 位置在 provider 里，所以面板和内置麦克风都吃这一层；用 DSH 自己配置的模型，
 * 不额外部署。所有失败路径都回退成原文，绝不能让校对把转写搞没。
 */
const VERIFY = {
  enabled: (process.env.LIVE_STT_LLM_VERIFY ?? 'off').toLowerCase() === 'on',
  provider: process.env.LIVE_STT_LLM_PROVIDER ?? 'deepseek-account',
  model: process.env.LIVE_STT_LLM_MODEL ?? 'deepseek-flash',
  timeoutMs: Number(process.env.LIVE_STT_LLM_TIMEOUT_MS ?? 2500),
  /** 太短的片段（“好”“行”）不值得花一次调用 */
  minChars: 4,
  /** 只保留最近几句做上下文 */
  historySize: 2,
}

const VERIFY_RULES = [
  '你是中文语音识别的校对器，只做最小改动。',
  '规则：',
  '1. 只修正明显的同音错字、专有名词与领域术语，并补上合理的标点。',
  '2. 严禁改写句式、增删信息、总结内容或回答文本本身。',
  '3. 拿不准就保持原样；宁可不动，也不要猜。',
  '4. 只输出一行修正后的文本：不要引号、不要解释、不要前缀。',
  '领域术语：调优、转写、浮窗、窗口、面板、阈值、校准、识别器、字幕、纪要、上下文、推理、延迟、缓存、麦克风。',
].join('\n')

/** Lazily started, self-restarting ndjson bridge to the Python recognizer. */
export class Qwen3Worker {
  constructor(logger) {
    this.logger = logger
    this.child = undefined
    /** Set while the model is loading. */
    this.starting = undefined
    /** Set between spawn and the worker's ready line. */
    this.onReady = undefined
    this.buffer = ''
    this.pending = new Map()
    this.seq = 0
    this.idle = undefined
  }

  info(message) {
    try {
      if (typeof this.logger?.info === 'function') this.logger.info(`[qwen3] ${message}`)
    } catch {
      /* logging must never break transcription */
    }
  }

  warn(message) {
    try {
      if (typeof this.logger?.warn === 'function') this.logger.warn(`[qwen3] ${message}`)
    } catch {
      /* ignore */
    }
  }

  /** Ensure a ready worker, spawning one if necessary. */
  async ensure() {
    if (this.child !== undefined && this.onReady === undefined) return
    if (this.starting === undefined) {
      this.starting = this.start().catch((error) => {
        this.starting = undefined
        throw error
      })
    }
    await this.starting
  }

  /** Spawn the worker and wait for its ready line. */
  start() {
    return new Promise((resolve, reject) => {
      this.info(`starting ${PYTHON} ${WORKER}`)
      let child
      try {
        child = spawn(PYTHON, [WORKER, MODEL], { stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (error) {
        reject(error)
        return
      }
      this.child = child
      let settled = false
      let timer
      const settle = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.onReady = undefined
        if (error !== undefined) {
          this.starting = undefined
          this.warn(`worker failed: ${error.message}`)
          this.kill()
          reject(error)
        } else {
          this.info('worker ready')
          this.armIdle()
          resolve()
        }
      }
      timer = setTimeout(
        () => settle(new Error(`Qwen3 模型加载超时（${READY_TIMEOUT_MS / 1000}s）`)),
        READY_TIMEOUT_MS,
      )
      this.onReady = () => settle(undefined)

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => this.receive(chunk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        for (const line of String(chunk).split('\n')) {
          if (line.trim() !== '') this.info(line.trim())
        }
      })
      child.on('error', (error) => settle(error))
      child.on('exit', (code, signal) => {
        this.failAll(new Error(`Qwen3 worker 已退出（code=${code}, signal=${signal}）`))
        if (!settled) settle(new Error(`Qwen3 worker 退出（code=${code}）`))
        this.child = undefined
        this.starting = undefined
      })
    })
  }

  /** Parse ndjson lines from the worker. */
  receive(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line !== '') this.dispatch(line)
      index = this.buffer.indexOf('\n')
    }
  }

  /** Route one worker message to the ready gate or the waiting request. */
  dispatch(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.warn(`忽略无法解析的 worker 输出：${line.slice(0, 120)}`)
      return
    }
    if (message.type === 'ready') {
      this.onReady?.()
      return
    }
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (typeof message.error === 'string') {
      entry.reject(new Error(`Qwen3 识别失败：${message.error}`))
      return
    }
    // 语音服务约定的返回值是严格对象 { text, audioSeconds, inferenceSeconds }，
    // 客户端会直接读 result.text；返回裸字符串会炸在 text.replace 上。
    entry.resolve({
      text: typeof message.text === 'string' ? message.text : '',
      audioSeconds: Number.isFinite(message.audioSec) ? message.audioSec : 0,
      inferenceSeconds: Number.isFinite(message.ms) ? message.ms / 1000 : 0,
    })
  }

  /** Reject every in-flight request (worker died or was disposed). */
  failAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  /**
   * Transcribe one 16 kHz mono PCM16 WAV buffer.
   *
   * 外面包了一层"唤醒自愈"：
   *  - 上一次调用已经是很久以前（合盖睡眠后常见）→ 主动杀掉旧进程重开，
   *    因为睡眠会让 Metal 上下文失效、管道半死，留着反而报错；
   *  - 传输层失败（进程退出/管道断/超时）→ 重启一次再试，用户无感。
   */
  async transcribe(wav, language, signal) {
    signal?.throwIfAborted()
    const now = Date.now()
    if (
      this.child !== undefined &&
      this.lastUsedAt !== undefined &&
      now - this.lastUsedAt > WAKE_GAP_MS
    ) {
      this.info(`空闲 ${Math.round((now - this.lastUsedAt) / 1000)}s，视为刚唤醒，重启 worker`)
      this.kill()
    }
    try {
      const result = await this.attempt(wav, language, signal)
      this.lastUsedAt = Date.now()
      return result
    } catch (error) {
      if (signal?.aborted) throw error
      if (!isTransportFailure(error)) throw error
      this.warn(`传输层失败（${error?.message ?? error}），重启 worker 后重试一次`)
      this.kill()
      const result = await this.attempt(wav, language, signal)
      this.lastUsedAt = Date.now()
      return result
    }
  }

  /** 一次真正发送（不含重试）。 */
  async attempt(wav, language, signal) {
    signal?.throwIfAborted()
    await this.ensure()
    const child = this.child
    if (child === undefined) throw new Error('Qwen3 worker 不可用')

    const id = ++this.seq
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Qwen3 识别超时（${REQUEST_TIMEOUT_MS / 1000}s）`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
    })

    const abort = () => {
      const entry = this.pending.get(id)
      if (entry === undefined) return
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(signal?.reason ?? new Error('已取消'))
    }
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    }

    try {
      child.stdin.write(
        `${JSON.stringify({ id, wav: wav.toString('base64'), language })}\n`,
      )
      this.armIdle()
      return await result
    } finally {
      signal?.removeEventListener?.('abort', abort)
    }
  }

  /** Restart the idle countdown; stop the worker when it expires. */
  armIdle() {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      if (this.pending.size === 0 && this.child !== undefined) {
        this.info('idle 超时，回收模型进程')
        this.kill()
      }
    }, IDLE_MS)
    this.idle?.unref?.()
  }

  /** Stop the worker process. */
  kill() {
    clearTimeout(this.idle)
    const child = this.child
    this.child = undefined
    this.starting = undefined
    this.onReady = undefined
    this.buffer = ''
    this.failAll(new Error('Qwen3 worker 已停止'))
    if (child === undefined) return
    try {
      child.stdin.end()
      child.kill('SIGTERM')
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, 2000).unref?.()
    } catch {
      /* ignore */
    }
  }

  /** Permanent shutdown on plugin disposal. */
  dispose() {
    this.kill()
  }
}

/** 记住最近几句，给下一次校对当上下文。 */
function remember(worker, text) {
  if (worker.history === undefined) worker.history = []
  if (typeof text !== 'string' || text.trim() === '') return
  worker.history.push(text.trim())
  while (worker.history.length > VERIFY.historySize) worker.history.shift()
}

/** 把模型输出收拾成一行纯文本。 */
function sanitize(output) {
  let text = String(output ?? '').trim()
  if (text === '') return ''
  const firstLine = text.split('\n').find((line) => line.trim() !== '')
  text = (firstLine ?? text).trim()
  // 去掉常见的"输出前缀"和包裹引号
  text = text.replace(/^(修正后|校正后|结果|输出)\s*[：:]\s*/u, '')
  text = text.replace(/^["'“”「『]+|["'“”」』]+$/gu, '').trim()
  return text
}

/** 判断校对结果是否可以采纳；任何可疑都退回原文。 */
function acceptable(raw, corrected) {
  if (corrected === '' || corrected === raw) return corrected !== ''
  const ratio = corrected.length / Math.max(1, raw.length)
  if (ratio < 0.5 || ratio > 1.8) return false
  if (/^(抱歉|无法|对不起)/u.test(corrected)) return false
  return true
}

/**
 * 用 DSH 自己配置的模型校对一句转写。
 *
 * 设计原则：校对是"锦上添花"，任何一步出问题都返回原文——超时、报错、
 * 长度异常、模型开始解释自己做了什么，全部回退。宁可少改，不能把转写搞丢。
 *
 * @param ctx - Host context（含 llm 服务）。
 * @param worker - 提供 history 缓冲。
 * @param text - Qwen3 的原始识别文本。
 * @param signal - 调用方取消信号（当前不转发给模型，仅保留接口）。
 * @returns 校对后的文本，或原文。
 */
async function verifyText(ctx, worker, text, signal) {
  const raw = typeof text === 'string' ? text : ''
  if (!VERIFY.enabled || raw.length < VERIFY.minChars) {
    remember(worker, raw)
    return raw
  }
  const llm = ctx.get?.('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    remember(worker, raw)
    return raw
  }

  const lines = Array.isArray(worker.history) ? worker.history : []
  const payload = (lines.length === 0 ? '' : `上文：${lines.join(' / ')}\n`) + `待校正：${raw}`
  const messages = [
    { role: 'system', content: [{ type: 'text', text: VERIFY_RULES }] },
    { role: 'user', content: [{ type: 'text', text: payload }] },
  ]

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('校对超时')), VERIFY.timeoutMs)
  let output = ''
  try {
    const stream = llm.stream({
      provider: VERIFY.provider,
      model: VERIFY.model,
      messages,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text
      else if (chunk?.type === 'finish') break
      else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') break
    }
  } catch (error) {
    worker.warn(`校对跳过：${error?.message ?? error}`)
    remember(worker, raw)
    return raw
  } finally {
    clearTimeout(timer)
  }

  const corrected = sanitize(output)
  if (!acceptable(raw, corrected)) {
    worker.warn(`校对结果被拒绝：${JSON.stringify(corrected)}（原文 ${raw.length} 字）`)
    remember(worker, raw)
    return raw
  }
  remember(worker, corrected)
  return corrected
}

/**
 * Register the Qwen3 recognizer with the Host speech registry.
 * @param ctx - Host context; `speechToText` arrives through `inject`.
 */
export function apply(ctx) {
  const logger =
    typeof ctx.logger === 'function' ? ctx.logger('qwen3-asr') : ctx.logger
  const worker = new Qwen3Worker(logger)

  if (!existsSync(MODEL)) {
    worker.warn(
      `模型目录不存在：${MODEL}\n` +
        `  准备模型：python3 "${PREPARE}" --source ${MODEL_SOURCE}\n` +
        `  （国内默认魔搭；海外可加 --source hf；也可用 LIVE_STT_MODEL 指到已有目录）`,
    )
  }

  ctx.effect(() => {
    const unregister = ctx.speechToText.register({
      info: {
        id: PROVIDER_ID,
        name: 'Qwen3-ASR 1.7B (8bit, MLX, 本地)',
        location: 'host-local',
        languages: LANGUAGES,
      },
      transcribe: async (input, signal) => {
        const result = await worker.transcribe(Buffer.from(input.audio), input.language, signal)
        const corrected = await verifyText(ctx, worker, result.text, signal)
        if (corrected !== result.text) {
          worker.info(`校对：${JSON.stringify(result.text)} -> ${JSON.stringify(corrected)}`)
        }
        return { ...result, text: corrected }
      },
    })
    worker.info(`provider ${PROVIDER_ID} 已注册`)
    preferThisProvider(ctx, worker)
    return async () => {
      const removing = unregister()
      worker.dispose()
      await removing
    }
  }, 'qwen3-asr: provider')
}

/**
 * Make this recognizer the active one. `cordis.patch.yml` already declares it as
 * the default; this runtime switch only covers compositions where a higher layer
 * kept the previous provider selected, and it uses the service's own API so the
 * choice stays visible and reversible in the UI.
 */
function preferThisProvider(ctx, worker) {
  try {
    const selection = ctx.speechToText.snapshot?.()?.selection
    if (selection === undefined) return
    if (selection.providerId === PROVIDER_ID) {
      worker.info(`当前识别器已是 ${PROVIDER_ID}`)
      return
    }
    void Promise.resolve(
      ctx.speechToText.configure({ providerId: PROVIDER_ID, language: 'auto' }),
    )
      .then(() => worker.info(`已切换默认识别器：${selection.providerId} → ${PROVIDER_ID}`))
      .catch((error) => {
        worker.warn(`自动切换识别器失败（可在插件详情里手动选）：${error?.message ?? error}`)
      })
  } catch (error) {
    worker.warn(`检查识别器选择失败：${error?.message ?? error}`)
  }
}
