/**
 * 
 * This file defines reusable "shape" types for JSON-like data used by API payloads.
 *
 * 
 * Shared structural types for serializable request/response and DB JSONB fields.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export interface JsonArray extends Array<JsonValue> { }
