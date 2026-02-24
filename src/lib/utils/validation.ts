import { z } from "zod";
import {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  PROPERTY_TYPES,
  UNIT_STATUSES,
  ALLOWED_PHOTO_TYPES,
  ALLOWED_VIDEO_TYPES,
  MAX_PHOTO_SIZE_BYTES,
  MAX_VIDEO_SIZE_BYTES,
  MAX_PHOTOS_PER_TICKET,
  MAX_VIDEOS_PER_TICKET,
} from "./constants";

// ============================================================
// Tickets
// ============================================================

export const createTicketSchema = z.object({
  title: z.string().min(5, "Title must be at least 5 characters").max(200),
  description: z.string().min(10, "Please describe the issue in more detail").max(5000),
  category: z.enum(TICKET_CATEGORIES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  unit_id: z.string().uuid("Invalid unit"),
});

export const updateTicketSchema = z.object({
  title: z.string().min(5).max(200).optional(),
  description: z.string().min(10).max(5000).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  status: z.enum(["open", "in_progress", "awaiting_tenant", "escalated", "resolved", "closed"] as const).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
});

// ============================================================
// Media
// ============================================================

export const mediaFileSchema = z.object({
  file_type: z.enum(["photo", "video"]),
  mime_type: z.string(),
  file_size: z.number().positive(),
}).refine(
  (data) => {
    if (data.file_type === "photo") {
      return ALLOWED_PHOTO_TYPES.includes(data.mime_type) && data.file_size <= MAX_PHOTO_SIZE_BYTES;
    }
    return ALLOWED_VIDEO_TYPES.includes(data.mime_type) && data.file_size <= MAX_VIDEO_SIZE_BYTES;
  },
  {
    message: "Invalid file type or file exceeds size limit",
  }
);

export const ticketMediaUploadSchema = z.object({
  photos: z.array(mediaFileSchema).max(MAX_PHOTOS_PER_TICKET, `Maximum ${MAX_PHOTOS_PER_TICKET} photos`).optional(),
  videos: z.array(mediaFileSchema).max(MAX_VIDEOS_PER_TICKET, `Maximum ${MAX_VIDEOS_PER_TICKET} video`).optional(),
});

// ============================================================
// Properties
// ============================================================

export const createPropertySchema = z.object({
  address_line1: z.string().min(1, "Address is required").max(200),
  address_line2: z.string().max(200).optional(),
  city: z.string().min(1, "City is required").max(100),
  state: z.string().min(2, "State is required").max(2),
  zip: z.string().regex(/^\d{5}(-\d{4})?$/, "Invalid ZIP code"),
  property_type: z.enum(PROPERTY_TYPES),
});

export const updatePropertySchema = createPropertySchema.partial();

// ============================================================
// Units
// ============================================================

export const createUnitSchema = z.object({
  property_id: z.string().uuid("Invalid property"),
  unit_number: z.string().max(20).optional(),
  tenant_id: z.string().uuid().nullable().optional(),
  status: z.enum(UNIT_STATUSES).optional(),
});

export const updateUnitSchema = createUnitSchema.partial().omit({ property_id: true });

// ============================================================
// Messages
// ============================================================

export const createMessageSchema = z.object({
  ticket_id: z.string().uuid("Invalid ticket"),
  body: z.string().min(1, "Message cannot be empty").max(5000),
});

// ============================================================
// Vendors
// ============================================================

export const createVendorSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  trade: z.enum(TICKET_CATEGORIES),
  phone: z.string().max(20).optional(),
  email: z.string().email().optional(),
  rating: z.number().min(1).max(5).optional(),
  notes: z.string().max(2000).optional(),
});

export const updateVendorSchema = createVendorSchema.partial();

// ============================================================
// Tenant Info (triage — no-unit flow)
// ============================================================

/** Loose phone regex: digits, spaces, dashes, parens, optional leading + */
const PHONE_REGEX = /^\+?[\d\s\-().]{7,20}$/;

export const tenantInfoPhoneSchema = z
  .string()
  .regex(PHONE_REGEX, "Please enter a valid phone number (e.g., 555-123-4567)");

export const tenantInfoEmailSchema = z.string().email("Please enter a valid email address");

// ============================================================
// Auth
// ============================================================

export const signUpSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  full_name: z.string().min(1, "Name is required").max(100),
  role: z.enum(["tenant", "manager"]),
});

export const signInSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(1, "Password is required"),
});

// ============================================================
// Type exports (inferred from schemas)
// ============================================================

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type CreatePropertyInput = z.infer<typeof createPropertySchema>;
export type CreateUnitInput = z.infer<typeof createUnitSchema>;
export type CreateMessageInput = z.infer<typeof createMessageSchema>;
export type CreateVendorInput = z.infer<typeof createVendorSchema>;
export type SignUpInput = z.infer<typeof signUpSchema>;
export type SignInInput = z.infer<typeof signInSchema>;
