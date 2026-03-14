/**
 * POST /api/triage/media — upload photo/video for a triage ticket
 *
 * Accepts multipart/form-data with:
 *   - file: the photo or video file
 *   - ticket_id: the ticket to associate with
 *
 * Stores the file in Supabase Storage (ticket-media bucket)
 * and creates a ticket_media record.
 *
 * Upload path format:
 *   <user_id>/<ticket_id>/<timestamp>-<random>.<ext>
 *
 * The user_id prefix enables folder-ownership RLS on storage.objects:
 *   (storage.foldername(name))[1] = auth.uid()::text
 *
 * Response:
 *   { media_id, file_path, file_type }
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database-generated";

const BUCKET = "ticket-media";
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const ALLOWED_TYPES = [...ALLOWED_PHOTO_TYPES, ...ALLOWED_VIDEO_TYPES];

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const ticketId = formData.get("ticket_id") as string | null;

    if (!file || !ticketId) {
      return NextResponse.json(
        { error: "file and ticket_id are required" },
        { status: 400 }
      );
    }

    // Validate file type
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type}. Allowed: JPEG, PNG, WebP, HEIC, MP4, MOV, WebM` },
        { status: 400 }
      );
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "File too large. Maximum size is 25 MB." },
        { status: 400 }
      );
    }

    // Verify ticket belongs to user
    const { data: ticket, error: ticketErr } = await supabase
      .from("tickets")
      .select("id")
      .eq("id", ticketId)
      .eq("tenant_id", user.id)
      .single();

    if (ticketErr || !ticket) {
      console.error("[media] ticket not found or access denied", {
        ticketId,
        userId: user.id,
        error: ticketErr?.message,
      });
      return NextResponse.json(
        { error: "Ticket not found" },
        { status: 404 }
      );
    }

    // Determine file type
    const fileType: Database["public"]["Enums"]["media_type"] =
      ALLOWED_VIDEO_TYPES.includes(file.type) ? "video" : "photo";

    // Generate file path: <user_id>/<ticket_id>/<timestamp>-<random>.<ext>
    // The user_id prefix is required by storage RLS folder-ownership policies
    const ext = file.name.split(".").pop() ?? (fileType === "photo" ? "jpg" : "mp4");
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filePath = `${user.id}/${ticketId}/${fileName}`;

    console.log("[media] uploading", {
      userId: user.id,
      ticketId,
      bucket: BUCKET,
      filePath,
      fileType,
      fileSize: file.size,
      mimeType: file.type,
    });

    // Upload to Supabase Storage
    const fileBuffer = await file.arrayBuffer();
    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(filePath, fileBuffer, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadErr) {
      console.error("[media] storage upload failed", {
        message: uploadErr.message,
        bucket: BUCKET,
        filePath,
        userId: user.id,
        ticketId,
      });
      return NextResponse.json(
        { error: "Upload failed" },
        { status: 500 }
      );
    }

    console.log("[media] storage upload succeeded", { filePath });

    // Get current max display_order for this ticket
    const { data: existingMedia } = await supabase
      .from("ticket_media")
      .select("display_order")
      .eq("ticket_id", ticketId)
      .order("display_order", { ascending: false })
      .limit(1);

    const nextOrder = (existingMedia?.[0]?.display_order ?? -1) + 1;

    // Create ticket_media record
    const { data: media, error: mediaErr } = await supabase
      .from("ticket_media")
      .insert({
        ticket_id: ticketId,
        uploaded_by: user.id,
        file_path: filePath,
        file_size: file.size,
        file_type: fileType,
        mime_type: file.type,
        display_order: nextOrder,
      })
      .select("id, file_path, file_type")
      .single();

    if (mediaErr || !media) {
      console.error("[media] ticket_media insert failed", {
        message: mediaErr?.message,
        code: mediaErr?.code,
        details: mediaErr?.details,
        ticketId,
        userId: user.id,
        filePath,
      });
      return NextResponse.json(
        { error: "Failed to save media record" },
        { status: 500 }
      );
    }

    console.log("[media] ticket_media record created", {
      mediaId: media.id,
      filePath: media.file_path,
      fileType: media.file_type,
    });

    return NextResponse.json({
      media_id: media.id,
      file_path: media.file_path,
      file_type: media.file_type,
    });
  } catch (err: unknown) {
    console.error("[media] fatal", {
      err,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.json(
      { error: "upload_failed", details: String(err) },
      { status: 500 }
    );
  }
}
