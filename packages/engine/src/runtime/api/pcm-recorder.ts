/*! MP3 encoder: @breezystack/lamejs 1.2.7, Alex Zhukov and LAME contributors, LGPL-3.0. See THIRD_PARTY_NOTICES.md. */
import { Mp3Encoder } from '@breezystack/lamejs';

export function encodePcm16(input: readonly Float32Array[], channels: number): Uint8Array<ArrayBuffer> {
  const length = input[0]?.length ?? 0;
  const bytes = new Uint8Array(length * channels * 2), view = new DataView(bytes.buffer);
  for (let frame = 0; frame < length; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const value = (input[channel] ?? input[0])[frame];
      const sample = Number.isNaN(value) ? 0 : Math.max(-1, Math.min(1, value));
      view.setInt16((frame * channels + channel) * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
    }
  }
  return bytes;
}

export function wavHeader(length: number, sampleRate: number, channels: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44), view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string) => Array.from(value).forEach((letter, index) => { bytes[offset + index] = letter.charCodeAt(0); });
  tag(0, 'RIFF'); view.setUint32(4, length + 36, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, length, true);
  return bytes;
}

const workletSource = `class FmpPcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (channels && channels.length && channels[0].length) {
      const copy = channels.map(channel => channel.slice());
      this.port.postMessage(copy, copy.map(channel => channel.buffer));
    }
    return true;
  }
}
registerProcessor('fmp-pcm-capture', FmpPcmCapture);`;

export class PcmRecorder {
  state: RecordingState = 'inactive';
  onstart: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onresume: (() => void) | null = null;
  onstop: (() => void) | null = null;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: ((event: { error: Error }) => void) | null = null;
  readonly mimeType: string;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: AudioWorkletNode | ScriptProcessorNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buffers: Uint8Array<ArrayBuffer>[] = [];
  private pendingBytes = 0;
  private frames = 0;
  private mp3: Mp3Encoder | null = null;

  constructor(private readonly stream: MediaStream, private readonly options: { format: 'wav' | 'PCM' | 'mp3'; sampleRate: number; numberOfChannels: number; encodeBitRate?: number }) {
    if (options.numberOfChannels !== 1 && options.numberOfChannels !== 2) throw new Error('numberOfChannels must be 1 or 2');
    this.mimeType = options.format === 'wav' ? 'audio/wav' : options.format === 'mp3' ? 'audio/mpeg' : 'audio/pcm';
    if (options.format === 'mp3') this.mp3 = new Mp3Encoder(options.numberOfChannels, options.sampleRate, Math.round((options.encodeBitRate ?? 48000) / 1000));
  }

  get duration() { return Math.round(this.frames / this.options.sampleRate * 1000); }

  async start(timeslice?: number) {
    if (this.state !== 'inactive') throw new Error('recording already started');
    this.state = 'recording';
    try {
      const Context = globalThis.AudioContext ?? (globalThis as any).webkitAudioContext;
      const context: AudioContext = this.context = new Context({ sampleRate: this.options.sampleRate });
      if (context.sampleRate !== this.options.sampleRate) throw new Error('requested recording sample rate is not supported');
      if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        const url = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
        try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        if (this.isInactive()) return;
        const processor = new AudioWorkletNode(context, 'fmp-pcm-capture', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [this.options.numberOfChannels],
          channelCount: this.options.numberOfChannels, channelCountMode: 'explicit'
        });
        processor.port.onmessage = event => this.capture(event.data);
        processor.onprocessorerror = () => { this.onerror?.({ error: new Error('audio capture processor failed') }); this.stop(); };
        this.processor = processor;
      } else {
        const processor = context.createScriptProcessor(1024, this.options.numberOfChannels, this.options.numberOfChannels);
        processor.onaudioprocess = event => this.capture(Array.from({ length: event.inputBuffer.numberOfChannels }, (_, index) => event.inputBuffer.getChannelData(index)));
        this.processor = processor;
      }
      this.source = context.createMediaStreamSource(this.stream);
      this.source.connect(this.processor);
      this.processor.connect(context.destination);
      await context.resume();
      if (this.isInactive()) return;
      if (timeslice && this.options.format !== 'wav') this.timer = setInterval(() => this.flush(false), timeslice);
      this.onstart?.();
    } catch (error) {
      if (this.isInactive()) return;
      this.state = 'inactive';
      await this.close();
      throw error;
    }
  }

  pause() {
    if (this.state !== 'recording') return;
    this.state = 'paused'; this.onpause?.();
    void this.context?.suspend().catch(() => undefined);
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'recording'; this.onresume?.();
    void this.context?.resume().catch(() => undefined);
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    if (this.mp3) this.append(new Uint8Array(this.mp3.flush()));
    this.flush(true);
    void this.close().then(() => this.onstop?.());
  }

  private capture(input: Float32Array[]) {
    if (this.state !== 'recording' || !input[0]?.length) return;
    let bytes = encodePcm16(input, this.options.numberOfChannels);
    this.frames += input[0].length;
    if (this.mp3) {
      const samples = new Int16Array(bytes.buffer);
      if (this.options.numberOfChannels === 1) bytes = new Uint8Array(this.mp3.encodeBuffer(samples));
      else {
        const left = new Int16Array(input[0].length), right = new Int16Array(input[0].length);
        for (let index = 0; index < left.length; index++) { left[index] = samples[index * 2]; right[index] = samples[index * 2 + 1]; }
        bytes = new Uint8Array(this.mp3.encodeBuffer(left, right));
      }
    }
    this.append(bytes);
  }

  private append(bytes: Uint8Array<ArrayBuffer>) {
    if (!bytes.length) return;
    this.buffers.push(bytes); this.pendingBytes += bytes.length;
  }

  private isInactive() { return this.state === 'inactive'; }

  private flush(final: boolean) {
    if (!final && (!this.pendingBytes || this.state !== 'recording' || this.options.format === 'wav')) return;
    const parts = this.buffers;
    const length = this.pendingBytes;
    this.buffers = []; this.pendingBytes = 0;
    if (!final) {
      // 保留一个采样帧，使结束时仍能标记最后一个非空分片。
      const last = parts.pop()!, tail = last.slice(-this.options.numberOfChannels * 2);
      parts.push(last.subarray(0, last.length - tail.length));
      this.buffers.push(tail); this.pendingBytes = tail.length;
    }
    if (final && this.options.format === 'wav') parts.unshift(wavHeader(length, this.options.sampleRate, this.options.numberOfChannels));
    if (parts.some(part => part.byteLength)) this.ondataavailable?.({ data: new Blob(parts, { type: this.mimeType }) });
  }

  private async close() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.source?.disconnect(); this.source = null;
    const processor = this.processor;
    if (processor) {
      if ('port' in processor) { processor.port.onmessage = null; processor.port.close(); }
      else processor.onaudioprocess = null;
      processor.disconnect(); this.processor = null;
    }
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') await context.close();
  }
}

