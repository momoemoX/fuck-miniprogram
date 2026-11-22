import { createAacExtractor } from './aac';

export const AAC_MEDIA_TYPE = 'audio/mp4;codecs=mp4a.40.2';

// Chrome 原生 AAC 编码器在低采样率、系统虚拟音频设备等环境下初始化会间歇失败，
// 且退化的音频栈可能让 AudioContext.resume() 或编码器无限期无输出：
// start 事件照常发出，随后立即 error→stop，或长时间无任何事件。
// 因此每次尝试都重建完整音频图，并以首个非空分片确认编码器真正产出；
// 确认前（含 resume 超时）视为初始化失败，按退避重试，确认后才对外触发 onStart。
const AAC_START_ATTEMPTS = 8;
const AAC_START_BACKOFF_MS = [0, 100, 300, 700, 1500, 2000, 2000];
// 单次尝试总预算：resume、start 与首个分片正常在数百毫秒内完成。
const AAC_START_ATTEMPT_MS = 1500;

export class AacRecorder {
  readonly mimeType = 'audio/aac';
  duration = 0;
  onstart: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onresume: (() => void) | null = null;
  onstop: (() => void) | null = null;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: ((event: { error: Error }) => void) | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private streaming = false;
  private extractor: ReturnType<typeof createAacExtractor> | null = null;
  private frames = 0;
  private streamRate = 0;
  private queue: Promise<void> = Promise.resolve();
  private starting = false;
  private started = false;
  private cancelled = false;
  private failed = false;
  private lastInitError: unknown = null;

  constructor(private readonly stream: MediaStream, private readonly options: { sampleRate: number; numberOfChannels: number; encodeBitRate: number }) {
    if (options.numberOfChannels !== 1 && options.numberOfChannels !== 2) throw new Error('numberOfChannels must be 1 or 2');
  }

  get state(): RecordingState {
    if (this.recorder && this.recorder.state !== 'inactive') return this.recorder.state;
    return this.starting ? 'recording' : 'inactive';
  }

  async start(timeslice?: number) {
    this.starting = true;
    this.streaming = timeslice !== undefined;
    try {
      for (let attempt = 0; !this.cancelled; attempt++) {
        if (await this.startAttempt(timeslice)) return;
        if (attempt + 1 >= AAC_START_ATTEMPTS) throw this.lastInitError ?? new Error('AAC encoder initialization failed');
        await new Promise(resolve => setTimeout(resolve, AAC_START_BACKOFF_MS[attempt + 1] ?? 500));
      }
    } catch (error) {
      this.failed = true;
      await this.close();
      if (!this.cancelled) throw error;
    } finally {
      this.starting = false;
    }
  }

  pause() { if (this.recorder?.state === 'recording') this.recorder.pause(); }
  resume() { if (this.recorder?.state === 'paused') this.recorder.resume(); }

  stop() {
    this.cancelled = true; this.starting = false;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    else void this.close();
  }

  private startAttempt(timeslice?: number): Promise<boolean> {
    return new Promise(resolve => {
      this.extractor = createAacExtractor();
      const Context = globalThis.AudioContext ?? (globalThis as any).webkitAudioContext;
      const context = this.context = new Context({ sampleRate: this.options.sampleRate });
      const source = this.source = context.createMediaStreamSource(this.stream);
      const destination = this.destination = context.createMediaStreamDestination();
      destination.channelCount = this.options.numberOfChannels;
      destination.channelCountMode = 'explicit';
      source.connect(destination);
      const recorder = this.recorder = new MediaRecorder(destination.stream, { mimeType: AAC_MEDIA_TYPE, audioBitsPerSecond: this.options.encodeBitRate });
      this.chunks = [];
      let settled = false;
      let deadline: ReturnType<typeof setTimeout> | null = null;
      // 失败尝试的音频图立即释放，避免残留或卡死的 AudioContext 影响下一次尝试。
      const discard = () => {
        source.disconnect();
        destination.stream.getTracks().forEach(track => track.stop());
        if (context.state !== 'closed') void context.close().catch(() => undefined);
      };
      const settle = (outcome: boolean) => { if (!settled) { settled = true; if (deadline) clearTimeout(deadline); resolve(outcome); if (!outcome) discard(); } };
      recorder.onpause = () => { if (!this.cancelled) this.onpause?.(); };
      recorder.onresume = () => { if (!this.cancelled) this.onresume?.(); };
      recorder.ondataavailable = event => {
        if (!event.data.size || this.recorder !== recorder) return;
        if (!this.streaming) {
          this.chunks.push(event.data);
        } else {
          // frameSize 模式：每个分片 MP4 片段可独立提取 ADTS，按序流式下发；
          // 无法独立解析的片段留到停止时合并提取。
          const data = event.data;
          this.queue = this.queue.then(() => this.consumeFragment(data)).catch(error => {
            this.failed = true;
            this.onerror?.({ error });
          });
        }
        if (!this.started && !settled) {
          this.started = true;
          if (!this.cancelled) this.onstart?.();
          settle(true);
        }
      };
      recorder.onstop = () => {
        if (this.recorder !== recorder) return;
        if (!this.started) settle(false);
        void this.finish();
      };
      recorder.onerror = (event: any) => {
        if (this.recorder !== recorder) return;
        if (!this.started) {
          this.lastInitError = event.error ?? new Error('AAC recording failed');
          settle(false);
          return;
        }
        this.failed = true;
        this.onerror?.({ error: event.error ?? new Error('AAC recording failed') });
        this.stream.getTracks().forEach(track => track.stop());
        void this.close();
      };
      deadline = setTimeout(() => {
        if (settled) return;
        if (!this.lastInitError) this.lastInitError = new Error('AAC encoder produced no output');
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* 已失败的重试无需处理 */ }
        settle(false);
      }, AAC_START_ATTEMPT_MS);
      context.resume().then(() => {
        // 尝试已判定失败（如看门狗超时）后迟到的 resume 不再重启录制器。
        if (settled || this.cancelled) { if (!settled) settle(false); return; }
        if (this.recorder === recorder && recorder.state === 'inactive') recorder.start(timeslice ?? 100);
      }).catch(error => {
        this.lastInitError = error;
        settle(false);
      });
    });
  }

  private async consumeFragment(data: Blob) {
    const bytes = new Uint8Array(await data.arrayBuffer());
    try {
      const result = this.extractor!.extract(bytes);
      if (!result.frames) return;
      this.frames += result.frames;
      this.streamRate = result.sampleRate;
      this.duration = Math.round(this.frames * 1024 / this.streamRate * 1000);
      this.ondataavailable?.({ data: new Blob([result.data], { type: this.mimeType }) });
    } catch {
      this.chunks.push(data);
    }
  }

  private async finish() {
    if (!this.started || this.failed) return;
    try {
      if (this.streaming) {
        // 等待最后一个分片提取完成，保证回调顺序与字节顺序一致。
        await this.queue;
        if (this.chunks.length) {
          const tail = this.extractor!.extract(new Uint8Array(await new Blob(this.chunks).arrayBuffer()));
          this.frames += tail.frames;
          if (tail.frames) this.ondataavailable?.({ data: new Blob([tail.data], { type: this.mimeType }) });
        }
        this.duration = Math.round(this.frames * 1024 / (this.streamRate || this.options.sampleRate) * 1000);
      } else {
        const result = this.extractor!.extract(new Uint8Array(await new Blob(this.chunks).arrayBuffer()));
        if (!result.frames) throw new Error('AAC recording contains no audio frames');
        this.duration = Math.round(result.frames * 1024 / result.sampleRate * 1000);
        this.ondataavailable?.({ data: new Blob([result.data], { type: this.mimeType }) });
      }
      this.chunks = [];
      await this.close();
      this.onstop?.();
    } catch (error: any) {
      this.failed = true;
      this.stream.getTracks().forEach(track => track.stop());
      this.onerror?.({ error });
      await this.close();
    }
  }

  private async close() {
    this.source?.disconnect(); this.source = null;
    this.destination?.stream.getTracks().forEach(track => track.stop()); this.destination = null;
    const context = this.context; this.context = null;
    // 退化的音频栈可能让 close 悬挂，限时放弃以避免阻塞 onStop 派发。
    if (context && context.state !== 'closed') {
      await Promise.race([context.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 1000))]);
    }
  }
}
