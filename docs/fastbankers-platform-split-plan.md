# FastBankers Platform Split & CRM Stabilization Plan

## 1) Project split map

### Public Website App (customer-facing only)
**Purpose:** Marketing, lead capture, trust/content pages, customer entry points.

**Keeps:**
- Landing pages, pricing, service pages, blog/content, contact forms.
- Public enquiry submission flows.
- Customer auth entry routes (login/signup/reset) that point to customer portal only.
- SEO assets, analytics tags, cookie consent.

**Must not include:**
- Staff login UI, staff route links, staff navigation hints.
- Internal CRM widgets (AI review panel, internal notes, risk flags, assignment controls).

### CRM App (internal + customer portal)
**Purpose:** Operational workspace for staff and authenticated customer self-service.

**Keeps:**
- Existing customer login at `/crm/login`.
- Hidden staff login at `/staff-login`.
- Role model and permissions: Super Admin, Manager, Admin, Sales, Accounts, Customer.
- Case workspace and all completed features currently in production scope.

**Internal-only surfaces:**
- AI review engine outputs and actions.
- Internal notes, flags, audit/assignment actions.
- Staff management, PIN reset/change controls for eligible roles.

### Duplicated/shared across apps
- Shared design tokens/theme package (optional monorepo package).
- Shared API client and Supabase typings.
- Shared validation schemas for entities (enquiries, cases, documents, notes, messages, requests).
- Shared auth utility package (without exposing staff-specific UI in public app).

### Backend-only (single source of truth)
- Supabase auth, DB schema, RLS policies, storage buckets, edge functions.
- Staff PIN verification logic and active-status checks.
- Assignment and role authorization enforcement.
- System audit logging and sensitive status transitions.

---

## 2) File inventory by app

> Use this as an implementation scaffold regardless of framework.

### Proposed repository structure
```
/apps
  /public-web
    /src/pages
    /src/components/public
    /src/routes
    /src/lib
  /crm-app
    /src/pages/customer
    /src/pages/staff
    /src/components/customer
    /src/components/staff
    /src/routes
    /src/lib
/packages
  /shared-ui
  /shared-types
  /shared-schemas
  /shared-supabase-client
/supabase
  /migrations
  /functions
  /policies
/docs
  fastbankers-platform-split-plan.md
```

### Public app inventory
- `pages/*` marketing/public pages.
- `routes/public.ts` public route definitions.
- `routes/auth-customer.ts` customer auth entry only.
- `lib/enquiry-client.ts` create/read own enquiry abstractions.

### CRM app inventory
- `pages/customer/*` customer portal pages.
- `pages/staff/*` internal CRM pages.
- `routes/customer.ts` customer authenticated routes.
- `routes/staff.ts` staff-only routes and guards.
- `lib/permissions.ts` role matrix + helper guards.
- `lib/staff-auth.ts` PIN auth and active staff enforcement.

### Shared package inventory
- `shared-types`: generated Supabase types + role enums.
- `shared-schemas`: Zod/Yup schemas for requests/responses.
- `shared-supabase-client`: server/client wrappers.
- `shared-ui`: base components (no staff logic).

---

## 3) Shared backend contract

### Data model contract (unchanged)
- **Auth users:** single Supabase project/user table.
- **Core entities:** enquiries, cases, documents, notes, messages, requests.
- **Storage:** same buckets; path conventions enforce ownership/privacy.
- **Functions:** same edge functions consumed by both apps.

### Authorization contract
- RLS remains authoritative; frontend guards are UX only.
- Staff-only data fields never returned to customer roles.
- Customer role restricted to own records and customer-safe projections.
- Staff role resolution uses role table + active flag check.

### Required API response separation
- Introduce `customer_safe` views/endpoints for case timelines and status.
- Keep internal fields (`ai_review`, `internal_note`, `risk_flag`, `staff_action`) staff-only by policy and query layer.

### Auth separation contract
- Public app only calls customer auth methods.
- Staff login flow lives only in CRM app (`/staff-login`) and is not linked publicly.
- No assumption of cross-domain SSO: explicitly test cookie/session handling for chosen domain model.

---

## 4) Route and redirect map

### Public website routes
- `/`
- `/about`
- `/services/*`
- `/pricing`
- `/contact`
- `/blog/*`
- `/login` -> customer login (redirect to `/crm/login` or portal host)
- `/signup` -> customer signup (redirect to customer portal auth)

### Customer portal routes (CRM app)
- `/crm/login`
- `/crm/signup`
- `/crm/forgot-password`
- `/crm/dashboard`
- `/crm/cases`
- `/crm/cases/:id` (customer-safe view only)
- `/crm/documents`
- `/crm/requests`
- `/crm/messages`
- `/crm/profile`

### Staff CRM routes (CRM app)
- `/staff-login` (hidden/internal entry)
- `/staff`
- `/staff/cases`
- `/staff/cases/:id`
- `/staff/users`
- `/staff/requests`
- `/staff/documents/review`
- `/staff/settings/pin`
- `/staff/admin/*` (super-admin-only where applicable)

### Legacy redirects (migration-safe)
- Old mixed auth routes -> `/crm/login` for customer context.
- Any historical staff login route -> `/staff-login` (internal only, no public nav exposure).
- Deprecated mixed dashboard routes -> role-based landing (`/crm/dashboard` or `/staff`).
- Add 301/302 map and retain for at least one release cycle with monitoring.

---

## 5) Execution order

1. **Baseline freeze + inventory**
   - Snapshot current working routes/features.
   - Capture role-policy matrix and current RLS.

2. **Monorepo/app split scaffolding**
   - Create `apps/public-web`, `apps/crm-app`, and shared packages.
   - Move code without behavioral changes first.

3. **Routing segregation**
   - Implement explicit route groups for public/customer/staff.
   - Remove staff links/components from public app bundles.

4. **Auth hard separation**
   - Keep customer auth at `/crm/login`.
   - Keep hidden `/staff-login` flow and active-staff dropdown enforcement.

5. **Permission hardening pass**
   - Validate role guard coverage across CRM pages/actions.
   - Re-check staff hierarchy: Super Admin > Manager > Admin > Sales; Accounts isolated permissions.

6. **Customer-safe data projection**
   - Introduce/verify customer-safe selectors/views.
   - Ensure internal AI review/notes/flags never appear in customer queries.

7. **Legacy redirects + telemetry**
   - Apply redirect rules.
   - Add route hit analytics and auth error observability.

8. **Stability + regression cycle**
   - Full UAT for existing completed features.
   - Fix regressions before any feature expansion.

9. **Production rollout**
   - Phased deployment (internal first, then public).
   - Rollback plan tested before cutover.

---

## 6) Validation checklist

### Functional regression
- [ ] Customer login still works at `/crm/login`.
- [ ] Staff login still works at `/staff-login` with name + 4-digit PIN.
- [ ] Inactive staff are excluded/blocked from login selection.
- [ ] Existing completed modules still function (workspace, docs verification, requests, user mgmt, AI review, mandate workflow).

### Security/visibility
- [ ] Public site contains no staff login surface.
- [ ] Customer cannot access staff routes or staff-only actions.
- [ ] Customer payloads omit internal notes/flags/AI internal outputs.
- [ ] RLS tests pass for Customer, Sales, Admin, Manager, Super Admin, Accounts.

### Routing/migration
- [ ] Legacy routes redirect correctly.
- [ ] No redirect loops.
- [ ] Deep links for existing customer and staff bookmarks remain valid or mapped.

### Operational readiness
- [ ] Error monitoring dashboards for auth/permissions/routes.
- [ ] Audit logs retained for sensitive actions.
- [ ] Rollback procedure documented and rehearsed.

---

## 7) Known risks

1. **Accidental staff exposure in public bundles**
   - Mitigation: bundle analysis + route-level CI checks + no staff components imported by public app.

2. **RLS gaps after route split**
   - Mitigation: policy test suite by role and table; block release on failures.

3. **Session/cookie issues if apps use different subdomains**
   - Mitigation: explicit cookie domain/sameSite testing in staging; do not assume automatic SSO.

4. **Legacy links breaking during migration**
   - Mitigation: redirect matrix + observability + gradual rollout.

5. **Role hierarchy drift in frontend checks**
   - Mitigation: central permission map in shared package + backend-enforced authorization.

6. **Data leakage via generic queries**
   - Mitigation: customer-safe views/endpoints, strict column selection, and API contract tests.

7. **Feature regressions from code movement**
   - Mitigation: move-first/no-refactor strategy, then incremental hardening with regression suite.
