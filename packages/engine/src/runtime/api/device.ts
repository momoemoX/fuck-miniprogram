/**
 * 设备能力：蓝牙、BLE、Wi-Fi、NFC、Beacon、Worker、键盘
 *
 * 浏览器无法直接访问这些硬件（Web Bluetooth 需要用户手势且限制多），
 * 按开发者工具的做法提供可用的模拟设备与完整的状态机：调用序列、
 * 事件名、回调结构都与真机一致，业务代码可以正常跑通流程。
 */

import { createWorker as spawnWorker, workerSource } from '../worker';
import type { WxHost } from './types';
import { deliver, invoke, syncResult } from './util';

interface BleDevice {
  deviceId: string;
  name: string;
  localName: string;
  RSSI: number;
  advertisData: ArrayBuffer;
  advertisServiceUUIDs: string[];
  connectable: boolean;
}

const SAMPLE_DEVICES: BleDevice[] = [
  {
    deviceId: 'B4:0E:CF:11:22:33',
    name: 'fmp-band',
    localName: 'fmp-band',
    RSSI: -52,
    advertisData: new ArrayBuffer(0),
    advertisServiceUUIDs: ['0000FFF0-0000-1000-8000-00805F9B34FB'],
    connectable: true
  },
  {
    deviceId: 'C8:1F:66:44:55:66',
    name: 'Demo Sensor',
    localName: 'Demo Sensor',
    RSSI: -71,
    advertisData: new ArrayBuffer(0),
    advertisServiceUUIDs: [],
    connectable: true
  }
];

export class DeviceApi {
  private adapter = { available: true, discovering: false };
  private devices = new Map<string, BleDevice>();
  private connected = new Map<string, boolean>();
  private wifi = { wifiEnabled: true };
  private keyboard = 0;
  private keyboardBound = false;
  private keyboardCleanup?: () => void;
  private keyActivated = false;
  private readonly keyCleanups: Array<() => void> = [];
  private readonly keyListeners: Record<string, Array<(value: any) => void>> = { keydown: [], keyup: [] };
  private workers = new Set<ReturnType<typeof spawnWorker>>();

  constructor(private readonly host: WxHost) {
    this.watchKeyboard();
    this.watchKeys();
  }

  private watchKeyboard() {
    if (this.keyboardBound || typeof window === 'undefined' || !window.visualViewport) return;
    this.keyboardBound = true;
    const viewport = window.visualViewport!;
    const update = () => {
      const height = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      if (Math.abs(height - this.keyboard) < 2) return;
      this.keyboard = height;
      this.host.emit('keyboardHeightChange', { height, duration: 0 });
    };
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    this.keyboardCleanup = () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }

  private watchKeys() {
    if (typeof window === 'undefined') return;
    const activate = (event: Event) => { if (event.isTrusted) this.keyActivated = true; };
    const editing = (target: EventTarget | null) => target instanceof Element && (
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLIFrameElement ||
      (target instanceof HTMLElement && target.isContentEditable) || !!target.closest('wx-editor, wx-web-view')
    );
    const report = (event: KeyboardEvent) => {
      if (!this.keyActivated || document.visibilityState === 'hidden' || editing(document.activeElement) || editing(event.composedPath()[0])) return;
      const value = {
        key: event.key, code: event.code, altKey: event.altKey, shiftKey: event.shiftKey, timeStamp: event.timeStamp
      };
      for (const callback of [...this.keyListeners[event.type]]) deliver(callback, value);
    };
    window.addEventListener('pointerdown', activate, true);
    window.addEventListener('keydown', report, true);
    window.addEventListener('keyup', report, true);
    this.keyCleanups.push(() => {
      window.removeEventListener('pointerdown', activate, true);
      window.removeEventListener('keydown', report, true);
      window.removeEventListener('keyup', report, true);
    });
  }

  private onKey(type: 'keydown' | 'keyup', callback: (value: any) => void) {
    if (typeof callback === 'function') this.keyListeners[type].push(callback);
  }

  private offKey(type: 'keydown' | 'keyup', callback?: (value: any) => void) {
    this.keyListeners[type] = callback ? this.keyListeners[type].filter(listener => listener !== callback) : [];
  }

  dispose() {
    this.keyboardCleanup?.();
    this.keyboardCleanup = undefined;
    for (const cleanup of this.keyCleanups) cleanup();
    this.keyCleanups.length = 0;
    this.keyListeners.keydown = [];
    this.keyListeners.keyup = [];
    for (const worker of this.workers) worker.terminate();
    this.workers.clear();
  }

  api() {
    return {
      // ---------------------------------------------------------------- 蓝牙
      openBluetoothAdapter: (options: any) =>
        invoke('openBluetoothAdapter', options, () => {
          this.adapter.available = true;
          this.host.emit('bluetoothAdapterStateChange', { ...this.adapter });
          return {};
        }),
      closeBluetoothAdapter: (options: any) =>
        invoke('closeBluetoothAdapter', options, () => {
          this.adapter.discovering = false;
          this.host.emit('bluetoothAdapterStateChange', { ...this.adapter });
          this.devices.clear();
          this.connected.clear();
          return {};
        }),
      getBluetoothAdapterState: (options: any) => invoke('getBluetoothAdapterState', options, () => ({ ...this.adapter })),
      onBluetoothAdapterStateChange: (callback: (res: any) => void) => this.host.on('bluetoothAdapterStateChange', callback),
      offBluetoothAdapterStateChange: (callback?: (res: any) => void) => this.host.off('bluetoothAdapterStateChange', callback),

      startBluetoothDevicesDiscovery: (options: any) =>
        invoke('startBluetoothDevicesDiscovery', options, async opts => {
          if (!this.adapter.available) throw new Error('adapter not available');
          this.adapter.discovering = true;
          this.host.emit('bluetoothAdapterStateChange', { ...this.adapter });
          const allowDuplicates = !!opts?.allowDuplicatesKey;
          setTimeout(() => {
            for (const device of SAMPLE_DEVICES) this.devices.set(device.deviceId, device);
            this.host.emit('bluetoothDeviceFound', {
              devices: SAMPLE_DEVICES.map(device => ({ ...device }))
            });
            if (!allowDuplicates) this.adapter.discovering = false;
          }, 120);
          return {};
        }),
      stopBluetoothDevicesDiscovery: (options: any) =>
        invoke('stopBluetoothDevicesDiscovery', options, () => {
          this.adapter.discovering = false;
          this.host.emit('bluetoothAdapterStateChange', { ...this.adapter });
          return {};
        }),
      getBluetoothDevices: (options: any) => invoke('getBluetoothDevices', options, () => ({ devices: Array.from(this.devices.values()) })),
      getConnectedBluetoothDevices: (options: any) =>
        invoke('getConnectedBluetoothDevices', options, () => ({
          devices: Array.from(this.devices.values()).filter(device => this.connected.get(device.deviceId))
        })),
      onBluetoothDeviceFound: (callback: (res: any) => void) => this.host.on('bluetoothDeviceFound', callback),
      offBluetoothDeviceFound: (callback?: (res: any) => void) => this.host.off('bluetoothDeviceFound', callback),

      createBLEConnection: (options: any) =>
        invoke('createBLEConnection', options, async opts => {
          if (!opts?.deviceId) throw new Error('parameter error: "deviceId" is required');
          await new Promise(resolve => setTimeout(resolve, 300));
          this.connected.set(opts.deviceId, true);
          this.host.emit('BLEConnectionStateChange', { deviceId: opts.deviceId, connected: true });
          return {};
        }),
      closeBLEConnection: (options: any) =>
        invoke('closeBLEConnection', options, opts => {
          this.connected.set(opts?.deviceId, false);
          this.host.emit('BLEConnectionStateChange', { deviceId: opts?.deviceId, connected: false });
          return {};
        }),
      onBLEConnectionStateChange: (callback: (res: any) => void) => this.host.on('BLEConnectionStateChange', callback),
      offBLEConnectionStateChange: (callback?: (res: any) => void) => this.host.off('BLEConnectionStateChange', callback),

      getBLEDeviceServices: (options: any) =>
        invoke('getBLEDeviceServices', options, async () => ({
          services: [
            { uuid: '0000FFF0-0000-1000-8000-00805F9B34FB', isPrimary: true },
            { uuid: '0000180F-0000-1000-8000-00805F9B34FB', isPrimary: true }
          ]
        })),
      getBLEDeviceCharacteristics: (options: any) =>
        invoke('getBLEDeviceCharacteristics', options, async () => ({
          characteristics: [
            { uuid: '0000FFF1-0000-1000-8000-00805F9B34FB', properties: { read: true, write: true, notify: true, indicate: false } },
            { uuid: '0000FFF2-0000-1000-8000-00805F9B34FB', properties: { read: true, write: false, notify: false, indicate: false } }
          ]
        })),
      readBLECharacteristicValue: (options: any) =>
        invoke('readBLECharacteristicValue', options, async opts => {
          await new Promise(resolve => setTimeout(resolve, 60));
          const value = new Uint8Array([0x01, 0x02, 0x03, 0x04]).buffer;
          this.host.emit('BLECharacteristicValueChange', {
            deviceId: opts?.deviceId,
            serviceId: opts?.serviceId,
            characteristicId: opts?.characteristicId,
            value
          });
          return {};
        }),
      writeBLECharacteristicValue: (options: any) =>
        invoke('writeBLECharacteristicValue', options, async opts => {
          await new Promise(resolve => setTimeout(resolve, 40));
          this.host.emit('BLECharacteristicValueChange', {
            deviceId: opts?.deviceId,
            serviceId: opts?.serviceId,
            characteristicId: opts?.characteristicId,
            value: opts?.value ?? new ArrayBuffer(0)
          });
          return {};
        }),
      notifyBLECharacteristicValueChange: (options: any) =>
        invoke('notifyBLECharacteristicValueChange', options, opts => {
          if (opts?.state) {
            setTimeout(() => {
              this.host.emit('BLECharacteristicValueChange', {
                deviceId: opts.deviceId,
                serviceId: opts.serviceId,
                characteristicId: opts.characteristicId,
                value: new Uint8Array([0x10, 0x20]).buffer
              });
            }, 300);
          }
          return {};
        }),
      onBLECharacteristicValueChange: (callback: (res: any) => void) => this.host.on('BLECharacteristicValueChange', callback),
      offBLECharacteristicValueChange: (callback?: (res: any) => void) => this.host.off('BLECharacteristicValueChange', callback),
      makeBluetoothPair: (options: any) => invoke('makeBluetoothPair', options, () => ({})),
      isBluetoothDevicePaired: (options: any) => invoke('isBluetoothDevicePaired', options, () => ({ isPaired: true })),

      // ---------------------------------------------------------------- Wi-Fi
      startWifi: (options: any) =>
        invoke('startWifi', options, () => {
          this.wifi.wifiEnabled = true;
          return {};
        }),
      stopWifi: (options: any) => invoke('stopWifi', options, () => ({})),
      getWifiList: (options: any) =>
        invoke('getWifiList', options, () => {
          setTimeout(() => {
            this.host.emit('getWifiList', {
              wifiList: [
                { SSID: 'fmp-demo', BSSID: '00:11:22:33:44:55', secure: true, signalStrength: 80, frequency: 2437 },
                { SSID: 'guest', BSSID: '00:11:22:33:44:56', secure: false, signalStrength: 55, frequency: 5180 }
              ]
            });
          }, 200);
          return {};
        }),
      onGetWifiList: (callback: (res: any) => void) => this.host.on('getWifiList', callback),
      offGetWifiList: (callback?: (res: any) => void) => this.host.off('getWifiList', callback),
      setWifiList: (options: any) => invoke('setWifiList', options, () => ({})),
      connectWifi: (options: any) =>
        invoke('connectWifi', options, opts => {
          setTimeout(() => {
            this.host.emit('wifiConnected', {
              wifi: { SSID: opts?.SSID ?? '', BSSID: opts?.BSSID ?? '', secure: true, signalStrength: 80, frequency: 2437 }
            });
          }, 300);
          return {};
        }),
      onWifiConnected: (callback: (res: any) => void) => this.host.on('wifiConnected', callback),
      offWifiConnected: (callback?: (res: any) => void) => this.host.off('wifiConnected', callback),
      getConnectedWifi: (options: any) =>
        invoke('getConnectedWifi', options, () => ({
          wifi: { SSID: 'fmp-demo', BSSID: '00:11:22:33:44:55', secure: true, signalStrength: 80, frequency: 2437 }
        })),
      onWifiDisconnect: (callback: (res: any) => void) => this.host.on('wifiDisconnect', callback),
      offWifiDisconnect: (callback?: (res: any) => void) => this.host.off('wifiDisconnect', callback),

      // ---------------------------------------------------------------- NFC
      getNFCAdapter: () => ({
        startDiscovery: (options: any) =>
          invoke('NFCAdapter.startDiscovery', options, () => {
            throw new Error('NFC is not supported');
          }),
        stopDiscovery: (options: any) => invoke('NFCAdapter.stopDiscovery', options, () => ({})),
        onDiscovered: (callback: (res: any) => void) => this.host.on('nfcDiscovered', callback),
        offDiscovered: (callback?: (res: any) => void) => this.host.off('nfcDiscovered', callback)
      }),
      startHCE: (options: any) =>
        invoke('startHCE', options, () => {
          throw new Error('HCE is not supported');
        }),
      stopHCE: (options: any) => invoke('stopHCE', options, () => ({})),
      onHCEMessage: (callback: (res: any) => void) => this.host.on('HCEMessage', callback),
      offHCEMessage: (callback?: (res: any) => void) => this.host.off('HCEMessage', callback),
      sendHCEMessage: (options: any) =>
        invoke('sendHCEMessage', options, () => {
          throw new Error('HCE is not supported');
        }),

      // ---------------------------------------------------------------- Beacon
      openBeacon: (options: any) => invoke('openBeacon', options, () => ({})),
      startBeaconDiscovery: (options: any) =>
        invoke('startBeaconDiscovery', options, () => {
          setTimeout(() => {
            this.host.emit('beaconUpdate', {
              beacons: [
                { uuid: 'FDA50693-A4E2-4FB1-AFCF-C6EB07647825', major: 10004, minor: 56696, proximity: 1, accuracy: 1.2, rssi: -60 }
              ]
            });
          }, 200);
          return {};
        }),
      stopBeaconDiscovery: (options: any) => invoke('stopBeaconDiscovery', options, () => ({})),
      getBeacons: (options: any) => invoke('getBeacons', options, () => ({ beacons: [] })),
      onBeaconUpdate: (callback: (res: any) => void) => this.host.on('beaconUpdate', callback),
      offBeaconUpdate: (callback?: (res: any) => void) => this.host.off('beaconUpdate', callback),
      onBeaconServiceChange: (callback: (res: any) => void) => this.host.on('beaconServiceChange', callback),
      offBeaconServiceChange: (callback?: (res: any) => void) => this.host.off('beaconServiceChange', callback),

      // ---------------------------------------------------------------- Worker
      createWorker: (scriptPath: string, options?: any) => {
        const source = workerSource(scriptPath);
        if (!source) {
          throw new Error(`createWorker:fail worker script "${scriptPath}" is not compiled`);
        }
        const worker = spawnWorker(source, options?.name);
        this.workers.add(worker);
        const terminate = worker.terminate;
        worker.terminate = () => {
          terminate();
          this.workers.delete(worker);
        };
        return worker;
      },

      // ---------------------------------------------------------------- 键盘
      onKeyDown: (callback: (value: any) => void) => this.onKey('keydown', callback),
      offKeyDown: (callback?: (value: any) => void) => this.offKey('keydown', callback),
      onKeyUp: (callback: (value: any) => void) => this.onKey('keyup', callback),
      offKeyUp: (callback?: (value: any) => void) => this.offKey('keyup', callback),
      hideKeyboard: (options?: any) => invoke('hideKeyboard', options, () => {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active instanceof HTMLElement && active.isContentEditable)) active.blur();
        return {};
      }),
      onKeyboardHeightChange: (callback: (res: any) => void) => this.host.on('keyboardHeightChange', callback),
      offKeyboardHeightChange: (callback?: (res: any) => void) => this.host.off('keyboardHeightChange', callback),
      getSelectedTextRange: (options: any) =>
        invoke('getSelectedTextRange', options, () => {
          const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
          if (!el || !('selectionStart' in el)) return { start: 0, end: 0 };
          return { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
        }),
      onDeviceOrientationChange: (callback: (res: any) => void) => this.host.on('deviceOrientationChange', callback),
      offDeviceOrientationChange: (callback?: (res: any) => void) => this.host.off('deviceOrientationChange', callback),
      onGeneratePoster: () => undefined,

      // ---------------------------------------------------------------- 其它
      getDeviceBenchmarkInfo: () => syncResult('getDeviceBenchmarkInfo', { benchmarkLevel: 1, model: 'devtools', platform: 'devtools' }),
      getPerformance: () => ({
        now: () => performance.now(),
        memory: () => ({
          usedJSHeapSize: (performance as any).memory?.usedJSHeapSize ?? 0,
          totalJSHeapSize: (performance as any).memory?.totalJSHeapSize ?? 0,
          jsHeapSizeLimit: (performance as any).memory?.jsHeapSizeLimit ?? 0
        }),
        createObserver: () => ({ observe: () => undefined, disconnect: () => undefined })
      })
    };
  }
}
