'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addRecentItem } from '@/lib/recent-items';
import { useCommandPalette, ShortcutBadge } from '@/components/command-palette';
import {
  Send,
  RotateCcw,
  Copy,
  Check,
  Clock,
  CheckCircle,
  XCircle,
  ChevronDown,
  AlertTriangle,
  Plus,
  Trash2,
  Save,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  fetchWebhookTemplates,
  fetchWebhookSigningStatus,
  saveWebhookTemplate,
  sendWebhook,
  fetchWebhookHistory,
  replayWebhook,
  type WebhookTemplate,
  type WebhookHistoryEntry,
  type WebhookSigningStatus,
} from '@/lib/api';
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  canonicalRequestBody,
  nowSeconds,
  signPayload,
  signedPayload,
} from '@/lib/webhook-signature';

function formatJson(data: unknown): string {
  try {
    if (typeof data === 'string') return data;
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function getStatusColor(status?: number | null): string {
  if (!status) return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30';
  if (status >= 200 && status < 300)
    return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
  if (status >= 300 && status < 400)
    return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
  if (status >= 400 && status < 500)
    return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
  return 'bg-red-500/15 text-red-400 border-red-500/30';
}

function escapeForSingleQuotes(value: string): string {
  return value.replace(/'/g, "'\\''");
}

/**
 * Renders a copy-pasteable reproduction of a delivery. Uses the exact body
 * bytes the API signed (not a fresh `JSON.stringify`) so the command a receiver
 * runs verifies against the signature the API sent.
 */
function curlFor(entry: WebhookHistoryEntry): string {
  const body = entry.signature?.body ?? JSON.stringify(entry.payload);
  return `curl -s -X ${entry.method || 'POST'} '${entry.endpointUrl}' \
  ${Object.entries(entry.requestHeaders)
    .map(([k, v]) => `-H '${k}: ${v}'`)
    .join(' \
  ')} \
  -d '${escapeForSingleQuotes(body)}'`;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-muted-foreground/50 transition-colors"
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-400" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
      {copied ? 'Copied!' : label}
    </button>
  );
}

export function WebhookTester() {
  const [templates, setTemplates] = useState<WebhookTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const { registerContextActions } = useCommandPalette();
  const [endpointUrl, setEndpointUrl] = useState('');
  const [method, setMethod] = useState<'POST' | 'PUT' | 'PATCH' | 'GET'>('POST');
  const [selectedEventType, setSelectedEventType] = useState('');
  const [payloadEditor, setPayloadEditor] = useState('');
  const [payloadValid, setPayloadValid] = useState(true);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [localSignature, setLocalSignature] = useState<string | null>(null);
  const [signingStatus, setSigningStatus] = useState<WebhookSigningStatus | null>(null);
  // Ticks once a second so the previewed timestamp stays the one a send would
  // use right now, instead of freezing on the value from when it was typed.
  const [clockSecond, setClockSecond] = useState(() => nowSeconds());

  const [customHeaders, setCustomHeaders] = useState<Array<{ name: string; value: string }>>([]);
  const [repeatCount, setRepeatCount] = useState<number>(1);
  const [repeatIntervalMs, setRepeatIntervalMs] = useState<number>(0);

  const [sending, setSending] = useState(false);
  const [resultsList, setResultsList] = useState<WebhookHistoryEntry[]>([]);
  const [result, setResult] = useState<WebhookHistoryEntry | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const [history, setHistory] = useState<WebhookHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);

  const [saveTemplateModal, setSaveTemplateModal] = useState(false);
  const [templateNameInput, setTemplateNameInput] = useState('');
  const [templateDescInput, setTemplateDescInput] = useState('');
  const [templateSavedMsg, setTemplateSavedMsg] = useState(false);

  const [eventDropdownOpen, setEventDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplatesError(null);
    try {
      const data = await fetchWebhookTemplates();
      setTemplates(data);
      if (data.length > 0) {
        setSelectedEventType(data[0].eventType);
        setPayloadEditor(JSON.stringify(data[0].samplePayload, null, 2));
      }
    } catch (err) {
      setTemplatesError(
        err instanceof Error ? err.message : 'Failed to load templates',
      );
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const data = await fetchWebhookHistory();
      setHistory(data);
      if (data.length > 0 && !result) {
        setResult(data[0]);
      }
    } catch {
      // silently fail on history load
    } finally {
      setHistoryLoading(false);
    }
  }, [result]);

  useEffect(() => {
    void loadTemplates();
    void loadHistory();
  }, [loadTemplates, loadHistory]);

  // Validate JSON payload and common webhook structure schema
  useEffect(() => {
    if (!payloadEditor.trim()) {
      setPayloadValid(true);
      setSchemaError(null);
      return;
    }
    try {
      const parsed = JSON.parse(payloadEditor);
      setPayloadValid(true);

      // Check common webhook schema validations (e.g. event type or data/payload fields)
      if (typeof parsed !== 'object' || parsed === null) {
        setSchemaError('Payload must be a JSON object');
      } else {
        setSchemaError(null);
      }
    } catch (err) {
      setPayloadValid(false);
      setSchemaError(err instanceof Error ? err.message : 'Invalid JSON syntax');
    }
  }, [payloadEditor]);

  useEffect(() => {
    void fetchWebhookSigningStatus()
      .then(setSigningStatus)
      .catch(() => setSigningStatus(null));
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setClockSecond(nowSeconds()), 1000);
    return () => clearInterval(timer);
  }, []);

  /**
   * The bytes the API signs: the parsed payload, serialised compactly — not the
   * pretty-printed text in the editor. While the editor still holds the
   * delivered payload we reuse the exact timestamp and body the API reported, so
   * the panel shows the value that actually went on the wire; once the payload
   * changes it falls back to the timestamp a send right now would use.
   */
  const signingInput = useMemo(() => {
    if (!payloadValid || !payloadEditor.trim()) return null;

    let editorBody: string;
    try {
      editorBody = canonicalRequestBody(JSON.parse(payloadEditor));
    } catch {
      return null;
    }

    if (result?.signature && result.signature.body === editorBody) {
      return {
        timestamp: result.signature.timestamp,
        body: result.signature.body,
        fromDelivery: true,
      };
    }

    return { timestamp: String(clockSecond), body: editorBody, fromDelivery: false };
  }, [result, payloadEditor, payloadValid, clockSecond]);

  const signedBytes = signingInput
    ? signedPayload(signingInput.timestamp, signingInput.body)
    : null;

  useEffect(() => {
    let cancelled = false;
    if (!secret || !signingInput) {
      setLocalSignature(null);
      return;
    }
    void signPayload(secret, signingInput.timestamp, signingInput.body).then(
      (value) => {
        if (!cancelled) setLocalSignature(value);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [secret, signingInput]);

  // A delivery is only trustworthy if this browser reproduces the API's
  // signature from the same timestamp and bytes, so say so explicitly. Only
  // meaningful once a signature was actually computed for the delivered input.
  const reproducesDelivery =
    !!result?.signature &&
    signingInput?.fromDelivery === true &&
    localSignature !== null;
  const localMatchesApi =
    reproducesDelivery && localSignature === result!.signature!.signature;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setEventDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleEventTypeSelect = (template: WebhookTemplate) => {
    setSelectedEventType(template.eventType);
    setPayloadEditor(JSON.stringify(template.samplePayload, null, 2));
    setEventDropdownOpen(false);
  };

  const handleSend = useCallback(async () => {
    if (!endpointUrl) {
      setSendError('Please enter a target endpoint URL');
      return;
    }
    if (!payloadValid) {
      setSendError('Please fix JSON payload syntax errors before sending');
      return;
    }

    setSending(true);
    setSendError(null);

    try {
      let parsedPayload: Record<string, unknown> | undefined;
      if (payloadEditor.trim()) {
        parsedPayload = JSON.parse(payloadEditor);
      }

      const headersObj: Record<string, string> = {};
      for (const h of customHeaders) {
        if (h.name.trim() && h.value.trim()) {
          headersObj[h.name.trim()] = h.value.trim();
        }
      }

      const response = await sendWebhook({
        endpointUrl,
        eventType: selectedEventType || 'custom.event',
        payload: parsedPayload,
        secret: secret || undefined,
        method,
        headers: Object.keys(headersObj).length > 0 ? headersObj : undefined,
        repeatCount,
        repeatIntervalMs,
      });

      const lastEntry = Array.isArray(response) ? response[response.length - 1] : response;
      if (Array.isArray(response)) {
        setResultsList(response);
        setResult(lastEntry);
      } else {
        setResultsList([response]);
        setResult(response);
      }

      if (lastEntry) {
        addRecentItem({
          category: 'webhooks',
          title: `Webhook: ${selectedEventType || 'custom.event'}`,
          subtitle: `${endpointUrl} · ${lastEntry.responseStatus ? `HTTP ${lastEntry.responseStatus}` : 'Sent'}`,
          href: '/webhooks',
        });
      }

      await loadHistory();
      resultRef.current?.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send webhook');
    } finally {
      setSending(false);
    }
  }, [
    endpointUrl,
    payloadValid,
    payloadEditor,
    customHeaders,
    selectedEventType,
    secret,
    method,
    repeatCount,
    repeatIntervalMs,
    loadHistory,
  ]);

  useEffect(() => {
    const unregister = registerContextActions({
      actionLabel: 'Send Webhook Test',
      runAction: () => {
        if (endpointUrl && payloadValid && !sending) {
          void handleSend();
        }
      },
    });
    return unregister;
  }, [endpointUrl, payloadValid, sending, registerContextActions, handleSend]);

  const handleSaveTemplate = async () => {
    if (!templateNameInput.trim()) return;
    try {
      const parsed = payloadValid ? JSON.parse(payloadEditor) : {};
      const newTpl: WebhookTemplate = {
        provider: 'crowdpay',
        eventType: templateNameInput.trim(),
        description: templateDescInput.trim() || 'Custom saved template',
        schema: { payload: 'Custom schema' },
        samplePayload: parsed,
      };
      await saveWebhookTemplate(newTpl);
      await loadTemplates();
      setTemplateSavedMsg(true);
      setTimeout(() => {
        setTemplateSavedMsg(false);
        setSaveTemplateModal(false);
        setTemplateNameInput('');
        setTemplateDescInput('');
      }, 1500);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save template');
    }
  };

  const handleReplay = async (historyId: string) => {
    try {
      const res = await replayWebhook(historyId);
      setResult(res);
      setEndpointUrl(res.endpointUrl);
      setSelectedEventType(res.eventType);
      setPayloadEditor(formatJson(res.payload));
      setMethod((res.method as any) || 'POST');
      await loadHistory();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to replay webhook');
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left Configuration Panel */}
      <div className="lg:col-span-7 space-y-6">
        {/* Target URL & Method */}
        <div className="rounded-lg border border-border bg-card p-5 space-y-4 shadow-sm">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Send className="h-4 w-4 text-primary" /> Target & Method
          </h3>
          <div className="flex gap-2">
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as any)}
              className="rounded-md border border-input bg-background px-3 py-2 text-xs font-bold uppercase"
            >
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="GET">GET</option>
            </select>
            <input
              type="url"
              value={endpointUrl}
              onChange={(e) => setEndpointUrl(e.target.value)}
              placeholder="https://your-server.com/webhook-handler"
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
            />
          </div>
        </div>

        {/* Event Template Selector & Payload Editor */}
        <div className="rounded-lg border border-border bg-card p-5 space-y-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Clock className="h-4 w-4 text-primary" /> Payload & Templates
            </h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSaveTemplateModal(true)}
                className="flex items-center gap-1 text-xs rounded border border-border px-2.5 py-1 text-muted-foreground hover:text-foreground transition-colors"
              >
                <Save className="h-3 w-3" /> Save as Template
              </button>
            </div>
          </div>

          {/* Template Dropdown */}
          <div className="relative">
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Load Sample Template
            </label>
            <button
              type="button"
              onClick={() => setEventDropdownOpen(!eventDropdownOpen)}
              className="w-full flex items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-xs font-mono text-left"
            >
              <span>{selectedEventType || 'Select webhook template...'}</span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </button>

            {eventDropdownOpen && (
              <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-popover shadow-md max-h-60 overflow-y-auto">
                {templates.map((tpl) => (
                  <button
                    key={`${tpl.provider}-${tpl.eventType}`}
                    type="button"
                    onClick={() => handleEventTypeSelect(tpl)}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-muted/50 transition-colors border-b border-border/50 last:border-0"
                  >
                    <div className="font-medium font-mono text-foreground">
                      [{tpl.provider.toUpperCase()}] {tpl.eventType}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {tpl.description}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Raw JSON Editor */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-muted-foreground">
                Payload Body (JSON)
              </label>
              <div className="flex items-center gap-2">
                {!payloadValid && (
                  <span className="text-[11px] text-red-400 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" /> Invalid JSON
                  </span>
                )}
                {schemaError && payloadValid && (
                  <span className="text-[11px] text-amber-400 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" /> {schemaError}
                  </span>
                )}
                {payloadValid && !schemaError && (
                  <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                    <CheckCircle className="h-3 w-3" /> Valid JSON
                  </span>
                )}
              </div>
            </div>
            <textarea
              value={payloadEditor}
              onChange={(e) => setPayloadEditor(e.target.value)}
              rows={10}
              className={cn(
                'w-full rounded-md border bg-background p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-1',
                !payloadValid
                  ? 'border-red-500/50 focus:ring-red-500'
                  : 'border-input focus:ring-primary',
              )}
              placeholder="{&#10;  &quot;event&quot;: &quot;custom.event&quot;,&#10;  &quot;data&quot;: {}&#10;}"
            />
          </div>
        </div>

        {/* Headers & Signature */}
        <div className="rounded-lg border border-border bg-card p-5 space-y-4 shadow-sm">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" /> Headers & Signature Verification
          </h3>

          {signingStatus && (
            <p className="text-[11px] text-muted-foreground">
              Deployment signing is{' '}
              <span className={signingStatus.enabled ? 'text-emerald-400' : 'text-amber-400'}>
                {signingStatus.enabled ? 'enabled' : 'disabled'}
              </span>{' '}
              — every signed request carries{' '}
              <span className="font-mono text-foreground">{signingStatus.signatureHeader}</span>{' '}
              and{' '}
              <span className="font-mono text-foreground">{signingStatus.timestampHeader}</span>
              , and the signature covers{' '}
              <span className="font-mono text-foreground">{signingStatus.signedPayloadFormat}</span>
              . Reject timestamps older than {signingStatus.replayWindowSeconds}s.
            </p>
          )}

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Webhook Signing Secret (HMAC-SHA256)
              </label>
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={`Enter shared secret to generate ${SIGNATURE_HEADER}`}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
              />
            </div>

            {secret && (
              <div className="space-y-2 rounded border border-border bg-muted/20 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {signingInput?.fromDelivery
                      ? 'Signed bytes used for the last delivery'
                      : 'Bytes that will be signed on send'}
                  </span>
                  {signedBytes && <CopyButton text={signedBytes} label="Copy Bytes" />}
                </div>

                <dl className="space-y-1.5 text-[11px] font-mono">
                  <div className="flex items-start gap-2">
                    <dt className="shrink-0 text-muted-foreground">{TIMESTAMP_HEADER}</dt>
                    <dd className="text-foreground break-all">
                      {signingInput?.timestamp ?? '—'}
                      {signingInput?.fromDelivery
                        ? ' (as sent)'
                        : ' (current second)'}
                    </dd>
                  </div>
                  <div className="flex items-start gap-2">
                    <dt className="shrink-0 text-muted-foreground">Signed payload</dt>
                    <dd className="text-foreground/80 break-all line-clamp-2">
                      {signedBytes ?? '—'}
                    </dd>
                  </div>
                  <div className="flex items-start gap-2">
                    <dt className="shrink-0 text-muted-foreground">{SIGNATURE_HEADER}</dt>
                    <dd className="text-foreground break-all">
                      {localSignature ?? '—'}
                    </dd>
                  </div>
                </dl>

                {signingInput && localSignature === null && (
                  <p className="text-[11px] text-amber-400">
                    Could not compute the signature here. It is still signed server-side —
                    check the last delivery below for the value that went on the wire.
                  </p>
                )}

                {reproducesDelivery && (
                  <p
                    className={cn(
                      'text-[11px] flex items-center gap-1.5',
                      localMatchesApi ? 'text-emerald-400' : 'text-amber-400',
                    )}
                  >
                    {localMatchesApi ? (
                      <CheckCircle className="h-3 w-3 shrink-0" />
                    ) : (
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                    )}
                    {localMatchesApi
                      ? `This browser reproduced the API's signature for timestamp ${result!.signature!.timestamp}`
                      : 'This browser could not reproduce the API signature for the last delivery'}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">
                  Custom Headers
                </label>
                <button
                  type="button"
                  onClick={() => setCustomHeaders([...customHeaders, { name: '', value: '' }])}
                  className="flex items-center gap-1 text-[11px] text-primary hover:underline"
                >
                  <Plus className="h-3 w-3" /> Add Header
                </button>
              </div>
              {customHeaders.map((header, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={header.name}
                    onChange={(e) => {
                      const updated = [...customHeaders];
                      updated[idx].name = e.target.value;
                      setCustomHeaders(updated);
                    }}
                    placeholder="Header-Name"
                    className="w-1/3 rounded border border-input bg-background px-2 py-1 text-xs font-mono"
                  />
                  <input
                    type="text"
                    value={header.value}
                    onChange={(e) => {
                      const updated = [...customHeaders];
                      updated[idx].value = e.target.value;
                      setCustomHeaders(updated);
                    }}
                    placeholder="Header Value"
                    className="flex-1 rounded border border-input bg-background px-2 py-1 text-xs font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setCustomHeaders(customHeaders.filter((_, i) => i !== idx))}
                    className="text-muted-foreground hover:text-red-400 p-1"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Loop / Load Testing */}
        <div className="rounded-lg border border-border bg-card p-5 space-y-4 shadow-sm">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <RotateCcw className="h-4 w-4 text-primary" /> Repeat / Load Test
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Repeat Count
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={repeatCount}
                onChange={(e) => setRepeatCount(parseInt(e.target.value) || 1)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Interval (ms)
              </label>
              <input
                type="number"
                min={0}
                max={10000}
                step={100}
                value={repeatIntervalMs}
                onChange={(e) => setRepeatIntervalMs(parseInt(e.target.value) || 0)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
              />
            </div>
          </div>
        </div>

        {/* Send Action */}
        {sendError && (
          <div className="rounded-md bg-red-500/15 border border-red-500/30 p-3 text-xs text-red-400 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{sendError}</span>
          </div>
        )}

        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={sending || !endpointUrl || !payloadValid}
          title="Send Webhook (Cmd+Enter)"
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-semibold text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {sending ? (
            <span className="animate-pulse">Sending webhook...</span>
          ) : (
            <>
              <Send className="h-4 w-4" /> Send Webhook {repeatCount > 1 ? `(${repeatCount}x)` : ''}
              <ShortcutBadge shortcut="Cmd+Enter" className="hidden sm:inline-flex bg-primary-foreground/20 text-primary-foreground border-transparent text-[9px]" />
            </>
          )}
        </button>
      </div>

      {/* Right Response & History Panel */}
      <div className="lg:col-span-5 space-y-6" ref={resultRef}>
        <div className="rounded-lg border border-border bg-card p-5 space-y-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">
              Response Inspector
            </h3>
            {result && (
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'inline-flex items-center rounded border px-2 py-0.5 text-xs font-bold font-mono',
                    getStatusColor(result.responseStatus),
                  )}
                >
                  {result.responseStatus ?? 'ERR'}
                </span>
                <span className="text-xs font-mono text-muted-foreground">
                  {result.latencyMs}ms
                </span>
              </div>
            )}
          </div>

          {result ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between text-xs text-muted-foreground border-b border-border pb-2">
                <span className="font-mono">{result.endpointUrl}</span>
                <span>{formatTime(result.timestamp)}</span>
              </div>

              {result.legacySignature ? (
                <p className="rounded border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11px] text-amber-400 flex items-start gap-1.5">
                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                  <span>
                    Recorded before the timestamped signing contract, so it carries the
                    legacy body-only signature. Replaying it re-signs under{' '}
                    <span className="font-mono">{SIGNATURE_HEADER}</span> +{' '}
                    <span className="font-mono">{TIMESTAMP_HEADER}</span>; a receiver
                    cannot verify this entry as it was sent.
                  </span>
                </p>
              ) : result.signature ? (
                <p className="rounded border border-border bg-muted/30 p-2.5 text-[11px] font-mono text-muted-foreground">
                  Signed with <span className="text-foreground">{TIMESTAMP_HEADER}: {result.signature.timestamp}</span>{' '}
                  over <span className="text-foreground">{SIGNATURE_HEADER}: {result.signature.signature}</span>
                </p>
              ) : null}

              {/* Response Headers */}
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-1">
                  Response Headers
                </h4>
                <pre className="rounded border border-border bg-muted/30 p-2 text-[11px] font-mono overflow-x-auto max-h-32">
                  {formatJson(result.responseHeaders)}
                </pre>
              </div>

              {/* Response Body */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <h4 className="text-xs font-medium text-muted-foreground">
                    Response Body
                  </h4>
                  <CopyButton text={result.responseBody} label="Copy Body" />
                </div>
                <pre className="rounded border border-border bg-muted/30 p-3 text-xs font-mono overflow-x-auto max-h-64">
                  {formatJson(result.responseBody)}
                </pre>
              </div>

              {/* Request cURL */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <h4 className="text-xs font-medium text-muted-foreground">
                    Request cURL
                  </h4>
                  <CopyButton
                    text={curlFor(result)}
                    label="Copy cURL"
                  />
                </div>
                <pre className="rounded border border-border bg-muted/30 p-3 text-[11px] font-mono overflow-x-auto max-h-40">
                  {curlFor(result)}
                </pre>
              </div>
            </div>
          ) : (
            <div className="py-16 text-center text-xs text-muted-foreground">
              No webhook sent yet. Configure and fire a payload to inspect the response.
            </div>
          )}
        </div>

        {/* Recent Webhook History */}
        <div className="rounded-lg border border-border bg-card p-5 space-y-4 shadow-sm">
          <h3 className="text-sm font-semibold text-foreground">
            Webhook History & Replay
          </h3>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {history.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">
                No history available
              </p>
            ) : (
              history.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    'flex items-center justify-between rounded border p-2.5 text-xs transition-colors',
                    result?.id === item.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-muted-foreground/50',
                  )}
                >
                  <div
                    className="flex-1 cursor-pointer truncate mr-2"
                    onClick={() => {
                      setResult(item);
                      setEndpointUrl(item.endpointUrl);
                      setSelectedEventType(item.eventType);
                      setPayloadEditor(formatJson(item.payload));
                      setMethod((item.method as any) || 'POST');
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'px-1.5 py-0.5 rounded text-[10px] font-bold font-mono',
                          getStatusColor(item.responseStatus),
                        )}
                      >
                        {item.responseStatus ?? 'ERR'}
                      </span>
                      <span className="font-mono font-medium truncate">
                        {item.eventType}
                      </span>
                      {item.legacySignature && (
                        <span
                          title="Signed with the legacy body-only format; a replay is re-signed"
                          className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400"
                        >
                          legacy
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                      {item.endpointUrl}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleReplay(item.id)}
                    title="Replay webhook"
                    className="rounded border border-border p-1.5 text-muted-foreground hover:text-foreground hover:border-muted-foreground transition-colors"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Save Template Modal */}
      {saveTemplateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 space-y-4 shadow-xl">
            <h3 className="text-base font-semibold text-foreground">
              Save Payload as Template
            </h3>
            {templateSavedMsg ? (
              <div className="p-4 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs text-center font-medium">
                Template successfully saved!
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Event Type / Template Name
                  </label>
                  <input
                    type="text"
                    value={templateNameInput}
                    onChange={(e) => setTemplateNameInput(e.target.value)}
                    placeholder="e.g. custom.stellar.payment"
                    className="w-full rounded border border-input bg-background px-3 py-2 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Description
                  </label>
                  <input
                    type="text"
                    value={templateDescInput}
                    onChange={(e) => setTemplateDescInput(e.target.value)}
                    placeholder="Describe what this webhook represents"
                    className="w-full rounded border border-input bg-background px-3 py-2 text-xs"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setSaveTemplateModal(false)}
                    className="rounded border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveTemplate}
                    disabled={!templateNameInput.trim()}
                    className="rounded bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    Save Template
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
