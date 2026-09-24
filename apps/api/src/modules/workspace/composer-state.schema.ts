/**
 * Validates persisted composer workspace payloads on import.
 * Returns `null` when valid, or a human-readable error message.
 */
export const ComposerStateSchema = {
  validate(data: unknown): string | null {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return 'composer state must be an object';
    }

    const state = data as Record<string, unknown>;

    if (state.sourceAccount !== undefined && typeof state.sourceAccount !== 'string') {
      return 'sourceAccount must be a string';
    }

    if (state.memo !== undefined && typeof state.memo !== 'string') {
      return 'memo must be a string';
    }

    if (state.operations !== undefined) {
      if (!Array.isArray(state.operations)) {
        return 'operations must be an array';
      }
      for (const [index, op] of state.operations.entries()) {
        if (!op || typeof op !== 'object' || Array.isArray(op)) {
          return `operations[${index}] must be an object`;
        }
        const operation = op as Record<string, unknown>;
        if (typeof operation.type !== 'string' || operation.type.length === 0) {
          return `operations[${index}].type must be a non-empty string`;
        }
        if (
          operation.fields !== undefined &&
          (typeof operation.fields !== 'object' || operation.fields === null || Array.isArray(operation.fields))
        ) {
          return `operations[${index}].fields must be an object`;
        }
      }
    }

    return null;
  },
};
