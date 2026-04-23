/**
 * Shared worker support surface.
 *
 * This file intentionally acts as the stable barrel for worker helpers that are consumed across
 * vaulting, notification, shredding, and network modules. Each concern lives in its own file so
 * high-churn logic stays easier to reason about.
 */
export * from "./identity";
export * from "./outbox";
export * from "./runtime";
export * from "./types";
export * from "./vault-store";
