/**
 * 临时文件表
 *
 * 浏览器里没有 wxfile://，用 blob URL 充当临时文件路径，同时把 Blob 本身
 * 记下来：saveFile / getFileInfo / uploadFile 都靠这张表还原内容。
 */

import { uid } from './util';

export interface TempFile {
  path: string;
  url: string;
  blob: Blob;
  size: number;
  type: string;
  name?: string;
  createdAt: number;
}

const files = new Map<string, TempFile>();

/** 用户目录里的文件由 FsApi 注册解析器，网络/媒体模块就能直接读 wxfile:// */
let resolvePath: ((path: string) => Blob | undefined) | null = null;

export function setPathResolver(fn: (path: string) => Blob | undefined) {
  resolvePath = fn;
}

export function addTempFile(blob: Blob, name?: string, type?: string): TempFile {
  const url = URL.createObjectURL(blob);
  const path = url;
  const record: TempFile = {
    path,
    url,
    blob,
    size: blob.size,
    type: type || blob.type || '',
    name,
    createdAt: Date.now()
  };
  files.set(path, record);
  return record;
}

export function fromDataUrl(dataUrl: string, name?: string): TempFile {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('invalid data url');
  const type = match[1] || 'application/octet-stream';
  const binary = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return addTempFile(new Blob([bytes], { type }), name, type);
}

export function getTempFile(path: string): TempFile | undefined {
  return files.get(path);
}

export function removeTempFile(path: string) {
  const record = files.get(path);
  if (!record) return;
  files.delete(path);
  URL.revokeObjectURL(record.url);
}

export async function blobFromPath(path: string, signal?: AbortSignal): Promise<Blob> {
  const record = files.get(path);
  if (record) return record.blob;
  const local = resolvePath?.(path);
  if (local) return local;
  if (path.startsWith('data:')) return (await fetch(path, { signal })).blob();
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`read file failed: ${path}`);
  return response.blob();
}

export function listTempFiles(): TempFile[] {
  return Array.from(files.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export function clearTempFiles() {
  for (const record of files.values()) URL.revokeObjectURL(record.url);
  files.clear();
}

export function tempPathFor(blob: Blob, name?: string): string {
  return addTempFile(blob, name).path;
}

export { uid };
