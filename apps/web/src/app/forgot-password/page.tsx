'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { requestPasswordReset } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError('Email is required.');
      return;
    }

    setSubmitting(true);

    try {
      // The response is identical whether or not the account exists, so the
      // page always shows the same confirmation (enumeration-resistant).
      await requestPasswordReset(email.trim());
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-md mx-auto px-6 py-16">
      <h1 className="text-xl font-semibold mb-2">Forgot password</h1>
      <p className="text-sm text-muted-foreground mb-8">
        Enter your email address and we will send you a link to reset your
        password. The link expires after 30 minutes.
      </p>

      {submitted ? (
        <div className="space-y-6">
          <p className="text-sm rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 px-4 py-3">
            If an account with that email exists, we have sent a link to reset
            your password.
          </p>
          <p className="text-sm text-muted-foreground">
            <Link href="/login" className="text-foreground hover:underline">
              Back to log in
            </Link>
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-primary text-primary-foreground px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            {submitting ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}

      {!submitted && (
        <p className="text-sm text-muted-foreground mt-6">
          <Link href="/login" className="text-foreground hover:underline">
            Back to log in
          </Link>
        </p>
      )}
    </div>
  );
}
