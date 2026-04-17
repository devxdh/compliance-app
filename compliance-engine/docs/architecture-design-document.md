# Architecture Design Document

## System Position

### Layman Terms
Imagine a giant corporate building. The central API is the CEO sitting at headquarters, making decisions and keeping the master ledger. This repository (the worker) is the highly trained security guard sitting inside the local office. The guard's job is to protect the local vault, follow the CEO's orders, and occasionally send a report back to headquarters via certified mail.

### Technical Terms
This repository is the **data plane** of the larger compliance system.
- The central API acts as the **control plane** (orchestrator and legal certification authority).
- This worker runs inside the client's Virtual Private Cloud (VPC) and performs local cryptographic and database mutations against the client's PostgreSQL database.
- The only outward-facing data path is the outbox relay (Egress-Only networking via Long-Polling).

---

## Core Design Choices

### 1. Envelope Encryption

#### Layman Terms
Instead of leaving the master key to the safe lying around where a thief could find it, we give every single safe its own unique physical key. Then, we lock all those millions of unique physical keys inside a giant Master Safe. The combination to the Master Safe is only kept in the security guard's brain. If a thief steals the building (the database dump), they can't open anything because they don't have the combination.

#### Technical Terms
- `DEK (Data Encrypting Key)`: A unique, per-user AES-256 key used to encrypt the PII payload.
- `KEK (Key Encrypting Key)`: A worker-level master key, injected via environment variables. It never touches the disk. The `DEK` is encrypted with the `KEK` before being stored in the `user_keys` table.

### 2. HMAC-Backed Worker Identifiers

#### Layman Terms
We never write the user's real name or real ID on the outside of the safe. Instead, we put their name through a one-way meat grinder. It comes out as a random string of letters and numbers. We write that random string on the safe. The worker knows which user is which based on the ground-up string, but a hacker looking at the safe has no idea who it belongs to.

#### Technical Terms
The worker stores `user_uuid_hash` as an HMAC-SHA256 derived identifier rather than the raw public database `id`. This prevents exposing plain-text identifiers or sensitive correlation keys in the `pii_vault` or `outbox` schemas.

### 3. Recursive Graph Traversal Inside Postgres

#### Layman Terms
To find all the user's transaction logs across dozens of tables, we don't want the worker to constantly ask the database "what's connected to this?", waiting for an answer, and then asking "what's connected to that?" over and over. It's too slow. Instead, we give the database a magic map-making spell that allows the database itself to instantly draw the entire family tree of connected records and hand it back to us in one quick trip.

#### Technical Terms
The Foreign Key (FK) graph is read from PostgreSQL system catalogs (`pg_constraint`) via a Recursive Common Table Expression (CTE). Database-side traversal executes in C++ at $O(V+E)$ complexity, avoiding brittle, network-saturating $O(n^2)$ application-side loops in Node.js.

### 4. Local State Machine In PostgreSQL

#### Layman Terms
The worker cannot rely on its own memory to remember what it has done, because what if the power goes out? It writes down exactly what step of the process a user is in directly on the safe itself. This guarantees that if the worker restarts, it won't accidentally vault a user twice or send them two warning emails.

#### Technical Terms
The state machine is durable. Important columns in `pii_vault` (e.g., `retention_expiry`, `notification_lock_id`, `shredded_at`) track exact lifecycle phases. Atomicity and `REPEATABLE READ` isolation levels ensure that state transitions are strictly idempotent and immune to race conditions.

### 5. Transactional Outbox With Leases

#### Layman Terms
When the worker finishes locking the safe, it doesn't immediately try to call headquarters. What if the phone lines are down? The worker would be standing there holding the safe door open indefinitely. Instead, the worker drops a "success" postcard in a local outbox tray, closes the safe, and moves on. A separate mailman process grabs the postcards and tries to deliver them, retrying later if the phone lines are down.

#### Technical Terms
Outbox events (`USER_VAULTED`, `SHRED_SUCCESS`) are inserted in the exact same database transaction as the primary mutation, guaranteeing synchronization. Network delivery runs out-of-band using short row-level leases (`FOR UPDATE SKIP LOCKED`) to ensure concurrent workers do not dispatch duplicate webhooks. Permanent failures are routed to a Dead Letter Queue (`dead_letter`) after exponential backoff.
