import "@testing-library/jest-dom/vitest";

// Node 26+ 在未传 --localstorage-file 时 global localStorage 为 undefined，
// jsdom 也不会再注入。测试只需要一个内存实现。
if (typeof globalThis.localStorage === "undefined" || globalThis.localStorage === null) {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(key) { return store.has(key) ? store.get(key)! : null; },
    key(index) { return Array.from(store.keys())[index] ?? null; },
    removeItem(key) { store.delete(key); },
    setItem(key, value) { store.set(key, String(value)); },
  };
  Object.defineProperty(globalThis, "localStorage", { value: memoryStorage, configurable: true });
}

// jsdom 不实现 matchMedia，ECharts resize 用到；测试里直接打桩
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// ECharts 在 jsdom 下需要 canvas 相关 API
if (typeof window !== "undefined" && !window.HTMLCanvasElement.prototype.getContext) {
  window.HTMLCanvasElement.prototype.getContext = () => null as never;
}

// jsdom 不实现 ResizeObserver，EChart 初始化时需要
if (typeof window !== "undefined" && !window.ResizeObserver) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom 不实现 requestIdleCallback（浏览器 Chrome/iOS Safari≥17 均有），
// Layout 空闲预加载在测试环境需要此 polyfill。
if (typeof window !== "undefined" && !window.requestIdleCallback) {
  window.requestIdleCallback = ((cb: IdleRequestCallback) =>
    window.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0)) as unknown as typeof requestIdleCallback;
}
