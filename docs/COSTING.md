# Order costing

All displayed totals use whole satang. Ingredient unit prices retain six decimal places and recipe quantities four until the final rounding. Packaging rounds per packaging line; recipe food and recipe packaging each round once after summing.

- Customer due = products - discount + delivery + tip.
- Net revenue = customer due - payment processing fee. This app reports payment fees as a revenue deduction.
- Food unit cost = recipe ingredients + round(menu price x pooled basis points / 10000).
- Services never receive the pooled food percentage. Explicit recipe costs still apply to services.
- Order COGS = sum(food unit costs x quantity) + packaging actually handed out + explicit custom-item costs.
- Gross profit = net revenue - COGS. Net profit subtracts operating expenses; direct purchase expenses are not subtracted a second time.
- Outstanding is calculated per bill from customer due minus received payments, then summed. Overpayments on another bill do not reduce it.
- Boxes exclude add-ons, services, and unclassified custom items. Per-order averages include every confirmed order; per-box totals are explicitly labelled as total profit divided by food boxes.
- Menu reports allocate discounts by sales value and actual packaging by recipe packaging weights (quantity if there is no packaging recipe). Whole-satang remainders are retained. Delivery, tips, processing fees and any remaining header/line difference appear on a separate adjustment row. Report sums equal order totals.
- For missing packaging payloads (slip import), defaults use the maximum of dish and add-on quantities per packaging item, rounded up. Explicit [] always means no packaging. Both paths save actual counts.
- Purchase changes affect future menu costs. Only an explicit historical recalculation replaces historical prices. It preserves sold prices, pooled food amounts, actual quantities, custom costs, and a recorded zero-packaging choice. Service pooled amounts are corrected to zero. Recalculation runs in one PostgreSQL transaction and leaves an audit record.

## Estimates and existing data

The pooled percentage is estimated from recorded pooled purchases / gross sales of regular food menus over 30 days. Service and custom income and future records are excluded. It is not an inventory-consumption measurement. A comparison using purchase totals does not become actual accounting profit without opening/closing stock and wastage. Incorrect purchase quantities must be corrected from reliable records; the system never guesses or deletes unlinked purchases.

Install `supabase/migrations/202611010001_order_cost_consistency.sql` after prior migrations on each database before using this version. It installs functions and indexes without repricing existing orders. Historical correction remains explicit.

Also install `supabase/migrations/202611010002_refresh_legacy_packaging_costs.sql` for older imports that have a positive packaging total but no detailed packaging rows. A full recalculation refreshes those positive totals using current recipe packaging costs and quantities sold. It does not invent actual packaging counts. Recorded zero totals without tracking rows stay zero. Correct purchase quantities and recipe settings before repricing any historical bill.

## Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.

For database integration tests, run `powershell -NoProfile -File scripts/test-costing-db.ps1` with Docker available. This creates a fresh, isolated PostgreSQL 16 container with a minimal auth/storage harness, installs the relevant real migrations and checks mixed orders, services, custom costs, payments, zero/default packaging, invalid input rejection, more than 1000 bills/lines, and rollback on injected failure. It removes only its own temporary container. No project environment credentials or real customer records are used.
