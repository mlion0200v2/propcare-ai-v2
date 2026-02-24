// ============================================================
// App-wide constants and enum value lists
// ============================================================

export const USER_ROLES = ["tenant", "manager"] as const;

export const PROPERTY_TYPES = ["single_family", "multi_unit", "condo", "commercial"] as const;

export const UNIT_STATUSES = ["occupied", "vacant", "maintenance"] as const;

export const TICKET_STATUSES = [
  "open",
  "in_progress",
  "awaiting_tenant",
  "escalated",
  "resolved",
  "closed",
] as const;

export const TICKET_PRIORITIES = ["low", "medium", "high", "emergency"] as const;

export const TICKET_CATEGORIES = [
  "plumbing",
  "electrical",
  "hvac",
  "appliance",
  "structural",
  "pest_control",
  "locksmith",
  "roofing",
  "painting",
  "flooring",
  "landscaping",
  "general",
  "other",
] as const;

export const MEDIA_TYPES = ["photo", "video"] as const;

// Display labels for categories
export const CATEGORY_LABELS: Record<(typeof TICKET_CATEGORIES)[number], string> = {
  plumbing: "Plumbing",
  electrical: "Electrical",
  hvac: "HVAC",
  appliance: "Appliance",
  structural: "Structural",
  pest_control: "Pest Control",
  locksmith: "Locksmith",
  roofing: "Roofing",
  painting: "Painting",
  flooring: "Flooring",
  landscaping: "Landscaping",
  general: "General",
  other: "Other",
};

export const PRIORITY_LABELS: Record<(typeof TICKET_PRIORITIES)[number], string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  emergency: "Emergency",
};

export const STATUS_LABELS: Record<(typeof TICKET_STATUSES)[number], string> = {
  open: "Open",
  in_progress: "In Progress",
  awaiting_tenant: "Awaiting Tenant",
  escalated: "Escalated",
  resolved: "Resolved",
  closed: "Closed",
};

// Media constraints
export const MAX_PHOTOS_PER_TICKET = 5;
export const MAX_VIDEOS_PER_TICKET = 1;
export const MAX_PHOTO_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_VIDEO_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
export const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/heic", "image/webp"];
export const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime"];
