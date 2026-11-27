/**
 * 加密数据缓存
 *
 * `wx.setStorage({ encrypt: true })` 写入的值以 AES-GCM(128) + 随机 IV 的密文落在
 * localStorage，明文只存在于内存与返回值里。密钥首次生成后存进 IndexedDB，因此同一
 * 浏览器重开小程序仍能解回；隐私模式或缺少 IndexedDB 时退化为内存密钥，保证当前会话
 * 内仍可读写，只是刷新后旧密文不再可解（这是浏览器环境本身的限制）。
 */

/** 密文在 localStorage 里的形态；`__fmpEncrypted` 同时用于识别加密记录 */
export interface EncryptedValue {
  __fmpEncrypted: 1;
  iv: string;
  cipher: string;
}

const DB_NAME = 'fmp-storage-crypto';
const STORE_NAME = 'keys';
const KEY_ID = 'storage';
const IV_BYTES = 12;
const USAGES: KeyUsage[] = ['encrypt', 'decrypt'];

let keyPromise: Promise<CryptoKey> | undefined;
let memoryKey: Promise<CryptoKey> | undefined;

function createKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, USAGES) as Promise<CryptoKey>;
}

/** IndexedDB 不可用时的兜底：只在内存里保留一份会话密钥 */
function fallbackKey(): Promise<CryptoKey> {
  return (memoryKey ??= createKey());
}

/** 读取持久密钥，没有则生成并写回 IndexedDB */
function loadKey(): Promise<CryptoKey> {
  if (typeof indexedDB === 'undefined') return fallbackKey();
  return new Promise<CryptoKey>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE_NAME);
    open.onerror = () => { void fallbackKey().then(resolve, reject); };
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => db.close();
      const read = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(KEY_ID);
      read.onerror = () => { db.close(); void fallbackKey().then(resolve, reject); };
      read.onsuccess = () => {
        if (read.result) { db.close(); resolve(read.result as CryptoKey); return; }
        void createKey().then(
          key => {
            const write = db.transaction(STORE_NAME, 'readwrite');
            write.objectStore(STORE_NAME).put(key, KEY_ID);
            write.oncomplete = () => { db.close(); resolve(key); };
            write.onerror = () => { db.close(); void fallbackKey().then(resolve, reject); };
          },
          error => { db.close(); reject(error); }
        );
      };
    };
  });
}

function key(): Promise<CryptoKey> {
  // 失败的结果不缓存，避免一次偶发错误让后续所有加密调用一起失败
  return (keyPromise ??= loadKey().catch(error => { keyPromise = undefined; throw error; }));
}

function encode(bytes: Uint8Array): string {
  // 单次 32KB 分块，避免把 1MB 上限的密文摊成十多万个函数参数
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(text);
}

function decode(text: string): ArrayBuffer {
  return Uint8Array.from(atob(text), char => char.charCodeAt(0)).buffer as ArrayBuffer;
}

export async function encryptValue(value: any): Promise<EncryptedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plain = new TextEncoder().encode(JSON.stringify(value === undefined ? null : value));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), plain);
  return { __fmpEncrypted: 1, iv: encode(iv), cipher: encode(new Uint8Array(cipher)) };
}

export async function decryptValue(value: EncryptedValue): Promise<any> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(value.iv) }, await key(), decode(value.cipher));
  return JSON.parse(new TextDecoder().decode(plain));
}
