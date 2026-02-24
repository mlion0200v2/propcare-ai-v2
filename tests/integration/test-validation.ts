/**
 * Test 8: Zod Validation Schemas
 * Run:  npx tsx tests/integration/test-validation.ts
 */
import { createRunner, printSection, runStandalone, type TestResult } from "./helpers";

import {
  createTicketSchema,
  updateTicketSchema,
  createPropertySchema,
  createUnitSchema,
  createMessageSchema,
  createVendorSchema,
  signUpSchema,
  signInSchema,
  mediaFileSchema,
} from "../../src/lib/utils/validation";

export function testValidation(): TestResult {
  printSection("Zod Validation Schemas");
  const { pass, fail, result } = createRunner();

  // Helpers
  function expectValid(
    label: string,
    schema: { safeParse: (d: unknown) => { success: boolean; error?: unknown } },
    data: unknown
  ) {
    const r = schema.safeParse(data);
    r.success ? pass(`${label} — accepted`) : fail(`${label} — rejected valid input`, r.error);
  }

  function expectInvalid(
    label: string,
    schema: { safeParse: (d: unknown) => { success: boolean } },
    data: unknown
  ) {
    const r = schema.safeParse(data);
    !r.success ? pass(`${label} — rejected`) : fail(`${label} — should have rejected`);
  }

  // ── createTicketSchema ──
  expectValid("createTicket: valid full input", createTicketSchema, {
    title: "Leaky faucet in kitchen",
    description: "The kitchen faucet has been dripping for two days straight",
    category: "plumbing",
    priority: "medium",
    unit_id: "550e8400-e29b-41d4-a716-446655440000",
  });
  expectInvalid("createTicket: title too short", createTicketSchema, {
    title: "Hi",
    description: "The kitchen faucet has been dripping for two days",
    unit_id: "550e8400-e29b-41d4-a716-446655440000",
  });
  expectInvalid("createTicket: description too short", createTicketSchema, {
    title: "Leaky faucet",
    description: "Short",
    unit_id: "550e8400-e29b-41d4-a716-446655440000",
  });
  expectInvalid("createTicket: missing unit_id", createTicketSchema, {
    title: "Leaky faucet in kitchen",
    description: "The kitchen faucet has been dripping for two days",
  });
  expectInvalid("createTicket: invalid uuid", createTicketSchema, {
    title: "Leaky faucet in kitchen",
    description: "The kitchen faucet has been dripping for two days",
    unit_id: "not-a-uuid",
  });

  // ── updateTicketSchema ──
  expectValid("updateTicket: partial update", updateTicketSchema, {
    status: "resolved",
    priority: "high",
  });
  expectInvalid("updateTicket: invalid status", updateTicketSchema, {
    status: "invalid_status",
  });

  // ── createPropertySchema ──
  expectValid("createProperty: valid input", createPropertySchema, {
    address_line1: "123 Main St",
    city: "Austin",
    state: "TX",
    zip: "78701",
    property_type: "multi_unit",
  });
  expectValid("createProperty: ZIP+4 format", createPropertySchema, {
    address_line1: "123 Main St",
    city: "Austin",
    state: "TX",
    zip: "78701-1234",
    property_type: "condo",
  });
  expectInvalid("createProperty: invalid ZIP", createPropertySchema, {
    address_line1: "123 Main St",
    city: "Austin",
    state: "TX",
    zip: "ABCDE",
    property_type: "multi_unit",
  });

  // ── createUnitSchema ──
  expectValid("createUnit: valid input", createUnitSchema, {
    property_id: "550e8400-e29b-41d4-a716-446655440000",
    unit_number: "101",
    status: "vacant",
  });

  // ── createMessageSchema ──
  expectValid("createMessage: valid input", createMessageSchema, {
    ticket_id: "550e8400-e29b-41d4-a716-446655440000",
    body: "Can you check this issue please?",
  });
  expectInvalid("createMessage: empty body", createMessageSchema, {
    ticket_id: "550e8400-e29b-41d4-a716-446655440000",
    body: "",
  });

  // ── createVendorSchema ──
  expectValid("createVendor: valid full input", createVendorSchema, {
    name: "Quick Fix Plumbing",
    trade: "plumbing",
    phone: "512-555-1234",
    email: "info@quickfix.com",
    rating: 4.5,
  });
  expectInvalid("createVendor: rating > 5", createVendorSchema, {
    name: "Bad Vendor",
    trade: "plumbing",
    rating: 6,
  });
  expectInvalid("createVendor: rating < 1", createVendorSchema, {
    name: "Bad Vendor",
    trade: "plumbing",
    rating: 0,
  });

  // ── signUpSchema ──
  expectValid("signUp: valid input", signUpSchema, {
    email: "newuser@example.com",
    password: "securepass123",
    full_name: "Jane Doe",
    role: "tenant",
  });
  expectInvalid("signUp: short password", signUpSchema, {
    email: "newuser@example.com",
    password: "short",
    full_name: "Jane Doe",
    role: "tenant",
  });
  expectInvalid("signUp: invalid email", signUpSchema, {
    email: "not-an-email",
    password: "securepass123",
    full_name: "Jane Doe",
    role: "tenant",
  });

  // ── signInSchema ──
  expectValid("signIn: valid input", signInSchema, {
    email: "user@example.com",
    password: "password123",
  });

  // ── mediaFileSchema ──
  expectValid("media: valid photo (2MB JPEG)", mediaFileSchema, {
    file_type: "photo",
    mime_type: "image/jpeg",
    file_size: 2 * 1024 * 1024,
  });
  expectInvalid("media: oversized photo (15MB > 10MB)", mediaFileSchema, {
    file_type: "photo",
    mime_type: "image/jpeg",
    file_size: 15 * 1024 * 1024,
  });
  expectValid("media: valid video (50MB MP4)", mediaFileSchema, {
    file_type: "video",
    mime_type: "video/mp4",
    file_size: 50 * 1024 * 1024,
  });
  expectInvalid("media: invalid mime (PDF as photo)", mediaFileSchema, {
    file_type: "photo",
    mime_type: "application/pdf",
    file_size: 1024,
  });

  return result;
}

// Standalone
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-validation");
if (isMain) runStandalone(async () => testValidation());
