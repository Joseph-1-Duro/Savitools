'use client';

import { PreconditionsInput } from '@/lib/composer-api';

export type PreconditionKind = 'none' | 'time_bounds' | 'ledger_bounds' | 'min_sequence';

export type PreconditionFields = Record<string, string>;

export const DEFAULT_PRECONDITION_FIELDS: PreconditionFields = {
  minTime: '',
  maxTime: '',
  minLedger: '',
  maxLedger: '',
  minSequence: '',
  minLedgerAge: '',
  maxLedgerAhead: '',
};

function isNonNegativeInt(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

/** Field-level validation for the preconditions draft (Savitura/Savitools#208). */
export function validatePreconditions(
  kind: PreconditionKind,
  fields: PreconditionFields,
): string | null {
  if (kind === 'none') return null;

  if (kind === 'time_bounds') {
    const min = fields.minTime.trim();
    const max = fields.maxTime.trim();
    if (!min) return 'minTime is required';
    if (!max) return 'maxTime is required';
    if (!isNonNegativeInt(min)) return 'minTime must be a non-negative integer';
    if (!isNonNegativeInt(max)) return 'maxTime must be a non-negative integer';
    if (Number(min) > Number(max)) return 'minTime must be less than or equal to maxTime';
    return null;
  }

  if (kind === 'ledger_bounds') {
    const min = fields.minLedger.trim();
    const max = fields.maxLedger.trim();
    if (!min) return 'minLedger is required';
    if (!max) return 'maxLedger is required';
    if (!isNonNegativeInt(min)) return 'minLedger must be a non-negative integer';
    if (!isNonNegativeInt(max)) return 'maxLedger must be a non-negative integer';
    if (Number(min) > Number(max)) return 'minLedger must be less than or equal to maxLedger';
    return null;
  }

  // min_sequence
  const minSequence = fields.minSequence.trim();
  if (!minSequence) return 'minSequence is required';
  if (!/^[1-9]\d*$/.test(minSequence)) return 'minSequence must be a positive integer string';
  const age = fields.minLedgerAge.trim();
  if (age && !(Number(age) > 0)) return 'minLedgerAge must be positive';
  const gap = fields.maxLedgerAhead.trim();
  if (gap && !(Number(gap) > 0)) return 'maxLedgerAhead must be positive';
  return null;
}

/** Convert a validated draft into the API payload entry (null when none/invalid). */
export function toPreconditions(
  kind: PreconditionKind,
  fields: PreconditionFields,
): PreconditionsInput | null {
  if (validatePreconditions(kind, fields)) return null;
  switch (kind) {
    case 'time_bounds':
      return {
        type: 'time_bounds',
        minTime: Number(fields.minTime.trim()),
        maxTime: Number(fields.maxTime.trim()),
      };
    case 'ledger_bounds':
      return {
        type: 'ledger_bounds',
        minLedger: Number(fields.minLedger.trim()),
        maxLedger: Number(fields.maxLedger.trim()),
      };
    case 'min_sequence': {
      const entry: Extract<PreconditionsInput, { type: 'min_sequence' }> = {
        type: 'min_sequence',
        minSequence: fields.minSequence.trim(),
      };
      const age = fields.minLedgerAge.trim();
      if (age) entry.minLedgerAge = Number(age);
      const gap = fields.maxLedgerAhead.trim();
      if (gap) entry.maxLedgerAhead = Number(gap);
      return entry;
    }
    default:
      return null;
  }
}

interface PreconditionsPanelProps {
  kind: PreconditionKind;
  fields: PreconditionFields;
  onKindChange: (kind: PreconditionKind) => void;
  onFieldChange: (fields: PreconditionFields) => void;
}

const KIND_OPTIONS: Array<{ value: PreconditionKind; label: string }> = [
  { value: 'none', label: 'None (default timeout)' },
  { value: 'time_bounds', label: 'Time bounds' },
  { value: 'ledger_bounds', label: 'Ledger bounds' },
  { value: 'min_sequence', label: 'Minimum account sequence' },
];

function NumberField({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
      >
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-xs font-mono placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-violet-500/50 focus:border-violet-500/50 transition-colors"
      />
    </div>
  );
}

export function PreconditionsPanel({
  kind,
  fields,
  onKindChange,
  onFieldChange,
}: PreconditionsPanelProps) {
  const error = validatePreconditions(kind, fields);

  const setField = (name: string, value: string) => {
    onFieldChange({ ...fields, [name]: value });
  };

  return (
    <div className="rounded-xl border border-border/60 bg-card/30 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Preconditions
          </p>
          <p className="text-[11px] text-muted-foreground/70">
            Optional — when omitted, the default 30s timeout is applied.
          </p>
        </div>
        <select
          id="precondition-kind"
          value={kind}
          onChange={(e) => onKindChange(e.target.value as PreconditionKind)}
          className="rounded-lg border border-border/60 bg-background/50 px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-violet-500/50 focus:border-violet-500/50 transition-colors"
        >
          {KIND_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {kind === 'time_bounds' && (
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            id="precond-min-time"
            label="Min Time (unix)"
            value={fields.minTime}
            onChange={(v) => setField('minTime', v)}
            placeholder="0"
          />
          <NumberField
            id="precond-max-time"
            label="Max Time (unix)"
            value={fields.maxTime}
            onChange={(v) => setField('maxTime', v)}
            placeholder="1893456000"
          />
        </div>
      )}

      {kind === 'ledger_bounds' && (
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            id="precond-min-ledger"
            label="Min Ledger"
            value={fields.minLedger}
            onChange={(v) => setField('minLedger', v)}
            placeholder="1000"
          />
          <NumberField
            id="precond-max-ledger"
            label="Max Ledger"
            value={fields.maxLedger}
            onChange={(v) => setField('maxLedger', v)}
            placeholder="2000"
          />
        </div>
      )}

      {kind === 'min_sequence' && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <NumberField
            id="precond-min-seq"
            label="Min Sequence"
            value={fields.minSequence}
            onChange={(v) => setField('minSequence', v)}
            placeholder="42"
          />
          <NumberField
            id="precond-seq-age"
            label="Min Ledger Age (opt.)"
            value={fields.minLedgerAge}
            onChange={(v) => setField('minLedgerAge', v)}
            placeholder="30"
          />
          <NumberField
            id="precond-seq-gap"
            label="Ledger Gap (opt.)"
            value={fields.maxLedgerAhead}
            onChange={(v) => setField('maxLedgerAhead', v)}
            placeholder="60"
          />
        </div>
      )}

      {error && <p className="text-[11px] text-rose-400">{error}</p>}
    </div>
  );
}
