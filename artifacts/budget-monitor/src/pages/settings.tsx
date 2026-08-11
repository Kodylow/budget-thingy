import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, CheckCircle, Mail, Trash2, Plus, XCircle } from 'lucide-react';
import {
  useListAdmins,
  useAddAdmin,
  useDeleteAdmin,
  useGetStatus,
  getListAdminsQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { formatDistanceToNow } from 'date-fns';
import { useAuthContext } from '@/components/auth-context';

export default function Settings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { isAccountAdmin } = useAuthContext();
  const [newEmail, setNewEmail] = useState('');

  const { data: admins, isLoading: adminsLoading } = useListAdmins();
  const { data: status, isLoading: statusLoading } = useGetStatus();
  const addAdmin = useAddAdmin();
  const deleteAdmin = useDeleteAdmin();

  const handleAddEmail = () => {
    if (!newEmail || newEmail.length < 3) {
      toast({
        title: 'Invalid email',
        description: 'Please enter a valid email address',
        variant: 'destructive',
      });
      return;
    }

    addAdmin.mutate(
      { data: { email: newEmail } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdminsQueryKey() });
          setNewEmail('');
          toast({
            title: 'Email added',
            description: `${newEmail} will receive alert notifications`,
          });
        },
        onError: (error: any) => {
          toast({
            title: 'Failed to add email',
            description: error?.error || 'An error occurred',
            variant: 'destructive',
          });
        },
      }
    );
  };

  const handleDeleteEmail = (adminId: number, email: string) => {
    deleteAdmin.mutate(
      { adminId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdminsQueryKey() });
          toast({
            title: 'Email removed',
            description: `${email} will no longer receive alerts`,
          });
        },
        onError: () => {
          toast({
            title: 'Failed to remove email',
            variant: 'destructive',
          });
        },
      }
    );
  };

  if (!isAccountAdmin) {
    return (
      <div className="p-8" data-testid="settings-forbidden">
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-2">
          Settings are only available to account administrators.
        </p>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight" data-testid="text-settings-title">
          Settings
        </h1>
        <p className="text-muted-foreground mt-1">
          Configure alert recipients and monitor system status
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>System Status</CardTitle>
          <CardDescription>
            Enterprise API connectivity and background checker state
          </CardDescription>
        </CardHeader>
        <CardContent>
          {statusLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-muted animate-pulse-glow rounded" />
              ))}
            </div>
          ) : status ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 rounded-lg border border-border" data-testid="status-enterprise-api">
                <div className="flex items-center gap-3">
                  {status.enterpriseApiConfigured && status.enterpriseApiOk ? (
                    <CheckCircle className="h-5 w-5 text-chart-1" />
                  ) : (
                    <XCircle className="h-5 w-5 text-destructive" />
                  )}
                  <div>
                    <p className="text-sm font-medium">Enterprise API</p>
                    {!status.enterpriseApiConfigured ? (
                      <p className="text-xs text-muted-foreground">Not configured</p>
                    ) : status.enterpriseApiOk ? (
                      <p className="text-xs text-chart-1">Connected</p>
                    ) : (
                      <p className="text-xs text-destructive">{status.enterpriseApiError || 'Connection failed'}</p>
                    )}
                  </div>
                </div>
                <Badge variant={status.enterpriseApiConfigured && status.enterpriseApiOk ? 'default' : 'destructive'}>
                  {status.enterpriseApiConfigured && status.enterpriseApiOk ? 'OK' : 'Error'}
                </Badge>
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-border" data-testid="status-email">
                <div className="flex items-center gap-3">
                  {status.emailConfigured ? (
                    <CheckCircle className="h-5 w-5 text-chart-1" />
                  ) : (
                    <AlertCircle className="h-5 w-5 text-chart-2" />
                  )}
                  <div>
                    <p className="text-sm font-medium">Email Sending</p>
                    <p className="text-xs text-muted-foreground">
                      {status.emailConfigured ? 'Configured' : 'Not configured'}
                    </p>
                  </div>
                </div>
                <Badge variant={status.emailConfigured ? 'default' : 'secondary'}>
                  {status.emailConfigured ? 'OK' : 'Not Set'}
                </Badge>
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-border" data-testid="status-checker">
                <div className="flex items-center gap-3">
                  <CheckCircle className="h-5 w-5 text-chart-1" />
                  <div>
                    <p className="text-sm font-medium">Background Checker</p>
                    <p className="text-xs text-muted-foreground">
                      Runs every {status.checkerIntervalMinutes} minutes
                      {status.lastCheckAt && (
                        <> · Last check {formatDistanceToNow(new Date(status.lastCheckAt), { addSuffix: true })}</>
                      )}
                    </p>
                  </div>
                </div>
                <Badge variant="default">Active</Badge>
              </div>

              {(!status.enterpriseApiConfigured || !status.enterpriseApiOk) && (
                <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 text-destructive mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-destructive">Action Required</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Set the REPLIT_ENTERPRISE_API_KEY environment variable to enable usage tracking.
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">Unable to load status</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Admin Notification Emails</CardTitle>
          <CardDescription>
            Email addresses that receive budget threshold alerts
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              type="email"
              placeholder="admin@comcast.com"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleAddEmail();
                }
              }}
              data-testid="input-new-email"
            />
            <Button
              onClick={handleAddEmail}
              disabled={addAdmin.isPending || !newEmail}
              data-testid="button-add-email"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add
            </Button>
          </div>

          {adminsLoading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div key={i} className="h-12 bg-muted animate-pulse-glow rounded" />
              ))}
            </div>
          ) : admins && admins.length > 0 ? (
            <div className="space-y-2">
              {admins.map((admin) => (
                <div
                  key={admin.id}
                  className="flex items-center justify-between p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors"
                  data-testid={`admin-email-${admin.id}`}
                >
                  <div className="flex items-center gap-3">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium" data-testid={`text-email-${admin.id}`}>
                        {admin.email}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Added {formatDistanceToNow(new Date(admin.createdAt), { addSuffix: true })}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteEmail(admin.id, admin.email)}
                    disabled={deleteAdmin.isPending}
                    data-testid={`button-delete-email-${admin.id}`}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground" data-testid="text-no-emails">
              <Mail className="h-12 w-12 text-muted-foreground/40 mx-auto mb-3" />
              <p className="font-medium">No admin emails configured</p>
              <p className="text-sm mt-1">Add an email address to receive budget alerts</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
