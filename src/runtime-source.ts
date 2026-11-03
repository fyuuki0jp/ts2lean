import type { SourceSnapshot } from "./source-snapshot.js";

export interface FunctionSource {
  module: string;
  name: string;
  snapshot: SourceSnapshot;
  callees: () => Record<string, unknown>;
  captures?: () => Record<string, unknown>;
  receivers?: () => Record<string, unknown>;
}

export interface ObjectSource {
  module: string;
  name: string;
  snapshot: SourceSnapshot;
}

/** A module law applies to the methods present when its object was registered. */
export interface RegisteredObjectSource extends ObjectSource {
  methods: ReadonlyMap<string, unknown>;
}
