// Runtime metadata stays outside serialised state. QuickJS can retain dead
// weak-map entries until GC, so frame-local ownership entries have an explicit
// lifetime. Nested folds own separate scopes, including exceptional exits.
interface DeletableMetadata { delete(key: object): boolean }
interface MetadataScope {
  parent: MetadataScope | null;
  maps?: DeletableMetadata[];
  keys?: object[];
}
let currentScope: MetadataScope | null = null;

export function beginStateMetadata(): MetadataScope {
  const scope: MetadataScope = { parent: currentScope };
  currentScope = scope;
  return scope;
}

export function trackStateMetadata(map: DeletableMetadata, key: object): void {
  if (!currentScope) return;
  (currentScope.maps ??= []).push(map);
  (currentScope.keys ??= []).push(key);
}

export function endStateMetadata(scope: MetadataScope): void {
  currentScope = scope.parent;
  const maps = scope.maps;
  if (maps === undefined) return;
  const keys = scope.keys!;
  for (let i = 0; i < maps.length; i++) maps[i]!.delete(keys[i]!);
}

/** Eviction only invalidates a derived revision cache; it never owns state.
 * Strong keys bound retention without leaving weak-entry tombstones each frame. */
export class RecentStateMetadata<K extends object, V> {
  private readonly values = new Map<K, V>();
  private readonly keys: K[] = [];
  private cursor = 0;
  get(key: K): V | undefined { return this.values.get(key); }
  set(key: K, value: V): void {
    if (!this.values.has(key)) {
      const previous = this.keys[this.cursor];
      if (previous) this.values.delete(previous);
      this.keys[this.cursor] = key;
      this.cursor = (this.cursor + 1) % 16;
    }
    this.values.set(key, value);
  }
}
