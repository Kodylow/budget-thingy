import { useAuthContext } from '@/components/auth-context';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function Help() {
  const { role } = useAuthContext();

  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">User Guide</h1>
        <p className="text-muted-foreground mt-1 text-sm md:text-base">
          Instructions and examples for using the Group Budget Monitor.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Understanding your Dashboard</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-3">
            <p>
              Your dashboard displays financial metrics specific to your authorized scope.
              If you have administrative access to certain workspaces or teams, the dashboard will aggregate data for those entities.
            </p>
            <p>
              By default, ordinary members see a "My usage" dashboard which displays their own spending limits and usage.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Spend Details</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-3">
            <p>
              Navigate to the <strong>Spend details</strong> page from the sidebar to view searchable and sortable tables of financial data.
            </p>
            <p>
              Different tabs (Pools, Groups, People, Projects) may be available depending on your administrative access level.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}