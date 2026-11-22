import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs' with { type: 'text' };

export async function showDocument(overlay: HTMLElement, blob: Blob, name: string, register: (close: () => void) => () => void) {
  const layer = document.createElement('div');
  layer.className = 'fmp-document';
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-label', '文档查看');
  const header = document.createElement('header');
  const title = document.createElement('span');
  title.textContent = name;
  const dismiss = document.createElement('button');
  dismiss.textContent = '关闭';
  const body = document.createElement('div');
  body.className = 'fmp-document-body';
  header.append(title, dismiss);
  layer.append(header, body);
  overlay.appendChild(layer);
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  GlobalWorkerOptions.workerSrc = workerUrl;
  const loading = getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false });
  let closed = false;
  let unregister = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    layer.remove();
    unregister();
    void loading.destroy();
    URL.revokeObjectURL(workerUrl);
  };
  dismiss.addEventListener('click', close);
  unregister = register(close);
  try {
    const document = await loading.promise;
    for (let number = 1; number <= document.numPages && !closed; number++) {
      const page = await document.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1.5, (body.clientWidth - 24) / base.width) });
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d')!;
      const text = window.document.createElement('div');
      text.className = 'fmp-document-text';
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item) || !item.str) continue;
        const line = window.document.createElement('p');
        line.textContent = item.str;
        text.appendChild(line);
      }
      body.append(canvas, text);
      await page.render({ canvasContext: context, canvas, viewport }).promise;
    }
    if (closed) throw new Error('document closed');
    return close;
  } catch (error) {
    close();
    throw error;
  }
}
