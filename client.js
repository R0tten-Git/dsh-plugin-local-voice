/**
 * Browser half of the voice-shortcut bundle.
 *
 * The shipped voice-input plugin registers no shortcut and exposes no service, so
 * this command drives the microphone control it already renders: the collapsed
 * trigger button, or the Stop button of the expanded capture row.
 *
 * Two delivery paths share one toggle:
 *  1. `voice.dictate`, a normal editable shortcut (⌘D on Desktop, ⌘⇧D on Web).
 *  2. A DOM `keydown` fallback mirroring the command's *effective* binding, which
 *     fires only when the event still reaches the page — on macOS/Windows Desktop
 *     the native bridge consumes accepted bindings before the renderer sees them,
 *     so this path stays silent whenever path 1 worked.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-local-voice',
  factory(require) {
    /** Dictionary namespace for this command. */
    const NS = 'voice-shortcut';
    /**
     * On-screen trace of every trigger, including which element was clicked and
     * whether the capture row appeared. Off by default; flip to true to debug a
     * machine where the shortcut does not visibly react.
     */
    const DIAGNOSTIC = false;
    const zh = {
      label: '语音输入',
      busy: '语音识别进行中，请稍候',
      unavailable: '语音输入当前不可用',
      modal: '弹窗打开时不可用',
    };
    const en = {
      label: 'Voice input',
      busy: 'Speech recognition is busy',
      unavailable: 'Voice input is unavailable',
      modal: 'Unavailable while a dialog is open',
    };
    /**
     * Every `aria-label` the shipped voice plugin puts on its microphone trigger,
     * in both shipped languages: ready (`start`) and not-ready (`setupPrompt.trigger`).
     */
    const TRIGGER_LABELS = [
      '开始录音', 'Start recording',
      '打开语音输入引导', 'Open voice input setup',
    ];
    /** Physical modifier names mapped to their DOM event flags. */
    const MODIFIER_FLAGS = [
      ['control', 'ctrlKey'],
      ['alt', 'altKey'],
      ['shift', 'shiftKey'],
      ['meta', 'metaKey'],
    ];
    /** Foreground dialog/menu selector, copied from the host's shared modal layer. */
    const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], [role="menu"]';

    let traceBox = null;
    let traceTimer = 0;
    /** Show or update the short-lived trace while DIAGNOSTIC is on. */
    function report(text) {
      if (!DIAGNOSTIC) return;
      try {
        if (traceBox === null || !traceBox.isConnected) {
          traceBox = document.createElement('div');
          traceBox.style.cssText = [
            'position:fixed', 'z-index:2147483647', 'left:50%', 'top:14px',
            'transform:translateX(-50%)', 'max-width:80vw', 'padding:6px 10px',
            'border-radius:6px', 'background:#111', 'color:#fff',
            'font:12px/1.5 system-ui,-apple-system,sans-serif', 'pointer-events:none',
          ].join(';');
          document.body.appendChild(traceBox);
        }
        traceBox.textContent = `voice-shortcut: ${text}`;
        clearTimeout(traceTimer);
        traceTimer = setTimeout(() => {
          traceBox?.remove();
          traceBox = null;
        }, 6000);
      } catch (_error) {}
    }

    /** The expanded capture row; it exists only while the voice control is active. */
    function captureRow() {
      return document.querySelector('[data-voice-activity]');
    }

    /** Describe a capture row for the trace: its phase and visible status text. */
    function describeRow(row) {
      const phase = row.getAttribute('data-voice-activity');
      const text = (row.textContent ?? '').trim().replace(/\s+/gu, ' ').slice(0, 70);
      return text === '' ? `phase=${phase}` : `phase=${phase} "${text}"`;
    }

    /**
     * The microphone trigger. The plugin's own localized `aria-label` is the precise
     * key; the CSS-module class token ending in `_trigger` is only the fallback, since
     * other components also name their popover trigger node that way.
     * @returns the element to click and how it was identified, or undefined.
     */
    function findTrigger() {
      const labelled = Array.from(document.querySelectorAll('button[aria-label]'))
        .find((button) => TRIGGER_LABELS.includes(button.getAttribute('aria-label') ?? ''));
      if (labelled !== undefined) {
        return { element: labelled, how: `aria-label "${labelled.getAttribute('aria-label')}"` };
      }
      const classed = Array.from(document.querySelectorAll('button'))
        .find((button) => Array.from(button.classList).some((name) => name.endsWith('_trigger')));
      if (classed !== undefined) return { element: classed, how: `class "${String(classed.className)}"` };
      return undefined;
    }

    /**
     * Toggle the voice control and trace the outcome.
     * @param path - which delivery path invoked the toggle.
     */
    function toggle(path) {
      const row = captureRow();
      if (row !== null) {
        const phase = row.getAttribute('data-voice-activity');
        if (phase !== 'recording') {
          report(`${path} -> capture row is ${describeRow(row)}`);
          return;
        }
        const buttons = row.querySelectorAll('button');
        const stop = buttons[buttons.length - 1];
        if (stop === undefined || stop.disabled) {
          report(`${path} -> stop control unavailable`);
          return;
        }
        stop.click();
        report(`${path} -> stop clicked, transcribing`);
        return;
      }
      const found = findTrigger();
      if (found === undefined) {
        report(`${path} -> no microphone trigger in the DOM`);
        return;
      }
      if (found.element.disabled) {
        report(`${path} -> ${found.how} is disabled`);
        return;
      }
      found.element.click();
      report(`${path} -> clicked ${found.how}`);
      setTimeout(() => {
        const after = captureRow();
        report(after === null
          ? `${path} -> clicked ${found.how}, no capture row appeared`
          : `${path} -> capture row appeared (${describeRow(after)})`);
      }, 600);
    }

    /** Whether a DOM event carries exactly the effective binding's physical keys. */
    function matchesBinding(event, binding) {
      if (binding === null || binding === undefined || binding.secondCode !== undefined) return false;
      if (event.code !== binding.code) return false;
      const pressed = MODIFIER_FLAGS.filter(([, flag]) => event[flag]).map(([name]) => name);
      return pressed.length === binding.modifiers.length &&
        binding.modifiers.every((modifier) => pressed.includes(modifier));
    }

    // ======================================================================= //
    // 独立实时转写面板
    //
    // 与内置语音输入无关：自己的按钮、自己的录音、自己切句，逐段调用
    // `ctx.remote.speech.transcribe`（识别器是 Host 侧注册的 qwen3-asr-local），
    // 字幕实时往上滚，结束时可以复制全文或存成 md。
    // ======================================================================= //
    const LIVE = {
      sampleRate: 16000,
      /**
       * 连续静音多久判定一句说完。
       * 0.7s 太激进：真人说话中途想一下就会超过 0.7 秒，句子被切成两半。
       * 0.95s 是实测下来"基本不断句、延迟还能接受"的值（出字约 1.5s）。
       */
      silenceMs: 950,
      /** 一段里至少要有多少毫秒人声 */
      minSpeechMs: 400,
      /** 单段上限，防止一个人滔滔不绝把内存吃光 */
      maxChunkMs: 9000,
      /** 校准环境噪声的时长 */
      calibrateMs: 1200,
    };

    /**
     * 明显"话没说完"的句尾：正常中文里这些词几乎不会出现在句号前面。
     * 命中就把下一段接上——用来兜住"切句切早了"的残留。
     */
    const FRAGMENT_TAIL = /(以及|或者|还是|就是|不会|不能|不是|而且|并且|但是|因为|所以|如果|虽然|由|把|被|对|给|和|跟|与)$/u;

    /** 下一段开头的口水词，拼接时去掉。 */
    const LEADING_FILLER = /^[呃嗯啊唉额哦噢呀哈]+[，,、。.\s]*/u;

    /**
     * 判断两段是不是同一句话被切断的，是则返回拼好的文本，否则 undefined。
     * 只在前一段停在不结句的词上时才动手，宁可不合也不乱合。
     */
    function mergeFragment(previous, next) {
      const tail = previous.replace(/[。．.！!？?，,；;：:\s]+$/u, '');
      if (!FRAGMENT_TAIL.test(tail)) return undefined;
      const head = next.replace(LEADING_FILLER, '').trim();
      if (head === '') return undefined;
      return `${tail}${head}`;
    }

    /** 计算一帧的 RMS（float32，-1..1）。 */
    function frameRms(samples) {
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
      return Math.sqrt(sum / Math.max(1, samples.length));
    }

    /** 线性插值重采样到 16kHz（AudioContext 不是 16k 时的兜底）。 */
    function resampleTo16k(input, inRate) {
      if (inRate === LIVE.sampleRate) return input;
      const ratio = inRate / LIVE.sampleRate;
      const outLength = Math.floor(input.length / ratio);
      const out = new Float32Array(outLength);
      for (let i = 0; i < outLength; i += 1) {
        const position = i * ratio;
        const index = Math.floor(position);
        const frac = position - index;
        const a = input[index] ?? 0;
        const b = input[index + 1] ?? a;
        out[i] = a * (1 - frac) + b * frac;
      }
      return out;
    }

    /** float32 PCM → 16bit 单声道 WAV。服务端校验的就是这个格式。 */
    function encodeWav(samples, sampleRate) {
      const buffer = new ArrayBuffer(44 + samples.length * 2);
      const view = new DataView(buffer);
      const put = (offset, text) => {
        for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
      };
      put(0, 'RIFF');
      view.setUint32(4, 36 + samples.length * 2, true);
      put(8, 'WAVE');
      put(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      put(36, 'data');
      view.setUint32(40, samples.length * 2, true);
      let offset = 44;
      for (let i = 0; i < samples.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        offset += 2;
      }
      return new Uint8Array(buffer);
    }

    /** 分块 base64，避免 String.fromCharCode 参数过多爆栈。 */
    function toBase64(bytes) {
      let binary = '';
      const step = 8192;
      for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
      }
      return btoa(binary);
    }

    /** 拼接 Float32Array 列表。 */
    function concatFrames(frames) {
      let total = 0;
      for (const frame of frames) total += frame.length;
      const out = new Float32Array(total);
      let offset = 0;
      for (const frame of frames) {
        out.set(frame, offset);
        offset += frame.length;
      }
      return out;
    }

    function clockText(date) {
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function elapsedText(ms) {
      const total = Math.floor(ms / 1000);
      return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }

    function fileStamp() {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    }

    /**
     * 造一个面板组件。需要闭包里的 client ctx 才能拿到 `ctx.remote.speech`。
     * @param ctx - Client runtime.
     * @param report - 诊断输出函数。
     */
    function makeLivePanel(ctx, report) {
      const React = require('react');
      const h = React.createElement;
      const { useCallback, useEffect, useRef, useState } = React;

      /** 开始一段录音：麦克风 → 16k → 能量切句 → 回调。 */
      async function openSession({ onChunk, onThreshold, onLevel, onError }) {
        if (navigator.mediaDevices?.getUserMedia === undefined) {
          throw new Error('当前环境不支持麦克风采集');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        const AudioCtor = window.AudioContext ?? window.webkitAudioContext;
        const audio = new AudioCtor({ sampleRate: LIVE.sampleRate });
        const source = audio.createMediaStreamSource(stream);
        const processor = audio.createScriptProcessor(4096, 1, 1);
        source.connect(processor);
        processor.connect(audio.destination);

        const state = {
          threshold: null,
          calibrating: [],
          calibrateMs: 0,
          speaking: false,
          frames: [],
          voicedMs: 0,
          silenceMs: 0,
          chunkMs: 0,
        };

        const flush = () => {
          const frames = state.frames;
          const voiced = state.voicedMs;
          const perFrame = frames.length > 0 ? (frames[0].length / LIVE.sampleRate) * 1000 : 0;
          let keep = frames.length;
          if (perFrame > 0) {
            const drop = Math.max(0, Math.floor((state.silenceMs - 200) / perFrame));
            keep = Math.max(1, frames.length - drop);
          }
          const samples = concatFrames(frames.slice(0, keep));
          state.frames = [];
          state.voicedMs = 0;
          state.silenceMs = 0;
          state.chunkMs = 0;
          state.speaking = false;
          if (voiced >= LIVE.minSpeechMs && samples.length > 0) onChunk(samples);
        };

        processor.onaudioprocess = (event) => {
          try {
            // getChannelData 返回的是会被下一个回调复用的缓冲区，必须拷贝，
            // 否则存进 frames 的数组会在后续回调里被覆盖成噪声。
            const raw = event.inputBuffer.getChannelData(0).slice();
            const block = resampleTo16k(raw, audio.sampleRate);
            const ms = (block.length / LIVE.sampleRate) * 1000;
            const level = frameRms(block);
            onLevel?.(level);

            if (state.threshold === null) {
              state.calibrating.push(level);
              state.calibrateMs += ms;
              if (state.calibrateMs >= LIVE.calibrateMs) {
                // 取 20 分位（安静的那些帧）当噪声底，再乘 3.5；上限收到 0.03。
                // 用中位数会被偶发噪声抬高，之前就顶到了 0.05 把小声说话全漏了。
                const sorted = state.calibrating.slice().sort((a, b) => a - b);
                const floor = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
                state.threshold = Math.min(0.03, Math.max(0.008, floor * 3.5));
                onThreshold?.(state.threshold);
              }
              return;
            }

            const voiced = level >= state.threshold;
            if (!state.speaking) {
              if (!voiced) return;
              state.speaking = true;
              state.frames = [block];
              state.voicedMs = ms;
              state.silenceMs = 0;
              state.chunkMs = ms;
              return;
            }

            state.frames.push(block);
            state.chunkMs += ms;
            if (voiced) {
              state.voicedMs += ms;
              state.silenceMs = 0;
            } else {
              state.silenceMs += ms;
            }

            if (state.silenceMs >= LIVE.silenceMs && state.voicedMs >= LIVE.minSpeechMs) flush();
            else if (state.chunkMs >= LIVE.maxChunkMs) flush();
          } catch (error) {
            onError(error instanceof Error ? error : new Error(String(error)));
          }
        };

        return {
          audio,
          stop() {
            try {
              processor.onaudioprocess = null;
              processor.disconnect();
              source.disconnect();
            } catch {
              /* ignore */
            }
            for (const track of stream.getTracks()) track.stop();
            void audio.close().catch(() => {});
            if (state.speaking) flush();
          },
        };
      }

      /** 把一次识别结果写进 markdown。 */
      function buildMarkdown(lines) {
        const header = [
          `# 实时转写 ${new Date().toLocaleString('zh-CN')}`,
          '',
          '- 模型：Qwen3-ASR-1.7B-8bit（MLX，本地推理，离线）',
          '- 来源：DSH 实时转写面板',
          '',
        ];
        const body = lines.map((line) => `[${line.ts}] ${line.text}`);
        return `${[...header, ...body].join('\n')}\n`;
      }

      return function LiveSttPanel() {
        const [open, setOpen] = useState(false);
        const [phase, setPhase] = useState('idle');
        const [confirmEnd, setConfirmEnd] = useState(false);
        const [lines, setLines] = useState([]);
        const [pending, setPending] = useState(0);
        const [elapsed, setElapsed] = useState(0);
        const [message, setMessage] = useState('');
        const [threshold, setThreshold] = useState(0);
        const [level, setLevel] = useState(0);
        const [peak, setPeak] = useState(0);
        const [stats, setStats] = useState({ chunks: 0, empty: 0, lastMs: 0, bytes: 0, lastChars: -1 });
        const sessionRef = useRef(undefined);
        const startedRef = useRef(0);
        const accumRef = useRef(0);
        const queueRef = useRef(Promise.resolve());
        const linesRef = useRef([]);
        const lastChunkRef = useRef(undefined);
        const scrollerRef = useRef(undefined);
        const confirmTimer = useRef(undefined);

        const append = useCallback((line) => {
          const previous = linesRef.current[linesRef.current.length - 1];
          if (previous !== undefined) {
            const merged = mergeFragment(previous.text, line.text);
            if (merged !== undefined) {
              // 同一句被切开：接回上一行，保留上一行的时间戳
              const updated = [...linesRef.current.slice(0, -1), { ...previous, text: merged }];
              linesRef.current = updated;
              setLines(updated);
              return;
            }
          }
          linesRef.current = [...linesRef.current, line];
          setLines(linesRef.current);
        }, []);

        /** 逐段送识别；串行排队，避免并发把 worker 挤爆。 */
        const transcribe = useCallback(
          (samples) => {
            lastChunkRef.current = samples;
            setPending((n) => n + 1);
            setStats((s) => ({ ...s, chunks: s.chunks + 1 }));
            queueRef.current = queueRef.current
              .then(async () => {
                let speech;
                try {
                  speech = ctx.remote?.speech;
                } catch (error) {
                  throw new Error(`识别服务注入失败：${error?.message ?? error}`);
                }
                if (speech === undefined || typeof speech.transcribe !== 'function') {
                  throw new Error('识别服务未就绪：ctx.remote.speech 不可用（语音输入 Bundle 是否启用？）');
                }
                const wav = encodeWav(samples, LIVE.sampleRate);
                // Remote 的返回值是 { ok, value } 信封，文字在 value.text
                const envelope = await speech.transcribe({
                  audioBase64: toBase64(wav),
                  language: 'auto',
                });
                const unwrapped =
                  envelope !== null && typeof envelope === 'object' && 'ok' in envelope
                    ? envelope
                    : { ok: true, value: envelope };
                if (unwrapped.ok !== true) {
                  throw new Error(unwrapped.error?.message ?? '识别被拒绝');
                }
                const value = unwrapped.value ?? {};
                const text = (value.text ?? '').trim();
                setStats((s) => ({
                  ...s,
                  bytes: wav.length,
                  lastMs: Math.round((value.inferenceSeconds ?? 0) * 1000),
                  lastChars: text.length,
                  empty: text === '' ? s.empty + 1 : s.empty,
                }));
                if (text === '') return;
                append({ id: `${Date.now()}-${Math.random()}`, ts: clockText(new Date()), text });
              })
              .catch((error) => {
                setMessage(`识别失败：${error?.message ?? error}`);
                report(`transcribe failed: ${error?.message ?? error}`);
              })
              .finally(() => setPending((n) => Math.max(0, n - 1)));
          },
          [append],
        );

        /** 开始（或继续）录音；reset=true 时清掉上一轮内容。 */
        const begin = useCallback(
          async (reset) => {
            setOpen(true);
            setMessage('');
            setConfirmEnd(false);
            if (reset === true) {
              linesRef.current = [];
              setLines([]);
              setStats({ chunks: 0, empty: 0, lastMs: 0, bytes: 0, lastChars: -1 });
              setThreshold(0);
              setLevel(0);
              setPeak(0);
              accumRef.current = 0;
              setElapsed(0);
            }
            try {
              const session = await openSession({
                onChunk: (samples) => transcribe(samples),
                onThreshold: (value) => setThreshold(value),
                onLevel: (value) => {
                  setLevel(value);
                  setPeak((previous) => (value > previous ? value : previous));
                },
                onError: (error) => setMessage(`采集出错：${error.message}`),
              });
              sessionRef.current = session;
              startedRef.current = Date.now();
              setPhase('recording');
            } catch (error) {
              setPhase(linesRef.current.length > 0 ? 'paused' : 'idle');
              setMessage(`打不开麦克风：${error?.message ?? error}`);
            }
          },
          [transcribe],
        );

        /** 暂停：停止采集但保留已转内容，下次继续往后追加。 */
        const pause = useCallback(() => {
          if (sessionRef.current !== undefined) {
            sessionRef.current.stop();
            sessionRef.current = undefined;
            accumRef.current += Date.now() - startedRef.current;
            setElapsed(accumRef.current);
          }
          setPhase(linesRef.current.length > 0 ? 'paused' : 'idle');
        }, []);

        /** 播放/暂停是同一个按钮。 */
        const toggle = useCallback(() => {
          if (phase === 'recording') pause();
          else void begin(linesRef.current.length === 0);
        }, [phase, pause, begin]);

        /** 彻底结束本次转写：有内容时要求二次确认，避免误删。 */
        const endAll = useCallback(() => {
          if (linesRef.current.length > 0 && confirmEnd !== true) {
            setConfirmEnd(true);
            clearTimeout(confirmTimer.current);
            confirmTimer.current = setTimeout(() => setConfirmEnd(false), 3000);
            return;
          }
          clearTimeout(confirmTimer.current);
          sessionRef.current?.stop();
          sessionRef.current = undefined;
          linesRef.current = [];
          setLines([]);
          setStats({ chunks: 0, empty: 0, lastMs: 0, bytes: 0, lastChars: -1 });
          setThreshold(0);
          setLevel(0);
          setPeak(0);
          setElapsed(0);
          accumRef.current = 0;
          setPhase('idle');
          setMessage('');
          setConfirmEnd(false);
          setOpen(false);
        }, [confirmEnd]);

        useEffect(() => {
          if (phase !== 'recording') return undefined;
          const timer = setInterval(
            () => setElapsed(accumRef.current + (Date.now() - startedRef.current)),
            500,
          );
          return () => clearInterval(timer);
        }, [phase]);

        useEffect(() => () => sessionRef.current?.stop(), []);

        useEffect(() => {
          const node = scrollerRef.current;
          if (node !== undefined && node !== null) node.scrollTop = node.scrollHeight;
        }, [lines.length, open]);

        const copyAll = useCallback(async () => {
          const text = linesRef.current.map((line) => line.text).join('\n');
          try {
            await navigator.clipboard.writeText(text);
            setMessage(`已复制 ${text.length} 字`);
          } catch (error) {
            setMessage(`复制失败：${error?.message ?? error}`);
          }
        }, []);

        const saveMarkdown = useCallback(async () => {
          const markdown = buildMarkdown(linesRef.current);
          const name = `live-stt-${fileStamp()}.md`;
          try {
            if (typeof window.showSaveFilePicker === 'function') {
              const handle = await window.showSaveFilePicker({
                suggestedName: name,
                types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
              });
              const writable = await handle.createWritable();
              await writable.write(markdown);
              await writable.close();
              setMessage(`已保存 ${handle.name}`);
            } else {
              const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = name;
              anchor.click();
              setTimeout(() => URL.revokeObjectURL(url), 4000);
              setMessage(`已下载 ${name}`);
            }
          } catch (error) {
            if (error?.name === 'AbortError') return;
            setMessage(`保存失败：${error?.message ?? error}`);
          }
        }, []);

        const characters = lines.reduce((sum, line) => sum + line.text.length, 0);

        const stylesheet = `
.dsh-live-stt__btn {
  display: inline-flex; align-items: center; gap: 4px;
  border: 1px solid transparent; background: transparent; color: inherit;
  opacity: .8; border-radius: 6px; padding: 2px 8px;
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
  transition: opacity .12s ease, background .12s ease, border-color .12s ease;
}
.dsh-live-stt__btn:hover {
  opacity: 1;
  background: color-mix(in srgb, currentColor 8%, transparent);
  border-color: color-mix(in srgb, currentColor 16%, transparent);
}
.dsh-live-stt__btn:active { background: color-mix(in srgb, currentColor 14%, transparent); }
.dsh-live-stt__btn:focus-visible {
  outline: 2px solid color-mix(in srgb, currentColor 45%, transparent);
  outline-offset: 1px;
}
.dsh-live-stt__danger {
  opacity: 1;
  border-color: color-mix(in srgb, #e5484d 50%, transparent);
  background: color-mix(in srgb, #e5484d 14%, transparent);
}
.dsh-live-stt__danger:hover {
  background: color-mix(in srgb, #e5484d 22%, transparent);
}
.dsh-live-stt__icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0; border-radius: 50%;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  background: transparent; color: inherit; cursor: pointer;
  transition: background .12s ease, border-color .12s ease, transform .12s ease;
}
.dsh-live-stt__icon:hover {
  background: color-mix(in srgb, currentColor 9%, transparent);
  border-color: color-mix(in srgb, currentColor 34%, transparent);
}
.dsh-live-stt__icon:active { transform: scale(.94); }
.dsh-live-stt__icon--live {
  border-color: color-mix(in srgb, #e5484d 55%, transparent);
  background: color-mix(in srgb, #e5484d 12%, transparent);
}
.dsh-live-stt__icon svg { width: 14px; height: 14px; fill: currentColor; display: block; }
.dsh-live-stt__fab {
  position: fixed; right: 20px; bottom: 108px; z-index: 60;
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 14px; border-radius: 999px;
  font: inherit; font-size: 13px; line-height: 18px; cursor: pointer;
  color: inherit; pointer-events: auto;
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  background: color-mix(in srgb, Canvas 92%, currentColor);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .16), 0 1px 4px rgba(0, 0, 0, .08);
  backdrop-filter: blur(8px);
  transition: transform .12s ease, box-shadow .12s ease;
}
.dsh-live-stt__fab:hover { transform: translateY(-1px); box-shadow: 0 10px 28px rgba(0, 0, 0, .2); }
.dsh-live-stt__fab--live {
  padding: 4px 9px; font-size: 11.5px; gap: 4px;
  opacity: .7; border-color: color-mix(in srgb, currentColor 12%, transparent);
  box-shadow: 0 2px 10px rgba(0, 0, 0, .1);
}
.dsh-live-stt__fab--live:hover { opacity: 1; }
.dsh-live-stt__win {
  position: fixed; right: 20px; bottom: 108px; z-index: 60;
  width: 380px; max-height: min(560px, 72vh);
  display: flex; flex-direction: column;
  border-radius: 14px; overflow: hidden;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  background: Canvas; color: CanvasText;
  box-shadow: 0 18px 48px rgba(0, 0, 0, .2), 0 2px 8px rgba(0, 0, 0, .08);
  color-scheme: light dark;
  pointer-events: auto;
}
.dsh-live-stt__head {
  display: flex; align-items: center; gap: 6px; flex-wrap: nowrap;
  padding: 8px 10px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
}
.dsh-live-stt__title {
  font-size: 12px; font-weight: 600; letter-spacing: .02em;
  white-space: nowrap; flex: 0 0 auto;
}
.dsh-live-stt__status {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  flex: 0 1 auto;
}
.dsh-live-stt__headActions { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
.dsh-live-stt__body {
  flex: 1 1 auto; overflow-y: auto; padding: 8px 10px;
  font-size: 12.5px; line-height: 1.8; min-height: 90px;
}
.dsh-live-stt__body::-webkit-scrollbar { width: 9px; }
.dsh-live-stt__body::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, currentColor 22%, transparent);
  border-radius: 5px; border: 2px solid transparent; background-clip: padding-box;
}
.dsh-live-stt__body::-webkit-scrollbar-track { background: transparent; }
.dsh-live-stt__foot {
  padding: 4px 8px 4px 10px; font-size: 11px;
  border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  display: flex; align-items: center; gap: 6px; flex-wrap: nowrap;
}
.dsh-live-stt__footLine {
  flex: 1 1 auto; min-width: 0; opacity: .55;
  font-variant-numeric: tabular-nums;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-live-stt__footActions { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; opacity: .9; }
.dsh-live-stt__footActions .dsh-live-stt__btn { font-size: 11px; padding: 1px 6px; }
.dsh-live-stt__placeholder { opacity: .45; font-size: 12px; padding: 6px 0; }
.dsh-live-stt__dot { color: #e5484d; font-size: 10px; }
@keyframes dsh-live-stt-blink { 50% { opacity: .25; } }
.dsh-live-stt__dot--live { animation: dsh-live-stt-blink 1.1s ease-in-out infinite; }
.dsh-live-stt__time { font-variant-numeric: tabular-nums; opacity: .85; }
`;

        const button = (label, onClick, title, extraClass) =>
          h(
            'button',
            {
              type: 'button',
              key: label,
              onClick,
              title: title ?? label,
              'aria-label': title ?? label,
              className: `dsh-live-stt__btn${extraClass === undefined ? '' : ` ${extraClass}`}`,
            },
            label,
          );

        const iconButton = (icon, onClick, title) =>
          h(
            'button',
            {
              type: 'button',
              className: `dsh-live-stt__icon${phase === 'recording' ? ' dsh-live-stt__icon--live' : ''}`,
              onClick,
              title,
              'aria-label': title,
            },
            icon === 'pause'
              ? h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
                  h('rect', { x: 6, y: 5, width: 4, height: 14, rx: 1 }),
                  h('rect', { x: 14, y: 5, width: 4, height: 14, rx: 1 }))
              : h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
                  h('path', { d: 'M8 5.5v13a1 1 0 0 0 1.53.85l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5z' })),
          );

        // 收起时：右下角胶囊按钮
        if (!open) {
          const label =
            phase === 'recording'
              ? h('span', { key: 'l' },
                  h('span', { className: 'dsh-live-stt__dot dsh-live-stt__dot--live' }, '●'),
                  ` ${elapsedText(accumRef.current + (Date.now() - startedRef.current))}`)
              : phase === 'paused'
                ? h('span', { key: 'l' }, `▶ 继续（${characters} 字）`)
                : h('span', { key: 'l' }, '🎙 实时转写');
          return h(
            'div',
            { key: 'fab' },
            h('style', { key: 'css' }, stylesheet),
            h(
              'button',
              {
                type: 'button',
                className: `dsh-live-stt__fab${
                  phase === 'recording' ? ' dsh-live-stt__fab--live' : ''
                }`,
                onClick: () => {
                  // 空闲 → 新开一场；暂停中 → 直接继续；录音中 → 只是展开窗口
                  if (phase === 'idle') void begin(true);
                  else if (phase === 'paused') void begin(false);
                  else setOpen(true);
                },
                title: phase === 'idle' ? '开始实时转写（本地 Qwen3）' : '展开实时转写窗口',
              },
              label,
            ),
          );
        }

        const head = [
          iconButton(
            phase === 'recording' ? 'pause' : 'play',
            toggle,
            phase === 'recording' ? '暂停（保留已转内容）' : '开始 / 继续转写',
          ),
          h('span', { key: 'title', className: 'dsh-live-stt__title' }, '实时转写'),
          phase === 'recording'
            ? h('span', { key: 'rec', className: 'dsh-live-stt__status' },
                h('span', { className: 'dsh-live-stt__dot dsh-live-stt__dot--live' }, '●'),
                h('span', { className: 'dsh-live-stt__time' }, ` ${elapsedText(elapsed)}`))
            : phase === 'paused'
              ? h('span', { key: 'paused', className: 'dsh-live-stt__status dsh-live-stt__time' },
                  `已暂停 · ${elapsedText(elapsed)}`)
              : undefined,
          h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
          h('span', { key: 'actions', className: 'dsh-live-stt__headActions' },
            button('—', () => setOpen(false), '最小化（继续录音，不占视野）'),
            button(
              confirmEnd ? '确认结束?' : '×',
              endAll,
              confirmEnd ? '再点一次：清空并关闭本次转写' : '结束本次转写（内容清空）',
              confirmEnd ? 'dsh-live-stt__danger' : '',
            )),
        ].filter((item) => item !== undefined);

        const body =
          lines.length === 0
            ? h('div', { className: 'dsh-live-stt__placeholder' },
                phase === 'recording'
                  ? '正在听…（说完一句停 0.7 秒就会出一行）'
                  : '点上面的播放键开始')
            : h(
                'div',
                { ref: scrollerRef, className: 'dsh-live-stt__body' },
                lines.map((line) =>
                  h(
                    'div',
                    { key: line.id },
                    h('span', { style: { opacity: 0.45, marginRight: 6 } }, line.ts),
                    line.text,
                  ),
                ),
              );

        const foot = [
          `${characters} 字`,
          `电平 ${level.toFixed(4)}`,
          `峰值 ${peak.toFixed(4)}`,
          `阈值 ${threshold > 0 ? threshold.toFixed(4) : '校准中'}`,
          `已发 ${stats.chunks}`,
          stats.empty > 0 ? `空 ${stats.empty}` : undefined,
          stats.lastMs > 0 ? `${(stats.lastMs / 1000).toFixed(2)}s` : undefined,
          pending > 0 ? `识别中 ${pending}` : undefined,
        ].filter((item) => item !== undefined);

        return h(
          'div',
          { className: 'dsh-live-stt__win' },
          h('style', { key: 'css' }, stylesheet),
          h('div', { className: 'dsh-live-stt__head' }, head),
          body,
          message === ''
            ? undefined
            : h('div', { style: { padding: '0 10px 6px', fontSize: 11.5, color: '#e5484d' } }, message),
          h('div', { className: 'dsh-live-stt__foot' },
            h('span', { className: 'dsh-live-stt__footLine' }, foot.join('  ·  ')),
            h('span', { className: 'dsh-live-stt__footActions' },
              lines.length > 0 ? button('复制', copyAll, '复制全文') : undefined,
              lines.length > 0 ? button('存 md', saveMarkdown, '保存成 markdown') : undefined)),

        );
      };
    }

    return {
      inject: ['locale'],
      /**
       * Register `voice.dictate` with the window's shortcut service.
       *
       * `shortcuts` arrives from a lazily loaded plugin, so it is requested with
       * `ctx.inject()` rather than the top-level `inject` list; declaring it at the
       * top level would keep this entry pending for the boot activation audit.
       * @param ctx - Client runtime.
       */
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'voice-shortcut: copy');
        ctx.inject(['shortcuts'], (ctx) => {
          ctx.effect(() => ctx.shortcuts.register({
            id: 'voice.dictate',
            label: () => t('label'),
            aliases: ['voice', 'dictate', 'microphone', 'speech to text', '语音输入', '听写'],
            /**
             * Web bindings must be combinations the Web adapter admits: macOS and
             * Windows take Mod+Shift, and Linux Web stays unbound by default.
             */
            defaults: {
              'desktop:macos': { code: 'KeyD', modifiers: ['primary'] },
              'desktop:windows': { code: 'KeyD', modifiers: ['primary'] },
              'desktop:linux': { code: 'KeyD', modifiers: ['primary'] },
              'web:macos': { code: 'KeyD', modifiers: ['primary', 'shift'] },
              'web:windows': { code: 'KeyD', modifiers: ['primary', 'shift'] },
            },
            regions: ['page', 'editable'],
            modals: [],
            resolve: ({ modal }) => {
              if (modal !== null) {
                report(`command -> blocked: dialog open (${modal})`);
                return { status: 'blocked', reason: t('modal') };
              }
              return {
                status: 'handled',
                run: () => {
                  toggle('command');
                },
              };
            },
          }), 'voice-shortcut: dictate');
          ctx.effect(() => {
            const onKeyDown = (event) => {
              if (event.defaultPrevented || event.repeat || event.isComposing) return;
              if (document.querySelector(MODAL_SELECTOR) !== null) return;
              const target = event.target ?? document.activeElement ?? null;
              if (target !== null && typeof target.closest === 'function' && target.closest('.xterm') !== null) return;
              const row = ctx.shortcuts.catalog.getSnapshot().find((entry) => entry.id === 'voice.dictate');
              if (row === undefined || !matchesBinding(event, row.binding)) return;
              event.preventDefault();
              toggle('dom fallback');
            };
            window.addEventListener('keydown', onKeyDown);
            return () => window.removeEventListener('keydown', onKeyDown);
          }, 'voice-shortcut: dom fallback');
        });

        // 独立实时转写面板：挂在输入框下方的 dock 槽位上
        //
        // 必须走 slots.inject(槽位名, …)：这个槽位由「对话 UI」插件提供，我们加载时
        // 它未必已经存在；直接 register 会因为找不到父槽位被静默丢弃。
        // `remote.speech` 是带点的服务键（不是 remote 的属性）。两个都要声明：
        // 访问 `ctx.remote` 本身需要 'remote'，再访问 `.speech` 需要 'remote.speech'，
        // 少任何一个 Cordis 都会抛 "cannot get property … without inject"。
        if (typeof require === 'function') {
          ctx.inject(['slots', 'remote', 'remote.speech'], (sctx) => {
            sctx.effect(
              () => {
                const register = () =>
                  sctx.slots.register(
                    { name: 'shell.overlay', id: 'live-stt-panel', order: 40 },
                    makeLivePanel(sctx, report),
                  );
                if (typeof sctx.slots.inject === 'function') {
                  return sctx.slots.inject('shell.overlay', register);
                }
                return register();
              },
              'live-stt: panel',
            );
          });
        } else {
          report('require 不可用，实时转写面板未注册');
        }
      },
    };
  },
});
