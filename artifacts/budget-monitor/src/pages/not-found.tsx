import { AlertCircle } from 'lucide-react';
import { Link } from 'wouter';

export default function NotFound() {
  return (
    <main className="flex min-h-[70vh] w-full items-center justify-center p-6">
      <div className="w-full max-w-lg border-t-2 border-primary pt-8">
        <AlertCircle className="mb-5 h-7 w-7 text-primary" aria-hidden="true" />
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Error 404</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Page not found</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          The address may be incorrect, or this destination may no longer be available.
        </p>
        <Link href="/" className="mt-6 inline-flex text-sm font-semibold text-primary hover:underline" data-testid="link-not-found-overview">
          Return to Overview
        </Link>
      </div>
    </main>
  );
}
