export function invoke(instance: any, callback: unknown, args: any[] = [], componentError = true): any {
  if (typeof callback !== 'function') return;
  try {
    return callback.apply(instance, args);
  } catch (error) {
    if (instance?.__handleError) instance.__handleError(error, componentError);
    else console.error('[fmp-engine] 回调出错', error);
  }
}
