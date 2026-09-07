export function getAutomatedEmailPolicyPresentation(enabled: boolean) {
  return enabled
    ? {
        label: 'On',
        detail: 'Scheduled and manual budget checks can send due threshold alerts.',
      }
    : {
        label: 'Off',
        detail: 'Budget checks will not send or consume due threshold alerts.',
      };
}

export function getEmailConnectorPresentation(configured: boolean) {
  return configured
    ? {
        label: 'Ready',
        detail: 'AgentMail is available for automated alerts and Test Email.',
      }
    : {
        label: 'Unavailable',
        detail: 'AgentMail is not currently available. Delivery policy is unchanged.',
      };
}