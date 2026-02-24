"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";

const DRAFT_TICKET_KEY = "propcare_draft_ticket_id";

interface ChatMessage {
  id: string;
  body: string;
  is_bot_reply: boolean;
}

export function TriageChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
      setIsComplete(data.is_complete);
      setMessages(
        (data.messages ?? []).map((m: { id: string; body: string; is_bot_reply: boolean }) => ({
          id: m.id,
          body: m.body,
          is_bot_reply: m.is_bot_reply,
        }))
      );
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

  // Show loading skeleton while resuming
  if (isResuming) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-gray-500">Resuming your conversation...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-gray-500 mt-8">
            <p className="text-lg font-medium">Report a Maintenance Issue</p>
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
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-2xl px-4 py-2.5 text-sm text-gray-500">
              Typing...
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

      {/* Input */}
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
            className="flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50"
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
    </div>
  );
}
