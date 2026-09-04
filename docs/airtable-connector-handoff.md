# Airtable connector handoff

**Owner:** Denise

Please restore the Airtable connector used by the Group Budget Monitor and confirm it can read the bases containing:

- `Replit Order Forms`
- `Replit Finance Approval`
- Any table that owns starter team allocations or canonical team identity

The connector should be read-only while the source contract is being verified. After reconnecting, record the stable base, table, and field IDs; field types; linked-record relationships; approval/revocation statuses; monthly allocation fields; and a few redacted sample records.

Do not run an allocation refresh until the mappings have been reviewed. The application must retain its last successful snapshot when the connector is unavailable or its schema does not match.