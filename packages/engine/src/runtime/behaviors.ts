interface BehaviorRecord {
  definition: any;
  filter?: (definition: any) => void;
}

const behaviors = new Map<string, BehaviorRecord>();
behaviors.set('wx://form-field', { definition: { properties: { name: String, value: { type: null } } } });
behaviors.set('wx://form-field-group', { definition: {} });
behaviors.set('wx://form-field-button', { definition: {} });
let sequence = 0;

function snapshot(value: any): any {
  if (Array.isArray(value)) return value.map(snapshot);
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)]));
  }
  return value;
}

function inheritedFilters(definition: any) {
  return Array.from(new Set(definition.behaviors ?? [])).flatMap(id => {
    const filter = typeof id === 'string' ? behaviors.get(id)?.filter : undefined;
    return filter ? [filter] : [];
  });
}

export function filterDefinition(definition: any) {
  for (const filter of inheritedFilters(definition)) filter(definition);
}

export function registerBehavior(definition: any): string {
  const inherited = inheritedFilters(definition);
  for (const filter of inherited) filter(definition);
  const stored = snapshot(definition);
  const id = `fmp-behavior-${++sequence}`;
  behaviors.set(id, {
    definition: stored,
    filter: typeof stored.definitionFilter === 'function' ? target => stored.definitionFilter(target, inherited) : undefined
  });
  return id;
}

export function resolveBehavior(value: any) {
  return typeof value === 'string' ? behaviors.get(value)?.definition : value;
}
