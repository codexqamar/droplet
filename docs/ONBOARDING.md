# Selling DROPLET to a business: onboarding guide

Each business that buys DROPLET gets **its own install**: its own server, its own database, its own
admin portal, and its own trade customers. Nothing is shared between businesses.

## Roles

| Role | Who | Can do |
|---|---|---|
| **You (operator)** | DROPLET, the seller | Deploy an install, generate its one-time setup link, ship desktop releases |
| **Administrator** | Staff at the business | Everything in the admin portal: approve accounts, pricing, catalogue, orders, quotes, team, security, settings |
| **Account manager** | Staff at the business | Only the trade accounts assigned to them: their orders and quotes |
| **Trade buyer** | The business's customers | The trade portal and desktop app for their own account |

## 1. You hand over a new install

1. Deploy the install (API + database + portal). On a fresh database there is no administrator.
2. Generate the one-time setup link:

   ```bash
   npm --prefix apps/cloud-api run setup-link
   ```

   The link is also printed in the API log on first boot. It is valid for 72 hours, works once,
   and stops working for good after the first administrator exists. Run the command again for a
   fresh link if it expires.
3. Send the link to the business owner.

## 2. The business creates its first administrator

Opening the link shows **Set up your trade portal**: business name, their name, email and
password. That creates the first administrator. On first sign-in they must turn on two-step
verification (authenticator app) before the admin portal opens. Every staff account has the
same requirement.

## 3. The business onboards its team

Admin portal → **Team** → **Invite staff**, as Administrator or Account manager. The person
gets a one-time link (emailed, and shown to copy) valid for 7 days, sets their own password,
then turns on two-step verification at first sign-in.

## 4. The business onboards its customers

Two ways:

* **Customer applies** from the portal's *Apply for an account* page. The application shows
  under Admin portal → **Trade accounts → Applications**. The administrator sets the price tier,
  credit limit, payment terms and account manager, then selects **Approve account**. The customer
  is emailed and can sign in. **Reject** or **Suspend** take an optional reason the customer sees.
* **Administrator opens the account** directly (**Trade accounts → Open account**) for
  phone or in-person sales. The contact receives an invitation link to set a password.

More buyers on the same account: open the account → **People** → **Invite buyer**.

## 5. Day to day in the admin portal

* **Orders**: approve orders that exceed the customer's credit, then confirm, ship and invoice.
  Invoicing posts the amount to the customer's statement with their payment terms.
* **Quotes**: price each line and send the offer; the customer accepts it from their portal and
  it becomes an order at the offered prices.
* **Catalogue**: products, stock, list prices, price tiers with quantity breaks. Contract prices
  for a single customer are set on the account (**Contract prices** tab).
* **Trade accounts → Statement**: record payments received, credit notes and adjustments.
* **Security**: desktop installs, tamper incidents, signed releases and the audit log. A
  confirmed false-positive lock can be lifted from the account (**Override security lock**).

## Ordering for a customer

Admin portal → **Trade accounts** → open the account → **New order**. Staff type SKUs and
quantities exactly like the customer's quick order, at the customer's own prices (contract,
then tier, then list). The order is marked as placed by the account manager, runs the same
credit check (over-limit orders wait in **Orders** for approval) and the customer's buyers are
emailed. Account managers can do this only for accounts assigned to them.

## Notifications

The bell in the admin portal's top bar shows new applications, new orders, orders needing
approval, quote requests and acceptances, security locks, people joining and desktop
connections, with a pop-up as each one arrives. Live on the web; the desktop app checks every
15 seconds. Account managers only see events for their own accounts, and nobody is notified
about their own actions.

## Desktop app for staff

The desktop app's title bar has an **Admin portal** button (shield icon), and the connect screen
has **Staff member? Sign in to the admin portal**. Staff sign in with email, password and
authenticator code; the session is held in memory by the app and ends when it closes.

## Development data

`npm run setup` creates an empty install. Optional demo data for local development only:
`npm --prefix apps/cloud-api run db:demo` (refuses to run on an install that has completed setup).
