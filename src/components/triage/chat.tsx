"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";

const DRAFT_TICKET_KEY = "propcare_draft_ticket_id";

interface ChatMessage {
  id: string;
  body: string;
  is_bot_reply: boolean;
  mediaUrl?: string;
  mediaType?: "photo" | "video";
}

export function TriageChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [triageState, setTriageState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Persist ticket_id to localStorage whenever it changes
  useEffect(() => {
    if (ticketId) {
      localStorage.setItem(DRAFT_TICKET_KEY, ticketId);
    }
  }, [ticketId]);

  // Clear draft when triage completes
  useEffect(() => {
    if (isComplete) {
      localStorage.removeItem(DRAFT_TICKET_KEY);
    }
  }, [isComplete]);

  // On mount: check for an in-progress draft and resume
  const resumeDraft = useCallback(async () => {
    const savedId = localStorage.getItem(DRAFT_TICKET_KEY);
    if (!savedId) return;

    setIsResuming(true);
    try {
      const res = await fetch(`/api/triage/chat?ticket_id=${savedId}`);
      if (!res.ok) {
        // Draft ticket no longer accessible — clear stale reference
        localStorage.removeItem(DRAFT_TICKET_KEY);
        return;
      }

      const data = await res.json();

      // If triage was already completed, clear draft and start fresh
      if (data.is_complete) {
        localStorage.removeItem(DRAFT_TICKET_KEY);
        return;
      }

      // Hydrate state from server
      setTicketId(data.ticket_id);
      setTriageState(data.triage_state ?? null);
      setIsComplete(data.is_complete);

      // Build message list from server messages
      const chatMessages: ChatMessage[] = (data.messages ?? []).map(
        (m: { id: string; body: string; is_bot_reply: boolean }) => ({
          id: m.id,
          body: m.body,
          is_bot_reply: m.is_bot_reply,
        })
      );

      // Inject media records as synthetic user messages positioned by timestamp
      if (data.media && data.media.length > 0) {
        for (const m of data.media as Array<{
          id: string;
          file_type: string;
          mime_type: string;
          signed_url: string;
          created_at: string;
        }>) {
          const mediaType = m.file_type === "video" ? "video" : "photo";
          const label = mediaType === "video" ? "Video uploaded" : "Photo uploaded";
          const mediaMsg: ChatMessage = {
            id: `media-${m.id}`,
            body: label,
            is_bot_reply: false,
            mediaUrl: m.signed_url,
            mediaType,
          };

          // Insert before the first message whose created_at comes after this media
          const insertIdx = chatMessages.findIndex(
            (cm) => {
              // Server messages have the full object with created_at in data.messages
              const serverMsg = (data.messages ?? []).find(
                (sm: { id: string; created_at: string }) => sm.id === cm.id
              );
              return serverMsg && serverMsg.created_at > m.created_at;
            }
          );
          if (insertIdx >= 0) {
            chatMessages.splice(insertIdx, 0, mediaMsg);
          } else {
            chatMessages.push(mediaMsg);
          }
        }
      }

      setMessages(chatMessages);
    } catch {
      // Network error on resume — clear stale draft
      localStorage.removeItem(DRAFT_TICKET_KEY);
    } finally {
      setIsResuming(false);
    }
  }, []);

  useEffect(() => {
    resumeDraft();
  }, [resumeDraft]);

  async function handleSend() {
    const text = input.trim();
    if (!text || isLoading || isComplete) return;

    setError(null);
    setIsLoading(true);

    // Optimistic: show user message immediately
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      body: text,
      is_bot_reply: false,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");

    try {
      const res = await fetch("/api/triage/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, ticket_id: ticketId }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Something went wrong");
        return;
      }

      if (!ticketId) {
        setTicketId(data.ticket_id);
      }
      setTriageState(data.triage_state ?? null);

      const botMsg: ChatMessage = {
        id: `bot-${Date.now()}`,
        body: data.reply,
        is_bot_reply: true,
      };
      setMessages((prev) => [...prev, botMsg]);

      if (data.is_complete) {
        setIsComplete(true);
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleConfirmProfile(action: "yes" | "change") {
    if (isLoading || isComplete || !ticketId) return;

    setError(null);
    setIsLoading(true);

    // Show user's choice as a chat message
    const userText = action === "yes" ? "Looks correct" : "I'd like to update my info";
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      body: userText,
      is_bot_reply: false,
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const res = await fetch("/api/triage/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: action, ticket_id: ticketId, confirm_profile: action }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Something went wrong");
        return;
      }

      setTriageState(data.triage_state ?? null);

      const botMsg: ChatMessage = {
        id: `bot-${Date.now()}`,
        body: data.reply,
        is_bot_reply: true,
      };
      setMessages((prev) => [...prev, botMsg]);

      if (data.is_complete) {
        setIsComplete(true);
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleMediaAction(action: "skip") {
    if (isLoading || isComplete || !ticketId) return;

    setError(null);
    setIsLoading(true);

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      body: "Skip",
      is_bot_reply: false,
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const res = await fetch("/api/triage/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: action, ticket_id: ticketId, media_action: action }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Something went wrong");
        return;
      }

      setTriageState(data.triage_state ?? null);

      const botMsg: ChatMessage = {
        id: `bot-${Date.now()}`,
        body: data.reply,
        is_bot_reply: true,
      };
      setMessages((prev) => [...prev, botMsg]);

      if (data.is_complete) {
        setIsComplete(true);
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !ticketId || isUploading) return;

    setError(null);
    setIsUploading(true);

    // Show upload message
    const fileType = file.type.startsWith("video/") ? "video" : "photo";
    const uploadMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      body: `Uploading ${fileType}...`,
      is_bot_reply: false,
    };
    setMessages((prev) => [...prev, uploadMsg]);

    try {
      // 1. Upload file
      const formData = new FormData();
      formData.append("file", file);
      formData.append("ticket_id", ticketId);

      const uploadRes = await fetch("/api/triage/media", {
        method: "POST",
        body: formData,
      });

      const uploadData = await uploadRes.json();

      if (!uploadRes.ok) {
        setError(uploadData.error ?? "Upload failed");
        // Update the upload message to show failure
        setMessages((prev) =>
          prev.map((m) =>
            m.id === uploadMsg.id
              ? { ...m, body: `${fileType} upload failed` }
              : m
          )
        );
        return;
      }

      // Update the upload message to show success + media preview
      const blobUrl = URL.createObjectURL(file);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === uploadMsg.id
            ? {
                ...m,
                body: `${fileType.charAt(0).toUpperCase() + fileType.slice(1)} uploaded`,
                mediaUrl: blobUrl,
                mediaType: fileType as "photo" | "video",
              }
            : m
        )
      );

      // Show success + give option to upload more or continue
      const successMsg: ChatMessage = {
        id: `bot-${Date.now()}`,
        body: "Got it, thanks! You can upload another file or skip to continue.",
        is_bot_reply: true,
      };
      setMessages((prev) => [...prev, successMsg]);

    } catch {
      setError("Upload failed. Please try again.");
    } finally {
      setIsUploading(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function triggerFileUpload(accept: string) {
    if (fileInputRef.current) {
      fileInputRef.current.accept = accept;
      fileInputRef.current.click();
    }
  }

  // Show loading skeleton while resuming
  if (isResuming) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-gray-600">Resuming your conversation...</p>
      </div>
    );
  }

  const showMediaControls =
    triageState === "AWAITING_MEDIA" && !isComplete && !isLoading && !isUploading;

  return (
    <div className="flex h-full flex-col">
      {/* Hidden file input for uploads */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileUpload}
        accept="image/*,video/*"
      />

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-gray-600 mt-8">
            <p className="text-lg font-medium text-gray-900">Report a Maintenance Issue</p>
            <p className="mt-1 text-sm">
              Describe your issue below and we&apos;ll help you get it resolved.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.is_bot_reply ? "justify-start" : "justify-end"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                msg.is_bot_reply
                  ? "bg-gray-100 text-gray-900"
                  : "bg-blue-600 text-white"
              }`}
            >
              {msg.body}
              {msg.mediaUrl && msg.mediaType === "photo" && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={msg.mediaUrl}
                  alt="Uploaded photo"
                  className="mt-2 max-w-full rounded-lg"
                />
              )}
              {msg.mediaUrl && msg.mediaType === "video" && (
                <video
                  src={msg.mediaUrl}
                  controls
                  className="mt-2 max-w-full rounded-lg"
                />
              )}
            </div>
          </div>
        ))}

        {(isLoading || isUploading) && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-2xl px-4 py-2.5 text-sm text-gray-600">
              {isUploading ? "Uploading..." : "Typing..."}
            </div>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mx-4 mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Completion banner */}
      {isComplete && (
        <div className="mx-4 mb-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
          Triage complete. Your ticket has been submitted to your property manager.
        </div>
      )}

      {/* Confirm Profile buttons */}
      {triageState === "CONFIRM_PROFILE" && !isComplete && !isLoading && (
        <div className="border-t border-gray-200 p-4 flex gap-2">
          <Button onClick={() => handleConfirmProfile("yes")} size="md">
            Looks correct
          </Button>
          <Button onClick={() => handleConfirmProfile("change")} variant="secondary" size="md">
            Update my info
          </Button>
        </div>
      )}

      {/* Media upload controls */}
      {showMediaControls && (
        <div className="border-t border-gray-200 p-4">
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => triggerFileUpload("image/jpeg,image/png,image/webp,image/heic")}
              size="md"
              variant="secondary"
            >
              Upload Photo
            </Button>
            <Button
              onClick={() => triggerFileUpload("video/mp4,video/quicktime,video/webm")}
              size="md"
              variant="secondary"
            >
              Upload Video
            </Button>
            <Button
              onClick={() => handleMediaAction("skip")}
              size="md"
              variant="ghost"
            >
              Skip
            </Button>
          </div>
        </div>
      )}

      {/* Input */}
      {triageState !== "CONFIRM_PROFILE" && triageState !== "AWAITING_MEDIA" && (
        <div className="border-t border-gray-200 p-4">
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isComplete
                  ? "Triage complete"
                  : messages.length === 0
                  ? "Describe your maintenance issue..."
                  : "Type your reply..."
              }
              disabled={isComplete || isLoading}
              rows={1}
              className="flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
            />
            <Button
              onClick={handleSend}
              disabled={!input.trim() || isLoading || isComplete}
              size="md"
            >
              Send
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
