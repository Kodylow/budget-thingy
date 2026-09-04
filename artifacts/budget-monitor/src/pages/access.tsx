import { useMemo } from 'react';
import { ShieldCheck, ShieldAlert, Key } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuthContext } from '@/components/auth-context';

export default function Access() {
  const { isAccountAdmin, capabilities } = useAuthContext();
  
  if (!isAccountAdmin && !capabilities.canManageAccess) {
    return (
      <div className="p-4 md:p-8 space-y-4">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Access</h1>
        <p className="text-muted-foreground">You do not have permission to view or manage access.</p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Access Management</h1>
        <p className="text-muted-foreground mt-1 text-sm md:text-base">
          Account admins manage application grants; organizational workspace/team membership remains sourced from Replit.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Application Grants</CardTitle>
          <CardDescription>View and manage explicit operational capabilities.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center p-8 border border-dashed rounded-lg bg-muted/10">
            <Key className="h-10 w-10 text-muted-foreground mb-4 opacity-50" />
            <h3 className="font-medium text-lg">Coming soon</h3>
            <p className="text-sm text-muted-foreground max-w-sm text-center mt-2">
              The ability to directly manage individual role grants and access rights within this interface is currently under development.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}