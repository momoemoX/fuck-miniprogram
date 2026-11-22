/**
 * 画布
 *
 * 旧版上下文记录绘图命令，在 draw 时按批次提交；Canvas 2D 节点由选择器查询返回。
 */

import type { FsApi } from './fs';
import { addTempFile, blobFromPath } from './temp-files';
import { createLegacyCanvas } from './legacy-canvas';
import { createMediaRecorderApi } from './media-recorder';
import { createVideoDecoderApi } from './video-decoder';
import type { WxHost } from './types';
import { absoluteUrl, deliver, invoke } from './util';
import { ownedElements } from '../selectors';

function findCanvas(host: WxHost, canvasId: string, component?: any): HTMLCanvasElement | null {
  if (!canvasId) return null;
  const root = component?.__el ?? host.pageElement() ?? document.body;
  const holder = ownedElements(root, `[canvas-id="${CSS.escape(canvasId)}"]`)[0] ?? ownedElements(root, `#${CSS.escape(canvasId)}`)[0];
  if (!holder) return null;
  return holder.tagName === 'CANVAS' ? (holder as HTMLCanvasElement) : holder.querySelector('canvas');
}

export class CanvasApi {
  constructor(
    private readonly host: WxHost,
    private readonly fs: FsApi
  ) {}

  private alive = true;
  private readonly queues = new WeakMap<HTMLCanvasElement, Promise<void>>();
  private readonly pendingImages = new Set<() => void>();

  private call(name: string, options: any, run: (options: any) => any) {
    const guarded = { ...options };
    for (const key of ['success', 'fail', 'complete']) {
      if (typeof options?.[key] === 'function')
        guarded[key] = (result: any) => {
          if (this.alive) options[key](result);
        };
    }
    return invoke(name, guarded, async opts => {
      if (!this.alive) throw new Error('canvas disposed');
      const result = await run(opts);
      if (!this.alive) throw new Error('canvas disposed');
      return result;
    });
  }

  dispose() {
    this.alive = false;
    for (const cancel of this.pendingImages) cancel();
    this.pendingImages.clear();
  }

  private submit(
    canvas: HTMLCanvasElement,
    actions: Array<(context: CanvasRenderingContext2D) => void | Promise<void>>,
    reserve: boolean,
    callback?: () => void
  ) {
    const previous = this.queues.get(canvas) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        if (!this.alive || !canvas.isConnected) return;
        // The 3.7.0 renderer preserves drawing state together with pixels on reserve.
        // Resizing also resets any saved state and clipping region for a fresh batch.
        if (!reserve) {
          const width = canvas.width;
          canvas.width = width;
        }
        const context = canvas.getContext('2d')!;
        for (const action of actions) {
          if (!this.alive || !canvas.isConnected) return;
          await action(context);
        }
        if (this.alive && canvas.isConnected) deliver(() => callback?.(), undefined);
      })
      .catch(error => {
        if (this.alive && canvas.isConnected)
          queueMicrotask(() => {
            throw error;
          });
      });
    this.queues.set(canvas, next);
  }

  private async image(source: string, canvas: HTMLCanvasElement): Promise<HTMLImageElement> {
    const controller = new AbortController();
    const image = new Image();
    let rejectImage: ((reason: Error) => void) | undefined;
    const cancel = () => {
      controller.abort();
      image.removeAttribute('src');
      rejectImage?.(new Error('canvas disposed'));
    };
    this.pendingImages.add(cancel);
    const observer = new MutationObserver(() => {
      if (!canvas.isConnected) cancel();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    let url: string | undefined;
    try {
      if (!this.alive || !canvas.isConnected) throw new Error('canvas disposed');
      const blob = await blobFromPath(absoluteUrl(source), controller.signal);
      if (!this.alive || !canvas.isConnected) throw new Error('canvas disposed');
      url = URL.createObjectURL(blob);
      return await new Promise<HTMLImageElement>((resolve, reject) => {
        rejectImage = reject;
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`image load failed: ${source}`));
        image.src = url!;
      });
    } finally {
      this.pendingImages.delete(cancel);
      observer.disconnect();
      image.onload = image.onerror = null;
      if (url) URL.revokeObjectURL(url);
    }
  }

  private legacyContext(canvas: () => HTMLCanvasElement | null) {
    return createLegacyCanvas(canvas, {
      submit: (target, actions, reserve, callback) => this.submit(target, actions, reserve, callback),
      image: (source, target) => this.image(source, target),
      export: options => this.toTempFile(canvas(), options)
    });
  }

  nodeContext(holder: Element) {
    if (holder.getAttribute('type')) return undefined;
    return this.legacyContext(() => (holder.tagName === 'CANVAS' ? (holder as HTMLCanvasElement) : holder.querySelector('canvas')));
  }

  api() {
    return {
      createCanvasContext: (canvasId: string, component?: any) => {
        const root = component?.__el ?? this.host.pageElement() ?? document.body;
        return this.legacyContext(() => findCanvas(this.host, canvasId, { __el: root }));
      },

      createOffscreenCanvas: (options?: any) => {
        const canvas = document.createElement('canvas');
        canvas.width = Number(options?.width ?? 300);
        canvas.height = Number(options?.height ?? 150);
        const node: any = canvas;
        node.createImage = () => {
          const image = new Image();
          image.crossOrigin = 'anonymous';
          return image;
        };
        node.requestAnimationFrame = (callback: FrameRequestCallback) => requestAnimationFrame(callback);
        node.cancelAnimationFrame = (handle: number) => cancelAnimationFrame(handle);
        node.toDataURL = HTMLCanvasElement.prototype.toDataURL.bind(canvas);
        node.transferToImageBitmap = () => createImageBitmap(canvas);
        return node;
      },

      // createVideoDecoder 基于渲染层 <video> + <canvas> 解帧；
      // createMediaRecorder 要求 canvas 具备 webgl 上下文
      ...createVideoDecoderApi(),
      ...createMediaRecorderApi(),

      canvasToTempFilePath: (options: any, component?: any) =>
        this.call('canvasToTempFilePath', options, async opts => {
          const canvas = opts?.canvas ?? findCanvas(this.host, opts?.canvasId ?? '', component ?? opts?.__component);
          return this.toTempFile(canvas, opts);
        }),

      canvasPutImageData: (options: any, component?: any) =>
        this.call('canvasPutImageData', options, () => {
          const canvas = findCanvas(this.host, options?.canvasId ?? '', component);
          const ctx = canvas?.getContext('2d');
          if (!ctx || !options?.data) throw new Error('canvas not found');
          const bytes = options.data instanceof Uint8ClampedArray ? options.data : new Uint8ClampedArray(options.data);
          const image = new ImageData(bytes, Number(options.width), Number(options.height));
          ctx.putImageData(image, options.x ?? 0, options.y ?? 0);
          return {};
        }),

      canvasGetImageData: (options: any, component?: any) =>
        this.call('canvasGetImageData', options, () => {
          const canvas = findCanvas(this.host, options?.canvasId ?? '', component);
          const ctx = canvas?.getContext('2d');
          if (!ctx) throw new Error('canvas not found');
          const data = ctx.getImageData(options.x ?? 0, options.y ?? 0, options.width ?? 0, options.height ?? 0);
          return { data: data.data, width: data.width, height: data.height };
        }),

      canvasToTempFilePathSync: (options: any) => {
        const canvas = findCanvas(this.host, options?.canvasId ?? '');
        if (!canvas) throw new Error('canvas not found');
        return { tempFilePath: canvas.toDataURL() };
      }
    };
  }

  private async toTempFile(canvas: HTMLCanvasElement | null, options: any) {
    if (!this.alive) throw new Error('canvas disposed');
    if (!canvas) throw new Error('canvas is not found');
    const x = Number(options?.x ?? 0);
    const y = Number(options?.y ?? 0);
    const sourceWidth = Number(options?.width ?? canvas.width);
    const sourceHeight = Number(options?.height ?? canvas.height);
    const width = Number(options?.destWidth ?? sourceWidth);
    const height = Number(options?.destHeight ?? sourceHeight);
    const target = document.createElement('canvas');
    target.width = width;
    target.height = height;
    target.getContext('2d')!.drawImage(canvas, x, y, sourceWidth, sourceHeight, 0, 0, width, height);
    const type = options?.fileType === 'jpg' ? 'image/jpeg' : 'image/png';
    const dataUrl = target.toDataURL(type, options?.quality ?? 1);
    const blob = await (await fetch(dataUrl)).blob();
    if (!this.alive) throw new Error('canvas disposed');
    const filePath = options?.filePath ?? options?.destPath;
    if (filePath) {
      await this.fs.saveBlob(filePath, blob);
      return { tempFilePath: filePath, errMsg: 'canvasToTempFilePath:ok' };
    }
    return { tempFilePath: addTempFile(blob).path, errMsg: 'canvasToTempFilePath:ok' };
  }
}
