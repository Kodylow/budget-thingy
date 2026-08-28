import { LoaderCircle } from 'lucide-react';

export function LoadingCell() {
  return (
    <div
      className="inline-flex min-h-4 min-w-16 items-center justify-center text-muted-foreground"
      role="status"
      aria-label="Loading"
    >
      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
