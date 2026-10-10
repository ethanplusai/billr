export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      agent_tool_calls: {
        Row: {
          created_at: string
          finished_at: string | null
          id: string
          key_id: string | null
          status: string
          tool_name: string
          user_id: string
        }
        Insert: {
          created_at?: string
          finished_at?: string | null
          id?: string
          key_id?: string | null
          status?: string
          tool_name: string
          user_id: string
        }
        Update: {
          created_at?: string
          finished_at?: string | null
          id?: string
          key_id?: string | null
          status?: string
          tool_name?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_tool_calls_key_id_fkey"
            columns: ["key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      api_keys: {
        Row: {
          business_id: string | null
          created_at: string
          expires_at: string | null
          id: string
          key_hash: string
          key_prefix: string | null
          kind: string
          label: string
          last_used_at: string | null
          oauth_client_id: string | null
          permissions: string[]
          revoked_at: string | null
          user_id: string
        }
        Insert: {
          business_id?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          key_hash: string
          key_prefix?: string | null
          kind?: string
          label?: string
          last_used_at?: string | null
          oauth_client_id?: string | null
          permissions?: string[]
          revoked_at?: string | null
          user_id: string
        }
        Update: {
          business_id?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          key_hash?: string
          key_prefix?: string | null
          kind?: string
          label?: string
          last_used_at?: string | null
          oauth_client_id?: string | null
          permissions?: string[]
          revoked_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_keys_oauth_client_id_fkey"
            columns: ["oauth_client_id"]
            isOneToOne: false
            referencedRelation: "oauth_clients"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_policies: {
        Row: {
          approved_by: string
          budget: number
          business_id: string
          client_id: string
          created_at: string
          currency: string
          hourly_rate: number
          id: string
          name: string
          usage_multiplier: number
        }
        Insert: {
          approved_by?: string
          budget: number
          business_id: string
          client_id: string
          created_at?: string
          currency: string
          hourly_rate: number
          id?: string
          name: string
          usage_multiplier: number
        }
        Update: {
          approved_by?: string
          budget?: number
          business_id?: string
          client_id?: string
          created_at?: string
          currency?: string
          hourly_rate?: number
          id?: string
          name?: string
          usage_multiplier?: number
        }
        Relationships: [
          {
            foreignKeyName: "billing_policies_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_policies_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_financials"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "billing_policies_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      business_members: {
        Row: {
          business_id: string
          created_at: string
          id: string
          role: string
          user_id: string
        }
        Insert: {
          business_id: string
          created_at?: string
          id?: string
          role?: string
          user_id: string
        }
        Update: {
          business_id?: string
          created_at?: string
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_members_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      businesses: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          city: string | null
          country: string
          created_at: string
          default_currency: string
          default_payment_terms: number
          email: string | null
          estimate_prefix: string
          id: string
          invoice_footer: string | null
          invoice_notes: string | null
          invoice_prefix: string
          is_active: boolean
          legal_name: string | null
          logo_url: string | null
          name: string
          next_estimate_number: number
          next_invoice_number: number
          phone: string | null
          postal_code: string | null
          primary_color: string
          schedule_templates: Json
          state: string | null
          tax_id: string | null
          updated_at: string
          website: string | null
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          country?: string
          created_at?: string
          default_currency?: string
          default_payment_terms?: number
          email?: string | null
          estimate_prefix?: string
          id?: string
          invoice_footer?: string | null
          invoice_notes?: string | null
          invoice_prefix?: string
          is_active?: boolean
          legal_name?: string | null
          logo_url?: string | null
          name: string
          next_estimate_number?: number
          next_invoice_number?: number
          phone?: string | null
          postal_code?: string | null
          primary_color?: string
          schedule_templates?: Json
          state?: string | null
          tax_id?: string | null
          updated_at?: string
          website?: string | null
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          country?: string
          created_at?: string
          default_currency?: string
          default_payment_terms?: number
          email?: string | null
          estimate_prefix?: string
          id?: string
          invoice_footer?: string | null
          invoice_notes?: string | null
          invoice_prefix?: string
          is_active?: boolean
          legal_name?: string | null
          logo_url?: string | null
          name?: string
          next_estimate_number?: number
          next_invoice_number?: number
          phone?: string | null
          postal_code?: string | null
          primary_color?: string
          schedule_templates?: Json
          state?: string | null
          tax_id?: string | null
          updated_at?: string
          website?: string | null
        }
        Relationships: []
      }
      client_contacts: {
        Row: {
          client_id: string
          created_at: string
          email: string | null
          id: string
          is_primary: boolean
          name: string
          phone: string | null
          role: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          email?: string | null
          id?: string
          is_primary?: boolean
          name: string
          phone?: string | null
          role?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          email?: string | null
          id?: string
          is_primary?: boolean
          name?: string
          phone?: string | null
          role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_contacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_financials"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_contacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          business_id: string
          city: string | null
          country: string | null
          created_at: string
          created_by_key_id: string | null
          created_via: string | null
          currency: string
          email: string | null
          id: string
          is_active: boolean
          name: string
          notes: string | null
          payment_terms: number
          phone: string | null
          postal_code: string | null
          state: string | null
          tax_id: string | null
          updated_at: string
          website: string | null
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          business_id: string
          city?: string | null
          country?: string | null
          created_at?: string
          created_by_key_id?: string | null
          created_via?: string | null
          currency?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          payment_terms?: number
          phone?: string | null
          postal_code?: string | null
          state?: string | null
          tax_id?: string | null
          updated_at?: string
          website?: string | null
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          business_id?: string
          city?: string | null
          country?: string | null
          created_at?: string
          created_by_key_id?: string | null
          created_via?: string | null
          currency?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          payment_terms?: number
          phone?: string | null
          postal_code?: string | null
          state?: string | null
          tax_id?: string | null
          updated_at?: string
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clients_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clients_created_by_key_id_fkey"
            columns: ["created_by_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      email_deliveries: {
        Row: {
          business_id: string
          created_at: string
          document_id: string
          input_hash: string
          kind: string
          payload: Json
          request_id: string
          sent_at: string | null
        }
        Insert: {
          business_id: string
          created_at?: string
          document_id: string
          input_hash: string
          kind: string
          payload?: Json
          request_id: string
          sent_at?: string | null
        }
        Update: {
          business_id?: string
          created_at?: string
          document_id?: string
          input_hash?: string
          kind?: string
          payload?: Json
          request_id?: string
          sent_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_deliveries_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      engagement_entries: {
        Row: {
          amount: number
          business_id: string
          completed_at: string | null
          created_at: string
          due_on: string | null
          due_rule: string
          engagement_id: string
          id: string
          invoice_id: string | null
          invoice_line_id: string | null
          label: string
          percent: number | null
          position: number
          status: string
          updated_at: string
          waived_reason: string | null
        }
        Insert: {
          amount: number
          business_id: string
          completed_at?: string | null
          created_at?: string
          due_on?: string | null
          due_rule: string
          engagement_id: string
          id?: string
          invoice_id?: string | null
          invoice_line_id?: string | null
          label: string
          percent?: number | null
          position: number
          status?: string
          updated_at?: string
          waived_reason?: string | null
        }
        Update: {
          amount?: number
          business_id?: string
          completed_at?: string | null
          created_at?: string
          due_on?: string | null
          due_rule?: string
          engagement_id?: string
          id?: string
          invoice_id?: string | null
          invoice_line_id?: string | null
          label?: string
          percent?: number | null
          position?: number
          status?: string
          updated_at?: string
          waived_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "engagement_entries_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engagement_entries_engagement_id_fkey"
            columns: ["engagement_id"]
            isOneToOne: false
            referencedRelation: "engagement_summary"
            referencedColumns: ["engagement_id"]
          },
          {
            foreignKeyName: "engagement_entries_engagement_id_fkey"
            columns: ["engagement_id"]
            isOneToOne: false
            referencedRelation: "engagements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engagement_entries_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      engagements: {
        Row: {
          billing_mode: string
          business_id: string
          client_id: string
          created_at: string
          created_by_key_id: string | null
          created_via: string
          currency: string
          id: string
          name: string
          notes: string | null
          source_estimate_id: string | null
          starts_on: string | null
          status: string
          target_end: string | null
          total: number
          updated_at: string
        }
        Insert: {
          billing_mode: string
          business_id: string
          client_id: string
          created_at?: string
          created_by_key_id?: string | null
          created_via?: string
          currency?: string
          id?: string
          name: string
          notes?: string | null
          source_estimate_id?: string | null
          starts_on?: string | null
          status?: string
          target_end?: string | null
          total?: number
          updated_at?: string
        }
        Update: {
          billing_mode?: string
          business_id?: string
          client_id?: string
          created_at?: string
          created_by_key_id?: string | null
          created_via?: string
          currency?: string
          id?: string
          name?: string
          notes?: string | null
          source_estimate_id?: string | null
          starts_on?: string | null
          status?: string
          target_end?: string | null
          total?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "engagements_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engagements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_financials"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "engagements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engagements_created_by_key_id_fkey"
            columns: ["created_by_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engagements_source_estimate_id_fkey"
            columns: ["source_estimate_id"]
            isOneToOne: false
            referencedRelation: "estimates"
            referencedColumns: ["id"]
          },
        ]
      }
      estimate_line_items: {
        Row: {
          amount: number
          created_at: string
          description: string
          discount_amount: number
          discount_percent: number
          estimate_id: string
          id: string
          quantity: number
          rate: number
          sort_order: number
          tax_amount: number
          tax_rate: number
        }
        Insert: {
          amount?: number
          created_at?: string
          description: string
          discount_amount?: number
          discount_percent?: number
          estimate_id: string
          id?: string
          quantity?: number
          rate?: number
          sort_order?: number
          tax_amount?: number
          tax_rate?: number
        }
        Update: {
          amount?: number
          created_at?: string
          description?: string
          discount_amount?: number
          discount_percent?: number
          estimate_id?: string
          id?: string
          quantity?: number
          rate?: number
          sort_order?: number
          tax_amount?: number
          tax_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "estimate_line_items_estimate_id_fkey"
            columns: ["estimate_id"]
            isOneToOne: false
            referencedRelation: "estimates"
            referencedColumns: ["id"]
          },
        ]
      }
      estimates: {
        Row: {
          business_id: string
          business_snapshot: Json | null
          client_id: string
          client_snapshot: Json | null
          converted_invoice_id: string | null
          created_at: string
          created_by_key_id: string | null
          created_via: string | null
          currency: string
          discount_amount: number
          discount_type: string
          discount_value: number
          estimate_number: string
          expiry_date: string | null
          id: string
          issue_date: string
          notes: string | null
          public_id: string
          shipping_amount: number
          status: string
          subtotal: number
          tax_amount: number
          tax_rate: number
          terms: string | null
          total: number
          updated_at: string
        }
        Insert: {
          business_id: string
          business_snapshot?: Json | null
          client_id: string
          client_snapshot?: Json | null
          converted_invoice_id?: string | null
          created_at?: string
          created_by_key_id?: string | null
          created_via?: string | null
          currency?: string
          discount_amount?: number
          discount_type?: string
          discount_value?: number
          estimate_number: string
          expiry_date?: string | null
          id?: string
          issue_date?: string
          notes?: string | null
          public_id?: string
          shipping_amount?: number
          status?: string
          subtotal?: number
          tax_amount?: number
          tax_rate?: number
          terms?: string | null
          total?: number
          updated_at?: string
        }
        Update: {
          business_id?: string
          business_snapshot?: Json | null
          client_id?: string
          client_snapshot?: Json | null
          converted_invoice_id?: string | null
          created_at?: string
          created_by_key_id?: string | null
          created_via?: string | null
          currency?: string
          discount_amount?: number
          discount_type?: string
          discount_value?: number
          estimate_number?: string
          expiry_date?: string | null
          id?: string
          issue_date?: string
          notes?: string | null
          public_id?: string
          shipping_amount?: number
          status?: string
          subtotal?: number
          tax_amount?: number
          tax_rate?: number
          terms?: string | null
          total?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "estimates_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "estimates_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_financials"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "estimates_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "estimates_created_by_key_id_fkey"
            columns: ["created_by_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_estimates_converted_invoice"
            columns: ["converted_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount: number
          business_id: string
          category: string
          client_id: string | null
          created_at: string
          created_by_key_id: string | null
          created_via: string | null
          currency: string
          date: string
          description: string | null
          id: string
          invoice_id: string | null
          is_billable: boolean
          is_billed: boolean
          mileage_distance: number | null
          mileage_rate: number | null
          notes: string | null
          receipt_url: string | null
          updated_at: string
          vendor: string | null
        }
        Insert: {
          amount: number
          business_id: string
          category?: string
          client_id?: string | null
          created_at?: string
          created_by_key_id?: string | null
          created_via?: string | null
          currency?: string
          date: string
          description?: string | null
          id?: string
          invoice_id?: string | null
          is_billable?: boolean
          is_billed?: boolean
          mileage_distance?: number | null
          mileage_rate?: number | null
          notes?: string | null
          receipt_url?: string | null
          updated_at?: string
          vendor?: string | null
        }
        Update: {
          amount?: number
          business_id?: string
          category?: string
          client_id?: string | null
          created_at?: string
          created_by_key_id?: string | null
          created_via?: string | null
          currency?: string
          date?: string
          description?: string | null
          id?: string
          invoice_id?: string | null
          is_billable?: boolean
          is_billed?: boolean
          mileage_distance?: number | null
          mileage_rate?: number | null
          notes?: string | null
          receipt_url?: string | null
          updated_at?: string
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expenses_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_financials"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "expenses_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_created_by_key_id_fkey"
            columns: ["created_by_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      install_accounts: {
        Row: {
          admitted_at: string
          user_id: string
        }
        Insert: {
          admitted_at?: string
          user_id: string
        }
        Update: {
          admitted_at?: string
          user_id?: string
        }
        Relationships: []
      }
      invoice_line_items: {
        Row: {
          amount: number
          created_at: string
          description: string
          discount_amount: number
          discount_percent: number
          id: string
          invoice_id: string
          quantity: number
          rate: number
          sort_order: number
          tax_amount: number
          tax_rate: number
        }
        Insert: {
          amount?: number
          created_at?: string
          description: string
          discount_amount?: number
          discount_percent?: number
          id?: string
          invoice_id: string
          quantity?: number
          rate?: number
          sort_order?: number
          tax_amount?: number
          tax_rate?: number
        }
        Update: {
          amount?: number
          created_at?: string
          description?: string
          discount_amount?: number
          discount_percent?: number
          id?: string
          invoice_id?: string
          quantity?: number
          rate?: number
          sort_order?: number
          tax_amount?: number
          tax_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_line_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          amount_paid: number
          balance_due: number
          business_id: string
          business_snapshot: Json | null
          client_id: string
          client_snapshot: Json | null
          created_at: string
          created_by_key_id: string | null
          created_via: string | null
          currency: string
          discount_amount: number
          discount_type: string
          discount_value: number
          disputed: boolean | null
          due_date: string
          footer: string | null
          from_estimate_id: string | null
          id: string
          invoice_number: string
          is_recurring: boolean
          issue_date: string
          last_sent_at: string | null
          last_viewed_at: string | null
          notes: string | null
          paid_at: string | null
          payment_instructions: string | null
          payment_method: string | null
          po_number: string | null
          public_id: string
          recurring_end_date: string | null
          recurring_interval: string | null
          shipping_amount: number
          status: string
          stripe_payment_intent_id: string | null
          stripe_payment_status: string | null
          subtotal: number
          tax_amount: number
          tax_rate: number
          terms: string | null
          total: number
          updated_at: string
        }
        Insert: {
          amount_paid?: number
          balance_due?: number
          business_id: string
          business_snapshot?: Json | null
          client_id: string
          client_snapshot?: Json | null
          created_at?: string
          created_by_key_id?: string | null
          created_via?: string | null
          currency?: string
          discount_amount?: number
          discount_type?: string
          discount_value?: number
          disputed?: boolean | null
          due_date: string
          footer?: string | null
          from_estimate_id?: string | null
          id?: string
          invoice_number: string
          is_recurring?: boolean
          issue_date?: string
          last_sent_at?: string | null
          last_viewed_at?: string | null
          notes?: string | null
          paid_at?: string | null
          payment_instructions?: string | null
          payment_method?: string | null
          po_number?: string | null
          public_id?: string
          recurring_end_date?: string | null
          recurring_interval?: string | null
          shipping_amount?: number
          status?: string
          stripe_payment_intent_id?: string | null
          stripe_payment_status?: string | null
          subtotal?: number
          tax_amount?: number
          tax_rate?: number
          terms?: string | null
          total?: number
          updated_at?: string
        }
        Update: {
          amount_paid?: number
          balance_due?: number
          business_id?: string
          business_snapshot?: Json | null
          client_id?: string
          client_snapshot?: Json | null
          created_at?: string
          created_by_key_id?: string | null
          created_via?: string | null
          currency?: string
          discount_amount?: number
          discount_type?: string
          discount_value?: number
          disputed?: boolean | null
          due_date?: string
          footer?: string | null
          from_estimate_id?: string | null
          id?: string
          invoice_number?: string
          is_recurring?: boolean
          issue_date?: string
          last_sent_at?: string | null
          last_viewed_at?: string | null
          notes?: string | null
          paid_at?: string | null
          payment_instructions?: string | null
          payment_method?: string | null
          po_number?: string | null
          public_id?: string
          recurring_end_date?: string | null
          recurring_interval?: string | null
          shipping_amount?: number
          status?: string
          stripe_payment_intent_id?: string | null
          stripe_payment_status?: string | null
          subtotal?: number
          tax_amount?: number
          tax_rate?: number
          terms?: string | null
          total?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoices_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_financials"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "invoices_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_created_by_key_id_fkey"
            columns: ["created_by_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_from_estimate_id_fkey"
            columns: ["from_estimate_id"]
            isOneToOne: false
            referencedRelation: "estimates"
            referencedColumns: ["id"]
          },
        ]
      }
      items: {
        Row: {
          business_id: string
          created_at: string
          created_by_key_id: string | null
          created_via: string | null
          description: string | null
          id: string
          is_active: boolean
          name: string
          rate: number
          tax_rate: number
          type: string
          unit: string | null
          updated_at: string
        }
        Insert: {
          business_id: string
          created_at?: string
          created_by_key_id?: string | null
          created_via?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          rate?: number
          tax_rate?: number
          type?: string
          unit?: string | null
          updated_at?: string
        }
        Update: {
          business_id?: string
          created_at?: string
          created_by_key_id?: string | null
          created_via?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          rate?: number
          tax_rate?: number
          type?: string
          unit?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "items_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "items_created_by_key_id_fkey"
            columns: ["created_by_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_authorization_codes: {
        Row: {
          business_id: string
          code_challenge: string
          code_challenge_method: string
          code_hash: string
          created_at: string
          expires_at: string
          id: string
          oauth_client_id: string
          permissions: string[]
          redirect_uri: string
          resource: string | null
          used_at: string | null
          user_id: string
        }
        Insert: {
          business_id: string
          code_challenge: string
          code_challenge_method?: string
          code_hash: string
          created_at?: string
          expires_at: string
          id?: string
          oauth_client_id: string
          permissions: string[]
          redirect_uri: string
          resource?: string | null
          used_at?: string | null
          user_id: string
        }
        Update: {
          business_id?: string
          code_challenge?: string
          code_challenge_method?: string
          code_hash?: string
          created_at?: string
          expires_at?: string
          id?: string
          oauth_client_id?: string
          permissions?: string[]
          redirect_uri?: string
          resource?: string | null
          used_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_authorization_codes_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "oauth_authorization_codes_oauth_client_id_fkey"
            columns: ["oauth_client_id"]
            isOneToOne: false
            referencedRelation: "oauth_clients"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_clients: {
        Row: {
          client_id: string
          client_name: string
          created_at: string
          id: string
          redirect_uris: string[]
        }
        Insert: {
          client_id: string
          client_name: string
          created_at?: string
          id?: string
          redirect_uris: string[]
        }
        Update: {
          client_id?: string
          client_name?: string
          created_at?: string
          id?: string
          redirect_uris?: string[]
        }
        Relationships: []
      }
      oauth_refresh_tokens: {
        Row: {
          api_key_id: string | null
          business_id: string
          created_at: string
          expires_at: string
          family_id: string
          id: string
          oauth_client_id: string
          permissions: string[]
          resource: string | null
          revoked_at: string | null
          token_hash: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          api_key_id?: string | null
          business_id: string
          created_at?: string
          expires_at: string
          family_id: string
          id?: string
          oauth_client_id: string
          permissions: string[]
          resource?: string | null
          revoked_at?: string | null
          token_hash: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          api_key_id?: string | null
          business_id?: string
          created_at?: string
          expires_at?: string
          family_id?: string
          id?: string
          oauth_client_id?: string
          permissions?: string[]
          resource?: string | null
          revoked_at?: string | null
          token_hash?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_refresh_tokens_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "oauth_refresh_tokens_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "oauth_refresh_tokens_oauth_client_id_fkey"
            columns: ["oauth_client_id"]
            isOneToOne: false
            referencedRelation: "oauth_clients"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_state: {
        Row: {
          business_id: string
          completed_at: string | null
          dismissed_at: string | null
          tour_completed_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          business_id: string
          completed_at?: string | null
          dismissed_at?: string | null
          tour_completed_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          business_id?: string
          completed_at?: string | null
          dismissed_at?: string | null
          tour_completed_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_state_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      operation_receipts: {
        Row: {
          business_id: string
          created_at: string
          input: Json
          operation: string
          request_id: string
          result: Json
        }
        Insert: {
          business_id: string
          created_at?: string
          input: Json
          operation: string
          request_id: string
          result: Json
        }
        Update: {
          business_id?: string
          created_at?: string
          input?: Json
          operation?: string
          request_id?: string
          result?: Json
        }
        Relationships: [
          {
            foreignKeyName: "operation_receipts_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_audit: {
        Row: {
          action: string
          actor_key_id: string | null
          actor_user_id: string | null
          after: Json
          before: Json
          business_id: string
          created_at: string
          id: string
          input: Json
          invoice_id: string
          payment_id: string
          request_id: string
        }
        Insert: {
          action: string
          actor_key_id?: string | null
          actor_user_id?: string | null
          after: Json
          before: Json
          business_id: string
          created_at?: string
          id?: string
          input?: Json
          invoice_id: string
          payment_id: string
          request_id: string
        }
        Update: {
          action?: string
          actor_key_id?: string | null
          actor_user_id?: string | null
          after?: Json
          before?: Json
          business_id?: string
          created_at?: string
          id?: string
          input?: Json
          invoice_id?: string
          payment_id?: string
          request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_audit_actor_key_id_fkey"
            columns: ["actor_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_audit_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_audit_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_audit_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          business_id: string
          client_id: string
          created_at: string
          created_by_key_id: string | null
          created_via: string | null
          currency: string
          id: string
          invoice_id: string
          notes: string | null
          payment_date: string
          payment_method: string
          reference_number: string | null
          source: string
          stripe_payment_id: string | null
          updated_at: string | null
          void_reason: string | null
          voided_at: string | null
        }
        Insert: {
          amount: number
          business_id: string
          client_id: string
          created_at?: string
          created_by_key_id?: string | null
          created_via?: string | null
          currency?: string
          id?: string
          invoice_id: string
          notes?: string | null
          payment_date: string
          payment_method?: string
          reference_number?: string | null
          source?: string
          stripe_payment_id?: string | null
          updated_at?: string | null
          void_reason?: string | null
          voided_at?: string | null
        }
        Update: {
          amount?: number
          business_id?: string
          client_id?: string
          created_at?: string
          created_by_key_id?: string | null
          created_via?: string | null
          currency?: string
          id?: string
          invoice_id?: string
          notes?: string | null
          payment_date?: string
          payment_method?: string
          reference_number?: string | null
          source?: string
          stripe_payment_id?: string | null
          updated_at?: string | null
          void_reason?: string | null
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_financials"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "payments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_created_by_key_id_fkey"
            columns: ["created_by_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      rate_limit_counters: {
        Row: {
          bucket: string
          expires_at: string
          hits: number
          window_start: string
        }
        Insert: {
          bucket: string
          expires_at: string
          hits?: number
          window_start: string
        }
        Update: {
          bucket?: string
          expires_at?: string
          hits?: number
          window_start?: string
        }
        Relationships: []
      }
      stripe_events: {
        Row: {
          id: string
          received_at: string | null
          type: string | null
        }
        Insert: {
          id: string
          received_at?: string | null
          type?: string | null
        }
        Update: {
          id?: string
          received_at?: string | null
          type?: string | null
        }
        Relationships: []
      }
      task_events: {
        Row: {
          actor_key_id: string | null
          actor_user_id: string | null
          business_id: string
          created_at: string
          id: string
          input: Json
          kind: string
          request_id: string
          result: Json
          task_id: string
        }
        Insert: {
          actor_key_id?: string | null
          actor_user_id?: string | null
          business_id: string
          created_at?: string
          id?: string
          input: Json
          kind: string
          request_id: string
          result: Json
          task_id: string
        }
        Update: {
          actor_key_id?: string | null
          actor_user_id?: string | null
          business_id?: string
          created_at?: string
          id?: string
          input?: Json
          kind?: string
          request_id?: string
          result?: Json
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_events_actor_key_id_fkey"
            columns: ["actor_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_events_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_events_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "work_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_usage: {
        Row: {
          business_id: string
          cost: number
          created_at: string
          currency: string
          id: string
          input_tokens: number | null
          model: string | null
          output_tokens: number | null
          provider: string
          provider_request_id: string
          source: string
          task_id: string
        }
        Insert: {
          business_id: string
          cost: number
          created_at?: string
          currency: string
          id?: string
          input_tokens?: number | null
          model?: string | null
          output_tokens?: number | null
          provider: string
          provider_request_id: string
          source: string
          task_id: string
        }
        Update: {
          business_id?: string
          cost?: number
          created_at?: string
          currency?: string
          id?: string
          input_tokens?: number | null
          model?: string | null
          output_tokens?: number | null
          provider?: string
          provider_request_id?: string
          source?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_usage_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_usage_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "work_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      time_entries: {
        Row: {
          amount: number | null
          business_id: string
          client_id: string | null
          created_at: string
          created_by_key_id: string | null
          created_via: string | null
          currency: string
          date: string
          description: string | null
          duration_minutes: number | null
          duration_seconds: number
          end_time: string | null
          hourly_rate: number | null
          id: string
          invoice_id: string | null
          is_billable: boolean
          is_billed: boolean
          is_running: boolean
          project_name: string | null
          start_time: string | null
          updated_at: string
        }
        Insert: {
          amount?: number | null
          business_id: string
          client_id?: string | null
          created_at?: string
          created_by_key_id?: string | null
          created_via?: string | null
          currency: string
          date: string
          description?: string | null
          duration_minutes?: number | null
          duration_seconds?: number
          end_time?: string | null
          hourly_rate?: number | null
          id?: string
          invoice_id?: string | null
          is_billable?: boolean
          is_billed?: boolean
          is_running?: boolean
          project_name?: string | null
          start_time?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number | null
          business_id?: string
          client_id?: string | null
          created_at?: string
          created_by_key_id?: string | null
          created_via?: string | null
          currency?: string
          date?: string
          description?: string | null
          duration_minutes?: number | null
          duration_seconds?: number
          end_time?: string | null
          hourly_rate?: number | null
          id?: string
          invoice_id?: string | null
          is_billable?: boolean
          is_billed?: boolean
          is_running?: boolean
          project_name?: string | null
          start_time?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "time_entries_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_entries_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_financials"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "time_entries_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_entries_created_by_key_id_fkey"
            columns: ["created_by_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_entries_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      work_tasks: {
        Row: {
          active_seconds: number
          business_id: string
          created_at: string
          created_by_key_id: string | null
          id: string
          invoice_id: string | null
          last_heartbeat_at: string | null
          policy_id: string
          status: string
          title: string
          updated_at: string
          usage_cost: number
        }
        Insert: {
          active_seconds?: number
          business_id: string
          created_at?: string
          created_by_key_id?: string | null
          id?: string
          invoice_id?: string | null
          last_heartbeat_at?: string | null
          policy_id: string
          status?: string
          title: string
          updated_at?: string
          usage_cost?: number
        }
        Update: {
          active_seconds?: number
          business_id?: string
          created_at?: string
          created_by_key_id?: string | null
          id?: string
          invoice_id?: string | null
          last_heartbeat_at?: string | null
          policy_id?: string
          status?: string
          title?: string
          updated_at?: string
          usage_cost?: number
        }
        Relationships: [
          {
            foreignKeyName: "work_tasks_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_tasks_created_by_key_id_fkey"
            columns: ["created_by_key_id"]
            isOneToOne: false
            referencedRelation: "api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_tasks_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: true
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_tasks_policy_id_fkey"
            columns: ["policy_id"]
            isOneToOne: false
            referencedRelation: "billing_policies"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      client_financials: {
        Row: {
          business_id: string | null
          client_id: string | null
          currency: string | null
          outstanding_balance: number | null
          total_invoiced: number | null
          total_paid: number | null
        }
        Relationships: [
          {
            foreignKeyName: "clients_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      engagement_summary: {
        Row: {
          amount_billed: number | null
          amount_remaining: number | null
          amount_waived: number | null
          billing_mode: string | null
          business_id: string | null
          client_id: string | null
          currency: string | null
          engagement_id: string | null
          entry_count: number | null
          name: string | null
          next_ready_entries: Json | null
          ready_amount: number | null
          ready_count: number | null
          starts_on: string | null
          status: string | null
          target_end: string | null
          total: number | null
        }
        Relationships: [
          {
            foreignKeyName: "engagements_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engagements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "client_financials"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "engagements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      admit_install_account: {
        Args: { p_open: boolean; p_user_id: string }
        Returns: boolean
      }
      allocate_document_number: {
        Args: { p_business_id: string; p_kind: string }
        Returns: {
          doc_number: number
          doc_prefix: string
        }[]
      }
      consume_rate_limit: {
        Args: {
          p_bucket: string
          p_cost?: number
          p_limit: number
          p_window_seconds: number
        }
        Returns: {
          allowed: boolean
          remaining: number
          retry_after_seconds: number
        }[]
      }
      convert_estimate_to_engagement: {
        Args: {
          p_actor_key_id?: string
          p_billing_mode: string
          p_entries?: Json
          p_estimate_id: string
          p_installments?: number
          p_request_id: string
        }
        Returns: Json
      }
      convert_estimate_to_invoice: {
        Args: {
          p_created_by_key_id?: string
          p_created_via?: string
          p_due_date: string
          p_estimate_id: string
          p_issue_date: string
          p_line_items: Json
          p_public_id: string
          p_subtotal: number
          p_total: number
        }
        Returns: Json
      }
      create_business_with_owner: {
        Args: { business_email?: string; business_name: string }
        Returns: {
          address_line1: string | null
          address_line2: string | null
          city: string | null
          country: string
          created_at: string
          default_currency: string
          default_payment_terms: number
          email: string | null
          estimate_prefix: string
          id: string
          invoice_footer: string | null
          invoice_notes: string | null
          invoice_prefix: string
          is_active: boolean
          legal_name: string | null
          logo_url: string | null
          name: string
          next_estimate_number: number
          next_invoice_number: number
          phone: string | null
          postal_code: string | null
          primary_color: string
          schedule_templates: Json
          state: string | null
          tax_id: string | null
          updated_at: string
          website: string | null
        }
        SetofOptions: {
          from: "*"
          to: "businesses"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_engagement_with_schedule: {
        Args: {
          p_actor_key_id?: string
          p_billing_mode: string
          p_business_id: string
          p_client_id: string
          p_currency: string
          p_entries?: Json
          p_installments?: number
          p_name: string
          p_notes?: string
          p_request_id: string
          p_source_estimate_id?: string
          p_starts_on?: string
          p_status?: string
          p_target_end?: string
          p_total: number
        }
        Returns: Json
      }
      create_estimate_document: {
        Args: {
          p_business_id: string
          p_client_id: string
          p_key_id?: string
          p_lines: Json
          p_patch: Json
          p_request_id: string
        }
        Returns: Json
      }
      create_invoice_document: {
        Args: {
          p_business_id: string
          p_client_id: string
          p_engagement_entry_ids?: string[]
          p_expense_ids?: string[]
          p_key_id?: string
          p_lines: Json
          p_patch: Json
          p_request_id: string
          p_time_ids?: string[]
        }
        Returns: Json
      }
      create_work_entry_once: {
        Args: {
          p_business_id: string
          p_key_id?: string
          p_kind: string
          p_record: Json
          p_request_id: string
        }
        Returns: Json
      }
      dashboard_summary: {
        Args: { p_business_id: string; p_currency: string }
        Returns: Json
      }
      engagement_payload: { Args: { p_engagement_id: string }; Returns: Json }
      expand_engagement_schedule: {
        Args: {
          p_billing_mode: string
          p_entries?: Json
          p_installments?: number
          p_total: number
        }
        Returns: Json
      }
      generate_public_id: { Args: never; Returns: string }
      get_agent_activity: {
        Args: {
          p_before?: string
          p_before_id?: string
          p_business_ids: string[]
          p_limit?: number
        }
        Returns: {
          amount: number
          business_id: string
          created_at: string
          created_by_key_id: string
          created_via: string
          entity_id: string
          entity_type: string
          label: string
        }[]
      }
      get_public_estimate: { Args: { p_public_id: string }; Returns: Json }
      get_public_invoice: { Args: { p_public_id: string }; Returns: Json }
      get_report_summary: {
        Args: {
          p_aging_limit?: number
          p_bucket?: string
          p_business_id: string
          p_currency?: string
          p_end: string
          p_prev_end?: string
          p_prev_start?: string
          p_start: string
        }
        Returns: Json
      }
      install_has_account: { Args: never; Returns: boolean }
      mark_entry_complete: {
        Args: {
          p_actor_key_id?: string
          p_entry_id: string
          p_request_id: string
        }
        Returns: Json
      }
      peek_rate_limit: {
        Args: { p_bucket: string; p_limit: number; p_window_seconds: number }
        Returns: {
          allowed: boolean
          remaining: number
          retry_after_seconds: number
        }[]
      }
      promote_due_entries: {
        Args: { p_actor_key_id?: string; p_business_id: string }
        Returns: Json
      }
      prune_rate_limit_counters: {
        Args: { p_max_rows?: number }
        Returns: number
      }
      public_business_snapshot: { Args: { snap: Json }; Returns: Json }
      public_client_snapshot: { Args: { snap: Json }; Returns: Json }
      recompute_invoice_money: {
        Args: { p_invoice_id: string; p_paid_at_hint?: string }
        Returns: {
          amount_paid: number
          balance_due: number
          business_id: string
          business_snapshot: Json | null
          client_id: string
          client_snapshot: Json | null
          created_at: string
          created_by_key_id: string | null
          created_via: string | null
          currency: string
          discount_amount: number
          discount_type: string
          discount_value: number
          disputed: boolean | null
          due_date: string
          footer: string | null
          from_estimate_id: string | null
          id: string
          invoice_number: string
          is_recurring: boolean
          issue_date: string
          last_sent_at: string | null
          last_viewed_at: string | null
          notes: string | null
          paid_at: string | null
          payment_instructions: string | null
          payment_method: string | null
          po_number: string | null
          public_id: string
          recurring_end_date: string | null
          recurring_interval: string | null
          shipping_amount: number
          status: string
          stripe_payment_intent_id: string | null
          stripe_payment_status: string | null
          subtotal: number
          tax_amount: number
          tax_rate: number
          terms: string | null
          total: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "invoices"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_invoice_payment: {
        Args: {
          p_amount: number
          p_created_by_key_id?: string
          p_created_via?: string
          p_invoice_id: string
          p_notes?: string
          p_payment_date: string
          p_payment_method?: string
          p_reference_number?: string
          p_stripe_payment_id?: string
        }
        Returns: Json
      }
      record_payment_once: {
        Args: {
          p_amount: number
          p_created_by_key_id?: string
          p_created_via?: string
          p_invoice_id: string
          p_notes?: string
          p_payment_date: string
          p_payment_method?: string
          p_reference_number?: string
          p_request_id: string
        }
        Returns: Json
      }
      record_stripe_payment: {
        Args: {
          p_amount: number
          p_invoice_id: string
          p_notes?: string
          p_payment_date: string
          p_provider_id: string
        }
        Returns: undefined
      }
      replace_estimate_line_items: {
        Args: {
          p_estimate_id: string
          p_estimate_patch?: Json
          p_line_items: Json
        }
        Returns: Json
      }
      replace_invoice_line_items: {
        Args: {
          p_invoice_id: string
          p_invoice_patch?: Json
          p_line_items: Json
        }
        Returns: Json
      }
      resolve_engagement_actor: {
        Args: {
          p_actor_key_id: string
          p_business_id: string
          p_permission?: string
        }
        Returns: Record<string, unknown>
      }
      resolve_payment_actor: {
        Args: { p_actor_key_id: string; p_business_id: string }
        Returns: Record<string, unknown>
      }
      respond_to_estimate: {
        Args: { p_public_id: string; p_response: string }
        Returns: boolean
      }
      set_engagement_status: {
        Args: {
          p_actor_key_id?: string
          p_engagement_id: string
          p_request_id: string
          p_status: string
        }
        Returns: Json
      }
      sync_invoice_payment_ledger: {
        Args: { p_intent_id?: string; p_invoice_id: string }
        Returns: undefined
      }
      task_operation: {
        Args: {
          p_action: string
          p_business_id: string
          p_input: Json
          p_key_id?: string
          p_request_id: string
        }
        Returns: Json
      }
      update_engagement: {
        Args: {
          p_actor_key_id?: string
          p_engagement_id: string
          p_name?: string
          p_notes?: string
          p_request_id: string
          p_starts_on?: string
          p_target_end?: string
        }
        Returns: Json
      }
      update_payment: {
        Args: {
          p_actor_key_id?: string
          p_amount?: number
          p_method?: string
          p_notes?: string
          p_payment_date?: string
          p_payment_id: string
          p_reference_number?: string
          p_request_id: string
        }
        Returns: Json
      }
      user_has_business_access: {
        Args: { check_business_id: string }
        Returns: boolean
      }
      user_is_business_admin: {
        Args: { check_business_id: string }
        Returns: boolean
      }
      void_payment: {
        Args: {
          p_actor_key_id?: string
          p_payment_id: string
          p_reason: string
          p_request_id: string
        }
        Returns: Json
      }
      waive_entry: {
        Args: {
          p_actor_key_id?: string
          p_entry_id: string
          p_reason: string
          p_request_id: string
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
  public: {
    Enums: {},
  },
} as const

