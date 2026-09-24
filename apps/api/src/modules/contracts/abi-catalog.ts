import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { decodeScVal } from './scval-decoder';
import {
  ABI_MAX_BYTES,
  AbiEvent,
  AbiEventTopic,
  AbiMethod,
  AbiMethodArg,
} from './dto/attach-abi.dto';

/** Soroban host types supported by the existing SCVal utilities. */
export const ABI_SUPPORTED_ARG_TYPES = [
  'Address',
  'Bool',
  'Bytes',
  'I32',
  'I64',
  'I128',
  'I256',
  'Symbol',
  'String',
  'U32',
  'U64',
  'U128',
  'U256',
] as const;

const MAX_METHOD_NAME_LENGTH = 64;
const MAX_ARGUMENTS = 32;
const MAX_TOPICS = 8;

export interface AbiCatalogEntry {
  id: string;
  contractId: string;
  wasmId?: string;
  network: 'testnet' | 'mainnet';
  name?: string;
  methods: AbiMethod[];
  events: AbiEvent[];
  attachedAt: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNoPrototypePollution(schema: unknown, path = 'schema'): void {
  if (Array.isArray(schema)) {
    for (let i = 0; i < schema.length; i++) {
      assertNoPrototypePollution(schema[i], `${path}[${i}]`);
    }
    return;
  }
  if (isPlainObject(schema)) {
    for (const [key, value] of Object.entries(schema)) {
      if (key === '__proto__') {
        throw new BadRequestException(`${path}.${key} is not allowed`);
      }
      assertNoPrototypePollution(value, `${path}.${key}`);
    }
  }
}

function normalizeType(type: string): string {
  const lower = type.trim().toLowerCase();
  const direct = ABI_SUPPORTED_ARG_TYPES.find((t) => t.toLowerCase() === lower);
  if (direct) return direct;

  if (/^option<.+>$/.test(lower)) return 'Option';
  if (lower === 'boolean') return 'Bool';
  if (lower.startsWith('bytes')) return 'Bytes';
  const intMatch = lower.match(/^(u|i)(32|64|128|256)$/);
  if (intMatch) return `${intMatch[1].toUpperCase()}${intMatch[2]}`;
  return type.trim();
}

function parseArg(raw: unknown, field: string): AbiMethodArg {
  if (!isPlainObject(raw)) {
    throw new BadRequestException(`${field} must be an object with name and type`);
  }
  const name = raw.name;
  const type = raw.type ?? raw.argType ?? raw.kind;
  if (typeof name !== 'string' || name.length === 0) {
    throw new BadRequestException(`${field}.name must be a non-empty string`);
  }
  if (typeof type !== 'string' || type.length === 0) {
    throw new BadRequestException(`${field}.type must be a non-empty string`);
  }
  return { name, type: normalizeType(type) };
}

function rawArgList(rawEntry: Record<string, unknown>): { array: unknown[]; field: string } | null {
  if (Array.isArray(rawEntry.args)) return { array: rawEntry.args, field: 'args' };
  if (Array.isArray(rawEntry.arguments)) return { array: rawEntry.arguments, field: 'arguments' };
  if (Array.isArray(rawEntry.params)) return { array: rawEntry.params, field: 'params' };
  if (Array.isArray(rawEntry.data)) return { array: rawEntry.data, field: 'data' };
  return null;
}

function assertSupportedTypes(method: AbiMethod, field: string, errors: Array<{ field: string; message: string }>): void {
  for (const arg of method.arguments) {
    const base = arg.type.replace(/^Option<|>$/g, '');
    if (!(ABI_SUPPORTED_ARG_TYPES as readonly string[]).includes(arg.type) && arg.type !== 'Option') {
      errors.push({
        field: `${field}.${arg.name}.type`,
        message: `unsupported type '${base}' for the existing SCVal utilities`,
      });
    }
  }
}

/**
 * Validate an ABI/interface document and produce stable method/event catalogs.
 * Field-level errors are collected so callers see every problem at once.
 */
export function buildAbiCatalog(
  contractId: string,
  rawSchema: unknown,
  options?: { wasmId?: string; network?: 'testnet' | 'mainnet'; name?: string },
): AbiCatalogEntry {
  const serialized = JSON.stringify(rawSchema ?? {});
  if (Buffer.byteLength(serialized, 'utf8') > ABI_MAX_BYTES) {
    throw new BadRequestException(
      `schema exceeds the maximum accepted size of ${ABI_MAX_BYTES} bytes`,
    );
  }

  if (!isPlainObject(rawSchema)) {
    throw new BadRequestException('schema must be a JSON object');
  }

  assertNoPrototypePollution(rawSchema);

  const errors: Array<{ field: string; message: string }> = [];

  const seenMethods = new Set<string>();
  const methods: AbiMethod[] = [];
  const rawMethods = rawSchema.methods ?? rawSchema.functions ?? [];
  if (!Array.isArray(rawMethods)) {
    errors.push({ field: 'schema.methods', message: 'must be an array' });
  } else {
    for (let i = 0; i < rawMethods.length; i++) {
      const field = `schema.methods[${i}]`;
      const rawMethod = rawMethods[i];
      if (!isPlainObject(rawMethod)) {
        errors.push({ field, message: 'must be an object' });
        continue;
      }

      const name = rawMethod.name;
      if (typeof name !== 'string' || name.length === 0) {
        errors.push({ field: `${field}.name`, message: 'must be a non-empty string' });
        continue;
      }
      if (name.length > MAX_METHOD_NAME_LENGTH) {
        errors.push({
          field: `${field}.name`,
          message: `exceeds the maximum length of ${MAX_METHOD_NAME_LENGTH}`,
        });
        continue;
      }
      if (seenMethods.has(name)) {
        errors.push({
          field: `${field}.name`,
          message: `duplicate method name '${name}'`,
        });
        continue;
      }
      seenMethods.add(name);

      const argList = rawArgList(rawMethod) ?? { array: [], field: 'arguments' };
      const argsField = `${field}.${argList.field}`;

      let parsedArgs: AbiMethodArg[];
      try {
        parsedArgs = argList.array.map((raw, j) => parseArg(raw, `${argsField}[${j}]`));
      } catch (err) {
        if (err instanceof BadRequestException) {
          const msg = err.message as string;
          errors.push({
            field: msg.match(/^(schema\.[^\s]+)/)?.[1] ?? argsField,
            message: msg.replace(/^schema\.[^\s]+\s*/, ''),
          });
          continue;
        }
        throw err;
      }

      if (parsedArgs.length > MAX_ARGUMENTS) {
        errors.push({
          field: argsField,
          message: `exceeds the maximum of ${MAX_ARGUMENTS} arguments`,
        });
        continue;
      }

      const method: AbiMethod = { name, arguments: parsedArgs, returnType: 'Void' };

      const returnTypeRaw = rawMethod.return ?? rawMethod.returns ?? rawMethod.returnType;
      if (typeof returnTypeRaw === 'string') {
        method.returnType = normalizeType(returnTypeRaw);
      }

      assertSupportedTypes(method, argsField, errors);
      methods.push(method);
    }
  }

  const seenEvents = new Set<string>();
  const events: AbiEvent[] = [];
  const rawEvents = rawSchema.events ?? [];
  if (!Array.isArray(rawEvents)) {
    errors.push({ field: 'schema.events', message: 'must be an array' });
  } else {
    for (let i = 0; i < rawEvents.length; i++) {
      const field = `schema.events[${i}]`;
      const rawEvent = rawEvents[i];
      if (!isPlainObject(rawEvent)) {
        errors.push({ field, message: 'must be an object' });
        continue;
      }

      const name = rawEvent.name ?? rawEvent.type;
      if (typeof name !== 'string' || name.length === 0) {
        errors.push({ field: `${field}.name`, message: 'must be a non-empty string' });
        continue;
      }
      if (seenEvents.has(name)) {
        errors.push({
          field: `${field}.name`,
          message: `duplicate event name '${name}'`,
        });
        continue;
      }
      seenEvents.add(name);

      const argList = rawArgList(rawEvent) ?? { array: [], field: 'arguments' };
      const argsField = `${field}.${argList.field}`;

      let parsedArgs: AbiMethodArg[];
      try {
        parsedArgs = argList.array.map((raw, j) => parseArg(raw, `${argsField}[${j}]`));
      } catch (err) {
        if (err instanceof BadRequestException) {
          const msg = err.message as string;
          errors.push({
            field: msg.match(/^(schema\.[^\s]+)/)?.[1] ?? argsField,
            message: msg.replace(/^schema\.[^\s]+\s*/, ''),
          });
          continue;
        }
        throw err;
      }

      const rawTopics = Array.isArray(rawEvent.topics) ? rawEvent.topics : [];
      const topics: AbiEventTopic[] = [];
      for (let j = 0; j < Math.min(rawTopics.length, MAX_TOPICS); j++) {
        const t = rawTopics[j];
        if (isPlainObject(t) && typeof t.name === 'string') {
          topics.push({ name: t.name, indexed: Boolean(t.indexed) });
        } else {
          errors.push({
            field: `${field}.topics[${j}]`,
            message: 'must be an object with a name',
          });
        }
      }

      events.push({ name, arguments: parsedArgs, topics });
    }
  }

  if (errors.length > 0) {
    throw new UnprocessableEntityException({
      message: 'ABI document failed validation',
      errors,
    });
  }

  return {
    id: `${contractId}:${options?.wasmId ?? 'default'}`,
    contractId,
    wasmId: options?.wasmId,
    network: options?.network ?? 'testnet',
    name: options?.name,
    methods,
    events,
    attachedAt: new Date().toISOString(),
  };
}

/**
 * Encode a declared-argument value with the existing SCVal utilities.
 * Integer values arrive as decimal strings and are converted with BigInt so
 * no value is ever routed through binary floating point.
 */
export function encodeAbiArgument(
  type: string,
  value: unknown,
): { xdrBase64: string; decoded: { type: string; value: unknown } } {
  const normalized = normalizeType(type);
  let scVal: xdr.ScVal;

  switch (normalized) {
    case 'U32':
    case 'U64':
    case 'U128':
    case 'U256':
    case 'I32':
    case 'I64':
    case 'I128':
    case 'I256': {
      const sign = normalized.startsWith('I') ? 'i' : 'u';
      const bits = normalized.replace(/^[UI]/, '');
      scVal = nativeToScVal(BigInt(String(value)), {
        type: `${sign}${bits}` as 'u64',
      });
      break;
    }
    case 'Bool':
      scVal = nativeToScVal(Boolean(value), { type: 'bool' });
      break;
    case 'Symbol':
      scVal = nativeToScVal(String(value), { type: 'symbol' });
      break;
    case 'String':
      scVal = nativeToScVal(String(value), { type: 'string' });
      break;
    case 'Bytes':
      scVal = nativeToScVal(
        Buffer.from(String(value).replace(/^0x/, ''), 'hex'),
        { type: 'bytes' },
      );
      break;
    case 'Address':
      scVal = new Address(String(value)).toScVal();
      break;
    default:
      throw new BadRequestException(
        `Unsupported argument type '${type}' for SCVal encoding`,
      );
  }

  return { xdrBase64: scVal.toXDR('base64'), decoded: decodeScVal(scVal) };
}
