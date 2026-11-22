export function normalizeSize(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return 0;
  const unit = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fmp-rpx')) || 0.5;
  const pixels = value.replace(/[+-]?\d+(?:\.\d+)?rpx/g, token => {
    const rpx = parseFloat(token);
    const magnitude = rpx === 0 ? 0 : Math.max(1, Math.floor(Math.abs(rpx) * unit + 1e-4));
    return `${rpx < 0 ? -magnitude : magnitude}px`;
  });
  const number = /[+-]?\d+(?:\.\d+)?px/.test(pixels) ? parseFloat(pixels) : Number(pixels);
  return Number.isNaN(number) ? 0 : number;
}

export function pageRect(rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>, page: Element | null) {
  const base = page?.getBoundingClientRect();
  const scaleX = base?.width && page?.clientWidth ? base.width / page.clientWidth : 1;
  const scaleY = base?.height && page?.clientHeight ? base.height / page.clientHeight : 1;
  return {
    left: (rect.left - (base?.left ?? 0)) / scaleX,
    top: (rect.top - (base?.top ?? 0)) / scaleY,
    right: (rect.right - (base?.left ?? 0)) / scaleX,
    bottom: (rect.bottom - (base?.top ?? 0)) / scaleY,
    width: rect.width / scaleX,
    height: rect.height / scaleY
  };
}
