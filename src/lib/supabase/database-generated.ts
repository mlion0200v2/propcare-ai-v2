export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      messages: {
        Row: {
          body: string
          created_at: string
          id: string
          is_bot_reply: boolean
          sender_id: string
          ticket_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          is_bot_reply?: boolean
          sender_id: string
          ticket_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          is_bot_reply?: boolean
          sender_id?: string
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          default_property_address: string | null
          default_unit_number: string | null
          email: string
          full_name: string
          id: string
          phone: string | null
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          default_property_address?: string | null
          default_unit_number?: string | null
          email: string
          full_name: string
          id: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          default_property_address?: string | null
          default_unit_number?: string | null
          email?: string
          full_name?: string
          id?: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Relationships: []
      }
      properties: {
        Row: {
          address_line1: string
          address_line2: string | null
          city: string
          created_at: string
          id: string
          manager_id: string
          property_type: Database["public"]["Enums"]["property_type"]
          state: string
          updated_at: string
          zip: string
        }
        Insert: {
          address_line1: string
          address_line2?: string | null
          city: string
          created_at?: string
          id?: string
          manager_id: string
          property_type?: Database["public"]["Enums"]["property_type"]
          state: string
          updated_at?: string
          zip: string
        }
        Update: {
          address_line1?: string
          address_line2?: string | null
          city?: string
          created_at?: string
          id?: string
          manager_id?: string
          property_type?: Database["public"]["Enums"]["property_type"]
          state?: string
          updated_at?: string
          zip?: string
        }
        Relationships: [
          {
            foreignKeyName: "properties_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ticket_media: {
        Row: {
          created_at: string
          display_order: number
          file_path: string
          file_size: number
          file_type: Database["public"]["Enums"]["media_type"]
          id: string
          mime_type: string
          ticket_id: string
          uploaded_by: string
        }
        Insert: {
          created_at?: string
          display_order?: number
          file_path: string
          file_size: number
          file_type: Database["public"]["Enums"]["media_type"]
          id?: string
          mime_type: string
          ticket_id: string
          uploaded_by: string
        }
        Update: {
          created_at?: string
          display_order?: number
          file_path?: string
          file_size?: number
          file_type?: Database["public"]["Enums"]["media_type"]
          id?: string
          mime_type?: string
          ticket_id?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_media_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "tickets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_media_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tickets: {
        Row: {
          assigned_to: string | null
          category: Database["public"]["Enums"]["ticket_category"]
          classification: Json | null
          created_at: string
          description: string
          id: string
          priority: Database["public"]["Enums"]["ticket_priority"]
          resolved_at: string | null
          safety_assessment: Json | null
          similar_issues: Json | null
          status: Database["public"]["Enums"]["ticket_status"]
          tenant_id: string
          title: string
          trace_id: string | null
          triage_state: string
          troubleshooting_steps: Json | null
          unit_id: string | null
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          category?: Database["public"]["Enums"]["ticket_category"]
          classification?: Json | null
          created_at?: string
          description: string
          id?: string
          priority?: Database["public"]["Enums"]["ticket_priority"]
          resolved_at?: string | null
          safety_assessment?: Json | null
          similar_issues?: Json | null
          status?: Database["public"]["Enums"]["ticket_status"]
          tenant_id: string
          title: string
          trace_id?: string | null
          triage_state?: string
          troubleshooting_steps?: Json | null
          unit_id?: string | null
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          category?: Database["public"]["Enums"]["ticket_category"]
          classification?: Json | null
          created_at?: string
          description?: string
          id?: string
          priority?: Database["public"]["Enums"]["ticket_priority"]
          resolved_at?: string | null
          safety_assessment?: Json | null
          similar_issues?: Json | null
          status?: Database["public"]["Enums"]["ticket_status"]
          tenant_id?: string
          title?: string
          trace_id?: string | null
          triage_state?: string
          troubleshooting_steps?: Json | null
          unit_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tickets_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tickets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tickets_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
        ]
      }
      units: {
        Row: {
          created_at: string
          id: string
          property_id: string
          status: Database["public"]["Enums"]["unit_status"]
          tenant_id: string | null
          unit_number: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          property_id: string
          status?: Database["public"]["Enums"]["unit_status"]
          tenant_id?: string | null
          unit_number?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          property_id?: string
          status?: Database["public"]["Enums"]["unit_status"]
          tenant_id?: string | null
          unit_number?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "units_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "units_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      vendors: {
        Row: {
          created_at: string
          email: string | null
          id: string
          manager_id: string
          name: string
          notes: string | null
          phone: string | null
          rating: number | null
          trade: Database["public"]["Enums"]["ticket_category"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          manager_id: string
          name: string
          notes?: string | null
          phone?: string | null
          rating?: number | null
          trade: Database["public"]["Enums"]["ticket_category"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          manager_id?: string
          name?: string
          notes?: string | null
          phone?: string | null
          rating?: number | null
          trade?: Database["public"]["Enums"]["ticket_category"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendors_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      media_type: "photo" | "video"
      property_type: "single_family" | "multi_unit" | "condo" | "commercial"
      ticket_category:
        | "plumbing"
        | "electrical"
        | "hvac"
        | "appliance"
        | "structural"
        | "pest_control"
        | "locksmith"
        | "roofing"
        | "painting"
        | "flooring"
        | "landscaping"
        | "general"
        | "other"
      ticket_priority: "low" | "medium" | "high" | "emergency"
      ticket_status:
        | "open"
        | "in_progress"
        | "awaiting_tenant"
        | "escalated"
        | "resolved"
        | "closed"
      unit_status: "occupied" | "vacant" | "maintenance"
      user_role: "tenant" | "manager"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      media_type: ["photo", "video"],
      property_type: ["single_family", "multi_unit", "condo", "commercial"],
      ticket_category: [
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
      ],
      ticket_priority: ["low", "medium", "high", "emergency"],
      ticket_status: [
        "open",
        "in_progress",
        "awaiting_tenant",
        "escalated",
        "resolved",
        "closed",
      ],
      unit_status: ["occupied", "vacant", "maintenance"],
      user_role: ["tenant", "manager"],
    },
  },
} as const
