"use client";

/** Generic error boundary: never shows stack traces or server messages. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl space-y-4 py-10 text-center">
      <h1 className="text-2xl font-semibold text-parchment">Something went wrong</h1>
      <p className="text-mist">The database could not be reached just now. Please try again in a moment.</p>
      <button type="button" className="btn-gold" onClick={reset}>Try again</button>
    </div>
  );
}
