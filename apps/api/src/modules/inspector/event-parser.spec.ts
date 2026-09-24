import { nativeToScVal, StrKey, xdr } from '@stellar/stellar-sdk';
import {
  decodeContractEvent,
  filterSorobanEvents,
  groupSorobanEventsByContract,
  parseSorobanEventsFromMeta,
  WELL_KNOWN_TOPIC_NAMES,
} from './event-parser';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

/** Well-known genesis / friendbot-style accounts (valid StrKey). */
const ACCOUNT_A = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const ACCOUNT_B = 'GALPCCZN4YXA3YMJHKL6CVIECKPLJJCTVMSNYWBTKJW4K5HQLYLDMZTB';

function accountScVal(accountId: string): xdr.ScVal {
  return nativeToScVal(accountId, { type: 'address' });
}

function contractEventBody(v0: xdr.ContractEventV0): xdr.ContractEventBody {
  return new (xdr.ContractEventBody as unknown as {
    new (switchValue: number, value: xdr.ContractEventV0): xdr.ContractEventBody;
  })(0, v0);
}

function extensionPoint(): xdr.ExtensionPoint {
  return new (xdr.ExtensionPoint as unknown as {
    new (switchValue: number): xdr.ExtensionPoint;
  })(0);
}

function sorobanMetaExt(): xdr.SorobanTransactionMetaExt {
  return new (xdr.SorobanTransactionMetaExt as unknown as {
    new (switchValue: number): xdr.SorobanTransactionMetaExt;
  })(0);
}

function transactionMetaV3(value: xdr.TransactionMetaV3): xdr.TransactionMeta {
  return new (xdr.TransactionMeta as unknown as {
    new (switchValue: number, value: xdr.TransactionMetaV3): xdr.TransactionMeta;
  })(3, value);
}

function makeTransferEvent(): xdr.ContractEvent {
  const topics = [
    nativeToScVal('transfer', { type: 'symbol' }),
    accountScVal(ACCOUNT_A),
    accountScVal(ACCOUNT_B),
  ];
  const data = nativeToScVal(1_000_000n, { type: 'i128' });
  const body = contractEventBody(new xdr.ContractEventV0({ topics, data }));
  return new xdr.ContractEvent({
    ext: extensionPoint(),
    contractId: StrKey.decodeContract(CONTRACT_ID),
    type: xdr.ContractEventType.contract(),
    body,
  });
}

function makeUnknownTopicEvent(): xdr.ContractEvent {
  const topics = [nativeToScVal(Buffer.from('deadbeef', 'hex'), { type: 'bytes' })];
  const data = nativeToScVal(true);
  const body = contractEventBody(new xdr.ContractEventV0({ topics, data }));
  return new xdr.ContractEvent({
    ext: extensionPoint(),
    contractId: StrKey.decodeContract(CONTRACT_ID),
    type: xdr.ContractEventType.contract(),
    body,
  });
}

function makeNestedContainerEvent(): xdr.ContractEvent {
  const vec = xdr.ScVal.scvVec([
    nativeToScVal(1, { type: 'u32' }),
    nativeToScVal('nested', { type: 'string' }),
    nativeToScVal({ k: 'v' }),
  ]);
  const body = contractEventBody(
    new xdr.ContractEventV0({
      topics: [nativeToScVal('swap', { type: 'symbol' })],
      data: vec,
    }),
  );
  return new xdr.ContractEvent({
    ext: extensionPoint(),
    contractId: StrKey.decodeContract(CONTRACT_ID),
    type: xdr.ContractEventType.contract(),
    body,
  });
}

function wrapInMeta(events: xdr.ContractEvent[]): string {
  const soroban = new xdr.SorobanTransactionMeta({
    ext: sorobanMetaExt(),
    returnValue: xdr.ScVal.scvVoid(),
    events,
    diagnosticEvents: [],
  });
  const metaV3 = new xdr.TransactionMetaV3({
    ext: extensionPoint(),
    txChangesBefore: [],
    operations: [],
    txChangesAfter: [],
    sorobanMeta: soroban,
  });
  return transactionMetaV3(metaV3).toXDR('base64');
}

describe('event-parser', () => {
  describe('scalar decode', () => {
    it('decodes a transfer event with well-known topic name and typed args', () => {
      const decoded = decodeContractEvent(makeTransferEvent(), 0, true);
      expect(decoded.contractId).toBe(CONTRACT_ID);
      expect(decoded.eventName).toBe(WELL_KNOWN_TOPIC_NAMES.transfer);
      expect(decoded.type).toBe('contract');
      expect(decoded.topics).toHaveLength(3);
      expect(decoded.topics[0]!.friendlyName).toBe('Transfer');
      expect(decoded.data?.type).toMatch(/scvI128/i);
      expect(decoded.data?.value).toBe('1000000');
      expect(decoded.signature).toMatch(/^Transfer\(/);
      expect(decoded.inSuccessfulContractCall).toBe(true);
      expect(decoded.partial).toBe(false);
    });
  });

  describe('container decode', () => {
    it('decodes nested Vec/Map data without throwing', () => {
      const decoded = decodeContractEvent(makeNestedContainerEvent(), 1);
      expect(decoded.eventName).toBe('Swap');
      expect(decoded.data?.type).toMatch(/scvVec/i);
      expect(Array.isArray(decoded.data?.value)).toBe(true);
      const items = decoded.data!.value as Array<{ type: string }>;
      expect(items.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('unknown topic fallback', () => {
    it('leaves friendlyName null and keeps raw hex for unknown topics', () => {
      const decoded = decodeContractEvent(makeUnknownTopicEvent(), 2);
      expect(decoded.eventName).toBeNull();
      expect(decoded.topics[0]!.friendlyName).toBeNull();
      expect(decoded.topics[0]!.rawHex.length).toBeGreaterThan(0);
      expect(decoded.topics[0]!.rawHex).toMatch(/deadbeef/i);
    });
  });

  describe('parseSorobanEventsFromMeta', () => {
    it('extracts events from TransactionMeta v3', () => {
      const xdrB64 = wrapInMeta([makeTransferEvent(), makeUnknownTopicEvent()]);
      const events = parseSorobanEventsFromMeta(xdrB64);
      expect(events).toHaveLength(2);
      expect(events[0]!.eventName).toBe('Transfer');
      expect(events[1]!.eventName).toBeNull();
    });

    it('returns [] for empty / invalid meta (graceful)', () => {
      expect(parseSorobanEventsFromMeta(null)).toEqual([]);
      expect(parseSorobanEventsFromMeta('')).toEqual([]);
      expect(parseSorobanEventsFromMeta('!!!not-xdr!!!')).toEqual([]);
    });
  });

  describe('filter', () => {
    it('filters by contract ID and event name', () => {
      const events = [
        decodeContractEvent(makeTransferEvent(), 0),
        decodeContractEvent(makeNestedContainerEvent(), 1),
      ];
      expect(filterSorobanEvents(events, { eventName: 'transfer' })).toHaveLength(1);
      expect(filterSorobanEvents(events, { eventName: 'swap' })).toHaveLength(1);
      expect(filterSorobanEvents(events, { contractId: CONTRACT_ID.slice(0, 8) })).toHaveLength(2);
      expect(filterSorobanEvents(events, { contractId: 'CNOPE' })).toHaveLength(0);
    });
  });

  describe('group by contract', () => {
    it('groups events by emitting contract', () => {
      const events = [
        decodeContractEvent(makeTransferEvent(), 0),
        decodeContractEvent(makeNestedContainerEvent(), 1),
      ];
      const grouped = groupSorobanEventsByContract(events);
      expect(grouped).toHaveLength(1);
      expect(grouped[0]!.contractId).toBe(CONTRACT_ID);
      expect(grouped[0]!.events).toHaveLength(2);
    });
  });
});
