type Action = ((context: CanvasRenderingContext2D) => void | Promise<void>) & { snapshot?(): Action };

interface CanvasRenderer {
  submit(canvas: HTMLCanvasElement, actions: Action[], reserve: boolean, callback?: () => void): void;
  image(source: string, canvas: HTMLCanvasElement): Promise<HTMLImageElement>;
  export(options: any): Promise<any>;
}

export function createLegacyCanvas(canvas: () => HTMLCanvasElement | null, renderer: CanvasRenderer): any {
  const preview = document.createElement('canvas').getContext('2d')!;
  const patterns = new WeakMap<object, { source: string; repetition: string }>();
  const gradients = new WeakMap<object, { circular: boolean; coordinates: number[]; stops: Array<[number, string]> }>();
  let actions: Action[] = [];
  const assign = (key: string, value: any) => {
    const gradient = value && typeof value === 'object' ? gradients.get(value) : undefined;
    if (gradient && (key === 'fillStyle' || key === 'strokeStyle')) {
      const action: Action = () => {};
      action.snapshot = () => {
        const stops = gradient.stops.map(stop => [...stop] as [number, string]);
        return context => {
          const native = gradient.circular
            ? context.createRadialGradient(...(gradient.coordinates as [number, number, number, number, number, number]))
            : context.createLinearGradient(...(gradient.coordinates as [number, number, number, number]));
          for (const [offset, color] of stops) native.addColorStop(offset, color);
          context[key] = native;
        };
      };
      actions.push(action);
      return;
    }
    const pattern = value && typeof value === 'object' ? patterns.get(value) : undefined;
    if (pattern && (key === 'fillStyle' || key === 'strokeStyle')) {
      actions.push(async context => {
        const image = await renderer.image(pattern.source, context.canvas);
        context[key] = context.createPattern(image, pattern.repetition)!;
      });
      return;
    }
    (preview as any)[key] = value;
    actions.push(context => {
      (context as any)[key] = value;
    });
  };
  const setters: Record<string, string> = {
    setFillStyle: 'fillStyle',
    setStrokeStyle: 'strokeStyle',
    setLineWidth: 'lineWidth',
    setLineCap: 'lineCap',
    setLineJoin: 'lineJoin',
    setMiterLimit: 'miterLimit',
    setTextAlign: 'textAlign',
    setTextBaseline: 'textBaseline',
    setGlobalAlpha: 'globalAlpha',
    setGlobalCompositeOperation: 'globalCompositeOperation'
  };
  const createGradient = (circular: boolean, coordinates: number[]) => {
    const native = circular
      ? preview.createRadialGradient(...(coordinates as [number, number, number, number, number, number]))
      : preview.createLinearGradient(...(coordinates as [number, number, number, number]));
    const stops: Array<[number, string]> = [];
    const value = {
      addColorStop(offset: number, color: string) {
        native.addColorStop(offset, color);
        stops.push([offset, color]);
      }
    };
    gradients.set(value, { circular, coordinates, stops });
    return value;
  };
  return new Proxy(
    {},
    {
      get(_target, key: string) {
        if (key === 'canvas') return canvas();
        if (key === 'draw')
          return (reserve = false, callback?: () => void) => {
            const batch = actions.map(action => (action.snapshot ? action.snapshot() : action));
            actions = [];
            const target = canvas();
            if (target) renderer.submit(target, batch, !!reserve, callback);
          };
        if (setters[key]) return (value: any) => assign(setters[key], value);
        if (key === 'setFontSize')
          return (value: number) => {
            const family = /px\s+(.+)$/.exec(preview.font)?.[1] ?? 'sans-serif';
            assign('font', `${Number(value) || 16}px ${family}`);
          };
        if (key === 'setShadow')
          return (x = 0, y = 0, blur = 0, color = 'transparent') => {
            assign('shadowOffsetX', x);
            assign('shadowOffsetY', y);
            assign('shadowBlur', blur);
            assign('shadowColor', color);
          };
        if (key === 'setLineDash')
          return (pattern: number[] = [], offset = 0) => {
            const copy = pattern.slice();
            preview.setLineDash(copy);
            assign('lineDashOffset', offset);
            actions.push(context => context.setLineDash(copy));
          };
        if (key === 'createLinearGradient')
          return (x0: number, y0: number, x1: number, y1: number) => createGradient(false, [x0, y0, x1, y1]);
        if (key === 'createCircularGradient')
          return (x: number, y: number, radius: number) => createGradient(true, [x, y, 0, x, y, radius]);
        if (key === 'createPattern')
          return (source: string, repetition: string) => {
            const pattern = {};
            patterns.set(pattern, { source, repetition });
            return pattern;
          };
        if (key === 'drawImage')
          return (source: any, ...coordinates: number[]) => {
            actions.push(async context => {
              const image = typeof source === 'string' ? await renderer.image(source, context.canvas) : (source?.__image ?? source);
              context.drawImage(image, ...(coordinates as [number, number]));
            });
          };
        if (key === 'measureText')
          return (text: string) => {
            return { width: preview.measureText(text).width };
          };
        if (key === 'getImageData')
          return (...args: [number, number, number, number]) =>
            canvas()
              ?.getContext('2d')!
              .getImageData(...args);
        if (key === 'toTempFilePath') return renderer.export;
        const value = (preview as any)[key];
        if (typeof value === 'function')
          return (...args: any[]) => {
            const copy = args.map(value => (Array.isArray(value) ? value.slice() : value));
            actions.push(context => {
              (context as any)[key](...copy);
            });
          };
        return key === 'font' ? preview.font : undefined;
      },
      set(_target, key: string, value: any) {
        assign(key, value);
        return true;
      }
    }
  );
}
