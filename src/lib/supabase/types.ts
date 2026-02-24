// ============================================================
// Database types — generated via:
//   npx supabase gen types typescript --linked > src/lib/supabase/database-generated.ts
//
// DO NOT manually maintain table Row/Insert/Update types here.
// Keep this file as a stable wrapper around generated types.
// ============================================================

export type UserRole = "tenant" | "manager";
export type PropertyType = "single_family" | "multi_unit" | "condo" | "commercial";
export type UnitStatus = "occupied" | "vacant" | "maintenance";
export type TicketStatus = "open" | "in_progress" | "awaiting_tenant" | "escalated" | "resolved" | "closed";
export type TicketPriority = "low" | "medium" | "high" | "emergency";
export type TicketCategory =
  | "plumbing" | "electrical" | "hvac" | "appliance" | "structural"
  | "pest_control" | "locksmith" | "roofing" | "painting" | "flooring"
  | "landscaping" | "general" | "other";
export type MediaType = "photo" | "video";

import type { Database as GeneratedDatabase } from "@/lib/supabase/database-generated";

export type Database = GeneratedDatabase;

export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type Property = Database["public"]["Tables"]["properties"]["Row"];
export type Unit = Database["public"]["Tables"]["units"]["Row"];
export type Ticket = Database["public"]["Tables"]["tickets"]["Row"];
export type TicketMedia = Database["public"]["Tables"]["ticket_media"]["Row"];
export type Message = Database["public"]["Tables"]["messages"]["Row"];
export type Vendor = Database["public"]["Tables"]["vendors"]["Row"];
