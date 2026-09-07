import React, { type ReactNode, useContext, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ClipboardCheck } from 'lucide-react';
import { useAuthContext } from '@/components/auth-context';
import { AdminDataQualityContext } from '@/components/admin-data-quality-context';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface AdminDataQualityProviderProps {
  children: ReactNode;
}

interface AdminDataQualitySessionProps extends AdminDataQualityProviderProps {
  canView: boolean;
}

function AdminDataQualitySession({ canView, children }: AdminDataQualitySessionProps) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const invokerRef = useRef<HTMLElement | null>(null);

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(canView && nextOpen);
    if (!nextOpen || !canView) setTarget(null);
  };
  const openPanel = (invoker: HTMLElement) => {
    if (!canView) return;
    invokerRef.current = invoker;
    setOpen(true);
  };

  return (
    <AdminDataQualityContext.Provider value={{
      canView,
      target: open && canView ? target : null,
      openPanel,
    }}>
      {children}
      <Dialog open={open && canView} onOpenChange={onOpenChange}>
        {open && canView && (
          <DialogContent
            className="max-h-[85dvh] overflow-y-auto"
            data-testid="dialog-data-quality"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              invokerRef.current?.focus();
              invokerRef.current = null;
            }}
          >
            <DialogHeader>
              <DialogTitle>Data quality</DialogTitle>
              <DialogDescription>
                Notes from the current page for your current access.
              </DialogDescription>
            </DialogHeader>
            <div
              ref={setTarget}
              className="space-y-3 empty:before:block empty:before:py-4 empty:before:text-sm empty:before:text-muted-foreground empty:before:content-['No_data_quality_notes_on_this_page.']"
              data-testid="data-quality-notes"
            />
          </DialogContent>
        )}
      </Dialog>
    </AdminDataQualityContext.Provider>
  );
}

export function AdminDataQualityProvider({ children }: AdminDataQualityProviderProps) {
  const {
    authorizationKey, isAccountAdmin, isWorkspaceAdmin, isTeamAdmin,
  } = useAuthContext();
  const canView = isAccountAdmin || isWorkspaceAdmin || isTeamAdmin;

  return (
    <AdminDataQualitySession key={`${authorizationKey}:${canView}`} canView={canView}>
      {children}
    </AdminDataQualitySession>
  );
}

export function AdminDataQualityTrigger() {
  const { canView, openPanel } = useContext(AdminDataQualityContext);
  if (!canView) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      className="w-full justify-start"
      data-testid="button-data-quality"
      onClick={(event) => openPanel(event.currentTarget)}
    >
      <ClipboardCheck className="mr-2 h-4 w-4 shrink-0" />
      Data quality
    </Button>
  );
}

export function AdminDataQualityNote({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  const { canView, target } = useContext(AdminDataQualityContext);
  if (!canView || !target) return null;

  return createPortal(
    <section className="rounded-md border bg-muted/30 p-3 text-sm">
      {title && <h3 className="mb-1 font-medium text-foreground">{title}</h3>}
      <div className="text-muted-foreground">{children}</div>
    </section>,
    target,
  );
}