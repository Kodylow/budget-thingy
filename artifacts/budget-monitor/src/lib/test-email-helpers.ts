export function formatTestEmailSpend(threshold: number): number {
  return 10000 * (threshold / 100) + (threshold === 100 ? 250 : 0);
}

export function formatTestEmailLabel(entityType: 'group' | 'team'): string {
  return `Engineering ${entityType === 'group' ? 'Group' : 'Team'}`;
}

export function getTestEmailResultView(result: {
  ok: boolean;
  error: string | null;
  senderEmail: string | null;
  messageId: string | null;
}) {
  if (!result.ok) {
    return {
      tone: 'error' as const,
      title: 'Failed to send',
      detail: result.error || 'AgentMail did not return a delivery result.',
    };
  }
  return {
    tone: 'success' as const,
    title: 'Sent successfully',
    detail: `Sender: ${result.senderEmail}\nMessage ID: ${result.messageId}`,
  };
}
