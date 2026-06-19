import '@testing-library/jest-dom';

// Polyfill IntersectionObserver for framer-motion whileInView
class MockIntersectionObserver {
  readonly root: Element | null = null;
  readonly rootMargin: string = '';
  readonly thresholds: ReadonlyArray<number> = [];
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: MockIntersectionObserver,
});

Object.defineProperty(global, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: MockIntersectionObserver,
});

// Polyfill ResizeObserver (sometimes needed by motion)
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  configurable: true,
  value: MockResizeObserver,
});

Object.defineProperty(global, 'ResizeObserver', {
  writable: true,
  configurable: true,
  value: MockResizeObserver,
});
