import { describe, expect, it } from 'vitest';
import { EventChannel } from '../../packages/engine/src/runtime/api/route';

describe('页面事件通道', () => {
  it('订阅前发送的消息会在订阅后按顺序送达', () => {
    const channel = new EventChannel();
    channel.emit('message', 1);
    channel.emit('message', 2);
    const values: number[] = [];
    channel.on('message', value => values.push(value));
    expect(values).toEqual([1, 2]);
  });
  it('同一回调在不同事件上的 once 状态互不影响', () => {
    const channel = new EventChannel();
    const values: number[] = [];
    const receive = (value: number) => values.push(value);
    channel.on('repeat', receive);
    channel.once('once', receive);
    channel.emit('repeat', 1);
    channel.emit('repeat', 2);
    channel.emit('once', 3);
    channel.emit('once', 4);
    expect(values).toEqual([1, 2, 3]);
  });
});
