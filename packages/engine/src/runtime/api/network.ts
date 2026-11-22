/**
 * 网络：request / downloadFile / uploadFile / WebSocket
 *
 * 传输返回 Task 对象；生命周期由应用管理，页面切换不会取消传输。
 */

import type { FsApi } from './fs';
import { addTempFile, blobFromPath } from './temp-files';
import type { WxHost } from './types';
import { deliver, failMessage, invoke, queryString } from './util';

type Listener = (...args: any[]) => void;

function emitter(alive: () => boolean) {
  const map = new Map<string, Set<Listener>>();
  return {
    on(event: string, callback: Listener) {
      let set = map.get(event);
      if (!set) {
        set = new Set();
        map.set(event, set);
      }
      set.add(callback);
    },
    off(event: string, callback?: Listener) {
      if (!callback) map.delete(event);
      else map.get(event)?.delete(callback);
    },
    emit(event: string, payload?: any) {
      if (!alive()) return;
      for (const callback of Array.from(map.get(event) ?? [])) {
        if (!alive()) break;
        deliver(callback, payload);
      }
    }
  };
}

function settle(name: string, options: any, alive: () => boolean, run: () => Promise<any>): Promise<void> {
  return run().then(
    value => {
      if (!alive()) return;
      const result = { errMsg: `${name}:ok`, ...value };
      deliver(options?.success, result);
      if (alive()) deliver(options?.complete, result);
    },
    error => {
      if (!alive()) return;
      const result = { errMsg: failMessage(name, error) };
      deliver(options?.fail, result);
      if (alive()) deliver(options?.complete, result);
    }
  );
}

export class NetworkApi {
  private socket: WebSocket | null = null;
  private socketTask: any = null;
  private disposed = false;
  private fetches = new Map<AbortController, ReturnType<typeof setTimeout>>();
  private uploads = new Map<XMLHttpRequest, AbortController>();
  private sockets = new Set<WebSocket>();
  private peers = new Set<RTCPeerConnection>();
  private pending = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly host: WxHost,
    private readonly fs: FsApi,
    private readonly timeouts: Record<string, number> = {}
  ) {}

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const [controller, timer] of this.fetches) {
      clearTimeout(timer);
      controller.abort();
    }
    this.fetches.clear();
    for (const [xhr, preparing] of this.uploads) {
      preparing.abort();
      xhr.abort();
    }
    this.uploads.clear();
    for (const socket of this.sockets) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close();
      } catch {
        // A socket still connecting may reject close; other resources must still be released.
      }
    }
    this.sockets.clear();
    for (const peer of this.peers) {
      peer.onicecandidate = null;
      peer.close();
    }
    this.peers.clear();
    this.socket = null;
    this.socketTask = null;
    for (const timer of this.pending) clearTimeout(timer);
    this.pending.clear();
  }

  private later(callback: () => void, delay = 0) {
    if (this.disposed) return;
    const timer = setTimeout(() => {
      this.pending.delete(timer);
      if (!this.disposed) callback();
    }, delay);
    this.pending.add(timer);
    return timer;
  }

  private fetchOperation(timeout: number) {
    const controller = new AbortController();
    let reason = '';
    const timer = setTimeout(() => {
      reason = 'timeout';
      controller.abort();
    }, timeout);
    this.fetches.set(controller, timer);
    if (this.disposed) controller.abort();
    return {
      abort: () => {
        reason = 'abort';
        controller.abort();
      },
      run: async <T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        try {
          if (controller.signal.aborted) throw new Error('abort');
          return await read(controller.signal);
        } catch (error) {
          if (reason) throw new Error(reason);
          throw error;
        } finally {
          clearTimeout(timer);
          this.fetches.delete(controller);
        }
      }
    };
  }

  api() {
    return {
      request: (options: any) => this.request(options),
      downloadFile: (options: any) => this.download(options),
      uploadFile: (options: any) => this.upload(options),
      connectSocket: (options: any) => this.connect(options),
      sendSocketMessage: (options: any) => {
        if (this.disposed) return;
        if (!this.socketTask) {
          const result = { errMsg: 'sendSocketMessage:fail socket is not connected' };
          deliver(options?.fail, result);
          deliver(options?.complete, result);
          return;
        }
        this.socketTask.send({ data: options.data, success: options.success, fail: options.fail, complete: options.complete });
      },
      closeSocket: (options: any) => {
        if (this.disposed) return;
        if (!this.socketTask) {
          const result = { errMsg: 'closeSocket:ok' };
          deliver(options?.success, result);
          deliver(options?.complete, result);
          return;
        }
        this.socketTask.close(options);
      },
      onSocketOpen: (callback: Listener) => this.host.on('socketOpen', callback),
      offSocketOpen: (callback?: Listener) => this.host.off('socketOpen', callback),
      onSocketMessage: (callback: Listener) => this.host.on('socketMessage', callback),
      offSocketMessage: (callback?: Listener) => this.host.off('socketMessage', callback),
      onSocketError: (callback: Listener) => this.host.on('socketError', callback),
      offSocketError: (callback?: Listener) => this.host.off('socketError', callback),
      onSocketClose: (callback: Listener) => this.host.on('socketClose', callback),
      offSocketClose: (callback?: Listener) => this.host.off('socketClose', callback),
      getLocalIPAddress: (options: any) =>
        invoke(
          'getLocalIPAddress',
          options,
          () =>
            new Promise(resolve => {
              if (this.disposed) return;
              const Peer = (window as any).RTCPeerConnection;
              if (!Peer) {
                resolve({ localip: '127.0.0.1' });
                return;
              }
              const pc = new Peer({ iceServers: [] });
              this.peers.add(pc);
              let finished = false;
              let timer: ReturnType<typeof setTimeout> | undefined;
              const finish = (value: string) => {
                if (finished || this.disposed) return;
                finished = true;
                this.peers.delete(pc);
                if (timer) {
                  clearTimeout(timer);
                  this.pending.delete(timer);
                }
                pc.onicecandidate = null;
                try {
                  pc.close();
                } catch {
                  /* 忽略 */
                }
                resolve({ localip: value });
              };
              pc.createDataChannel('');
              pc.onicecandidate = (event: any) => {
                const candidate: string = event.candidate?.candidate ?? '';
                const match = /([0-9]{1,3}(?:\.[0-9]{1,3}){3})/.exec(candidate);
                if (match) finish(match[1]);
              };
              pc.createOffer()
                .then((offer: any) => pc.setLocalDescription(offer))
                .catch(() => finish('127.0.0.1'));
              timer = this.later(() => finish('127.0.0.1'), 1500);
            })
        )
    };
  }

  private request(options: any) {
    const events = emitter(() => !this.disposed);
    const operation = this.fetchOperation(Number(options?.timeout ?? this.timeouts.request ?? 60000));

    const task: any = {
      abort: operation.abort,
      onHeadersReceived: (callback: Listener) => events.on('headers', callback),
      offHeadersReceived: (callback?: Listener) => events.off('headers', callback),
      onChunkReceived: (callback: Listener) => events.on('chunk', callback),
      offChunkReceived: (callback?: Listener) => events.off('chunk', callback)
    };

    const method = String(options?.method ?? 'GET').toUpperCase();
    let url = String(options?.url ?? '');
    if (!url) {
      void settle(
        'request',
        options,
        () => !this.disposed,
        () =>
          operation.run(async () => {
            throw new Error('parameter error: "url" is required');
          })
      );
      return task;
    }

    const header: Record<string, string> = {};
    for (const [key, value] of Object.entries<any>(options?.header ?? {})) header[key.toLowerCase()] = String(value);
    if (!header['content-type']) header['content-type'] = 'application/json';

    let body: BodyInit | undefined;
    if (method === 'GET' || method === 'HEAD') {
      const query = queryString(options?.data);
      if (query) url += (url.includes('?') ? '&' : '?') + query;
    } else if (options?.data !== undefined) {
      if (typeof options.data === 'string' || options.data instanceof ArrayBuffer) {
        body = options.data;
      } else if (header['content-type']?.includes('application/x-www-form-urlencoded')) {
        body = queryString(options.data, false);
      } else if (header['content-type']?.includes('multipart/form-data')) {
        body = queryString(options.data);
      } else {
        body = JSON.stringify(options.data);
        if (!header['content-type']) header['content-type'] = 'application/json';
      }
    }

    void settle(
      'request',
      options,
      () => !this.disposed,
      () =>
        operation.run(async signal => {
          const response = await fetch(url, {
            method,
            headers: header,
            body,
            signal,
            credentials: options?.withCredentials ? 'include' : 'same-origin'
          });

          const responseHeader: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            responseHeader[key] = value;
          });
          events.emit('headers', { header: responseHeader, statusCode: response.status, cookies: [] });

          const type = String(options?.responseType ?? 'text');
          let data: any;
          let buffer: ArrayBuffer | undefined;

          if (options?.enableChunked) {
            const reader = response.body?.getReader();
            const chunks: Uint8Array[] = [];
            if (reader) {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                  chunks.push(value);
                  events.emit('chunk', { data: value.slice().buffer });
                }
              }
            }
            const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const merged = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              merged.set(chunk, offset);
              offset += chunk.length;
            }
            buffer = merged.buffer;
            data = type === 'arraybuffer' ? buffer : new TextDecoder().decode(merged);
          } else if (type === 'arraybuffer') {
            data = await response.arrayBuffer();
          } else {
            data = await response.text();
          }

          if (type !== 'arraybuffer' && (options?.dataType ?? 'json') === 'json' && typeof data === 'string') {
            try {
              data = JSON.parse(data);
            } catch {
              /* 保持文本 */
            }
          }

          return {
            data,
            statusCode: response.status,
            header: responseHeader,
            cookies: []
          };
        })
    );

    return task;
  }

  private download(options: any) {
    const events = emitter(() => !this.disposed);
    const operation = this.fetchOperation(Number(options?.timeout ?? this.timeouts.downloadFile ?? 60000));

    const task: any = {
      abort: operation.abort,
      onProgressUpdate: (callback: Listener) => events.on('progress', callback),
      offProgressUpdate: (callback?: Listener) => events.off('progress', callback),
      onHeadersReceived: (callback: Listener) => events.on('headers', callback),
      offHeadersReceived: (callback?: Listener) => events.off('headers', callback)
    };

    const url = String(options?.url ?? '');
    void settle(
      'downloadFile',
      options,
      () => !this.disposed,
      () =>
        operation.run(async signal => {
          if (!url) throw new Error('parameter error: "url" is required');
          const response = await fetch(url, { signal, headers: options?.header });
          const header: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            header[key] = value;
          });
          events.emit('headers', { header, cookies: [] });

          const total = Number(response.headers.get('content-length') ?? 0);
          let received = 0;
          let blob: Blob;
          if (response.body && total > 0) {
            const reader = response.body.getReader();
            const chunks: BlobPart[] = [];
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value) continue;
              chunks.push(value);
              received += value.length;
              events.emit('progress', {
                progress: Math.round((received / total) * 100),
                totalBytesWritten: received,
                totalBytesExpectedToWrite: total,
                cookies: []
              });
            }
            blob = new Blob(chunks);
          } else {
            blob = await response.blob();
            events.emit('progress', { progress: 100, totalBytesWritten: blob.size, totalBytesExpectedToWrite: blob.size, cookies: [] });
          }

          if (this.disposed) throw new Error('abort');

          let filePath: string;
          if (options?.filePath) {
            filePath = await this.fs.saveBlob(options.filePath, blob);
          } else {
            filePath = addTempFile(blob, url.split('/').pop()).path;
          }
          return { tempFilePath: filePath, filePath, statusCode: response.status };
        })
    );

    return task;
  }

  private upload(options: any) {
    const xhr = new XMLHttpRequest();
    const preparing = new AbortController();
    this.uploads.set(xhr, preparing);
    let aborted = false;
    const events = emitter(() => !this.disposed);
    const task: any = {
      abort: () => {
        aborted = true;
        preparing.abort();
        xhr.abort();
      },
      onProgressUpdate: (callback: Listener) => events.on('progress', callback),
      offProgressUpdate: (callback?: Listener) => events.off('progress', callback),
      onHeadersReceived: (callback: Listener) => events.on('headers', callback),
      offHeadersReceived: (callback?: Listener) => events.off('headers', callback)
    };

    const url = String(options?.url ?? '');
    if (!url) {
      this.uploads.delete(xhr);
      this.later(() => {
        const result = { errMsg: 'uploadFile:fail parameter error: "url" is required' };
        deliver(options?.fail, result);
        deliver(options?.complete, result);
      });
      return task;
    }

    void settle(
      'uploadFile',
      options,
      () => !this.disposed,
      async () => {
        try {
          if (this.disposed) throw new Error('abort');
          const form = new FormData();
          for (const [key, value] of Object.entries<any>(options?.formData ?? {})) form.append(key, String(value));
          const name = options?.name || 'file';
          const filePath = options?.filePath;
          if (filePath) {
            const blob = await blobFromPath(filePath, preparing.signal);
            const filename = options?.fileName || filePath.split('/').pop() || 'file';
            form.append(name, blob, filename);
          }

          if (aborted || this.disposed) throw new Error('abort');

          const result = await new Promise<any>((resolve, reject) => {
            xhr.open(String(options?.method ?? 'POST').toUpperCase(), url);
            xhr.timeout = Number(options?.timeout ?? this.timeouts.uploadFile ?? 60000);
            for (const [key, value] of Object.entries<any>(options?.header ?? {})) {
              try {
                xhr.setRequestHeader(key, String(value));
              } catch {
                /* 受限头忽略 */
              }
            }
            xhr.upload.onprogress = event => {
              if (!event.lengthComputable) return;
              events.emit('progress', {
                progress: Math.round((event.loaded / event.total) * 100),
                totalBytesSent: event.loaded,
                totalBytesExpectedToSend: event.total
              });
            };
            xhr.onload = () => {
              const header: Record<string, string> = {};
              for (const line of xhr
                .getAllResponseHeaders()
                .trim()
                .split(/[\r\n]+/)) {
                if (!line) continue;
                const index = line.indexOf(':');
                header[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
              }
              events.emit('headers', { header });
              resolve({ data: xhr.responseText, statusCode: xhr.status, header });
            };
            xhr.onerror = () => reject(new Error('network error'));
            xhr.ontimeout = () => reject(new Error('timeout'));
            xhr.onabort = () => reject(new Error('abort'));
            xhr.send(form);
          });

          return result;
        } catch (error) {
          if (aborted) throw new Error('abort');
          throw error;
        } finally {
          this.uploads.delete(xhr);
        }
      }
    );

    return task;
  }

  private connect(options: any) {
    const url = String(options?.url ?? '');
    const events = emitter(() => !this.disposed);
    let socket: WebSocket | null = null;
    const queue: Array<string | ArrayBuffer> = [];
    let opened = false;
    const alive = () => !this.disposed;

    const task: any = {
      send(opts: any) {
        if (!alive()) return;
        if (!opened) {
          queue.push(opts?.data);
          return;
        }
        try {
          socket?.send(opts?.data);
          deliver(opts?.success, { errMsg: 'sendSocketMessage:ok' });
          deliver(opts?.complete, { errMsg: 'sendSocketMessage:ok' });
        } catch (error) {
          const result = { errMsg: failMessage('sendSocketMessage', error) };
          deliver(opts?.fail, result);
          deliver(opts?.complete, result);
        }
      },
      close(opts: any) {
        if (!alive()) return;
        try {
          socket?.close(opts?.code ?? 1000, opts?.reason ?? '');
        } catch {
          /* 已关闭 */
        }
        deliver(opts?.success, { errMsg: 'closeSocket:ok' });
        deliver(opts?.complete, { errMsg: 'closeSocket:ok' });
      },
      onOpen: (callback: Listener) => events.on('open', callback),
      offOpen: (callback?: Listener) => events.off('open', callback),
      onMessage: (callback: Listener) => events.on('message', callback),
      offMessage: (callback?: Listener) => events.off('message', callback),
      onClose: (callback: Listener) => events.on('close', callback),
      offClose: (callback?: Listener) => events.off('close', callback),
      onError: (callback: Listener) => events.on('error', callback),
      offError: (callback?: Listener) => events.off('error', callback)
    };

    if (this.disposed) return task;
    this.socketTask = task;

    try {
      socket = new WebSocket(url, options?.protocols);
      socket.binaryType = 'arraybuffer';
    } catch (error) {
      this.later(() => {
        const failed = { errMsg: failMessage('connectSocket', error) };
        deliver(options?.fail, failed);
        deliver(options?.complete, failed);
        events.emit('error', failed);
      });
      return task;
    }

    this.socket = socket;
    this.sockets.add(socket);

    socket.onopen = () => {
      if (this.disposed) return;
      opened = true;
      const result = { header: {}, errMsg: 'connectSocket:ok' };
      deliver(options?.success, result);
      deliver(options?.complete, result);
      events.emit('open', { header: {} });
      this.host.emit('socketOpen', { header: {} });
      for (const data of queue.splice(0)) {
        try {
          socket!.send(data);
        } catch {
          /* 忽略 */
        }
      }
    };

    socket.onmessage = event => {
      if (this.disposed) return;
      const payload = typeof event.data === 'string' ? { data: event.data, isBinary: false } : { data: event.data, isBinary: true };
      events.emit('message', payload);
      this.host.emit('socketMessage', payload);
    };

    socket.onerror = () => {
      if (this.disposed) return;
      const failed = { errMsg: 'connectSocket:fail network error' };
      deliver(options?.fail, failed);
      deliver(options?.complete, failed);
      events.emit('error', failed);
      this.host.emit('socketError', failed);
    };

    socket.onclose = event => {
      this.sockets.delete(socket!);
      if (this.disposed) return;
      opened = false;
      const result = { code: event.code, reason: event.reason, wasClean: event.wasClean };
      events.emit('close', result);
      this.host.emit('socketClose', result);
      if (this.socket === socket) {
        this.socket = null;
        this.socketTask = null;
      }
    };

    return task;
  }
}
