import { InspectorService } from './inspector.service';
import type { TransactionBreakdown } from './inspector.service';
import { ConfigService } from '@nestjs/config';

function sampleBreakdown(): TransactionBreakdown {
  return {
    hash: 'a'.repeat(64),
    ledger: 1234,
    createdAt: '2026-08-31T12:00:00.000Z',
    sourceAccount: 'GSOURCE',
    sequenceNumber: '123',
    feeCharged: '300',
    maxFee: '300',
    memo: 'hello, world',
    memoType: 'text',
    timeBounds: null,
    signatures: [],
    success: true,
    resultCode: 'tx_success',
    resultExplanation: 'The transaction succeeded.',
    operationCount: 2,
    operations: [
      {
        index: 0,
        type: 'create_account',
        label: 'Create Account',
        fields: { destination: 'GDEST', startingBalance: '10 XLM' },
        sourceAccount: null,
        resultCode: 'op_success',
        resultExplanation: null,
        success: true,
        effects: [{ type: 'account_created', account: 'GDEST' }],
      },
      {
        index: 1,
        type: 'payment',
        label: 'Payment',
        fields: { destination: 'GDEST', amount: '5', asset: 'XLM' },
        sourceAccount: 'GSOURCE',
        resultCode: 'op_success',
        resultExplanation: null,
        success: true,
        effects: [],
      },
    ],
    rawJson: null,
    network: 'testnet',
    sorobanEvents: [],
    composerPayload: null,
  };
}

describe('InspectorService CSV export', () => {
  let service: InspectorService;

  beforeEach(() => {
    service = new InspectorService(new ConfigService());
  });

  it('prepends the UTF-8 BOM for Excel compatibility', () => {
    const csv = service.exportTransactionCsv(sampleBreakdown());
    expect(csv.startsWith('\uFEFF')).toBe(true);
  });

  it('emits a header row followed by one row per operation', () => {
    const csv = service.exportTransactionCsv(sampleBreakdown());
    const lines = csv.slice(1).trim().split('\n');
    expect(lines.length).toBe(3); // header + 2 operations
    expect(lines[0]).toContain('hash');
    expect(lines[0]).toContain('operation_fields');
  });

  it('repeats transaction-level fields on every operation row', () => {
    const csv = service.exportTransactionCsv(sampleBreakdown());
    const lines = csv.slice(1).trim().split('\n');
    expect(lines[1]).toContain('a'.repeat(64));
    expect(lines[1]).toContain('GSOURCE');
    expect(lines[1]).toContain('testnet');
    expect(lines[2]).toContain('a'.repeat(64));
  });

  it('escapes commas in memo text', () => {
    const csv = service.exportTransactionCsv(sampleBreakdown());
    expect(csv).toContain('"hello, world"');
  });

  it('yields a header + single empty row for a zero-operation transaction', () => {
    const breakdown = sampleBreakdown();
    breakdown.operations = [];
    const csv = service.exportTransactionCsv(breakdown);
    const lines = csv.slice(1).trim().split('\n');
    expect(lines.length).toBe(2);
  });
});
