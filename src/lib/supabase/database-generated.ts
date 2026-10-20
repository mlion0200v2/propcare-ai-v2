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
      approvals: {
        Row: {
          amount_cents: number
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision: Database["public"]["Enums"]["approval_decision"]
          decision_note: string | null
          description: string | null
          id: string
          limit_cents: number
          requested_by: string | null
          ticket_id: string
          workspace_id: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision?: Database["public"]["Enums"]["approval_decision"]
          decision_note?: string | null
          description?: string | null
          id?: string
          limit_cents: number
          requested_by?: string | null
          ticket_id: string
          workspace_id?: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision?: Database["public"]["Enums"]["approval_decision"]
          decision_note?: string | null
          description?: string | null
          id?: string
          limit_cents?: number
          requested_by?: string | null
          ticket_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "approvals_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "tickets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approvals_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      intake_codes: {
        Row: {
          attempts: number
          channel: string
          code_hash: string
          consumed_at: string | null
          created_at: string
          destination: string
          expires_at: string
          id: string
          name: string
          unit_id: string
        }
        Insert: {
          attempts?: number
          channel: string
          code_hash: string
          consumed_at?: string | null
          created_at?: string
          destination: string
          expires_at: string
          id?: string
          name: string
          unit_id: string
        }
        Update: {
          attempts?: number
          channel?: string
          code_hash?: string
          consumed_at?: string | null
          created_at?: string
          destination?: string
          expires_at?: string
          id?: string
          name?: string
          unit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "intake_codes_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
        ]
      }
      invitations: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          property_ids: string[]
          revoked_at: string | null
          role: Database["public"]["Enums"]["membership_role"]
          token_hash: string
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          property_ids?: string[]
          revoked_at?: string | null
          role: Database["public"]["Enums"]["membership_role"]
          token_hash: string
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          property_ids?: string[]
          revoked_at?: string | null
          role?: Database["public"]["Enums"]["membership_role"]
          token_hash?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invitations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          created_at: string
          display_name: string | null
          role: Database["public"]["Enums"]["membership_role"]
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          role: Database["public"]["Enums"]["membership_role"]
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          role?: Database["public"]["Enums"]["membership_role"]
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
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
      owner_property_access: {
        Row: {
          created_at: string
          property_id: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          property_id: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          property_id?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "owner_property_access_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
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
          email: string | null
          full_name: string
          id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          default_property_address?: string | null
          default_unit_number?: string | null
          email?: string | null
          full_name: string
          id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          default_property_address?: string | null
          default_unit_number?: string | null
          email?: string | null
          full_name?: string
          id?: string
          phone?: string | null
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
          property_type: Database["public"]["Enums"]["property_type"]
          state: string
          updated_at: string
          workspace_id: string
          zip: string
        }
        Insert: {
          address_line1: string
          address_line2?: string | null
          city: string
          created_at?: string
          id?: string
          property_type?: Database["public"]["Enums"]["property_type"]
          state: string
          updated_at?: string
          workspace_id: string
          zip: string
        }
        Update: {
          address_line1?: string
          address_line2?: string | null
          city?: string
          created_at?: string
          id?: string
          property_type?: Database["public"]["Enums"]["property_type"]
          state?: string
          updated_at?: string
          workspace_id?: string
          zip?: string
        }
        Relationships: [
          {
            foreignKeyName: "properties_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      tenancies: {
        Row: {
          created_at: string
          email: string | null
          ended_at: string | null
          id: string
          name: string
          phone: string | null
          tenant_user_id: string | null
          unit_id: string
          updated_at: string
          verified_at: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          ended_at?: string | null
          id?: string
          name: string
          phone?: string | null
          tenant_user_id?: string | null
          unit_id: string
          updated_at?: string
          verified_at?: string | null
          workspace_id?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          ended_at?: string | null
          id?: string
          name?: string
          phone?: string | null
          tenant_user_id?: string | null
          unit_id?: string
          updated_at?: string
          verified_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenancies_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "units"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenancies_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      tenancy_verifications: {
        Row: {
          channel: string
          tenancy_id: string
          user_id: string
          verified_at: string
        }
        Insert: {
          channel: string
          tenancy_id: string
          user_id: string
          verified_at?: string
        }
        Update: {
          channel?: string
          tenancy_id?: string
          user_id?: string
          verified_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenancy_verifications_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "tenancies"
            referencedColumns: ["id"]
          },
        ]
      }
      ticket_comments: {
        Row: {
          author_id: string | null
          author_name: string
          author_role: string
          body: string
          created_at: string
          delivered_at: string | null
          delivery_error: string | null
          id: string
          ticket_id: string
          visibility: Database["public"]["Enums"]["comment_visibility"]
          workspace_id: string
        }
        Insert: {
          author_id?: string | null
          author_name: string
          author_role: string
          body: string
          created_at?: string
          delivered_at?: string | null
          delivery_error?: string | null
          id?: string
          ticket_id: string
          visibility: Database["public"]["Enums"]["comment_visibility"]
          workspace_id?: string
        }
        Update: {
          author_id?: string | null
          author_name?: string
          author_role?: string
          body?: string
          created_at?: string
          delivered_at?: string | null
          delivery_error?: string | null
          id?: string
          ticket_id?: string
          visibility?: Database["public"]["Enums"]["comment_visibility"]
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_comments_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "tickets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_comments_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
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
          entry_notice: string | null
          id: string
          priority: Database["public"]["Enums"]["ticket_priority"]
          resolved_at: string | null
          safety_assessment: Json | null
          similar_issues: Json | null
          stage: Database["public"]["Enums"]["ticket_stage"]
          status: Database["public"]["Enums"]["ticket_status"]
          tenancy_id: string | null
          tenant_id: string
          title: string
          trace_id: string | null
          triage_state: string
          troubleshooting_steps: Json | null
          unit_id: string
          updated_at: string
          vendor_booked_for: string | null
          vendor_name: string | null
          workspace_id: string
        }
        Insert: {
          assigned_to?: string | null
          category?: Database["public"]["Enums"]["ticket_category"]
          classification?: Json | null
          created_at?: string
          description: string
          entry_notice?: string | null
          id?: string
          priority?: Database["public"]["Enums"]["ticket_priority"]
          resolved_at?: string | null
          safety_assessment?: Json | null
          similar_issues?: Json | null
          stage?: Database["public"]["Enums"]["ticket_stage"]
          status?: Database["public"]["Enums"]["ticket_status"]
          tenancy_id?: string | null
          tenant_id: string
          title: string
          trace_id?: string | null
          triage_state?: string
          troubleshooting_steps?: Json | null
          unit_id: string
          updated_at?: string
          vendor_booked_for?: string | null
          vendor_name?: string | null
          workspace_id?: string
        }
        Update: {
          assigned_to?: string | null
          category?: Database["public"]["Enums"]["ticket_category"]
          classification?: Json | null
          created_at?: string
          description?: string
          entry_notice?: string | null
          id?: string
          priority?: Database["public"]["Enums"]["ticket_priority"]
          resolved_at?: string | null
          safety_assessment?: Json | null
          similar_issues?: Json | null
          stage?: Database["public"]["Enums"]["ticket_stage"]
          status?: Database["public"]["Enums"]["ticket_status"]
          tenancy_id?: string | null
          tenant_id?: string
          title?: string
          trace_id?: string | null
          triage_state?: string
          troubleshooting_steps?: Json | null
          unit_id?: string
          updated_at?: string
          vendor_booked_for?: string | null
          vendor_name?: string | null
          workspace_id?: string
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
            foreignKeyName: "tickets_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "tenancies"
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
          {
            foreignKeyName: "tickets_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      units: {
        Row: {
          created_at: string
          id: string
          intake_token: string
          link_active: boolean
          link_rotated_at: string | null
          property_id: string
          status: Database["public"]["Enums"]["unit_status"]
          unit_number: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          intake_token?: string
          link_active?: boolean
          link_rotated_at?: string | null
          property_id: string
          status?: Database["public"]["Enums"]["unit_status"]
          unit_number?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          intake_token?: string
          link_active?: boolean
          link_rotated_at?: string | null
          property_id?: string
          status?: Database["public"]["Enums"]["unit_status"]
          unit_number?: string | null
          updated_at?: string
          workspace_id?: string
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
            foreignKeyName: "units_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      vendors: {
        Row: {
          created_at: string
          email: string | null
          id: string
          name: string
          notes: string | null
          phone: string | null
          rating: number | null
          trade: Database["public"]["Enums"]["ticket_category"]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          phone?: string | null
          rating?: number | null
          trade: Database["public"]["Enums"]["ticket_category"]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          phone?: string | null
          rating?: number | null
          trade?: Database["public"]["Enums"]["ticket_category"]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendors_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          approval_limit_cents: number
          created_at: string
          created_by: string | null
          id: string
          kind: Database["public"]["Enums"]["workspace_kind"]
          name: string
          updated_at: string
        }
        Insert: {
          approval_limit_cents?: number
          created_at?: string
          created_by?: string | null
          id?: string
          kind: Database["public"]["Enums"]["workspace_kind"]
          name: string
          updated_at?: string
        }
        Update: {
          approval_limit_cents?: number
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["workspace_kind"]
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_invitation: {
        Args: { p_display_name?: string; p_token: string }
        Returns: string
      }
      create_workspace: {
        Args: {
          p_display_name?: string
          p_kind: Database["public"]["Enums"]["workspace_kind"]
          p_name: string
        }
        Returns: string
      }
      decide_approval: {
        Args: {
          p_approval: string
          p_decision: Database["public"]["Enums"]["approval_decision"]
          p_note?: string
        }
        Returns: undefined
      }
      intake_unit_for_token: {
        Args: { p_token: string }
        Returns: {
          address_line1: string
          city: string
          property_id: string
          unit_id: string
          unit_number: string | null
          workspace_id: string
          workspace_name: string
        }[]
      }
      remove_member: {
        Args: { p_user: string; p_workspace: string }
        Returns: undefined
      }
      set_member_role: {
        Args: {
          p_role: Database["public"]["Enums"]["membership_role"]
          p_user: string
          p_workspace: string
        }
        Returns: undefined
      }
      ticket_access: { Args: { tid: string }; Returns: string | null }
    }
    Enums: {
      approval_decision: "pending" | "approved" | "declined"
      comment_visibility: "team" | "team_owner" | "tenant"
      media_type: "photo" | "video"
      membership_role: "admin" | "manager" | "owner"
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
      ticket_stage:
        | "new"
        | "waiting_for_owner"
        | "vendor_booked"
        | "fixed"
        | "closed"
      ticket_status:
        | "open"
        | "in_progress"
        | "awaiting_tenant"
        | "escalated"
        | "resolved"
        | "closed"
      unit_status: "occupied" | "vacant" | "maintenance"
      workspace_kind: "individual" | "company"
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
      approval_decision: ["pending", "approved", "declined"],
      comment_visibility: ["team", "team_owner", "tenant"],
      media_type: ["photo", "video"],
      membership_role: ["admin", "manager", "owner"],
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
      ticket_stage: ["new", "waiting_for_owner", "vendor_booked", "fixed", "closed"],
      ticket_status: [
        "open",
        "in_progress",
        "awaiting_tenant",
        "escalated",
        "resolved",
        "closed",
      ],
      unit_status: ["occupied", "vacant", "maintenance"],
      workspace_kind: ["individual", "company"],
    },
  },
} as const
