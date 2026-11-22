import { RenderRange } from './range';

interface SlotSource {
  node: RenderRange;
  name: string;
  anchor: Comment;
}
interface SlotOutlet {
  node: RenderRange;
  name: string;
  multiple: boolean;
}

export const slotProjections = new WeakMap<Element, SlotProjection>();

export class SlotProjection {
  private sources: SlotSource[] = [];
  private outlets: SlotOutlet[] = [];

  add(node: RenderRange, name: string, anchor: Comment) {
    const source = { node, name, anchor };
    this.sources.push(source);
    this.distribute();
    return source;
  }

  rename(source: SlotSource, name: string) {
    source.name = name;
    this.distribute();
  }

  remove(source: SlotSource) {
    source.node.remove();
    this.sources = this.sources.filter(item => item !== source);
    this.distribute();
  }

  refresh() {
    this.distribute();
  }

  outlet(node: RenderRange, name: string, multiple: boolean) {
    const outlet = { node, name, multiple };
    this.outlets.push(outlet);
    this.distribute();
    return () => {
      this.outlets = this.outlets.filter(item => item !== outlet);
      this.distribute();
    };
  }

  private distribute() {
    this.sources.sort((a, b) => {
      const position = a.anchor.compareDocumentPosition(b.anchor);
      return position & Node.DOCUMENT_POSITION_DISCONNECTED
        ? 0
        : position & Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : position & Node.DOCUMENT_POSITION_PRECEDING
            ? 1
            : 0;
    });
    const assigned = new Map<SlotOutlet, SlotSource[]>();
    for (const source of this.sources) {
      const outlet = this.outlets.find(outlet => (outlet.multiple ? outlet.name === source.name : !outlet.name));
      if (!outlet) source.node.remove();
      else {
        const sources = assigned.get(outlet) ?? [];
        sources.push(source);
        assigned.set(outlet, sources);
      }
    }
    for (const [outlet, sources] of assigned) {
      let cursor: Node = outlet.node.end;
      for (const source of sources.slice().reverse()) {
        source.node.move(outlet.node, cursor);
        cursor = source.node.start;
      }
    }
  }

  dispose() {
    for (const source of this.sources) source.node.remove();
    this.sources = [];
    this.outlets = [];
  }
}
