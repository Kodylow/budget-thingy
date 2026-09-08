import { LiveLimitsTable } from '@/components/live-limits-table';
import { AdminDataQualityNote } from '@/components/admin-data-quality';

export default function LimitsLivePage() {
  return <>
    <LiveLimitsTable />
    <AdminDataQualityNote title="Group planning recommendations">
      <div className="space-y-2">
        <p>Approved funding includes the funding team’s baseline and accepted active adjustments. Canonical full-team spend across all services before the planning month is subtracted once. Current-month spend is not subtracted from the new total monthly plan.</p>
        <p>Opening remaining funds are shared over the remaining months of the fixed funding term, including this month. Boundary months are weighted by their funded calendar days. For a January–December $120,000 term, January recommends $10,000; after $5,000 spent in January, February recommends $115,000 ÷ 11 = $10,454.55.</p>
        <p>The monthly envelope is allocated once across mapped groups using eligible active workspace/user memberships. Each overlapping person’s weight is shared equally across their mapped groups; cent rounding reconciles to the team envelope. Missing history, membership, or full-team access makes the recommendation unavailable rather than assuming zero spend.</p>
        <p>A per-person suggestion divides a confirmed saved group plan—or its recommendation when no confirmed plan exists—by distinct eligible members, rounding down to cents. Copying or saving a plan does not enforce anything. Only verified calendar-month billing alignment permits a suggested current-cycle Agent limit; this is not a transferable pool or a reservation for other services. Zero plans never clear upstream limits.</p>
        <p>Local plans retain their approved workspace/group, mapping, and funding-term identity. A changed funding context requires explicit confirmation. Annual funding, inherited group defaults, and automatic enforcement policies remain separate.</p>
      </div>
    </AdminDataQualityNote>
  </>;
}