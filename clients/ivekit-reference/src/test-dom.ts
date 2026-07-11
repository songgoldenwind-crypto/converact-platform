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
  return () => dom.window.close();
}
