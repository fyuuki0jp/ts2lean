/** Immutable compilation inputs attached to a loaded module instance. */
export interface SourceSnapshot {
  readonly id: string;
  readonly root: string;
  readonly files: Readonly<Record<string, string>>;
  readonly roots: readonly string[];
  readonly resolutions: readonly {
    readonly directory: string;
    readonly name: string;
    readonly mode: number;
    readonly file?: string;
  }[];
  readonly specs: readonly string[];
  readonly lean: Readonly<Record<string, string>>;
}
