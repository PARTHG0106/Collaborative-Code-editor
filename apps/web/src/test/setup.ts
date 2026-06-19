import '@testing-library/jest-dom';

class IntersectionObserverMock {
  readonly root: Element | null = null;
  readonly rootMargin: string = '';
  readonly thresholds: ReadonlyArray<number> = [];
  
  constructor() {}
  
  disconnect() {}
  observe() {}
  takeRecords() { return []; }
  unobserve() {}
}

global.IntersectionObserver = IntersectionObserverMock as any;
