# Workspaces and access

PropCare is organised in **workspaces**. Each landlord or property-management
company gets its own; a person's role (`admin`, `manager`, `owner`) lives in
`memberships`, one row per workspace. Tenants have no membership: they report
through a unit's link.

The database is built from one migration,
`supabase/migrations/20261020000000_baseline.sql`, on a brand-new project
(PropCare was never in production, so there is no data to migrate). Setup:
[SETUP.md](../SETUP.md).

## Who can do what

| Who | Sees | Can change |
|---|---|---|
| Admin | Everything in the workspace | Everything; invites; settings; roles of others (never their own) |
| Manager | Everything in the workspace | Tickets, homes, units, tenant links, comments, approval requests |
| Owner (company workspaces) | Tickets, units and approvals for the properties they were given; comments marked "team and owner" or "to tenant" | Comment ("team and owner" only), approve or decline quotes |
| Tenant with the link | The requests they filed from that device; "to tenant" comments | File requests for that unit, reply |
| Tenant with an account | Every request of their tenancy | Same as above |

All of it is enforced by row-level security (`is_workspace_member`,
`ticket_access`, …) and SECURITY DEFINER functions for role changes, and
tested in `tests/integration/test-workspace-rls.ts` against the real
migration and seed in an in-process Postgres (PGlite).

## Rules worth knowing

- Roles are never read from `user_metadata`; there is no role on `profiles`.
- Memberships are only written by `create_workspace`, `accept_invitation`,
  `set_member_role` and `remove_member`. Nobody can change their own role.
- `workspace_id` on units, tenancies, tickets, comments and approvals is set
  by triggers from the parent row, so a client can't file into another
  workspace.
- Turning a unit's link off, or making a new one, removes the device
  verifications for that unit: old devices can't file new requests (they
  still see what they sent); tenants with an account keep access.

## Links and unit profiles

- One link and QR per unit (a house is one unit). No per-owner links: a
  tenant would have to pick among an owner's addresses, which is error-prone
  and shows them other addresses. The link page asks "Is the problem at
  <address>, Unit <n>? Yes / This isn't my home"; tenants never type an
  address.
- Each unit has a profile (Homes > unit): named rooms, fixtures and
  appliances with brand/model, main water shut-off, breaker panel, access
  notes, pets. The chat offers the rooms and appliances as tap-answers and
  shows the shut-off / breaker location for water and electrical problems;
  vendors see the access notes and pets on their work order.

## Assumptions to confirm (all configurable)

- **No billing yet.** The sign-up page has no price; workspace creation is
  capped at 5 per user (`create_workspace`).
- **Birchwood is just one workspace**: it signs up like any other company
  ("I manage rentals for owners") and invites its team and owners.
- **Tenant links live on the app's own domain** (`NEXT_PUBLIC_APP_URL/r/<token>`).
- **Email codes only.** Phone numbers are accepted by the parser but the form
  asks for email until an SMS provider (e.g. Twilio Verify) implements
  `CodeSender` in `src/lib/intake/senders.ts`. "Text it to the tenant" opens
  the manager's own phone messaging app; the server sends no texts.
- **Owners can comment ("team and owner") and approve/decline quotes, but
  cannot message tenants or change status.**
- Managers see every request in the workspace (per-home assignment for
  managers is not built).
- Approval limit defaults to $300 per workspace (Settings).
- One time zone for display/entry (`APP_TIME_ZONE`); current tz data has BC
  on permanent daylight time from late 2026.
