import '@testing-library/jest-dom/vitest';

// jsdom 缺失的浏览器 API 桩
let canvasContextStubbed = false;
if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  if (!('ResizeObserver' in window)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  }
  // jsdom 未安装 canvas 包时 getContext 抛“Not implemented”噪音；
  // 返回 null 令 FestivalOverlay 按“无绘制上下文”优雅跳过。
  if (!canvasContextStubbed) {
    canvasContextStubbed = true;
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  }
}
