import { defineConfig, devices } from '@playwright/test';

/**
 * 浏览器端到端验收（第 13.1 节）：编辑—跳站—预览—导出闭环与三端断点。
 * 注意：导出图片在真实设备上的保存行为需人工验证（第 14.2 节），
 * 自动化仅覆盖桌面 WebKit/Chromium 的生成路径。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:5173',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx vite --port 5173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
