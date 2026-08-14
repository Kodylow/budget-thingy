import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Mail, Plus, Trash2 } from 'lucide-react';
import {
  getListAdminsQueryKey,
  useAddAdmin,
  useDeleteAdmin,
  useListAdmins,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthContext } from '@/components/auth-context';
import { useToast } from '@/hooks/use-toast';

export function NotificationRecipients() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { isAccountAdmin } = useAuthContext();
  const [newEmail, setNewEmail] = useState('');
  const { data: admins, isLoading } = useListAdmins({
    query: { enabled: isAccountAdmin },
  });
  const addAdmin = useAddAdmin();
  const deleteAdmin = useDeleteAdmin();

  if (!isAccountAdmin) return null;

  const handleAddEmail = () => {
    const email = newEmail.trim();
    if (!email || email.length < 3) {
      toast({
        title: 'Invalid email',
        description: 'Please enter a valid email address',
        variant: 'destructive',
      });
      return;
    }

    addAdmin.mutate(
      { data: { email } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdminsQueryKey() });
          setNewEmail('');
          toast({
            title: 'Recipient added',
            description: `${email} will receive budget threshold notifications`,
          });
        },
        onError: (error: any) => {
          toast({
            title: 'Failed to add recipient',
            description: error?.error || 'An error occurred',
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleDeleteEmail = (adminId: number, email: string) => {
    deleteAdmin.mutate(
      { adminId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdminsQueryKey() });
          toast({
            title: 'Recipient removed',
            description: `${email} will no longer receive budget threshold notifications`,
          });
        },
        onError: () => {
          toast({
            title: 'Failed to remove recipient',
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <Card data-testid="card-notification-recipients">
      <CardHeader className="px-4 py-4 md:px-6 md:py-6">
        <CardTitle>Notification Recipients</CardTitle>
        <CardDescription>
          Account-admin managed email addresses that receive budget threshold notifications
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="email"
            placeholder="admin@comcast.com"
            value={newEmail}
            onChange={(event) => setNewEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleAddEmail();
            }}
            data-testid="input-new-email"
          />
          <Button
            onClick={handleAddEmail}
            disabled={addAdmin.isPending || !newEmail.trim()}
            data-testid="button-add-email"
            className="w-full sm:w-auto"
          >
            <Plus className="mr-2 h-4 w-4" />
            Add recipient
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[1, 2].map((item) => (
              <div key={item} className="h-12 rounded bg-muted animate-pulse-glow" />
            ))}
          </div>
        ) : admins && admins.length > 0 ? (
          <div className="space-y-2">
            {admins.map((admin) => (
              <div
                key={admin.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-muted/50"
                data-testid={`admin-email-${admin.id}`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium" data-testid={`text-email-${admin.id}`}>
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
                  aria-label={`Remove ${admin.email} from notification recipients`}
                  data-testid={`button-delete-email-${admin.id}`}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center py-8 text-center text-muted-foreground" data-testid="text-no-emails">
            <Mail className="mb-3 h-12 w-12 text-muted-foreground/40" />
            <p className="font-medium">No notification recipients configured</p>
            <p className="mt-1 text-sm">Add an email address to receive budget notifications</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}