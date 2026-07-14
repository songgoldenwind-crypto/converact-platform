import { JSDOM } from 'jsdom';

export function installTestDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/'
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    Node: dom.window.Node,
    File: dom.window.File,
    Blob: dom.window.Blob,
    URL: dom.window.URL,
    IS_REACT_ACT_ENVIRONMENT: true
  })) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const request = (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0);
  const cancel = (handle: number) => dom.window.clearTimeout(handle);
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: Observer });
  Object.defineProperty(dom.window, 'ResizeObserver', { configurable: true, writable: true, value: Observer });
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, writable: true, value: request });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, writable: true, value: cancel });
  Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, writable: true, value: request });
  Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, writable: true, value: cancel });
  return () => dom.window.close();
}
