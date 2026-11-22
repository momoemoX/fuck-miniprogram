/**
 * 文件系统
 *
 * 微信的 wxfile:// 在浏览器里没有对应物：用户目录、临时目录都用内存 + IndexedDB
 * 模拟，blob URL 作为临时文件路径。同步接口走内存缓存，异步接口会等一次持久化加载。
 */

import { decompress } from 'brotli/decompress.js';
import { unzipSync } from 'fflate';
import { fileDigest } from './file-digest';
import { fileBytes, fileData, type Encoding } from './file-codecs';
import type { WxHost } from './types';
import { blobFromPath, getTempFile, removeTempFile, setPathResolver } from './temp-files';
import { invoke, uid } from './util';

const USER_ROOT = 'wxfile://usr';
const TMP_ROOT = 'wxfile://tmp';
const STORE_ROOT = 'wxfile://store';
const DB_NAME = 'fmp-engine-fs';
const STORE_NAME = 'files';

const encodedBlobs = new WeakMap<Blob, Uint8Array>();

interface Entry {
  path: string;
  blob: Blob;
  directory: boolean;
  mtime: number;
  /** 同步读写用的原始内容：文本或字节，写入时顺手留下 */
  bytes?: Uint8Array;
}

function normalize(input: string): string {
  if (!input) return USER_ROOT;
  const path = String(input).replace(/\\/g, '/');
  if (/^(blob:|data:|https?:)/.test(path)) return path;
  const writable = path.startsWith('wxfile://');
  const parts: string[] = [];
  for (const segment of (writable ? path.slice(9) : path).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return (writable ? 'wxfile://' : '/') + parts.join('/');
}

function packageUrl(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index > 8 ? path.slice(0, index) : path.slice(0, path.indexOf('://') + 3);
}

function encode(data: ArrayBuffer | string, encoding: Encoding = 'utf8'): Blob {
  const bytes = fileBytes(data, encoding);
  const blob = new Blob([bytes]);
  encodedBlobs.set(blob, bytes);
  return blob;
}

async function decode(blob: Blob, encoding?: Encoding, position?: number, length?: number): Promise<string | ArrayBuffer> {
  const bytes = encodedBlobs.get(blob) ?? new Uint8Array(await blob.arrayBuffer());
  encodedBlobs.set(blob, bytes);
  return fileData(readRange(bytes, position, length), encoding);
}

function readRange(bytes: Uint8Array, position = 0, length?: number) {
  if (!Number.isSafeInteger(position) || position < 0 || position > bytes.length) throw new Error('invalid read position');
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 1)) throw new Error('invalid read length');
  return bytes.subarray(position, length === undefined ? undefined : position + length);
}

export class FsApi {
  private entries = new Map<string, Entry>();
  private openFiles = new Map<string, { entry: Entry; position: number; read: boolean; write: boolean; append: boolean }>();
  readonly ready: Promise<void>;
  private changedDuringLoad = new Set<string>();
  private db: IDBDatabase | null = null;
  private disposed = false;

  constructor(private readonly host: WxHost) {
    this.mkdirp(USER_ROOT);
    this.mkdirp(TMP_ROOT);
    this.mkdirp(STORE_ROOT);
    setPathResolver(path => this.entries.get(normalize(path))?.blob);
    this.ready = this.load();
  }

  private openDb(): Promise<IDBDatabase | null> {
    if (this.disposed) return Promise.resolve(null);
    if (this.db) return Promise.resolve(this.db);
    return new Promise(resolve => {
      try {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => {
          this.db = request.result;
          resolve(this.db);
        };
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  dispose() {
    this.disposed = true;
    this.openFiles.clear();
    void this.ready.then(() => {
      this.db?.close();
      this.db = null;
    });
  }

  private async load() {
    const db = await this.openDb();
    if (!db) return;
    await new Promise<void>(resolve => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.openCursor();
      const decoding: Promise<void>[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          void Promise.all(decoding).then(() => resolve());
          return;
        }
        const value = cursor.value as { blob: Blob; bytes?: Uint8Array; directory: boolean; mtime: number };
        const path = String(cursor.key);
        if (!this.changedDuringLoad.has(path)) {
          const entry: Entry = { path, ...value };
          this.entries.set(path, entry);
          if (!entry.directory && !entry.bytes)
            decoding.push(
              entry.blob.arrayBuffer().then(buffer => {
                entry.bytes = new Uint8Array(buffer);
              })
            );
        }
        cursor.continue();
      };
      request.onerror = () => resolve();
    });
  }

  private async persist(entry: Entry | null, path: string) {
    const db = this.db ?? (await this.openDb());
    if (!db) return;
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      if (entry) store.put({ blob: entry.blob, bytes: entry.bytes, directory: entry.directory, mtime: entry.mtime }, path);
      else store.delete(path);
    } catch {
      /* 持久化失败不影响本次会话 */
    }
  }

  private mkdirp(path: string) {
    const root = path.slice(0, path.indexOf('://') + 3);
    const parts = path.slice(root.length).split('/').filter(Boolean);
    let current = root;
    this.entries.set(current, { path: current, blob: new Blob([]), directory: true, mtime: Date.now() });
    for (const part of parts) {
      current = `${current}${current.endsWith('://') ? '' : '/'}${part}`;
      if (!this.entries.has(current)) {
        this.entries.set(current, { path: current, blob: new Blob([]), directory: true, mtime: Date.now() });
      }
    }
  }

  private require(path: string): Entry {
    const entry = this.entries.get(path) ?? (path.startsWith('/') ? this.loadPackageSync(path) : undefined);
    if (!entry || entry.directory) {
      if (getTempFile(path)) {
        const temp = getTempFile(path)!;
        const created: Entry = { path, blob: temp.blob, directory: false, mtime: temp.createdAt };
        this.entries.set(path, created);
        return created;
      }
      throw new Error(`no such file or directory: ${path}`);
    }
    return entry;
  }

  private cachePackage(path: string, bytes: Uint8Array<ArrayBuffer>) {
    const parents = path.split('/').slice(1, -1);
    let current = '';
    for (const part of ['', ...parents]) {
      current = part ? `${current === '/' ? '' : current}/${part}` : '/';
      if (!this.entries.has(current)) this.entries.set(current, { path: current, blob: new Blob([]), directory: true, mtime: 0 });
    }
    const entry: Entry = { path, bytes, blob: new Blob([bytes]), directory: false, mtime: 0 };
    this.entries.set(path, entry);
    return entry;
  }

  private loadPackageSync(path: string) {
    if (typeof XMLHttpRequest === 'undefined') throw new Error(`no such file or directory ${path}`);
    const request = new XMLHttpRequest();
    request.open('GET', packageUrl(path), false);
    request.overrideMimeType('text/plain; charset=x-user-defined');
    request.send();
    if (request.status !== 200) throw new Error(`no such file or directory ${path}`);
    return this.cachePackage(
      path,
      Uint8Array.from(request.responseText, letter => letter.charCodeAt(0) & 255)
    );
  }

  private writable(path: string) {
    if (!path.startsWith('wxfile://')) throw new Error(`permission denied: readonly package ${path}`);
  }

  private put(path: string, blob: Blob, extra: { bytes?: Uint8Array } = {}) {
    this.writable(path);
    this.directory(parentOf(path));
    const previous = this.entries.get(path);
    if (previous?.directory) throw new Error(`illegal operation on a directory ${path}`);
    const entry: Entry = Object.assign(previous ?? {}, {
      path,
      blob,
      directory: false,
      mtime: Date.now(),
      ...extra,
      bytes: extra.bytes ?? encodedBlobs.get(blob)
    });
    this.changedDuringLoad.add(path);
    this.entries.set(path, entry);
    void this.persist(entry, path);
    return entry;
  }

  private directory(path: string) {
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`no such file or directory ${path}`);
    if (!entry.directory) throw new Error(`not a directory ${path}`);
    return entry;
  }

  private mkdir(path: string, recursive: boolean) {
    this.writable(path);
    if (this.entries.has(path)) {
      if (!this.entries.get(path)!.directory || !recursive) throw new Error(`file already exists ${path}`);
      return;
    }
    if (!recursive) this.directory(parentOf(path));
    else if (!this.entries.has(parentOf(path))) this.mkdir(parentOf(path), true);
    const entry: Entry = { path, blob: new Blob([]), bytes: new Uint8Array(), directory: true, mtime: Date.now() };
    this.entries.set(path, entry);
    this.changedDuringLoad.add(path);
    void this.persist(entry, path);
  }

  private erase(path: string) {
    this.entries.delete(path);
    this.changedDuringLoad.add(path);
    void this.persist(null, path);
  }

  private remove(path: string, directory: boolean, recursive = false) {
    this.writable(path);
    if ([USER_ROOT, TMP_ROOT, STORE_ROOT, 'wxfile://'].includes(path)) throw new Error(`operation not permitted ${path}`);
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`no such file or directory ${path}`);
    if (entry.directory !== directory) throw new Error(`invalid file type ${path}`);
    const children = Array.from(this.entries.keys()).filter(key => key.startsWith(`${path}/`));
    if (directory && !recursive && children.length) throw new Error(`directory not empty ${path}`);
    for (const key of [path, ...children]) this.erase(key);
  }

  private rename(from: string, to: string) {
    this.writable(from);
    this.writable(to);
    const entry = this.entries.get(from);
    if (!entry) throw new Error(`no such file or directory ${from}`);
    if ([USER_ROOT, TMP_ROOT, STORE_ROOT].includes(from) || [USER_ROOT, TMP_ROOT, STORE_ROOT].includes(to))
      throw new Error('operation not permitted');
    this.directory(parentOf(to));
    if (from === to) return;
    if (entry.directory && to.startsWith(`${from}/`)) throw new Error('invalid argument: directory moved into itself');
    const destination = this.entries.get(to);
    if (destination) {
      if (destination.directory !== entry.directory) throw new Error('invalid file type');
      if (destination.directory && Array.from(this.entries.keys()).some(key => key.startsWith(`${to}/`)))
        throw new Error('directory not empty');
    }
    const moving = Array.from(this.entries).filter(([path]) => path === from || (entry.directory && path.startsWith(`${from}/`)));
    for (const [path] of moving) this.erase(path);
    for (const [path, value] of moving) {
      value.path = to + path.slice(from.length);
      this.entries.set(value.path, value);
      this.changedDuringLoad.add(value.path);
      void this.persist(value, value.path);
    }
  }

  private cached(entry: Entry) {
    const bytes = entry.bytes ?? encodedBlobs.get(entry.blob);
    if (!bytes) throw new Error('file is not ready');
    return bytes;
  }

  private writeEntry(entry: Entry, bytes: Uint8Array<ArrayBuffer>) {
    const blob = new Blob([bytes]);
    if (this.entries.get(entry.path) === entry) this.put(entry.path, blob, { bytes });
    else Object.assign(entry, { blob, bytes, mtime: Date.now() });
  }

  private resize(entry: Entry, length = 0) {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('invalid length');
    const bytes = new Uint8Array(length);
    if (length) bytes.set(this.cached(entry).subarray(0, length));
    this.writeEntry(entry, bytes);
  }

  private open(options: any) {
    const path = normalize(options.filePath);
    const flag = options.flag ?? 'r';
    if (!['a', 'ax', 'a+', 'ax+', 'as', 'as+', 'r', 'r+', 'w', 'wx', 'w+', 'wx+'].includes(flag)) throw new Error('invalid flag');
    let entry = this.entries.get(path) ?? (path.startsWith('/') && flag === 'r' ? this.require(path) : undefined);
    if (flag !== 'r') this.writable(path);
    if (flag.includes('x') && entry) throw new Error('file already exists');
    if (!entry) {
      if (flag.startsWith('r')) throw new Error('no such file or directory');
      entry = this.put(path, encode(''));
    }
    if (entry.directory) throw new Error('illegal operation on a directory');
    if (flag.startsWith('w')) this.resize(entry, 0);
    const fd = uid('fd');
    this.openFiles.set(fd, {
      entry,
      position: 0,
      read: flag.startsWith('r') || flag.includes('+'),
      write: !flag.startsWith('r') || flag.includes('+'),
      append: flag.startsWith('a')
    });
    return fd;
  }

  private descriptor(fd: string) {
    const handle = this.openFiles.get(fd);
    if (!handle) throw new Error('bad file descriptor');
    return handle;
  }

  private readDescriptor(options: any) {
    const handle = this.descriptor(options.fd);
    if (!handle.read) throw new Error('bad file descriptor: not readable');
    if (!(options.arrayBuffer instanceof ArrayBuffer)) throw new Error('arrayBuffer must be an ArrayBuffer');
    const bytes = this.cached(handle.entry);
    const target = new Uint8Array(options.arrayBuffer);
    const offset = options.offset ?? 0;
    const length = options.length ?? 0;
    const explicit = typeof options.position === 'number';
    const start = explicit ? options.position : handle.position;
    if (![offset, length, start].every(value => Number.isSafeInteger(value) && value >= 0) || offset + length > target.length)
      throw new Error('invalid read range');
    const chunk = bytes.subarray(start, start + length);
    target.set(chunk, offset);
    if (!explicit) handle.position += chunk.length;
    return { bytesRead: chunk.length, arrayBuffer: options.arrayBuffer as ArrayBuffer };
  }

  private writeDescriptor(options: any) {
    const handle = this.descriptor(options.fd);
    if (!handle.write) throw new Error('bad file descriptor: not writable');
    const previous = this.cached(handle.entry);
    let incoming = fileBytes(options.data, options.encoding);
    if (typeof options.data !== 'string') {
      const offset = options.offset ?? 0;
      const length = options.length ?? incoming.length - offset;
      if (![offset, length].every(value => Number.isSafeInteger(value) && value >= 0) || offset + length > incoming.length)
        throw new Error('invalid write range');
      incoming = incoming.slice(offset, offset + length);
    }
    const explicit = typeof options.position === 'number';
    const start = handle.append ? previous.length : explicit ? options.position : handle.position;
    if (!Number.isSafeInteger(start) || start < 0) throw new Error('invalid position');
    const bytes = new Uint8Array(Math.max(previous.length, start + incoming.length));
    bytes.set(previous);
    bytes.set(incoming, start);
    this.writeEntry(handle.entry, bytes);
    if (!explicit || handle.append) handle.position = start + incoming.length;
    return { bytesWritten: incoming.length };
  }

  /** 供网络模块保存下载文件 */
  async saveBlob(path: string, blob: Blob) {
    const target = normalize(path);
    this.put(target, blob, { bytes: new Uint8Array(await blob.arrayBuffer()) });
    return target;
  }

  private stats(entry: Entry) {
    return {
      mode: entry.directory ? 16877 : 33188,
      size: entry.blob.size,
      lastAccessedTime: Math.floor(entry.mtime / 1000),
      lastModifiedTime: Math.floor(entry.mtime / 1000),
      isDirectory: () => entry.directory,
      isFile: () => !entry.directory
    };
  }

  private statPath(path: string, recursive: boolean) {
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`no such file or directory ${path}`);
    if (!recursive) return this.stats(entry);
    return Array.from(this.entries.values())
      .filter(child => child.path.startsWith(`${path}/`))
      .map(child => ({ path: child.path, stats: this.stats(child) }));
  }

  private tempPath(ext = ''): string {
    return `${TMP_ROOT}/${uid('tmp')}${ext}`;
  }

  api() {
    const access = async (path: string) => {
      await this.ready;
      const target = normalize(path);
      if (this.entries.has(target) || getTempFile(target)) return;
      if (target.startsWith('wxfile://')) throw new Error(`access:fail no such file or directory ${target}`);
      // 代码包里的静态资源
      const response = await fetch(target.startsWith('/') ? packageUrl(target) : target).catch(() => null);
      if (!response?.ok) throw new Error(`access:fail no such file or directory ${target}`);
    };

    const readFile = async (path: string, encoding?: Encoding, position?: number, length?: number) => {
      await this.ready;
      const target = normalize(path);
      if (target.startsWith('wxfile://')) return decode(this.require(target).blob, encoding, position, length);
      if (getTempFile(target)) return decode(getTempFile(target)!.blob, encoding, position, length);
      const cached = this.entries.get(target);
      if (cached && !cached.directory) return fileData(readRange(this.cached(cached), position, length), encoding);
      const response = await fetch(target.startsWith('/') ? packageUrl(target) : target);
      if (!response.ok) throw new Error(`readFile:fail no such file or directory ${target}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (target.startsWith('/')) this.cachePackage(target, bytes);
      return fileData(readRange(bytes, position, length), encoding);
    };

    const writeFile = async (path: string, data: ArrayBuffer | string, encoding?: Encoding) => {
      await this.ready;
      this.put(normalize(path), encode(data, encoding));
    };

    const readdir = async (path: string) => {
      await this.ready;
      const target = normalize(path);
      const entry = this.entries.get(target);
      if (!entry?.directory) throw new Error(`readdir:fail no such file or directory ${target}`);
      const prefix = target.endsWith('/') ? target : `${target}/`;
      const names: string[] = [];
      for (const key of this.entries.keys()) {
        if (!key.startsWith(prefix) || key === target) continue;
        const name = key.slice(prefix.length).split('/')[0];
        if (name && !names.includes(name)) names.push(name);
      }
      return names;
    };

    const rm = async (path: string, recursive: boolean) => {
      await this.ready;
      this.remove(normalize(path), true, recursive);
    };

    const stat = async (path: string, recursive = false) => {
      await this.ready;
      return this.statPath(normalize(path), recursive);
    };

    const copy = async (from: string, to: string) => {
      await this.ready;
      const source = await readFile(from);
      const target = normalize(to);
      const bytes = fileBytes(source);
      this.put(target, new Blob([bytes]), { bytes });
    };

    const fs = {
      access: (options: any) =>
        invoke('access', options, async opts => {
          await access(opts.path);
          return {};
        }),
      accessSync: (path: string) => {
        const target = normalize(path);
        if (!this.entries.has(target) && !getTempFile(target)) this.require(target);
      },
      readFile: (options: any) =>
        invoke('readFile', options, async opts => ({ data: await readFile(opts.filePath, opts.encoding, opts.position, opts.length) })),
      readFileSync: (filePath: string, encoding?: Encoding, position?: number, length?: number) => {
        const target = normalize(filePath);
        const entry = this.require(target);

        const bytes = entry.bytes ?? encodedBlobs.get(entry.blob);
        if (!bytes) throw new Error('readFileSync:fail file is not ready');
        return fileData(readRange(bytes, position, length), encoding);
      },
      writeFile: (options: any) =>
        invoke('writeFile', options, async opts => {
          await writeFile(opts.filePath, opts.data, opts.encoding);
          return {};
        }),
      writeFileSync: (filePath: string, data: ArrayBuffer | string, encoding?: Encoding) => {
        this.put(normalize(filePath), encode(data, encoding));
      },
      appendFile: (options: any) =>
        invoke('appendFile', options, async opts => {
          const target = normalize(opts.filePath);
          await this.ready;
          const existing = this.entries.get(target);
          const incoming = fileBytes(opts.data, opts.encoding);
          const previous = existing ? (existing.bytes ?? new Uint8Array(await existing.blob.arrayBuffer())) : new Uint8Array();
          const bytes = concatBytes(previous, incoming);
          this.put(target, new Blob([bytes]), { bytes });
          return {};
        }),
      appendFileSync: (filePath: string, data: string | ArrayBuffer, encoding?: Encoding) => {
        const target = normalize(filePath);
        const existing = this.entries.get(target);
        const incoming = fileBytes(data, encoding);
        if (existing && !existing.bytes) throw new Error('appendFileSync:fail file is not ready');
        const bytes = concatBytes(existing?.bytes ?? new Uint8Array(), incoming);
        this.put(target, new Blob([bytes]), { bytes });
      },
      mkdir: (options: any) =>
        invoke('mkdir', options, async opts => {
          const target = normalize(opts.dirPath);
          await this.ready;
          this.mkdir(target, !!opts.recursive);
          return {};
        }),
      mkdirSync: (dirPath: string, recursive?: boolean) => {
        const target = normalize(dirPath);
        this.mkdir(target, !!recursive);
      },
      readdir: (options: any) => invoke('readdir', options, async opts => ({ files: await readdir(opts.dirPath) })),
      readdirSync: (dirPath: string) => {
        const target = normalize(dirPath);
        this.directory(target);
        const prefix = `${target}/`;
        const names: string[] = [];
        for (const key of this.entries.keys()) {
          if (!key.startsWith(prefix)) continue;
          const name = key.slice(prefix.length).split('/')[0];
          if (name && !names.includes(name)) names.push(name);
        }
        return names;
      },
      rmdir: (options: any) =>
        invoke('rmdir', options, async opts => {
          await rm(opts.dirPath, !!opts.recursive);
          return {};
        }),
      rmdirSync: (dirPath: string, recursive?: boolean) => this.remove(normalize(dirPath), true, !!recursive),
      unlink: (options: any) =>
        invoke('unlink', options, async opts => {
          await this.ready;
          this.remove(normalize(opts.filePath), false);
          return {};
        }),
      unlinkSync: (filePath: string) => this.remove(normalize(filePath), false),
      stat: (options: any) => invoke('stat', options, async opts => ({ stats: await stat(opts.path, !!opts.recursive) })),
      statSync: (path: string, recursive = false) => this.statPath(normalize(path), recursive),
      rename: (options: any) =>
        invoke('rename', options, async opts => {
          await this.ready;
          this.rename(normalize(opts.oldPath), normalize(opts.newPath));
          return {};
        }),
      renameSync: (oldPath: string, newPath: string) => this.rename(normalize(oldPath), normalize(newPath)),
      copyFile: (options: any) =>
        invoke('copyFile', options, async opts => {
          await copy(opts.srcPath, opts.destPath);
          return {};
        }),
      copyFileSync: (srcPath: string, destPath: string) => {
        const source = this.entries.get(normalize(srcPath));
        if (!source) throw new Error('no such file or directory');
        this.put(normalize(destPath), source.blob, { bytes: source.bytes?.slice() });
      },
      truncate: (options: any) =>
        invoke('truncate', options, async opts => {
          const target = normalize(opts.filePath);
          const entry = this.require(target);
          this.resize(entry, opts.length);
          return {};
        }),
      getFileInfo: (options: any) =>
        invoke('getFileInfo', options, async opts => {
          const data = await readFile(opts.filePath);
          const bytes = fileBytes(data);
          return { size: bytes.length, digest: await fileDigest(bytes, opts.digestAlgorithm) };
        }),
      saveFile: (options: any) =>
        invoke('saveFile', options, async opts => {
          await this.ready;
          const blob = await blobFromPath(opts.tempFilePath);
          const name = opts.filePath ? normalize(opts.filePath) : `${STORE_ROOT}/${uid('saved')}`;
          this.put(name, blob, { bytes: new Uint8Array(await blob.arrayBuffer()) });
          const source = normalize(opts.tempFilePath);
          if (source !== name && source.startsWith(`${TMP_ROOT}/`)) this.erase(source);
          if (getTempFile(source)) removeTempFile(source);
          return { savedFilePath: name };
        }),
      saveFileSync: (tempFilePath: string, filePath?: string) => {
        const source = normalize(tempFilePath);
        const entry = this.require(source);
        const target = filePath ? normalize(filePath) : `${STORE_ROOT}/${uid('saved')}`;
        this.put(target, entry.blob, { bytes: this.cached(entry).slice() });
        if (source !== target && source.startsWith(`${TMP_ROOT}/`)) this.erase(source);
        if (getTempFile(source)) removeTempFile(source);
        return target;
      },
      getSavedFileList: (options: any) =>
        invoke('getSavedFileList', options, async () => {
          await this.ready;
          const fileList = Array.from(this.entries.values())
            .filter(entry => entry.path.startsWith(`${STORE_ROOT}/`))
            .map(entry => ({ filePath: entry.path, size: entry.blob.size, createTime: Math.floor(entry.mtime / 1000) }));
          return { fileList };
        }),
      removeSavedFile: (options: any) =>
        invoke('removeSavedFile', options, opts => {
          this.remove(normalize(opts.filePath), false);
          return {};
        }),
      open: (options: any) =>
        invoke('open', options, async opts => {
          await this.ready;
          return { fd: this.open(opts) };
        }),
      openSync: (options: any) => this.open(options),
      close: (options: any) =>
        invoke('close', options, opts => {
          this.descriptor(opts.fd);
          this.openFiles.delete(opts.fd);
          return {};
        }),
      closeSync: (options: any) => {
        this.descriptor(options.fd);
        this.openFiles.delete(options.fd);
      },
      read: (options: any) =>
        invoke('read', options, async opts => {
          await this.ready;
          return this.readDescriptor(opts);
        }),
      readSync: (options: any) => this.readDescriptor(options),
      write: (options: any) =>
        invoke('write', options, async opts => {
          await this.ready;
          return this.writeDescriptor(opts);
        }),
      writeSync: (options: any) => this.writeDescriptor(options),
      fstat: (options: any) => invoke('fstat', options, opts => ({ stats: this.stats(this.descriptor(opts.fd).entry) })),
      fstatSync: (options: any) => this.stats(this.descriptor(options.fd).entry),
      ftruncate: (options: any) =>
        invoke('ftruncate', options, opts => {
          const handle = this.descriptor(opts.fd);
          if (!handle.write) throw new Error('bad file descriptor: not writable');
          this.resize(handle.entry, opts.length);
          return {};
        }),
      ftruncateSync: (options: any) => {
        const handle = this.descriptor(options.fd);
        if (!handle.write) throw new Error('bad file descriptor: not writable');
        this.resize(handle.entry, options.length);
      },
      truncateSync: (filePath: string, length = 0) => this.resize(this.require(normalize(filePath)), length),
      readCompressedFile: (options: any) =>
        invoke('readCompressedFile', options, async opts => {
          if (opts.compressionAlgorithm !== 'br') throw new Error('unsupported compression algorithm');
          const bytes = fileBytes(await readFile(opts.filePath));
          return { data: decompress(bytes).slice().buffer as ArrayBuffer };
        }),
      readCompressedFileSync: (options: any) => {
        if (options.compressionAlgorithm !== 'br') throw new Error('unsupported compression algorithm');
        return decompress(this.cached(this.require(normalize(options.filePath)))).slice().buffer as ArrayBuffer;
      },
      readZipEntry: (options: any) =>
        invoke('readZipEntry', options, async opts => {
          const files = unzipSync(fileBytes(await readFile(opts.filePath)));
          const requested: Array<{ path: string; encoding?: Encoding }> =
            opts.entries === 'all'
              ? Object.keys(files)
                  .filter(path => !path.endsWith('/'))
                  .map(path => ({ path, encoding: opts.encoding }))
              : opts.entries;
          if (!Array.isArray(requested)) throw new Error('entries must be an array or all');
          const entries: Record<string, any> = Object.create(null);
          for (const entry of requested) {
            try {
              if (!Object.prototype.hasOwnProperty.call(files, entry.path)) throw new Error('no such file in archive');
              entries[entry.path] = { data: fileData(files[entry.path], entry.encoding), errMsg: 'readZipEntry:ok' };
            } catch (error) {
              entries[entry.path] = { errMsg: `readZipEntry:fail ${(error as Error).message}` };
            }
          }
          return { entries };
        }),
      unzip: (options: any) =>
        invoke('unzip', options, async opts => {
          const files = unzipSync(fileBytes(await readFile(opts.zipFilePath)));
          const root = normalize(opts.targetPath);
          const targets = Object.entries(files).map(([name, bytes]) => {
            const path = normalize(`${root}/${name}`);
            if (name.startsWith('/') || !path.startsWith(`${root}/`)) throw new Error('invalid archive path');
            return { path, bytes: bytes.slice(), directory: name.endsWith('/') };
          });
          this.mkdir(root, true);
          for (const { path, bytes, directory } of targets) {
            this.mkdir(directory ? path : parentOf(path), true);
            if (!directory) this.put(path, new Blob([bytes]), { bytes });
          }
          return {};
        }),
      openDocument: (options: any) =>
        invoke('openDocument', options, async opts => {
          const blob = await blobFromPath(opts.filePath).catch(() => null);
          if (!blob) throw new Error('file not found');
          window.open(URL.createObjectURL(blob), '_blank');
          return {};
        }),
      saveFileToDisk: (options: any) =>
        invoke('saveFileToDisk', options, async opts => {
          const blob = await blobFromPath(opts.filePath);
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = opts.filePath.split('/').pop() || 'download';
          link.click();
          setTimeout(() => URL.revokeObjectURL(link.href), 1000);
          return {};
        }),
      getFileSystemManager: () => this.manager
    };

    this.manager = Object.fromEntries(
      Object.entries(fs)
        .filter(([name]) => !['getFileSystemManager', 'openDocument', 'saveFileToDisk'].includes(name))
        .map(([name, method]) => [
          name,
          name.endsWith('Sync')
            ? method
            : (options: any = {}) => {
                (method as any)({ ...options, fail: options.fail ?? (() => {}) });
              }
        ])
    );
    return fs;
  }

  manager: any;

  /** wx.env.USER_DATA_PATH 指向的用户目录 */
  static get userRoot() {
    return USER_ROOT;
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a);
  merged.set(b, a.length);
  return merged;
}

export const FS_CONSTANTS = { USER_ROOT, TMP_ROOT, STORE_ROOT };
