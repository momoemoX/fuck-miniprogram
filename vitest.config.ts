import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 浏览器用例会各自拉起 Chromium，并发过高时内存与 GPU 进程互相争抢，反而更容易超时
    maxWorkers: 2,
    testTimeout: 30000,
    hookTimeout: 60000
  }
});
