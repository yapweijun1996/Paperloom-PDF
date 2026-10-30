import { PDFArray, PDFDict, PDFName, PDFRef, type PDFObject } from '../types';

/** The viewer cannot safely determine whether optional content should be shown. */
export class OptionalContentError extends Error {
  constructor(reason: string) { super(`Cannot determine optional content visibility: ${reason}`); this.name = 'OptionalContentError'; }
}

/** Resolve the initial View state, including membership policies and expressions. */
export class OptionalContentVisibility {
  private readonly states = new Map<PDFDict, boolean>();
  private readonly intents: string[];
  private readonly baseState: boolean;
  private readonly hasConfiguration: boolean;
  private readonly hasContext: boolean;

  constructor(catalog: PDFDict | undefined, private readonly objects: Map<string, PDFObject>) {
    this.hasContext = !!catalog;
    if (!catalog) { this.hasConfiguration = false; this.baseState = true; this.intents = ['View']; return; }
    const raw = catalog.get('OCProperties');
    if (!raw) { this.hasConfiguration = false; this.baseState = true; this.intents = ['View']; return; }
    this.hasConfiguration = true;
    const properties = this.dict(raw, 'OCProperties');
    const rawGroups = properties.get('OCGs');
    const groups = rawGroups ? this.array(rawGroups, 'OCGs').items.map(item => this.group(item)) : [];
    const defaultEntry = properties.get('D');
    const config = defaultEntry ? this.dict(defaultEntry, 'default configuration') : new PDFDict();
    const base = this.name(config.get('BaseState'), 'BaseState') ?? 'ON';
    if (!['ON', 'OFF', 'Unchanged'].includes(base)) throw new OptionalContentError('invalid BaseState');
    this.baseState = base !== 'OFF';
    this.intents = this.names(config.get('Intent'), ['View']);
    for (const group of groups) this.states.set(group, this.baseState);
    for (const [key, state] of [['ON', true], ['OFF', false]] as const) {
      const entry = config.get(key);
      if (entry) for (const item of this.array(entry, key).items) {
        const group = this.group(item);
        if (!this.states.has(group)) throw new OptionalContentError('group is not registered');
        this.states.set(group, state);
      }
    }
    const applications = config.get('AS');
    if (applications) for (const application of this.array(applications, 'AS').items) {
      const rule = this.dict(application, 'usage application');
      if (this.name(rule.get('Event'), 'usage event') !== 'View') continue;
      const categories = this.names(rule.get('Category'), []);
      if (categories.some(category => category !== 'View')) throw new OptionalContentError('unsupported View usage category');
      if (!categories.includes('View')) continue;
      const affected = rule.get('OCGs');
      if (!affected) continue;
      for (const value of this.array(affected, 'usage OCGs').items) {
        const group = this.group(value);
        if (!this.states.has(group)) throw new OptionalContentError('group is not registered');
        const usageEntry = group.get('Usage');
        if (!usageEntry) continue;
        const viewEntry = this.dict(usageEntry, 'usage').get('View');
        if (!viewEntry) continue;
        const viewState = this.name(this.dict(viewEntry, 'View usage').get('ViewState'), 'ViewState');
        if (viewState === 'ON' || viewState === 'OFF') this.states.set(group, viewState === 'ON');
        else if (viewState) throw new OptionalContentError('invalid ViewState');
      }
    }
  }

  /** Layer-sensitive masks must not be reused after the configuration changes. */
  get canCacheMasks(): boolean { return this.hasContext && !this.hasConfiguration; }

  private resolve(value: PDFObject | undefined): PDFObject | undefined {
    const seen = new Set<string>();
    while (value instanceof PDFRef) {
      const key = value.toKey();
      if (seen.has(key) || seen.size >= 1000) throw new OptionalContentError('cyclic reference');
      seen.add(key);
      value = this.objects.get(key);
      if (!value) throw new OptionalContentError('unresolved reference');
    }
    return value;
  }
  private dict(value: PDFObject | undefined, label: string): PDFDict {
    const result = this.resolve(value);
    if (!(result instanceof PDFDict)) throw new OptionalContentError(`invalid ${label}`);
    return result;
  }
  private array(value: PDFObject | undefined, label: string): PDFArray {
    const result = this.resolve(value);
    if (!(result instanceof PDFArray)) throw new OptionalContentError(`invalid ${label}`);
    return result;
  }
  private name(value: PDFObject | undefined, label: string): string | undefined {
    if (!value) return undefined;
    const result = this.resolve(value);
    if (!(result instanceof PDFName)) throw new OptionalContentError(`invalid ${label}`);
    return result.name;
  }
  private names(value: PDFObject | undefined, fallback: string[]): string[] {
    if (!value) return fallback;
    const result = this.resolve(value);
    if (result instanceof PDFName) return [result.name];
    if (result instanceof PDFArray) return result.items.map(item => this.name(item, 'intent or category')!);
    throw new OptionalContentError('invalid name array');
  }
  private group(value: PDFObject): PDFDict {
    const group = this.dict(value, 'group');
    if (group.getName('Type') !== 'OCG') throw new OptionalContentError('invalid group type');
    return group;
  }
  private groupVisible(group: PDFDict): boolean {
    if (!this.states.has(group)) throw new OptionalContentError('group is not registered');
    const groupIntents = this.names(group.get('Intent'), ['View']);
    if (!groupIntents.includes('All') && !this.intents.includes('All') && !groupIntents.some(intent => this.intents.includes(intent))) return true;
    return this.states.get(group) ?? this.baseState;
  }
  private expression(
    value: PDFObject, active: Set<PDFArray>, memo: Map<PDFArray, boolean>,
    budget: { remaining: number }, depth: number,
  ): boolean {
    if (--budget.remaining < 0) throw new OptionalContentError('expression size limit');
    if (depth > 100) throw new OptionalContentError('expression nesting limit');
    const node = this.resolve(value);
    if (node instanceof PDFDict) return this.groupVisible(this.group(node));
    if (!(node instanceof PDFArray) || active.has(node)) throw new OptionalContentError('invalid or cyclic expression');
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    active.add(node);
    try {
      const operator = this.name(node.items[0], 'expression operator');
      const args = node.items.slice(1);
      if ((operator === 'Not' && args.length !== 1) || ((operator === 'And' || operator === 'Or') && args.length < 2)) throw new OptionalContentError('invalid expression arity');
      if (operator !== 'Not' && operator !== 'And' && operator !== 'Or') throw new OptionalContentError('unsupported expression operator');
      // Validate every operand even when the Boolean result could short-circuit;
      // an unresolved operand must not turn malformed membership into visibility.
      const states = args.map(item => this.expression(item, active, memo, budget, depth + 1));
      const result = operator === 'Not' ? !states[0] : operator === 'And' ? states.every(Boolean) : states.some(Boolean);
      memo.set(node, result);
      return result;
    } finally { active.delete(node); }
  }
  isVisible(value: PDFObject | undefined): boolean {
    if (!this.hasContext) throw new OptionalContentError('document catalog is required');
    if (!value) throw new OptionalContentError('missing membership');
    if (!this.hasConfiguration) return true;
    const object = this.dict(value, 'membership');
    const type = object.getName('Type');
    if (type === 'OCG') return this.groupVisible(object);
    if (type !== 'OCMD') throw new OptionalContentError('unsupported membership type');
    const expression = object.get('VE');
    if (expression) return this.expression(expression, new Set(), new Map(), { remaining: 100_000 }, 0);
    const entry = object.get('OCGs');
    if (!entry) return true;
    const groups = this.resolve(entry);
    const values = groups instanceof PDFArray ? groups.items : groups ? [groups] : [];
    if (!values.length) return true;
    const states = values.map(value => this.groupVisible(this.group(value)));
    const policy = this.name(object.get('P'), 'membership policy') ?? 'AnyOn';
    if (policy === 'AnyOn') return states.some(Boolean);
    if (policy === 'AllOn') return states.every(Boolean);
    if (policy === 'AnyOff') return states.some(state => !state);
    if (policy === 'AllOff') return states.every(state => !state);
    throw new OptionalContentError('unsupported membership policy');
  }
}
