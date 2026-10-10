-- Billr database baseline.
--
-- The complete schema for a new installation: tables, row-level security
-- policies, functions, triggers and grants in public, the auth trigger that
-- creates a profile for each new user, and the storage buckets with their
-- policies. Applied once to an empty Supabase database. Later changes are new
-- migrations numbered after this one; never edit a migration once applied.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";




COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."allocate_document_number"("p_business_id" "uuid", "p_kind" "text") RETURNS TABLE("doc_number" integer, "doc_prefix" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_number INTEGER;
  v_prefix TEXT;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.user_has_business_access(p_business_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF p_kind = 'invoice' THEN
    UPDATE public.businesses b
       SET next_invoice_number = b.next_invoice_number + 1
     WHERE b.id = p_business_id
    RETURNING b.next_invoice_number - 1, b.invoice_prefix
      INTO v_number, v_prefix;
  ELSIF p_kind = 'estimate' THEN
    UPDATE public.businesses b
       SET next_estimate_number = b.next_estimate_number + 1
     WHERE b.id = p_business_id
    RETURNING b.next_estimate_number - 1, b.estimate_prefix
      INTO v_number, v_prefix;
  ELSE
    RAISE EXCEPTION 'invalid_kind' USING ERRCODE = 'P0001';
  END IF;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'business_not_found' USING ERRCODE = 'P0001';
  END IF;

  doc_number := v_number;
  doc_prefix := v_prefix;
  RETURN NEXT;
END;
$$;


ALTER FUNCTION "public"."allocate_document_number"("p_business_id" "uuid", "p_kind" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."consume_rate_limit"("p_bucket" "text", "p_limit" integer, "p_window_seconds" integer, "p_cost" integer DEFAULT 1) RETURNS TABLE("allowed" boolean, "remaining" integer, "retry_after_seconds" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_bucket TEXT := LEFT(BTRIM(COALESCE(p_bucket, '')), 200);
  v_limit INTEGER := GREATEST(COALESCE(p_limit, 1), 1);
  -- Clamp the window to [1s, 24h] so a caller cannot pin rows in the table
  -- forever with an absurd window length.
  v_window INTEGER := LEAST(GREATEST(COALESCE(p_window_seconds, 60), 1), 86400);
  v_cost INTEGER := LEAST(GREATEST(COALESCE(p_cost, 1), 0), 1000);
  v_now TIMESTAMPTZ := NOW();
  v_window_start TIMESTAMPTZ;
  v_window_end TIMESTAMPTZ;
  v_hits INTEGER;
BEGIN
  IF v_bucket = '' THEN
    RAISE EXCEPTION 'invalid_bucket' USING ERRCODE = 'P0001';
  END IF;

  -- Integer division floors, so every instance in every region derives the
  -- same window_start from the database clock.
  v_window_start := TO_TIMESTAMP((FLOOR(EXTRACT(EPOCH FROM v_now))::BIGINT / v_window) * v_window);
  v_window_end := v_window_start + MAKE_INTERVAL(secs => v_window);

  -- The whole limiter, in one atomic statement. Two concurrent callers cannot
  -- both read "hits = limit - 1" and both write "limit": the second one blocks
  -- on the first one's row lock and then increments the committed value.
  INSERT INTO public.rate_limit_counters AS c (bucket, window_start, hits, expires_at)
       VALUES (v_bucket, v_window_start, v_cost, v_window_end)
  ON CONFLICT (bucket, window_start)
  DO UPDATE SET hits = c.hits + v_cost
    RETURNING c.hits INTO v_hits;

  -- Opportunistic pruning: roughly one call in fifty pays for a small bounded
  -- sweep. Cheap enough to be invisible, frequent enough that the table tracks
  -- live traffic instead of growing forever, and it needs no cron extension.
  IF random() < 0.02 THEN
    PERFORM public.prune_rate_limit_counters(500);
  END IF;

  allowed := v_hits <= v_limit;
  remaining := GREATEST(v_limit - v_hits, 0);
  retry_after_seconds := GREATEST(CEIL(EXTRACT(EPOCH FROM (v_window_end - v_now)))::INTEGER, 1);
  RETURN NEXT;
END;
$$;


ALTER FUNCTION "public"."consume_rate_limit"("p_bucket" "text", "p_limit" integer, "p_window_seconds" integer, "p_cost" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."convert_estimate_to_engagement"("p_request_id" "uuid", "p_estimate_id" "uuid", "p_billing_mode" "text", "p_entries" "jsonb" DEFAULT '[]'::"jsonb", "p_installments" integer DEFAULT NULL::integer, "p_actor_key_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_estimate public.estimates%ROWTYPE;
  v_actor RECORD;
  v_receipt public.operation_receipts%ROWTYPE;
  v_engagement public.engagements%ROWTYPE;
  v_schedule JSONB;
  v_entry JSONB;
  v_input JSONB;
  v_result JSONB;
  v_existing UUID;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_estimate FROM public.estimates WHERE id = p_estimate_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'estimate_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_actor FROM public.resolve_engagement_actor(v_estimate.business_id, p_actor_key_id, 'write');

  v_input := jsonb_build_object(
    'estimate_id', p_estimate_id, 'billing_mode', p_billing_mode,
    'entries', COALESCE(p_entries, '[]'::JSONB), 'installments', p_installments
  );

  SELECT * INTO v_receipt FROM public.operation_receipts
   WHERE business_id = v_estimate.business_id
     AND operation = 'convert_estimate_to_engagement'
     AND request_id = p_request_id;
  IF FOUND THEN
    IF v_receipt.input <> v_input THEN
      RAISE EXCEPTION 'request_id_reused' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_set(v_receipt.result, '{replayed}', 'true'::JSONB);
  END IF;

  IF v_estimate.status IN ('declined', 'expired') THEN
    RAISE EXCEPTION 'estimate_not_convertible' USING ERRCODE = 'P0001', DETAIL = v_estimate.status;
  END IF;
  IF v_estimate.converted_invoice_id IS NOT NULL OR v_estimate.status = 'converted' THEN
    RAISE EXCEPTION 'estimate_already_converted' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_existing FROM public.engagements WHERE source_estimate_id = p_estimate_id LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'estimate_already_an_engagement' USING ERRCODE = 'P0001',
      DETAIL = format('Estimate %s is already engagement %s.', p_estimate_id, v_existing);
  END IF;

  -- The total and the currency are read off the estimate, never taken from the
  -- caller, so a conversion cannot quietly re-price the quote.
  v_schedule := public.expand_engagement_schedule(
    p_billing_mode, v_estimate.total, COALESCE(p_entries, '[]'::JSONB), p_installments);

  INSERT INTO public.engagements (
    business_id, client_id, name, total, currency, status, billing_mode,
    notes, source_estimate_id, created_via, created_by_key_id
  ) VALUES (
    v_estimate.business_id, v_estimate.client_id,
    LEFT('Estimate ' || v_estimate.estimate_number, 200),
    ROUND(v_estimate.total, 2), UPPER(COALESCE(v_estimate.currency, 'USD')), 'draft', p_billing_mode,
    v_estimate.notes, p_estimate_id,
    CASE WHEN v_actor.actor_key_id IS NULL THEN 'web' ELSE 'agent' END, v_actor.actor_key_id
  ) RETURNING * INTO v_engagement;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(v_schedule) LOOP
    INSERT INTO public.engagement_entries (
      engagement_id, business_id, position, label, amount, percent, due_rule, due_on, status
    ) VALUES (
      v_engagement.id, v_estimate.business_id,
      (v_entry ->> 'position')::INTEGER,
      v_entry ->> 'label',
      (v_entry ->> 'amount')::NUMERIC,
      (v_entry ->> 'percent')::NUMERIC,
      v_entry ->> 'due_rule',
      (v_entry ->> 'due_on')::DATE,
      'pending'
    );
  END LOOP;

  v_result := public.engagement_payload(v_engagement.id) || jsonb_build_object(
    'replayed', FALSE,
    'estimate', to_jsonb(v_estimate)
  );

  INSERT INTO public.operation_receipts (business_id, operation, request_id, input, result)
  VALUES (v_estimate.business_id, 'convert_estimate_to_engagement', p_request_id, v_input, v_result);

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."convert_estimate_to_engagement"("p_request_id" "uuid", "p_estimate_id" "uuid", "p_billing_mode" "text", "p_entries" "jsonb", "p_installments" integer, "p_actor_key_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."convert_estimate_to_invoice"("p_estimate_id" "uuid", "p_public_id" "text", "p_issue_date" "date", "p_due_date" "date", "p_line_items" "jsonb", "p_subtotal" numeric, "p_total" numeric, "p_created_via" "text" DEFAULT 'web'::"text", "p_created_by_key_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_estimate public.estimates%ROWTYPE;
  v_invoice public.invoices%ROWTYPE;
  v_existing public.invoices%ROWTYPE;
  v_engagement UUID;
  v_invoice_id UUID := gen_random_uuid();
  v_number INTEGER;
  v_prefix TEXT;
  v_invoice_number TEXT;
  v_client JSONB;
  v_business JSONB;
BEGIN
  IF jsonb_typeof(p_line_items) <> 'array' THEN
    RAISE EXCEPTION 'invalid_line_items' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_array_length(p_line_items) < 1 OR jsonb_array_length(p_line_items) > 500 THEN
    RAISE EXCEPTION 'invalid_line_items' USING ERRCODE = 'P0001';
  END IF;

  IF p_public_id IS NULL OR BTRIM(p_public_id) = '' THEN
    RAISE EXCEPTION 'invalid_public_id' USING ERRCODE = 'P0001';
  END IF;

  IF p_issue_date IS NULL OR p_due_date IS NULL THEN
    RAISE EXCEPTION 'invalid_dates' USING ERRCODE = 'P0001';
  END IF;

  -- One quote becomes one thing. Checked before the claim, so the estimate is
  -- left exactly as it was.
  SELECT id INTO v_engagement FROM public.engagements WHERE source_estimate_id = p_estimate_id LIMIT 1;
  IF v_engagement IS NOT NULL THEN
    RAISE EXCEPTION 'estimate_already_an_engagement' USING ERRCODE = 'P0001',
      DETAIL = format('Estimate %s is already engagement %s. Bill it from its schedule.',
                      p_estimate_id, v_engagement);
  END IF;

  UPDATE public.estimates e
     SET status = 'converted',
         converted_invoice_id = v_invoice_id
   WHERE e.id = p_estimate_id
     AND e.converted_invoice_id IS NULL
     AND e.status NOT IN ('converted', 'declined', 'expired')
  RETURNING e.* INTO v_estimate;

  IF NOT FOUND THEN
    SELECT * INTO v_estimate FROM public.estimates WHERE id = p_estimate_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'estimate_not_found' USING ERRCODE = 'P0001';
    END IF;

    IF v_estimate.status IN ('declined', 'expired') THEN
      RAISE EXCEPTION 'estimate_not_convertible'
        USING ERRCODE = 'P0001', DETAIL = v_estimate.status;
    END IF;

    IF v_estimate.converted_invoice_id IS NOT NULL THEN
      SELECT * INTO v_existing
        FROM public.invoices
       WHERE id = v_estimate.converted_invoice_id;
    END IF;

    RETURN jsonb_build_object(
      'claimed', FALSE,
      'estimate', to_jsonb(v_estimate),
      'invoice', CASE WHEN v_existing.id IS NULL THEN NULL::JSONB ELSE to_jsonb(v_existing) END,
      'invoice_number', v_existing.invoice_number
    );
  END IF;

  p_subtotal := v_estimate.subtotal;
  p_total := v_estimate.total;
  SELECT jsonb_agg(to_jsonb(li) ORDER BY li.sort_order,li.id) INTO p_line_items FROM estimate_line_items li WHERE li.estimate_id=v_estimate.id;
  IF p_line_items IS NULL THEN RAISE EXCEPTION 'Estimate has no line items'; END IF;

  SELECT a.doc_number, a.doc_prefix
    INTO v_number, v_prefix
    FROM public.allocate_document_number(v_estimate.business_id, 'invoice') a;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'business_not_found' USING ERRCODE = 'P0001';
  END IF;

  v_invoice_number := COALESCE(NULLIF(v_prefix, ''), 'INV') || '-' ||
    CASE
      WHEN length(v_number::TEXT) >= 4 THEN v_number::TEXT
      ELSE lpad(v_number::TEXT, 4, '0')
    END;

  SELECT to_jsonb(c) INTO v_client FROM public.clients c WHERE c.id = v_estimate.client_id;
  SELECT to_jsonb(b) INTO v_business FROM public.businesses b WHERE b.id = v_estimate.business_id;

  IF v_client IS NULL OR v_business IS NULL THEN
    RAISE EXCEPTION 'estimate_context_missing' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.invoices (
    id, public_id, business_id, client_id, invoice_number, status,
    issue_date, due_date, currency,
    subtotal, discount_type, discount_value, discount_amount,
    tax_rate, tax_amount, shipping_amount, total, balance_due,
    notes, terms, is_recurring,
    client_snapshot, business_snapshot, created_via, created_by_key_id
  ) VALUES (
    v_invoice_id,
    p_public_id,
    v_estimate.business_id,
    v_estimate.client_id,
    v_invoice_number,
    'draft',
    p_issue_date,
    p_due_date,
    v_estimate.currency,
    COALESCE(p_subtotal, 0),
    v_estimate.discount_type,
    v_estimate.discount_value,
    v_estimate.discount_amount,
    v_estimate.tax_rate,
    v_estimate.tax_amount,
    v_estimate.shipping_amount,
    COALESCE(p_total, 0),
    COALESCE(p_total, 0),
    v_estimate.notes,
    v_estimate.terms,
    FALSE,
    v_client,
    v_business,
    COALESCE(NULLIF(BTRIM(p_created_via), ''), 'web'),
    p_created_by_key_id
  )
  RETURNING * INTO v_invoice;

  INSERT INTO public.invoice_line_items (
    invoice_id, description, quantity, rate, amount,
    tax_rate, tax_amount, discount_percent, discount_amount, sort_order
  )
  SELECT
    v_invoice_id,
    COALESCE(li.item->>'description', ''),
    COALESCE((li.item->>'quantity')::NUMERIC, 1),
    COALESCE((li.item->>'rate')::NUMERIC, 0),
    COALESCE((li.item->>'amount')::NUMERIC, 0),
    COALESCE((li.item->>'tax_rate')::numeric,0),
    COALESCE((li.item->>'tax_amount')::numeric,0),
    COALESCE((li.item->>'discount_percent')::numeric,0),
    COALESCE((li.item->>'discount_amount')::numeric,0),
    (li.idx - 1)::INTEGER
  FROM jsonb_array_elements(p_line_items) WITH ORDINALITY AS li(item, idx);

  RETURN jsonb_build_object(
    'claimed', TRUE,
    'estimate', to_jsonb(v_estimate),
    'invoice', to_jsonb(v_invoice),
    'invoice_number', v_invoice_number
  );
END;
$$;


ALTER FUNCTION "public"."convert_estimate_to_invoice"("p_estimate_id" "uuid", "p_public_id" "text", "p_issue_date" "date", "p_due_date" "date", "p_line_items" "jsonb", "p_subtotal" numeric, "p_total" numeric, "p_created_via" "text", "p_created_by_key_id" "uuid") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."businesses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "legal_name" "text",
    "email" "text",
    "phone" "text",
    "website" "text",
    "address_line1" "text",
    "address_line2" "text",
    "city" "text",
    "state" "text",
    "postal_code" "text",
    "country" "text" DEFAULT 'US'::"text" NOT NULL,
    "tax_id" "text",
    "logo_url" "text",
    "primary_color" "text" DEFAULT '#2563eb'::"text" NOT NULL,
    "default_currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "default_payment_terms" integer DEFAULT 30 NOT NULL,
    "invoice_prefix" "text" DEFAULT 'INV'::"text" NOT NULL,
    "estimate_prefix" "text" DEFAULT 'EST'::"text" NOT NULL,
    "next_invoice_number" integer DEFAULT 1 NOT NULL,
    "next_estimate_number" integer DEFAULT 1 NOT NULL,
    "invoice_notes" "text",
    "invoice_footer" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "schedule_templates" "jsonb" DEFAULT '[{"key": "50_50", "name": "50/50", "entries": [{"label": "Deposit", "percent": 50, "due_rule": "on_start"}, {"label": "On completion", "percent": 50, "due_rule": "on_complete"}], "billing_mode": "percent_split"}, {"key": "30_70", "name": "30/70", "entries": [{"label": "Deposit", "percent": 30, "due_rule": "on_start"}, {"label": "On completion", "percent": 70, "due_rule": "on_complete"}], "billing_mode": "percent_split"}, {"key": "design_build_launch", "name": "Design / Build / Launch", "entries": [{"label": "Design", "due_rule": "on_start"}, {"label": "Build", "due_rule": "on_milestone"}, {"label": "Launch", "due_rule": "on_complete"}], "billing_mode": "equal_installments", "installments": 3}, {"key": "10_equal", "name": "10 equal installments", "billing_mode": "equal_installments", "installments": 10}]'::"jsonb" NOT NULL
);


ALTER TABLE "public"."businesses" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_business_with_owner"("business_name" "text", "business_email" "text" DEFAULT NULL::"text") RETURNS "public"."businesses"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  new_business public.businesses;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  -- Sign-up closes after the first account: only an admitted account (see
  -- install_accounts below) may start a business.
  IF NOT EXISTS (SELECT 1 FROM public.install_accounts WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'signup_closed' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.businesses (name, email)
  VALUES (business_name, business_email)
  RETURNING * INTO new_business;

  INSERT INTO public.business_members (business_id, user_id, role)
  VALUES (new_business.id, auth.uid(), 'owner');

  RETURN new_business;
END;
$$;


ALTER FUNCTION "public"."create_business_with_owner"("business_name" "text", "business_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_engagement_with_schedule"("p_request_id" "uuid", "p_business_id" "uuid", "p_client_id" "uuid", "p_name" "text", "p_total" numeric, "p_currency" "text", "p_billing_mode" "text", "p_entries" "jsonb" DEFAULT '[]'::"jsonb", "p_installments" integer DEFAULT NULL::integer, "p_status" "text" DEFAULT 'draft'::"text", "p_starts_on" "date" DEFAULT NULL::"date", "p_target_end" "date" DEFAULT NULL::"date", "p_notes" "text" DEFAULT NULL::"text", "p_source_estimate_id" "uuid" DEFAULT NULL::"uuid", "p_actor_key_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_actor RECORD;
  v_receipt public.operation_receipts%ROWTYPE;
  v_client public.clients%ROWTYPE;
  v_business public.businesses%ROWTYPE;
  v_engagement public.engagements%ROWTYPE;
  v_schedule JSONB;
  v_entry JSONB;
  v_input JSONB;
  v_result JSONB;
  v_currency TEXT;
  v_status TEXT := COALESCE(NULLIF(BTRIM(COALESCE(p_status, '')), ''), 'draft');
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = 'P0001';
  END IF;
  IF v_status NOT IN ('draft', 'active') THEN
    RAISE EXCEPTION 'invalid_initial_status' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_business FROM public.businesses WHERE id = p_business_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'engagement_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_actor FROM public.resolve_engagement_actor(p_business_id, p_actor_key_id, 'write');

  SELECT * INTO v_client FROM public.clients WHERE id = p_client_id AND business_id = p_business_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'client_not_found' USING ERRCODE = 'P0001';
  END IF;

  IF p_source_estimate_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.estimates WHERE id = p_source_estimate_id AND business_id = p_business_id
  ) THEN
    RAISE EXCEPTION 'estimate_not_found' USING ERRCODE = 'P0001';
  END IF;

  v_input := jsonb_build_object(
    'client_id', p_client_id, 'name', BTRIM(COALESCE(p_name, '')), 'total', ROUND(p_total, 2),
    'currency', UPPER(COALESCE(p_currency, '')), 'billing_mode', p_billing_mode,
    'entries', COALESCE(p_entries, '[]'::JSONB), 'installments', p_installments,
    'status', v_status, 'starts_on', p_starts_on, 'target_end', p_target_end,
    'notes', p_notes, 'source_estimate_id', p_source_estimate_id
  );

  SELECT * INTO v_receipt FROM public.operation_receipts
   WHERE business_id = p_business_id AND operation = 'create_engagement' AND request_id = p_request_id;
  IF FOUND THEN
    IF v_receipt.input <> v_input THEN
      RAISE EXCEPTION 'request_id_reused' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_set(v_receipt.result, '{replayed}', 'true'::JSONB);
  END IF;

  IF char_length(BTRIM(COALESCE(p_name, ''))) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = 'P0001';
  END IF;

  v_schedule := public.expand_engagement_schedule(p_billing_mode, p_total, COALESCE(p_entries, '[]'::JSONB), p_installments);
  v_currency := UPPER(COALESCE(NULLIF(BTRIM(COALESCE(p_currency, '')), ''), v_client.currency, v_business.default_currency, 'USD'));
  IF char_length(v_currency) <> 3 THEN
    RAISE EXCEPTION 'invalid_currency' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.engagements (
    business_id, client_id, name, total, currency, status, billing_mode,
    starts_on, target_end, notes, source_estimate_id, created_via, created_by_key_id
  ) VALUES (
    p_business_id, p_client_id, BTRIM(p_name), ROUND(p_total, 2), v_currency, v_status, p_billing_mode,
    p_starts_on, p_target_end, NULLIF(BTRIM(COALESCE(p_notes, '')), ''), p_source_estimate_id,
    CASE WHEN v_actor.actor_key_id IS NULL THEN 'web' ELSE 'agent' END, v_actor.actor_key_id
  ) RETURNING * INTO v_engagement;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(v_schedule) LOOP
    INSERT INTO public.engagement_entries (
      engagement_id, business_id, position, label, amount, percent, due_rule, due_on, status
    ) VALUES (
      v_engagement.id, p_business_id,
      (v_entry ->> 'position')::INTEGER,
      v_entry ->> 'label',
      (v_entry ->> 'amount')::NUMERIC,
      (v_entry ->> 'percent')::NUMERIC,
      v_entry ->> 'due_rule',
      (v_entry ->> 'due_on')::DATE,
      -- Starting an engagement makes its on_start money billable at once.
      -- Everything else waits for its own rule to fire.
      CASE WHEN v_status = 'active' AND v_entry ->> 'due_rule' = 'on_start'
           THEN 'ready_to_bill' ELSE 'pending' END
    );
  END LOOP;

  v_result := public.engagement_payload(v_engagement.id) || jsonb_build_object('replayed', FALSE);

  INSERT INTO public.operation_receipts (business_id, operation, request_id, input, result)
  VALUES (p_business_id, 'create_engagement', p_request_id, v_input, v_result);

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."create_engagement_with_schedule"("p_request_id" "uuid", "p_business_id" "uuid", "p_client_id" "uuid", "p_name" "text", "p_total" numeric, "p_currency" "text", "p_billing_mode" "text", "p_entries" "jsonb", "p_installments" integer, "p_status" "text", "p_starts_on" "date", "p_target_end" "date", "p_notes" "text", "p_source_estimate_id" "uuid", "p_actor_key_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_estimate_document"("p_business_id" "uuid", "p_client_id" "uuid", "p_patch" "jsonb", "p_lines" "jsonb", "p_request_id" "uuid", "p_key_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE b businesses%ROWTYPE; c clients%ROWTYPE; e estimates%ROWTYPE; r operation_receipts%ROWTYPE; n record; li jsonb; input jsonb;
 subtotal numeric:=0; discount numeric; tax numeric; amount numeric; pos integer:=0;
 dv numeric:=COALESCE((p_patch->>'discount_value')::numeric,0); tr numeric:=COALESCE((p_patch->>'tax_rate')::numeric,0); shipping numeric:=COALESCE((p_patch->>'shipping_amount')::numeric,0); dk text:=COALESCE(p_patch->>'discount_type','percentage');
BEGIN
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'A request ID is required'; END IF;
 SELECT * INTO b FROM businesses WHERE id=p_business_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Business not found'; END IF;
 SELECT * INTO c FROM clients WHERE id=p_client_id AND business_id=p_business_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Client not found'; END IF;
 IF p_key_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM api_keys k JOIN business_members bm ON bm.user_id=k.user_id WHERE k.id=p_key_id AND bm.business_id=b.id AND(k.business_id IS NULL OR k.business_id=b.id) AND k.revoked_at IS NULL AND(k.expires_at IS NULL OR k.expires_at>now()) AND 'write'=ANY(k.permissions)) THEN RAISE EXCEPTION 'Key cannot create estimates'; END IF;
 input:=jsonb_build_object('client',c.id,'patch',p_patch,'lines',p_lines);
 SELECT * INTO r FROM operation_receipts WHERE business_id=b.id AND operation='create_estimate' AND request_id=p_request_id;
 IF FOUND THEN IF r.input<>input THEN RAISE EXCEPTION 'Request ID used with different input'; END IF; RETURN r.result; END IF;
 IF jsonb_typeof(p_lines)<>'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Provide between 1 and 500 lines'; END IF;
 IF dv<0 OR dv>=100000000 OR tr<0 OR tr>100 OR shipping<0 OR shipping>=100000000 OR dk NOT IN('percentage','fixed') OR(dk='percentage' AND dv>100) THEN RAISE EXCEPTION 'Invalid discounts or taxes'; END IF;
 FOR li IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
  IF COALESCE(length(trim(li->>'description')),0) NOT BETWEEN 1 AND 2000 OR COALESCE((li->>'quantity')::numeric,0)<=0 OR (li->>'quantity')::numeric>=100000000 OR COALESCE((li->>'rate')::numeric,-1)<0 OR (li->>'rate')::numeric>=100000000 THEN RAISE EXCEPTION 'Invalid line item'; END IF;
  subtotal:=subtotal+ROUND((li->>'quantity')::numeric*(li->>'rate')::numeric,2);
 END LOOP;
 discount:=LEAST(subtotal,CASE WHEN dk='percentage' THEN ROUND(subtotal*dv/100,2) ELSE ROUND(dv,2) END);
 tax:=ROUND((subtotal-discount)*tr/100,2);
 SELECT * INTO n FROM allocate_document_number(b.id,'estimate');
 INSERT INTO estimates(business_id,client_id,estimate_number,status,issue_date,expiry_date,currency,subtotal,discount_type,discount_value,discount_amount,tax_rate,tax_amount,shipping_amount,total,notes,terms,created_via,created_by_key_id)
 VALUES(b.id,c.id,n.doc_prefix||'-'||LPAD(n.doc_number::text,GREATEST(4,length(n.doc_number::text)),'0'),'draft',COALESCE((p_patch->>'issue_date')::date,CURRENT_DATE),(p_patch->>'expiry_date')::date,COALESCE(c.currency,b.default_currency),subtotal,dk,dv,discount,tr,tax,shipping,subtotal-discount+tax+shipping,p_patch->>'notes',p_patch->>'terms',CASE WHEN p_key_id IS NULL THEN 'web' ELSE 'agent' END,p_key_id) RETURNING * INTO e;
 FOR li IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
  INSERT INTO estimate_line_items(estimate_id,description,quantity,rate,amount,sort_order) VALUES(e.id,li->>'description',(li->>'quantity')::numeric,(li->>'rate')::numeric,ROUND((li->>'quantity')::numeric*(li->>'rate')::numeric,2),pos);pos:=pos+1;
 END LOOP;
 INSERT INTO operation_receipts(business_id,operation,request_id,input,result) VALUES(b.id,'create_estimate',p_request_id,input,to_jsonb(e));RETURN to_jsonb(e);
END $$;


ALTER FUNCTION "public"."create_estimate_document"("p_business_id" "uuid", "p_client_id" "uuid", "p_patch" "jsonb", "p_lines" "jsonb", "p_request_id" "uuid", "p_key_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_invoice_document"("p_business_id" "uuid", "p_client_id" "uuid", "p_patch" "jsonb", "p_lines" "jsonb", "p_request_id" "uuid", "p_time_ids" "uuid"[] DEFAULT '{}'::"uuid"[], "p_expense_ids" "uuid"[] DEFAULT '{}'::"uuid"[], "p_key_id" "uuid" DEFAULT NULL::"uuid", "p_engagement_entry_ids" "uuid"[] DEFAULT '{}'::"uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
 b businesses%ROWTYPE; c clients%ROWTYPE; i invoices%ROWTYPE;
 t time_entries%ROWTYPE; e expenses%ROWTYPE; li JSONB; lines JSONB:=p_lines;
 receipt operation_receipts%ROWTYPE; input JSONB;
 number_row RECORD; number_text TEXT; currency_code TEXT;
 subtotal_value NUMERIC:=0; total_value NUMERIC; amount_value NUMERIC;
 discount_value NUMERIC:=COALESCE((p_patch->>'discount_value')::NUMERIC,0);
 discount_amount NUMERIC; tax_amount NUMERIC;
 tax_rate_value NUMERIC:=COALESCE((p_patch->>'tax_rate')::NUMERIC,0);
 shipping NUMERIC:=COALESCE((p_patch->>'shipping_amount')::NUMERIC,0);
 discount_kind TEXT:=COALESCE(p_patch->>'discount_type','percentage');
 position INTEGER:=0;
 entry_ids UUID[]:=COALESCE(p_engagement_entry_ids,'{}'); entry_row RECORD;
 entry_order UUID[]:=ARRAY[]::UUID[]; entry_offset INTEGER; entry_index INTEGER; line_id UUID;
BEGIN
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'A request_id is required'; END IF;
 SELECT * INTO b FROM businesses WHERE id=p_business_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Business not found'; END IF;
 SELECT * INTO c FROM clients WHERE id=p_client_id AND business_id=p_business_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Client not found in this business'; END IF;
 IF p_key_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM api_keys k JOIN business_members bm ON bm.user_id=k.user_id
   WHERE k.id=p_key_id AND k.revoked_at IS NULL AND bm.business_id=p_business_id
   AND (k.business_id IS NULL OR k.business_id=p_business_id)) THEN RAISE EXCEPTION 'Invalid agent key'; END IF;
 input:=jsonb_build_object('client',p_client_id,'patch',p_patch,'lines',p_lines,'time',p_time_ids,'expenses',p_expense_ids);
 -- Added as an extra key only when it carries something, so a receipt for an
 -- invoice without engagement entries keeps the same input on replay.
 IF cardinality(entry_ids)>0 THEN input:=input||jsonb_build_object('engagement_entries',entry_ids); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_business_id::TEXT||':invoice:'||p_request_id::TEXT,0));
 SELECT * INTO receipt FROM operation_receipts WHERE business_id=p_business_id AND operation='create_invoice' AND request_id=p_request_id;
 IF FOUND THEN
   -- A replay returns the original invoice and touches no entry a second time:
   -- everything below, including the claim, is skipped.
   IF receipt.input<>input THEN RAISE EXCEPTION 'request_id was already used with different input'; END IF;
   RETURN receipt.result;
 END IF;
 currency_code:=COALESCE(p_patch->>'currency',c.currency,b.default_currency);
 IF discount_value<0 OR (discount_kind='percentage' AND discount_value>100)
  OR discount_kind NOT IN ('percentage','fixed') OR tax_rate_value NOT BETWEEN 0 AND 100 OR shipping<0 THEN
   RAISE EXCEPTION 'Invalid discount, tax or shipping';
 END IF;
 IF cardinality(p_time_ids)>0 OR cardinality(p_expense_ids)>0 THEN
   lines:='[]'::JSONB;
   IF (SELECT count(DISTINCT x) FROM unnest(p_time_ids) x)<>cardinality(p_time_ids)
    OR (SELECT count(DISTINCT x) FROM unnest(p_expense_ids) x)<>cardinality(p_expense_ids) THEN RAISE EXCEPTION 'Duplicate source IDs'; END IF;
   -- Stable locking order; sources are claimed only after all validation succeeds.
   FOR t IN SELECT * FROM time_entries WHERE id=ANY(p_time_ids) AND business_id=p_business_id ORDER BY id FOR UPDATE LOOP
     IF t.client_id IS DISTINCT FROM p_client_id OR t.invoice_id IS NOT NULL OR NOT t.is_billable OR t.hourly_rate IS NULL THEN
       RAISE EXCEPTION 'Time must be unbilled, billable, priced and assigned to this client'; END IF;
     IF currency_code<>b.default_currency THEN RAISE EXCEPTION 'Time currency must match the business currency'; END IF;
     -- One exact source amount, not hours rounded for display and multiplied again.
     lines:=lines||jsonb_build_array(jsonb_build_object('description',COALESCE(t.description,'Tracked work')||' ('||t.duration_seconds||' seconds)',
       'quantity',1,'rate',ROUND(t.duration_seconds::NUMERIC*t.hourly_rate/3600,2)));
   END LOOP;
   IF jsonb_array_length(lines)<>cardinality(p_time_ids) THEN RAISE EXCEPTION 'Time entry not found'; END IF;
   FOR e IN SELECT * FROM expenses WHERE id=ANY(p_expense_ids) AND business_id=p_business_id ORDER BY id FOR UPDATE LOOP
     IF e.client_id IS DISTINCT FROM p_client_id OR e.invoice_id IS NOT NULL OR NOT e.is_billable OR e.currency<>currency_code THEN
       RAISE EXCEPTION 'Expense must be unbilled and match the invoice client and currency'; END IF;
     lines:=lines||jsonb_build_array(jsonb_build_object('description',COALESCE(e.description,'Expense'),'quantity',1,'rate',e.amount));
   END LOOP;
   IF jsonb_array_length(lines)<>cardinality(p_time_ids)+cardinality(p_expense_ids) THEN RAISE EXCEPTION 'Expense not found'; END IF;
 END IF;
 -- Engagement schedule entries. Appended rather than replacing, so an invoice
 -- may carry a deposit and a written out line at once. entry_offset remembers
 -- where they start, because each entry has to be linked back to the exact
 -- line it became once the lines have ids.
 IF cardinality(entry_ids)>0 THEN
   IF (SELECT count(DISTINCT x) FROM unnest(entry_ids) x)<>cardinality(entry_ids) THEN
     RAISE EXCEPTION 'duplicate_engagement_entry_ids' USING ERRCODE='P0001'; END IF;
   IF jsonb_typeof(lines)<>'array' THEN lines:='[]'::JSONB; END IF;
   entry_offset:=jsonb_array_length(lines);
   FOR entry_row IN
     SELECT en.*, g.name AS engagement_name, g.client_id AS engagement_client_id,
            g.currency AS engagement_currency, g.status AS engagement_status
       FROM engagement_entries en JOIN engagements g ON g.id=en.engagement_id
      WHERE en.id=ANY(entry_ids) AND en.business_id=p_business_id
      ORDER BY en.id FOR UPDATE OF en
   LOOP
     -- Already billed is the one refusal that has to be loud: it means two
     -- invoices are about to ask for the same money.
     IF entry_row.status='invoiced' THEN
       RAISE EXCEPTION 'engagement_entry_already_invoiced' USING ERRCODE='P0001',
         DETAIL=format('Entry %s is already on invoice %s.',entry_row.id,entry_row.invoice_id); END IF;
     IF entry_row.engagement_client_id IS DISTINCT FROM p_client_id THEN
       RAISE EXCEPTION 'engagement_entry_client_mismatch' USING ERRCODE='P0001'; END IF;
     IF entry_row.engagement_status IN ('draft','cancelled') THEN
       RAISE EXCEPTION 'engagement_not_billable' USING ERRCODE='P0001',
         DETAIL=format('Engagement %s is %s.',entry_row.engagement_id,entry_row.engagement_status); END IF;
     IF entry_row.engagement_currency<>currency_code THEN
       RAISE EXCEPTION 'engagement_entry_currency_mismatch' USING ERRCODE='P0001',
         DETAIL=format('The engagement is in %s and the invoice is in %s.',entry_row.engagement_currency,currency_code); END IF;
     IF NOT (entry_row.status='ready_to_bill' OR (entry_row.status='pending' AND entry_row.due_rule='manual')) THEN
       RAISE EXCEPTION 'engagement_entry_not_ready' USING ERRCODE='P0001',
         DETAIL=format('Entry %s is %s.',entry_row.id,entry_row.status); END IF;
     lines:=lines||jsonb_build_array(jsonb_build_object(
       'description',LEFT(entry_row.engagement_name||': '||entry_row.label,500),
       'quantity',1,'rate',entry_row.amount));
     entry_order:=entry_order||entry_row.id;
   END LOOP;
   -- Missing, another tenant's and another client's all end here rather than
   -- reporting which: no existence oracle across businesses.
   IF cardinality(entry_order)<>cardinality(entry_ids) THEN
     RAISE EXCEPTION 'engagement_entry_not_found' USING ERRCODE='P0001'; END IF;
 END IF;
 IF jsonb_typeof(lines)<>'array' OR jsonb_array_length(lines) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Provide 1 to 500 line items'; END IF;
 FOR li IN SELECT value FROM jsonb_array_elements(lines) LOOP
   IF NULLIF(btrim(li->>'description'),'') IS NULL OR COALESCE((li->>'quantity')::NUMERIC,0)<=0
    OR COALESCE((li->>'rate')::NUMERIC,-1)<0 OR COALESCE((li->>'discount_percent')::NUMERIC,0) NOT BETWEEN 0 AND 100 THEN
     RAISE EXCEPTION 'Invalid line item'; END IF;
   subtotal_value:=subtotal_value+ROUND((li->>'quantity')::NUMERIC*(li->>'rate')::NUMERIC*(1-COALESCE((li->>'discount_percent')::NUMERIC,0)/100),2);
 END LOOP;
 discount_amount:=ROUND(CASE WHEN discount_kind='percentage' THEN subtotal_value*discount_value/100 ELSE LEAST(discount_value,subtotal_value) END,2);
 tax_amount:=ROUND((subtotal_value-discount_amount)*tax_rate_value/100,2);
 total_value:=subtotal_value-discount_amount+tax_amount+shipping;
 SELECT * INTO number_row FROM allocate_document_number(p_business_id,'invoice');
 number_text:=COALESCE(NULLIF(p_patch->>'invoice_number',''), number_row.doc_prefix||'-'||lpad(number_row.doc_number::TEXT,GREATEST(4,length(number_row.doc_number::TEXT)),'0'));
 -- The business row is locked by allocation, serializing the duplicate check.
 IF EXISTS (SELECT 1 FROM invoices WHERE business_id=p_business_id AND invoice_number=number_text) THEN RAISE EXCEPTION 'Invoice number already exists'; END IF;
 INSERT INTO invoices (business_id,client_id,invoice_number,status,issue_date,due_date,currency,
 subtotal,discount_type,discount_value,discount_amount,tax_rate,tax_amount,shipping_amount,total,balance_due,
 notes,terms,footer,payment_instructions,po_number,client_snapshot,business_snapshot,created_via,created_by_key_id)
 VALUES (p_business_id,p_client_id,number_text,'draft',COALESCE((p_patch->>'issue_date')::DATE,CURRENT_DATE),
 COALESCE((p_patch->>'due_date')::DATE,CURRENT_DATE+b.default_payment_terms),currency_code,
 subtotal_value,discount_kind,discount_value,discount_amount,tax_rate_value,tax_amount,shipping,total_value,total_value,
 p_patch->>'notes',p_patch->>'terms',COALESCE(p_patch->>'footer',b.invoice_footer),p_patch->>'payment_instructions',p_patch->>'po_number',
 to_jsonb(c),to_jsonb(b),CASE WHEN p_key_id IS NULL THEN 'web' ELSE 'agent' END,p_key_id) RETURNING * INTO i;
 FOR li IN SELECT value FROM jsonb_array_elements(lines) LOOP
   amount_value:=ROUND((li->>'quantity')::NUMERIC*(li->>'rate')::NUMERIC*(1-COALESCE((li->>'discount_percent')::NUMERIC,0)/100),2);
   INSERT INTO invoice_line_items(invoice_id,description,quantity,rate,amount,discount_percent,discount_amount,sort_order)
   VALUES(i.id,li->>'description',(li->>'quantity')::NUMERIC,(li->>'rate')::NUMERIC,amount_value,
    COALESCE((li->>'discount_percent')::NUMERIC,0),ROUND((li->>'quantity')::NUMERIC*(li->>'rate')::NUMERIC-amount_value,2),position);
   position:=position+1;
 END LOOP;
 UPDATE time_entries SET invoice_id=i.id,is_billed=true WHERE id=ANY(p_time_ids) AND business_id=p_business_id;
 UPDATE expenses SET invoice_id=i.id,is_billed=true WHERE id=ANY(p_expense_ids) AND business_id=p_business_id;
 -- THE CLAIM. sort_order was written from the same array order the entries
 -- were appended in, so entry_offset + n identifies the line entry n became.
 -- From here the entry is frozen by guard_engagement_entry: sending or paying the
 -- invoice changes nothing about it, and only deleting the draft releases it.
 FOR entry_index IN 1..COALESCE(cardinality(entry_order),0) LOOP
   SELECT id INTO line_id FROM invoice_line_items
    WHERE invoice_id=i.id AND sort_order=entry_offset+entry_index-1;
   UPDATE engagement_entries
      SET status='invoiced', invoice_id=i.id, invoice_line_id=line_id
    WHERE id=entry_order[entry_index];
 END LOOP;
 INSERT INTO operation_receipts VALUES(p_business_id,'create_invoice',p_request_id,input,to_jsonb(i),now());
 RETURN to_jsonb(i);
END $$;


ALTER FUNCTION "public"."create_invoice_document"("p_business_id" "uuid", "p_client_id" "uuid", "p_patch" "jsonb", "p_lines" "jsonb", "p_request_id" "uuid", "p_time_ids" "uuid"[], "p_expense_ids" "uuid"[], "p_key_id" "uuid", "p_engagement_entry_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_work_entry_once"("p_business_id" "uuid", "p_kind" "text", "p_record" "jsonb", "p_request_id" "uuid", "p_key_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE receipt operation_receipts%ROWTYPE; result jsonb; t time_entries%ROWTYPE; e expenses%ROWTYPE;
BEGIN
 IF p_request_id IS NULL OR p_kind NOT IN('time','expense') THEN RAISE EXCEPTION 'Valid kind and request ID are required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM businesses WHERE id=p_business_id) THEN RAISE EXCEPTION 'Business not found'; END IF;
 IF p_key_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM api_keys k JOIN business_members bm ON bm.user_id=k.user_id WHERE k.id=p_key_id AND bm.business_id=p_business_id AND(k.business_id IS NULL OR k.business_id=p_business_id) AND k.revoked_at IS NULL AND(k.expires_at IS NULL OR k.expires_at>now()) AND 'write'=ANY(k.permissions)) THEN RAISE EXCEPTION 'Key cannot record work'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_business_id::text||':work:'||p_request_id::text,0));
 SELECT * INTO receipt FROM operation_receipts WHERE business_id=p_business_id AND operation='log_'||p_kind AND request_id=p_request_id;
 IF FOUND THEN IF receipt.input<>p_record THEN RAISE EXCEPTION 'Request ID used for different work'; END IF; RETURN receipt.result; END IF;
 IF p_kind='time' THEN
  INSERT INTO time_entries(business_id,client_id,description,date,duration_seconds,hourly_rate,is_billable,project_name,currency,created_via,created_by_key_id)
  VALUES(p_business_id,(p_record->>'client_id')::uuid,p_record->>'description',(p_record->>'date')::date,(p_record->>'duration_seconds')::bigint,(p_record->>'hourly_rate')::numeric,COALESCE((p_record->>'is_billable')::boolean,true),p_record->>'project_name',p_record->>'currency',CASE WHEN p_key_id IS NULL THEN 'web' ELSE 'agent' END,p_key_id) RETURNING * INTO t;
  result:=to_jsonb(t);
 ELSE
  INSERT INTO expenses(business_id,client_id,description,date,amount,currency,category,is_billable,vendor,notes,created_via,created_by_key_id)
  VALUES(p_business_id,(p_record->>'client_id')::uuid,p_record->>'description',(p_record->>'date')::date,(p_record->>'amount')::numeric,p_record->>'currency',p_record->>'category',COALESCE((p_record->>'is_billable')::boolean,false),p_record->>'vendor',p_record->>'notes',CASE WHEN p_key_id IS NULL THEN 'web' ELSE 'agent' END,p_key_id) RETURNING * INTO e;
  result:=to_jsonb(e);
 END IF;
 INSERT INTO operation_receipts(business_id,operation,request_id,input,result) VALUES(p_business_id,'log_'||p_kind,p_request_id,p_record,result);
 RETURN result;
END $$;


ALTER FUNCTION "public"."create_work_entry_once"("p_business_id" "uuid", "p_kind" "text", "p_record" "jsonb", "p_request_id" "uuid", "p_key_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dashboard_summary"("p_business_id" "uuid", "p_currency" "text") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
 SELECT jsonb_build_object(
 'totalRevenue',(SELECT COALESCE(SUM(amount),0) FROM payments WHERE business_id=p_business_id AND currency=p_currency AND voided_at IS NULL),
 'outstanding',(SELECT COALESCE(SUM(balance_due),0) FROM invoices WHERE business_id=p_business_id AND currency=p_currency AND status NOT IN('draft','cancelled','paid')),
 'overdueCount',(SELECT COUNT(*) FROM invoices WHERE business_id=p_business_id AND balance_due>0 AND status IN('sent','viewed','partial','overdue') AND due_date<CURRENT_DATE),
 'activeClients',(SELECT COUNT(*) FROM clients WHERE business_id=p_business_id AND is_active),
 'currency',p_currency)
$$;


ALTER FUNCTION "public"."dashboard_summary"("p_business_id" "uuid", "p_currency" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."engagement_payload"("p_engagement_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_engagement public.engagements%ROWTYPE;
  v_summary JSONB;
  v_entries JSONB;
BEGIN
  SELECT * INTO v_engagement FROM public.engagements WHERE id = p_engagement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'engagement_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT to_jsonb(s) INTO v_summary FROM public.engagement_summary s WHERE s.engagement_id = p_engagement_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(en) ORDER BY en.position), '[]'::JSONB)
    INTO v_entries
    FROM public.engagement_entries en
   WHERE en.engagement_id = p_engagement_id;

  RETURN jsonb_build_object(
    'engagement', to_jsonb(v_engagement),
    'summary', COALESCE(v_summary, '{}'::JSONB),
    'entries', v_entries
  );
END;
$$;


ALTER FUNCTION "public"."engagement_payload"("p_engagement_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."engagement_schedule_balances"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_engagement_id UUID;
  v_total NUMERIC;
  v_sum NUMERIC;
  v_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'engagements' THEN
    v_engagement_id := NEW.id;
  ELSE
    v_engagement_id := COALESCE(NEW.engagement_id, OLD.engagement_id);
  END IF;

  SELECT e.total INTO v_total FROM public.engagements e WHERE e.id = v_engagement_id;
  -- The engagement itself went away in this transaction (a cascade delete).
  -- There is no whole left for the parts to add up to.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*), COALESCE(SUM(en.amount), 0)
    INTO v_count, v_sum
    FROM public.engagement_entries en
   WHERE en.engagement_id = v_engagement_id;

  IF v_count > 0 AND ROUND(v_sum, 2) <> ROUND(v_total, 2) THEN
    RAISE EXCEPTION 'engagement_schedule_unbalanced'
      USING ERRCODE = 'P0001',
            DETAIL = format('Engagement %s totals %s but its %s schedule entries add up to %s.',
                            v_engagement_id, v_total, v_count, v_sum);
  END IF;

  RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."engagement_schedule_balances"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."expand_engagement_schedule"("p_billing_mode" "text", "p_total" numeric, "p_entries" "jsonb" DEFAULT '[]'::"jsonb", "p_installments" integer DEFAULT NULL::integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_total NUMERIC := ROUND(p_total, 2);
  v_entries JSONB := COALESCE(p_entries, '[]'::JSONB);
  v_count INTEGER;
  v_index INTEGER;
  v_amounts NUMERIC[] := ARRAY[]::NUMERIC[];
  v_percents NUMERIC[] := ARRAY[]::NUMERIC[];
  v_percent_total NUMERIC := 0;
  v_allocated NUMERIC := 0;
  v_share NUMERIC;
  v_entry JSONB;
  v_rule TEXT;
  v_label TEXT;
  v_due_on DATE;
  v_out JSONB := '[]'::JSONB;
BEGIN
  IF p_billing_mode IS NULL
     OR p_billing_mode NOT IN ('percent_split', 'equal_installments', 'milestones', 'manual') THEN
    RAISE EXCEPTION 'invalid_billing_mode' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_typeof(v_entries) <> 'array' THEN
    RAISE EXCEPTION 'entries_required' USING ERRCODE = 'P0001';
  END IF;
  IF v_total IS NULL OR v_total <= 0 OR v_total >= 100000000 THEN
    RAISE EXCEPTION 'invalid_total' USING ERRCODE = 'P0001';
  END IF;

  IF p_billing_mode = 'equal_installments' THEN
    v_count := CASE
                 WHEN jsonb_array_length(v_entries) > 0 THEN jsonb_array_length(v_entries)
                 ELSE COALESCE(p_installments, 0)
               END;
    IF v_count < 1 OR v_count > 100 THEN
      RAISE EXCEPTION 'invalid_installments' USING ERRCODE = 'P0001';
    END IF;
    FOR v_index IN 1..(v_count - 1) LOOP
      v_share := ROUND(v_total / v_count, 2);
      v_amounts := v_amounts || v_share;
      v_allocated := ROUND(v_allocated + v_share, 2);
    END LOOP;
    v_amounts := v_amounts || ROUND(v_total - v_allocated, 2);
  ELSE
    v_count := jsonb_array_length(v_entries);
    IF v_count = 0 THEN
      RAISE EXCEPTION 'entries_required' USING ERRCODE = 'P0001';
    END IF;
    IF v_count > 100 THEN
      RAISE EXCEPTION 'too_many_entries' USING ERRCODE = 'P0001';
    END IF;

    IF p_billing_mode = 'percent_split' THEN
      FOR v_index IN 0..(v_count - 1) LOOP
        v_share := ROUND(COALESCE((v_entries -> v_index ->> 'percent')::NUMERIC, 0), 2);
        IF v_share <= 0 OR v_share > 100 THEN
          RAISE EXCEPTION 'invalid_percent' USING ERRCODE = 'P0001';
        END IF;
        v_percents := v_percents || v_share;
        v_percent_total := ROUND(v_percent_total + v_share, 2);
      END LOOP;
      IF v_percent_total <> 100 THEN
        RAISE EXCEPTION 'percent_must_total_100' USING ERRCODE = 'P0001';
      END IF;

      FOR v_index IN 1..(v_count - 1) LOOP
        v_share := ROUND(v_total * v_percents[v_index] / 100, 2);
        v_amounts := v_amounts || v_share;
        v_allocated := ROUND(v_allocated + v_share, 2);
      END LOOP;
      v_amounts := v_amounts || ROUND(v_total - v_allocated, 2);
    ELSE
      -- milestones and manual: the caller states every amount, and they must
      -- already add up. Nothing is redistributed behind their back.
      FOR v_index IN 0..(v_count - 1) LOOP
        IF (v_entries -> v_index ->> 'amount') IS NULL THEN
          RAISE EXCEPTION 'entry_amount_required' USING ERRCODE = 'P0001';
        END IF;
        v_share := ROUND((v_entries -> v_index ->> 'amount')::NUMERIC, 2);
        IF v_share <= 0 OR v_share >= 100000000 THEN
          RAISE EXCEPTION 'invalid_entry_amount' USING ERRCODE = 'P0001';
        END IF;
        v_amounts := v_amounts || v_share;
        v_allocated := ROUND(v_allocated + v_share, 2);
      END LOOP;
      IF v_allocated <> v_total THEN
        RAISE EXCEPTION 'entries_must_total_engagement' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  FOR v_index IN 0..(v_count - 1) LOOP
    v_entry := COALESCE(v_entries -> v_index, '{}'::JSONB);

    IF v_amounts[v_index + 1] <= 0 THEN
      RAISE EXCEPTION 'invalid_entry_amount' USING ERRCODE = 'P0001';
    END IF;

    v_rule := COALESCE(
      NULLIF(BTRIM(COALESCE(v_entry ->> 'due_rule', '')), ''),
      CASE
        WHEN p_billing_mode = 'manual' THEN 'manual'
        WHEN v_count = 1 THEN 'on_complete'
        WHEN v_index = 0 THEN 'on_start'
        WHEN v_index = v_count - 1 THEN 'on_complete'
        ELSE 'on_milestone'
      END
    );
    IF v_rule NOT IN ('on_start', 'on_complete', 'on_milestone', 'on_date', 'manual') THEN
      RAISE EXCEPTION 'invalid_due_rule' USING ERRCODE = 'P0001';
    END IF;

    -- A date only means something for an on_date entry. Anything else keeps
    -- NULL, so a stale date cannot make promote_due_entries fire it early.
    v_due_on := NULL;
    IF v_rule = 'on_date' THEN
      BEGIN
        v_due_on := NULLIF(BTRIM(COALESCE(v_entry ->> 'due_on', '')), '')::DATE;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'due_on_required' USING ERRCODE = 'P0001';
      END;
      IF v_due_on IS NULL THEN
        RAISE EXCEPTION 'due_on_required' USING ERRCODE = 'P0001';
      END IF;
    END IF;

    v_label := LEFT(
      COALESCE(
        NULLIF(BTRIM(COALESCE(v_entry ->> 'label', '')), ''),
        CASE
          WHEN p_billing_mode = 'equal_installments'
            THEN 'Installment ' || (v_index + 1) || ' of ' || v_count
          ELSE 'Payment ' || (v_index + 1) || ' of ' || v_count
        END
      ), 200);

    v_out := v_out || jsonb_build_object(
      'position', v_index,
      'label', v_label,
      'amount', v_amounts[v_index + 1],
      'percent', CASE WHEN p_billing_mode = 'percent_split' THEN to_jsonb(v_percents[v_index + 1]) ELSE 'null'::JSONB END,
      'due_rule', v_rule,
      'due_on', CASE WHEN v_due_on IS NULL THEN 'null'::JSONB ELSE to_jsonb(v_due_on) END
    );
  END LOOP;

  RETURN v_out;
END;
$$;


ALTER FUNCTION "public"."expand_engagement_schedule"("p_billing_mode" "text", "p_total" numeric, "p_entries" "jsonb", "p_installments" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_public_id"() RETURNS "text"
    LANGUAGE "sql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$ SELECT replace(gen_random_uuid()::TEXT, '-', '') $$;


ALTER FUNCTION "public"."generate_public_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_agent_activity"("p_business_ids" "uuid"[], "p_limit" integer DEFAULT 50, "p_before" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_before_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("entity_type" "text", "entity_id" "uuid", "business_id" "uuid", "label" "text", "amount" numeric, "created_at" timestamp with time zone, "created_via" "text", "created_by_key_id" "uuid")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  allowed UUID[];
BEGIN
  -- Inline membership check deliberately mirrors user_has_business_access()
  -- for performance (avoids a per-row function call across the six-table
  -- union below); it must stay in lockstep with that function's semantics.
  SELECT COALESCE(array_agg(bm.business_id), '{}')
    INTO allowed
    FROM public.business_members bm
   WHERE bm.user_id = auth.uid()
     AND bm.business_id = ANY(p_business_ids);

  IF array_length(allowed, 1) IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT * FROM (
    SELECT 'invoice'::TEXT, i.id AS entity_id, i.business_id,
           ('Invoice ' || i.invoice_number)::TEXT, i.total::NUMERIC,
           i.created_at, i.created_via, i.created_by_key_id
      FROM public.invoices i WHERE i.business_id = ANY(allowed) AND i.created_via = 'agent'
    UNION ALL
    SELECT 'client'::TEXT, c.id AS entity_id, c.business_id,
           c.name::TEXT, NULL::NUMERIC,
           c.created_at, c.created_via, c.created_by_key_id
      FROM public.clients c WHERE c.business_id = ANY(allowed) AND c.created_via = 'agent'
    UNION ALL
    SELECT 'estimate'::TEXT, e.id AS entity_id, e.business_id,
           ('Estimate ' || e.estimate_number)::TEXT, e.total::NUMERIC,
           e.created_at, e.created_via, e.created_by_key_id
      FROM public.estimates e WHERE e.business_id = ANY(allowed) AND e.created_via = 'agent'
    UNION ALL
    SELECT 'time_entry'::TEXT, t.id AS entity_id, t.business_id,
           COALESCE(t.description, 'Time entry')::TEXT, NULL::NUMERIC,
           t.created_at, t.created_via, t.created_by_key_id
      FROM public.time_entries t WHERE t.business_id = ANY(allowed) AND t.created_via = 'agent'
    UNION ALL
    SELECT 'expense'::TEXT, x.id AS entity_id, x.business_id,
           COALESCE(x.description, 'Expense')::TEXT, x.amount::NUMERIC,
           x.created_at, x.created_via, x.created_by_key_id
      FROM public.expenses x WHERE x.business_id = ANY(allowed) AND x.created_via = 'agent'
    UNION ALL
    SELECT 'payment'::TEXT, p.id AS entity_id, p.business_id,
           ('Payment ' || COALESCE(p.payment_method, 'recorded'))::TEXT, p.amount::NUMERIC,
           p.created_at, p.created_via, p.created_by_key_id
      FROM public.payments p WHERE p.business_id = ANY(allowed) AND p.created_via = 'agent'
  ) rows
  WHERE (p_before IS NULL OR (rows.created_at, rows.entity_id) < (p_before, COALESCE(p_before_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  ORDER BY rows.created_at DESC, rows.entity_id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
END;
$$;


ALTER FUNCTION "public"."get_agent_activity"("p_business_ids" "uuid"[], "p_limit" integer, "p_before" timestamp with time zone, "p_before_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_estimate"("p_public_id" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'estimate', json_build_object(
      'public_id', e.public_id,
      'estimate_number', e.estimate_number,
      'status', e.status,
      'issue_date', e.issue_date,
      'expiry_date', e.expiry_date,
      'currency', e.currency,
      'subtotal', e.subtotal,
      'discount_type', e.discount_type,
      'discount_value', e.discount_value,
      'discount_amount', e.discount_amount,
      'tax_rate', e.tax_rate,
      'tax_amount', e.tax_amount,
      'shipping_amount', e.shipping_amount,
      'total', e.total,
      'notes', e.notes,
      'terms', e.terms,
      'business_snapshot', public.public_business_snapshot(e.business_snapshot),
      'client_snapshot', public.public_client_snapshot(e.client_snapshot)
    ),
    'line_items', COALESCE((
      SELECT json_agg(json_build_object(
        'id', li.id,
        'description', li.description,
        'quantity', li.quantity,
        'rate', li.rate,
        'amount', li.amount,
        'sort_order', li.sort_order
      ) ORDER BY li.sort_order)
      FROM public.estimate_line_items li WHERE li.estimate_id = e.id
    ), '[]'::json)
  ) INTO result
  FROM public.estimates e
  WHERE e.public_id = p_public_id
    AND e.status NOT IN ('draft', 'declined', 'expired');

  RETURN result;
END;
$$;


ALTER FUNCTION "public"."get_public_estimate"("p_public_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_public_invoice"("p_public_id" "text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'invoice', json_build_object(
      'public_id', i.public_id,
      'invoice_number', i.invoice_number,
      'status', i.status,
      'issue_date', i.issue_date,
      'due_date', i.due_date,
      'currency', i.currency,
      'subtotal', i.subtotal,
      'discount_type', i.discount_type,
      'discount_value', i.discount_value,
      'discount_amount', i.discount_amount,
      'tax_rate', i.tax_rate,
      'tax_amount', i.tax_amount,
      'shipping_amount', i.shipping_amount,
      'total', i.total,
      'amount_paid', i.amount_paid,
      'balance_due', i.balance_due,
      'notes', i.notes,
      'terms', i.terms,
      'footer', i.footer,
      'payment_instructions', i.payment_instructions,
      'po_number', i.po_number,
      -- Snapshots are point-in-time copies, not live PII joins. Strip the
      -- business tax_id from the business snapshot before it goes public.
      'business_snapshot', public.public_business_snapshot(i.business_snapshot),
      'client_snapshot', public.public_client_snapshot(i.client_snapshot)
    ),
    'line_items', COALESCE((
      SELECT json_agg(json_build_object(
        'id', li.id,
        'description', li.description,
        'quantity', li.quantity,
        'rate', li.rate,
        'amount', li.amount,
        'sort_order', li.sort_order
      ) ORDER BY li.sort_order)
      FROM public.invoice_line_items li WHERE li.invoice_id = i.id
    ), '[]'::json)
  ) INTO result
  FROM public.invoices i
  WHERE i.public_id = p_public_id
    AND i.status NOT IN ('draft', 'cancelled');

  -- Record first view for status tracking (best effort). Only for
  -- non-excluded rows so unsent/cancelled docs are never touched.
  UPDATE public.invoices SET last_viewed_at = NOW(),
    status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END
  WHERE public_id = p_public_id
    AND status NOT IN ('draft', 'cancelled');

  RETURN result;
END;
$$;


ALTER FUNCTION "public"."get_public_invoice"("p_public_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_report_summary"("p_business_id" "uuid", "p_start" "date", "p_end" "date", "p_prev_start" "date" DEFAULT NULL::"date", "p_prev_end" "date" DEFAULT NULL::"date", "p_bucket" "text" DEFAULT 'month'::"text", "p_currency" "text" DEFAULT NULL::"text", "p_aging_limit" integer DEFAULT 500) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_currency TEXT;
  v_limit INT := LEAST(GREATEST(COALESCE(p_aging_limit, 500), 1), 2000);
  v_step INTERVAL;
  v_result JSONB;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.business_members bm
     WHERE bm.business_id = p_business_id AND bm.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of this business' USING ERRCODE = '42501';
  END IF;

  -- p_bucket is concatenated into an interval literal below, so it is
  -- allow-listed rather than trusted.
  IF p_bucket IS NULL OR p_bucket NOT IN ('day', 'week', 'month') THEN
    RAISE EXCEPTION 'p_bucket must be one of day, week, month';
  END IF;
  v_step := ('1 ' || p_bucket)::INTERVAL;

  SELECT COALESCE(p_currency, b.default_currency, 'USD') INTO v_currency
    FROM public.businesses b WHERE b.id = p_business_id;

  WITH periods AS (
    SELECT 'current'::TEXT AS k, p_start AS s, p_end AS e
    UNION ALL
    SELECT 'previous'::TEXT, p_prev_start, p_prev_end
  ),
  -- Invoiced (accrual): what was billed in the window. Drafts and cancelled
  -- invoices are excluded everywhere, matching EXCLUDED_FROM_TOTALS in the
  -- MCP layer so the app and the agents report the same numbers.
  inv AS (
    SELECT pr.k,
           COALESCE(SUM(i.total), 0)::NUMERIC AS invoiced,
           COALESCE(SUM(i.amount_paid), 0)::NUMERIC AS invoiced_paid,
           COUNT(i.id) AS invoice_count
      FROM periods pr
      LEFT JOIN public.invoices i
        ON i.business_id = p_business_id
       AND i.currency = v_currency
       AND i.status NOT IN ('draft', 'cancelled')
       AND pr.s IS NOT NULL
       AND i.issue_date BETWEEN pr.s AND pr.e
     GROUP BY pr.k
  ),
  -- Collected (cash): money that actually arrived in the window. Payments,
  -- not invoice.paid_at, so partial payments land in the period they were
  -- received.
  pay AS (
    SELECT pr.k,
           COALESCE(SUM(p.amount), 0)::NUMERIC AS collected,
           COUNT(p.id) AS payment_count
      FROM periods pr
      LEFT JOIN public.payments p
        ON p.business_id = p_business_id
       AND p.currency = v_currency
       AND pr.s IS NOT NULL
       AND p.payment_date BETWEEN pr.s AND pr.e
       AND p.voided_at IS NULL
     GROUP BY pr.k
  ),
  exp AS (
    SELECT pr.k,
           COALESCE(SUM(x.amount), 0)::NUMERIC AS expenses,
           COUNT(x.id) AS expense_count
      FROM periods pr
      LEFT JOIN public.expenses x
        ON x.business_id = p_business_id
       AND x.currency = v_currency
       AND pr.s IS NOT NULL
       AND x.date BETWEEN pr.s AND pr.e
     GROUP BY pr.k
  ),
  totals AS (
    SELECT inv.k,
           inv.invoiced, inv.invoiced_paid, inv.invoice_count,
           pay.collected, pay.payment_count,
           exp.expenses, exp.expense_count
      FROM inv JOIN pay ON pay.k = inv.k JOIN exp ON exp.k = inv.k
  ),
  buckets AS (
    SELECT gs::DATE AS bucket_start
      FROM generate_series(
             date_trunc(p_bucket, p_start::TIMESTAMP),
             date_trunc(p_bucket, p_end::TIMESTAMP),
             v_step
           ) gs
  ),
  prev_buckets AS (
    SELECT gs::DATE AS bucket_start
      FROM generate_series(
             date_trunc(p_bucket, COALESCE(p_prev_start, p_start)::TIMESTAMP),
             date_trunc(p_bucket, COALESCE(p_prev_end, p_start - 1)::TIMESTAMP),
             v_step
           ) gs
     WHERE p_prev_start IS NOT NULL
  ),
  -- Bucketing happens on DATE columns via date_trunc, so no timestamp is ever
  -- shifted into or out of a bucket by a timezone. The client formats the
  -- same yyyy-mm-dd string without re-interpreting it as UTC.
  series AS (
    SELECT b.bucket_start,
           COALESCE((
             SELECT SUM(i.total) FROM public.invoices i
              WHERE i.business_id = p_business_id AND i.currency = v_currency
                AND i.status NOT IN ('draft', 'cancelled')
                AND i.issue_date >= b.bucket_start
                AND i.issue_date < (b.bucket_start + v_step)::DATE
                AND i.issue_date BETWEEN p_start AND p_end
           ), 0)::NUMERIC AS invoiced,
           COALESCE((
             SELECT SUM(p.amount) FROM public.payments p
              WHERE p.business_id = p_business_id AND p.currency = v_currency
                AND p.payment_date >= b.bucket_start
                AND p.payment_date < (b.bucket_start + v_step)::DATE
                AND p.payment_date BETWEEN p_start AND p_end
                AND p.voided_at IS NULL
           ), 0)::NUMERIC AS collected,
           COALESCE((
             SELECT SUM(x.amount) FROM public.expenses x
              WHERE x.business_id = p_business_id AND x.currency = v_currency
                AND x.date >= b.bucket_start
                AND x.date < (b.bucket_start + v_step)::DATE
                AND x.date BETWEEN p_start AND p_end
           ), 0)::NUMERIC AS expenses
      FROM buckets b
  ),
  prev_series AS (
    SELECT b.bucket_start,
           COALESCE((
             SELECT SUM(i.total) FROM public.invoices i
              WHERE i.business_id = p_business_id AND i.currency = v_currency
                AND i.status NOT IN ('draft', 'cancelled')
                AND i.issue_date >= b.bucket_start
                AND i.issue_date < (b.bucket_start + v_step)::DATE
                AND i.issue_date BETWEEN p_prev_start AND p_prev_end
           ), 0)::NUMERIC AS invoiced,
           COALESCE((
             SELECT SUM(p.amount) FROM public.payments p
              WHERE p.business_id = p_business_id AND p.currency = v_currency
                AND p.payment_date >= b.bucket_start
                AND p.payment_date < (b.bucket_start + v_step)::DATE
                AND p.payment_date BETWEEN p_prev_start AND p_prev_end
                AND p.voided_at IS NULL
           ), 0)::NUMERIC AS collected
      FROM prev_buckets b
  ),
  by_category AS (
    SELECT x.category,
           SUM(x.amount)::NUMERIC AS amount,
           COUNT(*) AS count
      FROM public.expenses x
     WHERE x.business_id = p_business_id AND x.currency = v_currency
       AND x.date BETWEEN p_start AND p_end
     GROUP BY x.category
  ),
  by_status AS (
    SELECT i.status,
           SUM(i.total)::NUMERIC AS amount,
           SUM(i.balance_due)::NUMERIC AS balance_due,
           COUNT(*) AS count
      FROM public.invoices i
     WHERE i.business_id = p_business_id AND i.currency = v_currency
       AND i.status NOT IN ('draft', 'cancelled')
       AND i.issue_date BETWEEN p_start AND p_end
     GROUP BY i.status
  ),
  client_totals AS (
    SELECT i.client_id,
           SUM(i.total)::NUMERIC AS invoiced,
           SUM(i.amount_paid)::NUMERIC AS paid,
           SUM(i.balance_due)::NUMERIC AS outstanding,
           COUNT(*) AS invoice_count
      FROM public.invoices i
     WHERE i.business_id = p_business_id AND i.currency = v_currency
       AND i.status NOT IN ('draft', 'cancelled')
       AND i.issue_date BETWEEN p_start AND p_end
     GROUP BY i.client_id
  ),
  top_clients AS (
    SELECT ct.client_id, c.name AS client_name,
           ct.invoiced, ct.paid, ct.outstanding, ct.invoice_count
      FROM client_totals ct
      JOIN public.clients c ON c.id = ct.client_id
     ORDER BY ct.invoiced DESC
     LIMIT 10
  ),
  time_summary AS (
    SELECT
      COALESCE(SUM((t.duration_seconds::numeric / 60)), 0)::NUMERIC AS total_minutes,
      COALESCE(SUM((t.duration_seconds::numeric / 60)) FILTER (WHERE t.is_billable), 0)::NUMERIC AS billable_minutes,
      COALESCE(SUM((t.duration_seconds::numeric / 60)) FILTER (WHERE NOT t.is_billable), 0)::NUMERIC AS non_billable_minutes,
      COALESCE(SUM((t.duration_seconds::numeric / 60)) FILTER (WHERE t.is_billable AND NOT t.is_billed), 0)::NUMERIC AS unbilled_minutes,
      COALESCE(SUM(t.amount) FILTER (WHERE t.is_billable AND NOT t.is_billed), 0)::NUMERIC AS unbilled_value,
      COALESCE(SUM(t.amount) FILTER (WHERE t.is_billable), 0)::NUMERIC AS billable_value,
      COUNT(*) AS entry_count
      FROM public.time_entries t
     WHERE t.business_id = p_business_id
       AND t.date BETWEEN p_start AND p_end
       AND COALESCE(t.is_running, FALSE) = FALSE
  ),
  -- Open invoices, as of today, for the aging report. Not restricted to the
  -- selected range: money owed from two years ago is still owed today.
  open_invoices AS (
    SELECT i.id, i.public_id, i.invoice_number, i.status, i.issue_date, i.due_date,
           i.total::NUMERIC, i.balance_due::NUMERIC, i.currency,
           i.client_id, c.name AS client_name, c.email AS client_email
      FROM public.invoices i
      LEFT JOIN public.clients c ON c.id = i.client_id
     WHERE i.business_id = p_business_id
       AND i.currency = v_currency
       AND i.status NOT IN ('draft', 'cancelled', 'paid')
       AND i.balance_due > 0
     ORDER BY i.due_date ASC
     LIMIT v_limit
  ),
  open_count AS (
    SELECT COUNT(*) AS n
      FROM public.invoices i
     WHERE i.business_id = p_business_id
       AND i.currency = v_currency
       AND i.status NOT IN ('draft', 'cancelled', 'paid')
       AND i.balance_due > 0
  ),
  currencies AS (
    SELECT code, SUM(n) AS n FROM (
      SELECT i.currency AS code, COUNT(*) AS n FROM public.invoices i
       WHERE i.business_id = p_business_id AND i.status NOT IN ('draft', 'cancelled')
       GROUP BY i.currency
      UNION ALL
      SELECT x.currency, COUNT(*) FROM public.expenses x
       WHERE x.business_id = p_business_id
       GROUP BY x.currency
    ) u
     WHERE code IS NOT NULL
     GROUP BY code
     ORDER BY SUM(n) DESC
  )
  SELECT jsonb_build_object(
    'currency', v_currency,
    'bucket', p_bucket,
    'range', jsonb_build_object('start', p_start, 'end', p_end),
    'previous_range', CASE WHEN p_prev_start IS NULL THEN NULL
      ELSE jsonb_build_object('start', p_prev_start, 'end', p_prev_end) END,
    'totals', COALESCE((
      SELECT jsonb_object_agg(t.k, jsonb_build_object(
        'invoiced', t.invoiced,
        'invoiced_paid', t.invoiced_paid,
        'collected', t.collected,
        'expenses', t.expenses,
        'invoice_count', t.invoice_count,
        'payment_count', t.payment_count,
        'expense_count', t.expense_count
      )) FROM totals t), '{}'::JSONB),
    'series', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'bucket_start', s.bucket_start,
        'invoiced', s.invoiced,
        'collected', s.collected,
        'expenses', s.expenses
      ) ORDER BY s.bucket_start) FROM series s), '[]'::JSONB),
    'previous_series', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'bucket_start', s.bucket_start,
        'invoiced', s.invoiced,
        'collected', s.collected
      ) ORDER BY s.bucket_start) FROM prev_series s), '[]'::JSONB),
    'expenses_by_category', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'category', b.category, 'amount', b.amount, 'count', b.count
      ) ORDER BY b.amount DESC) FROM by_category b), '[]'::JSONB),
    'invoices_by_status', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'status', b.status, 'amount', b.amount, 'balance_due', b.balance_due, 'count', b.count
      ) ORDER BY b.amount DESC) FROM by_status b), '[]'::JSONB),
    'top_clients', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'client_id', t.client_id, 'client_name', t.client_name,
        'invoiced', t.invoiced, 'paid', t.paid, 'outstanding', t.outstanding,
        'invoice_count', t.invoice_count
      ) ORDER BY t.invoiced DESC) FROM top_clients t), '[]'::JSONB),
    'time', COALESCE((
      SELECT jsonb_build_object(
        'total_minutes', ts.total_minutes,
        'billable_minutes', ts.billable_minutes,
        'non_billable_minutes', ts.non_billable_minutes,
        'unbilled_minutes', ts.unbilled_minutes,
        'unbilled_value', ts.unbilled_value,
        'billable_value', ts.billable_value,
        'entry_count', ts.entry_count
      ) FROM time_summary ts), '{}'::JSONB),
    'open_invoices', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', o.id, 'public_id', o.public_id, 'invoice_number', o.invoice_number,
        'status', o.status, 'issue_date', o.issue_date, 'due_date', o.due_date,
        'total', o.total, 'balance_due', o.balance_due, 'currency', o.currency,
        'client_id', o.client_id, 'client_name', o.client_name, 'client_email', o.client_email
      ) ORDER BY o.due_date) FROM open_invoices o), '[]'::JSONB),
    'open_invoice_count', (SELECT n FROM open_count),
    'open_invoice_limit', v_limit,
    'currencies', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('code', c.code, 'count', c.n)) FROM currencies c
    ), '[]'::JSONB)
  ) INTO v_result;

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."get_report_summary"("p_business_id" "uuid", "p_start" "date", "p_end" "date", "p_prev_start" "date", "p_prev_end" "date", "p_bucket" "text", "p_currency" "text", "p_aging_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_api_key_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;
  NEW.id := OLD.id;
  NEW.user_id := OLD.user_id;
  NEW.business_id := OLD.business_id;
  NEW.key_hash := OLD.key_hash;
  NEW.key_prefix := OLD.key_prefix;
  NEW.permissions := OLD.permissions;
  NEW.kind := OLD.kind;
  NEW.oauth_client_id := OLD.oauth_client_id;
  NEW.expires_at := OLD.expires_at;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."guard_api_key_columns"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_document_client"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE v_client clients%ROWTYPE;
BEGIN
  SELECT * INTO v_client FROM clients WHERE id = NEW.client_id AND business_id = NEW.business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Client not found in this business'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.business_id <> OLD.business_id THEN RAISE EXCEPTION 'Documents cannot move between businesses'; END IF;
    IF OLD.status <> 'draft' AND (NEW.client_id <> OLD.client_id OR NEW.currency <> OLD.currency
      OR NEW.total <> OLD.total OR NEW.issue_date <> OLD.issue_date) THEN
      RAISE EXCEPTION 'Issued documents require a correction, not a financial edit';
    END IF;
  END IF;
  IF NEW.status = 'draft' THEN
    NEW.client_snapshot := to_jsonb(v_client);
    SELECT to_jsonb(b) INTO NEW.business_snapshot FROM businesses b WHERE b.id = NEW.business_id;
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."guard_document_client"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_document_delete"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
 IF OLD.status<>'draft' OR EXISTS(SELECT 1 FROM email_deliveries WHERE document_id=OLD.id) THEN RAISE EXCEPTION 'Only unsent drafts can be deleted'; END IF;
 RETURN OLD;
END $$;


ALTER FUNCTION "public"."guard_document_delete"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_engagement_entry"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_status TEXT;
  v_releasing BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'invoiced' THEN
      RAISE EXCEPTION 'entry_invoiced_immutable' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'invoiced' THEN
    -- COALESCE matters twice over: current_setting(..., TRUE) is NULL when the
    -- setting was never set, and a NULL here would make the guard below
    -- evaluate to NULL and skip the RAISE entirely, which is the opposite of
    -- what a guard should do when it is unsure.
    v_releasing := COALESCE(
      -- Only the invoice delete trigger may claim this, and
      -- only while it is running.
      pg_trigger_depth() > 1
        AND OLD.invoice_id IS NOT NULL
        AND COALESCE(current_setting('billr.releasing_invoice', TRUE), '') = OLD.invoice_id::TEXT
        AND NEW.invoice_id IS NULL
        AND NEW.invoice_line_id IS NULL
        AND NEW.status = 'ready_to_bill'
        AND NEW.amount = OLD.amount
        AND NEW.engagement_id = OLD.engagement_id,
      FALSE
    );

    IF NOT v_releasing AND (
         NEW.amount <> OLD.amount
      OR NEW.status <> 'invoiced'
      OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
      OR NEW.engagement_id <> OLD.engagement_id
    ) THEN
      RAISE EXCEPTION 'entry_invoiced_immutable' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.status = 'invoiced' AND (TG_OP = 'INSERT' OR OLD.status <> 'invoiced') THEN
    SELECT e.status INTO v_status FROM public.engagements e WHERE e.id = NEW.engagement_id;
    IF v_status = 'cancelled' THEN
      RAISE EXCEPTION 'engagement_cancelled' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- An entry always belongs to the same business as its engagement. Written
  -- here rather than trusted from the caller, so a mis-scoped insert lands in
  -- nobody's list rather than in the wrong tenant's.
  SELECT e.business_id INTO NEW.business_id FROM public.engagements e WHERE e.id = NEW.engagement_id;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."guard_engagement_entry"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_payment_amount"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;
  IF NEW.amount IS NULL OR ROUND(NEW.amount, 2) <= 0 THEN
    RAISE EXCEPTION 'Only a verified refund may post a non-positive payment'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."guard_payment_amount"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_payment_relations"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = NEW.invoice_id
    AND i.business_id = NEW.business_id AND i.client_id = NEW.client_id AND i.currency = NEW.currency) THEN
    RAISE EXCEPTION 'Payment must match its invoice, client, business and currency';
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."guard_payment_relations"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_stripe_invoice_fields"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.stripe_payment_intent_id IS NOT NULL OR NEW.stripe_payment_status IS NOT NULL THEN
    RAISE EXCEPTION 'Stripe payment references are server managed';
   END IF;
  ELSIF NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id
     OR NEW.stripe_payment_status IS DISTINCT FROM OLD.stripe_payment_status THEN
   RAISE EXCEPTION 'Stripe payment references are server managed';
  END IF;
 END IF;
 RETURN NEW;
END $$;


ALTER FUNCTION "public"."guard_stripe_invoice_fields"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_stripe_payment_fields"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' AND(NEW.stripe_payment_id IS NOT NULL OR NEW.payment_method='stripe' OR NEW.created_via='stripe') THEN RAISE EXCEPTION 'Stripe ledger entries require a verified server event'; END IF;
 RETURN NEW;
END $$;


ALTER FUNCTION "public"."guard_stripe_payment_fields"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_task_key"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
 IF NEW.actor_key_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM api_keys WHERE id=NEW.actor_key_id AND revoked_at IS NULL AND(expires_at IS NULL OR expires_at>now()) AND 'write'=ANY(permissions)) THEN RAISE EXCEPTION 'Agent key cannot record work'; END IF;
 RETURN NEW;
END $$;


ALTER FUNCTION "public"."guard_task_key"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_work_currency"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
BEGIN
 IF TG_TABLE_NAME='time_entries' AND NEW.currency IS NULL THEN
  SELECT COALESCE((SELECT currency FROM clients WHERE id=NEW.client_id),default_currency) INTO NEW.currency FROM businesses WHERE id=NEW.business_id;
 END IF;
 IF NEW.currency !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'Invalid currency'; END IF;
 IF NEW.invoice_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM invoices WHERE id=NEW.invoice_id AND currency=NEW.currency) THEN RAISE EXCEPTION 'Work currency must match its invoice'; END IF;
 RETURN NEW;
END $_$;


ALTER FUNCTION "public"."guard_work_currency"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_work_entry"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE v_invoice invoices%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.invoice_id IS NOT NULL THEN RAISE EXCEPTION 'Invoiced work cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.invoice_id IS NOT NULL THEN
    -- A draft deletion releases work through ON DELETE SET NULL. Everything
    -- else on linked work is immutable, including a reassignment to another invoice.
    IF NEW.invoice_id IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Invoiced work cannot be edited';
    END IF;
    IF NEW.invoice_id IS NULL AND EXISTS (SELECT 1 FROM invoices WHERE id = OLD.invoice_id) THEN
      RAISE EXCEPTION 'Delete the draft invoice before releasing its work';
    END IF;
  END IF;
  IF NEW.client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM clients WHERE id = NEW.client_id AND business_id = NEW.business_id
  ) THEN RAISE EXCEPTION 'Client not found in this business'; END IF;
  IF NEW.invoice_id IS NOT NULL THEN
    SELECT * INTO v_invoice FROM invoices WHERE id = NEW.invoice_id FOR UPDATE;
    IF NOT FOUND OR v_invoice.business_id <> NEW.business_id OR v_invoice.client_id IS DISTINCT FROM NEW.client_id
      OR NOT NEW.is_billable OR v_invoice.status <> 'draft' THEN
      RAISE EXCEPTION 'Work must match an editable draft and its client';
    END IF;
    IF TG_TABLE_NAME = 'expenses' THEN
      IF NEW.currency <> v_invoice.currency THEN RAISE EXCEPTION 'Expense currency must match the invoice'; END IF;
    END IF;
  END IF;
  NEW.is_billed := NEW.invoice_id IS NOT NULL;
  IF TG_TABLE_NAME = 'time_entries' THEN
    -- Old integrations can still write minutes; new integrations preserve seconds.
    IF TG_OP = 'INSERT' AND NEW.duration_seconds = 0 AND COALESCE(NEW.duration_minutes, 0) > 0 THEN
      NEW.duration_seconds := NEW.duration_minutes * 60;
    ELSIF TG_OP = 'UPDATE' AND NEW.duration_seconds = OLD.duration_seconds
      AND NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes THEN
      NEW.duration_seconds := COALESCE(NEW.duration_minutes, 0) * 60;
    END IF;
    IF NEW.duration_seconds <= 0 OR NEW.duration_seconds > 86400 THEN RAISE EXCEPTION 'Time must be between one second and 24 hours'; END IF;
    IF NEW.hourly_rate < 0 THEN RAISE EXCEPTION 'Rate cannot be negative'; END IF;
    NEW.duration_minutes := ROUND(NEW.duration_seconds::NUMERIC / 60);
    NEW.amount := CASE WHEN NOT NEW.is_billable THEN 0 WHEN NEW.hourly_rate IS NULL THEN NULL
      ELSE ROUND(NEW.duration_seconds::NUMERIC * NEW.hourly_rate / 3600, 2) END;
    IF NEW.invoice_id IS NOT NULL AND NEW.hourly_rate IS NULL THEN RAISE EXCEPTION 'Confirm an hourly rate before invoicing'; END IF;
  ELSE
    IF NEW.amount <= 0 THEN RAISE EXCEPTION 'Expense amount must be positive'; END IF;
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."guard_work_entry"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name');
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_entry_complete"("p_request_id" "uuid", "p_entry_id" "uuid", "p_actor_key_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_entry public.engagement_entries%ROWTYPE;
  v_actor RECORD;
  v_receipt public.operation_receipts%ROWTYPE;
  v_input JSONB;
  v_result JSONB;
  v_became_ready BOOLEAN := FALSE;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_entry FROM public.engagement_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entry_not_found' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    SELECT * INTO v_actor FROM public.resolve_engagement_actor(v_entry.business_id, p_actor_key_id, 'write');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'engagement_not_found' THEN
      RAISE EXCEPTION 'entry_not_found' USING ERRCODE = 'P0001';
    END IF;
    RAISE;
  END;

  v_input := jsonb_build_object('entry_id', p_entry_id);

  SELECT * INTO v_receipt FROM public.operation_receipts
   WHERE business_id = v_entry.business_id AND operation = 'mark_entry_complete' AND request_id = p_request_id;
  IF FOUND THEN
    IF v_receipt.input <> v_input THEN
      RAISE EXCEPTION 'request_id_reused' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_set(v_receipt.result, '{replayed}', 'true'::JSONB);
  END IF;

  IF v_entry.status = 'invoiced' THEN
    RAISE EXCEPTION 'entry_already_invoiced' USING ERRCODE = 'P0001';
  END IF;
  IF v_entry.status = 'waived' THEN
    RAISE EXCEPTION 'entry_waived' USING ERRCODE = 'P0001';
  END IF;

  v_became_ready := v_entry.status = 'pending' AND v_entry.due_rule IN ('on_milestone', 'manual');

  UPDATE public.engagement_entries
     SET completed_at = COALESCE(completed_at, now()),
         status = CASE WHEN v_became_ready THEN 'ready_to_bill' ELSE status END
   WHERE id = p_entry_id
  RETURNING * INTO v_entry;

  v_result := public.engagement_payload(v_entry.engagement_id) || jsonb_build_object(
    'replayed', FALSE,
    'entry', to_jsonb(v_entry),
    'became_ready_to_bill', v_became_ready
  );

  INSERT INTO public.operation_receipts (business_id, operation, request_id, input, result)
  VALUES (v_entry.business_id, 'mark_entry_complete', p_request_id, v_input, v_result);

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."mark_entry_complete"("p_request_id" "uuid", "p_entry_id" "uuid", "p_actor_key_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."peek_rate_limit"("p_bucket" "text", "p_limit" integer, "p_window_seconds" integer) RETURNS TABLE("allowed" boolean, "remaining" integer, "retry_after_seconds" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_bucket TEXT := LEFT(BTRIM(COALESCE(p_bucket, '')), 200);
  v_limit INTEGER := GREATEST(COALESCE(p_limit, 1), 1);
  v_window INTEGER := LEAST(GREATEST(COALESCE(p_window_seconds, 60), 1), 86400);
  v_now TIMESTAMPTZ := NOW();
  v_window_start TIMESTAMPTZ;
  v_window_end TIMESTAMPTZ;
  v_hits INTEGER;
BEGIN
  IF v_bucket = '' THEN
    RAISE EXCEPTION 'invalid_bucket' USING ERRCODE = 'P0001';
  END IF;

  v_window_start := TO_TIMESTAMP((FLOOR(EXTRACT(EPOCH FROM v_now))::BIGINT / v_window) * v_window);
  v_window_end := v_window_start + MAKE_INTERVAL(secs => v_window);

  SELECT c.hits INTO v_hits
    FROM public.rate_limit_counters c
   WHERE c.bucket = v_bucket
     AND c.window_start = v_window_start;

  v_hits := COALESCE(v_hits, 0);

  allowed := v_hits < v_limit;
  remaining := GREATEST(v_limit - v_hits, 0);
  retry_after_seconds := GREATEST(CEIL(EXTRACT(EPOCH FROM (v_window_end - v_now)))::INTEGER, 1);
  RETURN NEXT;
END;
$$;


ALTER FUNCTION "public"."peek_rate_limit"("p_bucket" "text", "p_limit" integer, "p_window_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."promote_due_entries"("p_business_id" "uuid", "p_actor_key_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_actor RECORD;
  v_ids UUID[];
BEGIN
  SELECT * INTO v_actor FROM public.resolve_engagement_actor(p_business_id, p_actor_key_id, 'read');

  WITH promoted AS (
    UPDATE public.engagement_entries en
       SET status = 'ready_to_bill'
      FROM public.engagements e
     WHERE en.engagement_id = e.id
       AND en.business_id = p_business_id
       AND en.status = 'pending'
       AND en.due_rule = 'on_date'
       AND en.due_on IS NOT NULL
       AND en.due_on <= CURRENT_DATE
       -- Only a live agreement bills itself. A draft, paused, completed or
       -- cancelled engagement waits for a person.
       AND e.status = 'active'
    RETURNING en.id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::UUID[]) INTO v_ids FROM promoted;

  RETURN jsonb_build_object('promoted', COALESCE(array_length(v_ids, 1), 0), 'entry_ids', to_jsonb(v_ids));
END;
$$;


ALTER FUNCTION "public"."promote_due_entries"("p_business_id" "uuid", "p_actor_key_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prune_rate_limit_counters"("p_max_rows" integer DEFAULT 500) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_max INTEGER := LEAST(GREATEST(COALESCE(p_max_rows, 500), 1), 50000);
  v_deleted INTEGER;
BEGIN
  -- SKIP LOCKED so two instances sweeping at the same moment never wait on
  -- each other, and delete by primary key rather than ctid so a concurrently
  -- updated row cannot be matched by a stale physical address.
  WITH doomed AS (
    SELECT c.bucket, c.window_start
      FROM public.rate_limit_counters c
     WHERE c.expires_at < NOW() - INTERVAL '1 hour'
     ORDER BY c.expires_at
     LIMIT v_max
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.rate_limit_counters t
   USING doomed d
   WHERE t.bucket = d.bucket
     AND t.window_start = d.window_start;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;


ALTER FUNCTION "public"."prune_rate_limit_counters"("p_max_rows" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."public_business_snapshot"("snap" "jsonb") RETURNS "jsonb"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
    FROM jsonb_each(COALESCE(snap, '{}'::jsonb))
   WHERE key IN (
     'name', 'email', 'phone', 'website', 'logo_url', 'primary_color',
     'address_line1', 'address_line2', 'city', 'state', 'postal_code',
     'country'
   );
$$;


ALTER FUNCTION "public"."public_business_snapshot"("snap" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."public_client_snapshot"("snap" "jsonb") RETURNS "jsonb"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
    FROM jsonb_each(COALESCE(snap, '{}'::jsonb))
   WHERE key IN (
     'name', 'email', 'phone', 'company',
     'address_line1', 'address_line2', 'city', 'state', 'postal_code',
     'country'
   );
$$;


ALTER FUNCTION "public"."public_client_snapshot"("snap" "jsonb") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "public_id" "text" DEFAULT "public"."generate_public_id"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "invoice_number" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "issue_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "due_date" "date" NOT NULL,
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "subtotal" numeric(12,2) DEFAULT 0 NOT NULL,
    "discount_type" "text" DEFAULT 'percentage'::"text" NOT NULL,
    "discount_value" numeric(18,6) DEFAULT 0 NOT NULL,
    "discount_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "tax_rate" numeric(9,6) DEFAULT 0 NOT NULL,
    "tax_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "shipping_amount" numeric(10,2) DEFAULT 0 NOT NULL,
    "total" numeric(12,2) DEFAULT 0 NOT NULL,
    "amount_paid" numeric(12,2) DEFAULT 0 NOT NULL,
    "balance_due" numeric(12,2) DEFAULT 0 NOT NULL,
    "notes" "text",
    "terms" "text",
    "footer" "text",
    "payment_instructions" "text",
    "po_number" "text",
    "is_recurring" boolean DEFAULT false NOT NULL,
    "recurring_interval" "text",
    "recurring_end_date" "date",
    "last_sent_at" timestamp with time zone,
    "last_viewed_at" timestamp with time zone,
    "paid_at" "date",
    "payment_method" "text",
    "stripe_payment_intent_id" "text",
    "stripe_payment_status" "text",
    "client_snapshot" "jsonb",
    "business_snapshot" "jsonb",
    "from_estimate_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "disputed" boolean DEFAULT false,
    "created_via" "text" DEFAULT 'web'::"text",
    "created_by_key_id" "uuid",
    CONSTRAINT "invoices_discount_type_check" CHECK (("discount_type" = ANY (ARRAY['percentage'::"text", 'fixed'::"text"]))),
    CONSTRAINT "invoices_recurring_interval_check" CHECK (("recurring_interval" = ANY (ARRAY['weekly'::"text", 'biweekly'::"text", 'monthly'::"text", 'quarterly'::"text", 'yearly'::"text"]))),
    CONSTRAINT "invoices_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'sent'::"text", 'viewed'::"text", 'paid'::"text", 'partial'::"text", 'overdue'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."invoices" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."recompute_invoice_money"("p_invoice_id" "uuid", "p_paid_at_hint" "date" DEFAULT NULL::"date") RETURNS "public"."invoices"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_invoice public.invoices%ROWTYPE;
  v_sum NUMERIC;
  v_last DATE;
  v_amount_paid NUMERIC;
  v_balance_due NUMERIC;
  v_status TEXT;
BEGIN
  SELECT * INTO v_invoice FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(SUM(p.amount), 0), MAX(p.payment_date)
    INTO v_sum, v_last
    FROM public.payments p
   WHERE p.invoice_id = p_invoice_id
     AND p.voided_at IS NULL;

  v_amount_paid := GREATEST(ROUND(v_sum, 2), 0);
  v_balance_due := GREATEST(ROUND(v_invoice.total - v_amount_paid, 2), 0);
  v_status := CASE
    WHEN v_amount_paid <= 0 AND v_invoice.status = 'cancelled' THEN 'cancelled'
    WHEN v_amount_paid <= 0 THEN 'sent'
    WHEN v_balance_due <= 0 THEN 'paid'
    ELSE 'partial'
  END;

  UPDATE public.invoices i SET
    amount_paid = v_amount_paid,
    balance_due = v_balance_due,
    status = v_status,
    paid_at = CASE
      WHEN v_status = 'paid' THEN COALESCE(p_paid_at_hint, v_last, CURRENT_DATE)
      ELSE NULL END
  WHERE i.id = p_invoice_id
  RETURNING i.* INTO v_invoice;

  RETURN v_invoice;
END;
$$;


ALTER FUNCTION "public"."recompute_invoice_money"("p_invoice_id" "uuid", "p_paid_at_hint" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_invoice_payment"("p_invoice_id" "uuid", "p_amount" numeric, "p_payment_date" "date", "p_payment_method" "text" DEFAULT 'other'::"text", "p_reference_number" "text" DEFAULT NULL::"text", "p_notes" "text" DEFAULT NULL::"text", "p_created_via" "text" DEFAULT 'web'::"text", "p_created_by_key_id" "uuid" DEFAULT NULL::"uuid", "p_stripe_payment_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_invoice public.invoices%ROWTYPE;
  v_payment_id UUID;
  v_payment_date DATE := COALESCE(p_payment_date, CURRENT_DATE);
  v_source TEXT;
BEGIN
  IF p_amount IS NULL OR p_amount = 0 THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = 'P0001';
  END IF;

  IF ABS(p_amount) > 1000000000 THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_invoice FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'P0001';
  END IF;

  v_source := CASE
    WHEN NULLIF(BTRIM(COALESCE(p_stripe_payment_id, '')), '') IS NOT NULL
      OR p_created_via = 'stripe' THEN 'stripe'
    WHEN p_created_via = 'agent' OR p_created_by_key_id IS NOT NULL THEN 'agent'
    ELSE 'manual'
  END;

  INSERT INTO public.payments (
    business_id, invoice_id, client_id, amount, currency, payment_date,
    payment_method, reference_number, notes, stripe_payment_id,
    created_via, created_by_key_id, source
  ) VALUES (
    v_invoice.business_id,
    v_invoice.id,
    v_invoice.client_id,
    ROUND(p_amount, 2),
    v_invoice.currency,
    v_payment_date,
    COALESCE(NULLIF(BTRIM(p_payment_method), ''), 'other'),
    NULLIF(BTRIM(COALESCE(p_reference_number, '')), ''),
    NULLIF(BTRIM(COALESCE(p_notes, '')), ''),
    NULLIF(BTRIM(COALESCE(p_stripe_payment_id, '')), ''),
    COALESCE(NULLIF(BTRIM(p_created_via), ''), 'web'),
    p_created_by_key_id,
    v_source
  )
  ON CONFLICT (stripe_payment_id) WHERE stripe_payment_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_payment_id;

  -- Runs on the dedup path too: if the ledger row already existed but the
  -- invoice update never landed last time, this heals it.
  v_invoice := public.recompute_invoice_money(p_invoice_id, v_payment_date);

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'duplicate', v_payment_id IS NULL,
    'ledger_total', v_invoice.amount_paid,
    'invoice', to_jsonb(v_invoice)
  );
END;
$$;


ALTER FUNCTION "public"."record_invoice_payment"("p_invoice_id" "uuid", "p_amount" numeric, "p_payment_date" "date", "p_payment_method" "text", "p_reference_number" "text", "p_notes" "text", "p_created_via" "text", "p_created_by_key_id" "uuid", "p_stripe_payment_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_payment_once"("p_invoice_id" "uuid", "p_amount" numeric, "p_payment_date" "date", "p_request_id" "uuid", "p_payment_method" "text" DEFAULT 'other'::"text", "p_reference_number" "text" DEFAULT NULL::"text", "p_notes" "text" DEFAULT NULL::"text", "p_created_via" "text" DEFAULT 'web'::"text", "p_created_by_key_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE i invoices%ROWTYPE; receipt operation_receipts%ROWTYPE; input jsonb; result jsonb;
BEGIN
 IF p_request_id IS NULL OR p_amount IS NULL OR ROUND(p_amount,2)<=0 OR p_amount>=100000000 THEN RAISE EXCEPTION 'A request ID and positive payment amount are required'; END IF;
 SELECT * INTO i FROM invoices WHERE id=p_invoice_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
 -- The invoice lookup above is the membership check: this function is SECURITY
 -- INVOKER, so RLS has already hidden every invoice the caller cannot see.
 IF i.status='cancelled' THEN RAISE EXCEPTION 'Cancelled invoices cannot receive manual payments'; END IF;
 input:=jsonb_build_object('invoice_id',p_invoice_id,'amount',p_amount,'date',p_payment_date,'method',p_payment_method,'reference',p_reference_number,'notes',p_notes);
 SELECT * INTO receipt FROM operation_receipts WHERE business_id=i.business_id AND operation='record_payment' AND request_id=p_request_id;
 IF FOUND THEN IF receipt.input<>input THEN RAISE EXCEPTION 'Request ID used for a different payment'; END IF; RETURN receipt.result; END IF;
 IF p_created_by_key_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM api_keys k JOIN business_members bm ON bm.user_id=k.user_id WHERE k.id=p_created_by_key_id AND bm.business_id=i.business_id AND(k.business_id IS NULL OR k.business_id=i.business_id) AND k.revoked_at IS NULL AND(k.expires_at IS NULL OR k.expires_at>now()) AND 'payments'=ANY(k.permissions)) THEN RAISE EXCEPTION 'Key cannot record payments'; END IF;
 result:=record_invoice_payment(p_invoice_id,p_amount,p_payment_date,p_payment_method,p_reference_number,p_notes,p_created_via,p_created_by_key_id);
 INSERT INTO operation_receipts(business_id,operation,request_id,input,result) VALUES(i.business_id,'record_payment',p_request_id,input,result);
 RETURN result;
END $$;


ALTER FUNCTION "public"."record_payment_once"("p_invoice_id" "uuid", "p_amount" numeric, "p_payment_date" "date", "p_request_id" "uuid", "p_payment_method" "text", "p_reference_number" "text", "p_notes" "text", "p_created_via" "text", "p_created_by_key_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_stripe_payment"("p_invoice_id" "uuid", "p_amount" numeric, "p_payment_date" "date", "p_provider_id" "text", "p_notes" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE i invoices%ROWTYPE; existing payments%ROWTYPE;
BEGIN
 IF p_provider_id IS NULL OR p_provider_id='' THEN RAISE EXCEPTION 'Provider payment ID is required'; END IF;
 SELECT * INTO i FROM invoices WHERE id=p_invoice_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
 SELECT * INTO existing FROM payments WHERE stripe_payment_id=p_provider_id;
 IF FOUND AND(existing.invoice_id<>i.id OR existing.amount<>p_amount OR existing.currency<>i.currency) THEN RAISE EXCEPTION 'Provider payment ID conflicts with the recorded ledger'; END IF;
 PERFORM record_invoice_payment(i.id,p_amount,p_payment_date,'stripe',NULL,p_notes,'stripe',NULL,p_provider_id);
 -- Only an invoice with no current attempt adopts this intent. One that has
 -- moved on to a newer intent keeps pointing at it.
 IF p_amount>0 THEN
  UPDATE invoices SET stripe_payment_intent_id=p_provider_id WHERE id=i.id AND stripe_payment_intent_id IS NULL;
 END IF;
END $$;


ALTER FUNCTION "public"."record_stripe_payment"("p_invoice_id" "uuid", "p_amount" numeric, "p_payment_date" "date", "p_provider_id" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_draft_invoice_claims"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  t public.work_tasks%ROWTYPE;
  en public.engagement_entries%ROWTYPE;
BEGIN
  IF OLD.status <> 'draft' THEN RETURN OLD; END IF;

  -- Approved task billing.
  FOR t IN SELECT * FROM public.work_tasks WHERE invoice_id = OLD.id FOR UPDATE LOOP
    IF auth.role() IS DISTINCT FROM 'service_role' AND NOT EXISTS (
      SELECT 1 FROM public.business_members
       WHERE business_id = t.business_id AND user_id = auth.uid() AND role IN ('owner', 'admin')
    ) THEN
      RAISE EXCEPTION 'An owner or admin must release approved task billing';
    END IF;
    UPDATE public.work_tasks
       SET invoice_id = NULL, status = 'completed', updated_at = now()
     WHERE id = t.id
    RETURNING * INTO t;
    INSERT INTO public.task_events(task_id, business_id, request_id, kind, input, result, actor_user_id)
    VALUES (t.id, t.business_id, gen_random_uuid(), 'draft_deleted',
            jsonb_build_object('invoice_id', OLD.id), to_jsonb(t), auth.uid());
  END LOOP;

  -- Engagement schedule entries. They go back to 'ready_to_bill' rather than
  -- to whatever they were before: the rule that made them billable already
  -- fired, and deleting the draft undoes the billing, not the rule.
  IF EXISTS (SELECT 1 FROM public.engagement_entries WHERE invoice_id = OLD.id) THEN
    PERFORM set_config('billr.releasing_invoice', OLD.id::TEXT, TRUE);
    FOR en IN SELECT * FROM public.engagement_entries WHERE invoice_id = OLD.id FOR UPDATE LOOP
      UPDATE public.engagement_entries
         SET status = 'ready_to_bill', invoice_id = NULL, invoice_line_id = NULL
       WHERE id = en.id;
    END LOOP;
    -- Narrow the exemption back down again immediately, so nothing later in
    -- the same transaction inherits it.
    PERFORM set_config('billr.releasing_invoice', '', TRUE);
  END IF;

  RETURN OLD;
END;
$$;


ALTER FUNCTION "public"."release_draft_invoice_claims"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_estimate_line_items"("p_estimate_id" "uuid", "p_line_items" "jsonb", "p_estimate_patch" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_estimate public.estimates%ROWTYPE;
  v_patch JSONB := COALESCE(p_estimate_patch, '{}'::JSONB);
BEGIN
  IF jsonb_typeof(p_line_items) <> 'array' THEN
    RAISE EXCEPTION 'invalid_line_items' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_array_length(p_line_items) < 1 OR jsonb_array_length(p_line_items) > 500 THEN
    RAISE EXCEPTION 'invalid_line_items' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_typeof(v_patch) <> 'object' THEN
    RAISE EXCEPTION 'invalid_patch' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_estimate FROM public.estimates WHERE id = p_estimate_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'estimate_not_found' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.estimate_line_items WHERE estimate_id = p_estimate_id;

  INSERT INTO public.estimate_line_items (
    estimate_id, description, quantity, rate, amount,
    tax_rate, tax_amount, discount_percent, discount_amount, sort_order
  )
  SELECT
    p_estimate_id,
    LEFT(COALESCE(li.item->>'description', ''), 500),
    COALESCE((li.item->>'quantity')::NUMERIC, 1),
    COALESCE((li.item->>'rate')::NUMERIC, 0),
    COALESCE((li.item->>'amount')::NUMERIC, 0),
    COALESCE((li.item->>'tax_rate')::NUMERIC, 0),
    COALESCE((li.item->>'tax_amount')::NUMERIC, 0),
    COALESCE((li.item->>'discount_percent')::NUMERIC, 0),
    COALESCE((li.item->>'discount_amount')::NUMERIC, 0),
    (li.idx - 1)::INTEGER
  FROM jsonb_array_elements(p_line_items) WITH ORDINALITY AS li(item, idx);

  UPDATE public.estimates e SET
    client_id = COALESCE((v_patch->>'client_id')::UUID, e.client_id),
    issue_date = COALESCE((v_patch->>'issue_date')::DATE, e.issue_date),
    expiry_date = CASE
      WHEN v_patch ? 'expiry_date' THEN (v_patch->>'expiry_date')::DATE
      ELSE e.expiry_date END,
    currency = COALESCE(v_patch->>'currency', e.currency),
    subtotal = COALESCE((v_patch->>'subtotal')::NUMERIC, e.subtotal),
    discount_type = COALESCE(v_patch->>'discount_type', e.discount_type),
    discount_value = COALESCE((v_patch->>'discount_value')::NUMERIC, e.discount_value),
    discount_amount = COALESCE((v_patch->>'discount_amount')::NUMERIC, e.discount_amount),
    tax_rate = COALESCE((v_patch->>'tax_rate')::NUMERIC, e.tax_rate),
    tax_amount = COALESCE((v_patch->>'tax_amount')::NUMERIC, e.tax_amount),
    shipping_amount = COALESCE((v_patch->>'shipping_amount')::NUMERIC, e.shipping_amount),
    total = COALESCE((v_patch->>'total')::NUMERIC, e.total),
    notes = CASE WHEN v_patch ? 'notes' THEN v_patch->>'notes' ELSE e.notes END,
    terms = CASE WHEN v_patch ? 'terms' THEN v_patch->>'terms' ELSE e.terms END
  WHERE e.id = p_estimate_id
  RETURNING e.* INTO v_estimate;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'estimate_not_found' USING ERRCODE = 'P0001';
  END IF;

  RETURN to_jsonb(v_estimate);
END;
$$;


ALTER FUNCTION "public"."replace_estimate_line_items"("p_estimate_id" "uuid", "p_line_items" "jsonb", "p_estimate_patch" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."replace_invoice_line_items"("p_invoice_id" "uuid", "p_line_items" "jsonb", "p_invoice_patch" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_invoice public.invoices%ROWTYPE;
  v_patch JSONB := COALESCE(p_invoice_patch, '{}'::JSONB);
  v_line JSONB;
  v_quantity NUMERIC;
  v_rate NUMERIC;
  v_line_discount NUMERIC;
  v_line_tax NUMERIC;
  v_gross NUMERIC;
  v_amount NUMERIC;
  v_subtotal NUMERIC := 0;
  v_discount_kind TEXT;
  v_discount_value NUMERIC;
  v_discount_amount NUMERIC;
  v_tax_rate NUMERIC;
  v_tax_amount NUMERIC;
  v_shipping NUMERIC;
  v_total NUMERIC;
  v_position INTEGER := 0;
  -- Headroom: amount and subtotal are DECIMAL(12,2), quantity and rate are
  -- DECIMAL(10,2). These caps keep every derived figure inside both.
  c_max_quantity CONSTANT NUMERIC := 1000000;
  c_max_rate CONSTANT NUMERIC := 1000000;
  c_max_money CONSTANT NUMERIC := 1000000000;
BEGIN
  IF jsonb_typeof(p_line_items) <> 'array' THEN
    RAISE EXCEPTION 'invalid_line_items' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_array_length(p_line_items) < 1 OR jsonb_array_length(p_line_items) > 500 THEN
    RAISE EXCEPTION 'invalid_line_items' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_typeof(v_patch) <> 'object' THEN
    RAISE EXCEPTION 'invalid_patch' USING ERRCODE = 'P0001';
  END IF;

  -- FOR UPDATE serialises concurrent edits of the same invoice, so two
  -- overlapping saves cannot interleave delete/insert with each other.
  -- Invisible under RLS means not found, which is the answer we want to give
  -- either way: no distinction between "no such invoice" and "not yours".
  SELECT * INTO v_invoice FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'P0001';
  END IF;

  -- -----------------------------------------------------------------------
  -- Validate every line BEFORE anything is deleted, so a rejected save leaves
  -- the invoice exactly as it was rather than emptied.
  -- -----------------------------------------------------------------------
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_line_items) LOOP
    IF jsonb_typeof(v_line) <> 'object' THEN
      RAISE EXCEPTION 'invalid_line_items' USING ERRCODE = 'P0001';
    END IF;

    v_quantity := COALESCE((v_line->>'quantity')::NUMERIC, 1);
    v_rate := COALESCE((v_line->>'rate')::NUMERIC, 0);
    v_line_discount := COALESCE((v_line->>'discount_percent')::NUMERIC, 0);
    v_line_tax := COALESCE((v_line->>'tax_rate')::NUMERIC, 0);

    IF v_quantity < 0 OR v_quantity > c_max_quantity
       OR v_rate < 0 OR v_rate > c_max_rate
       OR v_line_discount < 0 OR v_line_discount > 100
       OR v_line_tax < 0 OR v_line_tax > 100 THEN
      RAISE EXCEPTION 'invalid_line_amounts' USING ERRCODE = 'P0001',
        DETAIL = 'quantity and rate must be between 0 and their caps; percentages between 0 and 100.';
    END IF;

    v_gross := ROUND(v_quantity * v_rate, 2);
    v_amount := ROUND(v_quantity * v_rate * (1 - v_line_discount / 100), 2);
    v_subtotal := v_subtotal + v_amount;

    IF v_gross > c_max_money OR v_subtotal > c_max_money THEN
      RAISE EXCEPTION 'invalid_line_amounts' USING ERRCODE = 'P0001',
        DETAIL = 'The invoice total is out of range.';
    END IF;
  END LOOP;

  -- -----------------------------------------------------------------------
  -- Invoice-wide figures. Taken from the patch where the patch names them,
  -- from the stored invoice otherwise, and validated either way, because a
  -- patch that omits them must not be able to smuggle a stored bad value past
  -- the same check.
  -- -----------------------------------------------------------------------
  v_discount_kind := COALESCE(v_patch->>'discount_type', v_invoice.discount_type, 'percentage');
  v_discount_value := COALESCE((v_patch->>'discount_value')::NUMERIC, v_invoice.discount_value, 0);
  v_tax_rate := COALESCE((v_patch->>'tax_rate')::NUMERIC, v_invoice.tax_rate, 0);
  v_shipping := COALESCE((v_patch->>'shipping_amount')::NUMERIC, v_invoice.shipping_amount, 0);

  IF v_discount_kind NOT IN ('percentage', 'fixed')
     OR v_discount_value < 0
     OR (v_discount_kind = 'percentage' AND v_discount_value > 100)
     OR v_tax_rate < 0 OR v_tax_rate > 100
     OR v_shipping < 0 OR v_shipping > c_max_money THEN
    RAISE EXCEPTION 'invalid_invoice_amounts' USING ERRCODE = 'P0001',
      DETAIL = 'Discount, tax rate or shipping is out of range.';
  END IF;

  -- Same order of operations as create_invoice_document: a fixed discount is
  -- clamped to the subtotal so a total can never go negative, and tax applies
  -- to the discounted amount.
  v_discount_amount := ROUND(
    CASE WHEN v_discount_kind = 'percentage'
         THEN v_subtotal * v_discount_value / 100
         ELSE LEAST(v_discount_value, v_subtotal)
    END, 2);
  v_tax_amount := ROUND((v_subtotal - v_discount_amount) * v_tax_rate / 100, 2);
  v_total := ROUND(v_subtotal - v_discount_amount + v_tax_amount + v_shipping, 2);

  IF v_total > c_max_money THEN
    RAISE EXCEPTION 'invalid_invoice_amounts' USING ERRCODE = 'P0001',
      DETAIL = 'The invoice total is out of range.';
  END IF;

  DELETE FROM public.invoice_line_items WHERE invoice_id = p_invoice_id;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_line_items) LOOP
    v_quantity := COALESCE((v_line->>'quantity')::NUMERIC, 1);
    v_rate := COALESCE((v_line->>'rate')::NUMERIC, 0);
    v_line_discount := COALESCE((v_line->>'discount_percent')::NUMERIC, 0);
    v_line_tax := COALESCE((v_line->>'tax_rate')::NUMERIC, 0);
    v_amount := ROUND(v_quantity * v_rate * (1 - v_line_discount / 100), 2);

    INSERT INTO public.invoice_line_items (
      invoice_id, description, quantity, rate, amount,
      tax_rate, tax_amount, discount_percent, discount_amount, sort_order
    ) VALUES (
      p_invoice_id,
      LEFT(COALESCE(v_line->>'description', ''), 500),
      v_quantity,
      v_rate,
      v_amount,
      v_line_tax,
      ROUND(v_amount * v_line_tax / 100, 2),
      v_line_discount,
      ROUND(ROUND(v_quantity * v_rate, 2) - v_amount, 2),
      v_position
    );
    v_position := v_position + 1;
  END LOOP;

  UPDATE public.invoices i SET
    client_id = COALESCE((v_patch->>'client_id')::UUID, i.client_id),
    invoice_number = COALESCE(v_patch->>'invoice_number', i.invoice_number),
    issue_date = COALESCE((v_patch->>'issue_date')::DATE, i.issue_date),
    due_date = COALESCE((v_patch->>'due_date')::DATE, i.due_date),
    currency = COALESCE(v_patch->>'currency', i.currency),
    po_number = CASE WHEN v_patch ? 'po_number' THEN v_patch->>'po_number' ELSE i.po_number END,
    discount_type = v_discount_kind,
    discount_value = v_discount_value,
    tax_rate = v_tax_rate,
    shipping_amount = v_shipping,
    -- Derived, never supplied. A caller-sent subtotal, discount_amount,
    -- tax_amount, total or balance_due in p_invoice_patch is ignored.
    subtotal = v_subtotal,
    discount_amount = v_discount_amount,
    tax_amount = v_tax_amount,
    total = v_total,
    balance_due = GREATEST(v_total - i.amount_paid, 0),
    notes = CASE WHEN v_patch ? 'notes' THEN v_patch->>'notes' ELSE i.notes END,
    terms = CASE WHEN v_patch ? 'terms' THEN v_patch->>'terms' ELSE i.terms END,
    footer = CASE WHEN v_patch ? 'footer' THEN v_patch->>'footer' ELSE i.footer END,
    payment_instructions = CASE
      WHEN v_patch ? 'payment_instructions' THEN v_patch->>'payment_instructions'
      ELSE i.payment_instructions END,
    is_recurring = COALESCE((v_patch->>'is_recurring')::BOOLEAN, i.is_recurring),
    recurring_interval = CASE
      WHEN v_patch ? 'recurring_interval' THEN v_patch->>'recurring_interval'
      ELSE i.recurring_interval END,
    recurring_end_date = CASE
      WHEN v_patch ? 'recurring_end_date' THEN (v_patch->>'recurring_end_date')::DATE
      ELSE i.recurring_end_date END
  WHERE i.id = p_invoice_id
  RETURNING i.* INTO v_invoice;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found' USING ERRCODE = 'P0001';
  END IF;

  RETURN to_jsonb(v_invoice);
END;
$$;


ALTER FUNCTION "public"."replace_invoice_line_items"("p_invoice_id" "uuid", "p_line_items" "jsonb", "p_invoice_patch" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_engagement_actor"("p_business_id" "uuid", "p_actor_key_id" "uuid", "p_permission" "text" DEFAULT 'write'::"text", OUT "actor_user_id" "uuid", OUT "actor_key_id" "uuid") RETURNS "record"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE k public.api_keys%ROWTYPE;
BEGIN
  IF auth.role() = 'service_role' THEN
    IF p_actor_key_id IS NULL THEN
      RAISE EXCEPTION 'invalid_actor' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO k FROM public.api_keys
     WHERE id = p_actor_key_id
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now());
    IF NOT FOUND OR (k.business_id IS NOT NULL AND k.business_id <> p_business_id) THEN
      RAISE EXCEPTION 'invalid_agent_key' USING ERRCODE = 'P0001';
    END IF;
    IF NOT (p_permission = ANY(k.permissions)) THEN
      RAISE EXCEPTION 'key_cannot_manage_engagements' USING ERRCODE = 'P0001';
    END IF;
    actor_user_id := k.user_id;
    actor_key_id := k.id;
  ELSE
    IF p_actor_key_id IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_actor' USING ERRCODE = 'P0001';
    END IF;
    actor_user_id := auth.uid();
    actor_key_id := NULL;
  END IF;

  IF actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.business_members
     WHERE business_id = p_business_id AND user_id = actor_user_id
  ) THEN
    RAISE EXCEPTION 'engagement_not_found' USING ERRCODE = 'P0001';
  END IF;
END;
$$;


ALTER FUNCTION "public"."resolve_engagement_actor"("p_business_id" "uuid", "p_actor_key_id" "uuid", "p_permission" "text", OUT "actor_user_id" "uuid", OUT "actor_key_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_payment_actor"("p_business_id" "uuid", "p_actor_key_id" "uuid", OUT "actor_user_id" "uuid", OUT "actor_key_id" "uuid") RETURNS "record"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE k public.api_keys%ROWTYPE;
BEGIN
  IF auth.role() = 'service_role' THEN
    IF p_actor_key_id IS NULL THEN
      RAISE EXCEPTION 'invalid_actor' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO k FROM public.api_keys
     WHERE id = p_actor_key_id
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now());
    IF NOT FOUND OR (k.business_id IS NOT NULL AND k.business_id <> p_business_id) THEN
      RAISE EXCEPTION 'invalid_agent_key' USING ERRCODE = 'P0001';
    END IF;
    IF NOT ('payments' = ANY(k.permissions)) THEN
      RAISE EXCEPTION 'key_cannot_edit_payments' USING ERRCODE = 'P0001';
    END IF;
    actor_user_id := k.user_id;
    actor_key_id := k.id;
  ELSE
    IF p_actor_key_id IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_actor' USING ERRCODE = 'P0001';
    END IF;
    actor_user_id := auth.uid();
    actor_key_id := NULL;
  END IF;

  -- Missing and out of scope deliberately share one error, so neither RPC can
  -- be used to probe for payment ids in another tenant.
  IF actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.business_members
     WHERE business_id = p_business_id AND user_id = actor_user_id
  ) THEN
    RAISE EXCEPTION 'payment_not_found' USING ERRCODE = 'P0001';
  END IF;
END;
$$;


ALTER FUNCTION "public"."resolve_payment_actor"("p_business_id" "uuid", "p_actor_key_id" "uuid", OUT "actor_user_id" "uuid", OUT "actor_key_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."respond_to_estimate"("p_public_id" "text", "p_response" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF p_response NOT IN ('accepted', 'declined') THEN
    RAISE EXCEPTION 'invalid response';
  END IF;
  UPDATE public.estimates
  SET status = p_response
  WHERE public_id = p_public_id
    AND status IN ('sent', 'viewed');
  RETURN FOUND;
END;
$$;


ALTER FUNCTION "public"."respond_to_estimate"("p_public_id" "text", "p_response" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_engagement_status"("p_request_id" "uuid", "p_engagement_id" "uuid", "p_status" "text", "p_actor_key_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_engagement public.engagements%ROWTYPE;
  v_actor RECORD;
  v_receipt public.operation_receipts%ROWTYPE;
  v_input JSONB;
  v_result JSONB;
  v_promoted UUID[] := ARRAY[]::UUID[];
  v_remaining NUMERIC := 0;
  v_warning TEXT := NULL;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = 'P0001';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('draft', 'active', 'paused', 'completed', 'cancelled') THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_engagement FROM public.engagements WHERE id = p_engagement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'engagement_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_actor FROM public.resolve_engagement_actor(v_engagement.business_id, p_actor_key_id, 'write');

  v_input := jsonb_build_object('engagement_id', p_engagement_id, 'status', p_status);

  SELECT * INTO v_receipt FROM public.operation_receipts
   WHERE business_id = v_engagement.business_id AND operation = 'set_engagement_status' AND request_id = p_request_id;
  IF FOUND THEN
    IF v_receipt.input <> v_input THEN
      RAISE EXCEPTION 'request_id_reused' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_set(v_receipt.result, '{replayed}', 'true'::JSONB);
  END IF;

  IF v_engagement.status IN ('completed', 'cancelled') AND p_status <> v_engagement.status THEN
    RAISE EXCEPTION 'engagement_closed' USING ERRCODE = 'P0001';
  END IF;
  IF v_engagement.status = 'draft' AND p_status = 'paused' THEN
    RAISE EXCEPTION 'invalid_status_transition' USING ERRCODE = 'P0001';
  END IF;
  IF p_status = 'draft' AND v_engagement.status <> 'draft' THEN
    RAISE EXCEPTION 'invalid_status_transition' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.engagements SET status = p_status WHERE id = p_engagement_id;

  IF p_status = 'active' THEN
    UPDATE public.engagement_entries
       SET status = 'ready_to_bill'
     WHERE engagement_id = p_engagement_id AND status = 'pending' AND due_rule = 'on_start';
    SELECT COALESCE(array_agg(id), ARRAY[]::UUID[]) INTO v_promoted
      FROM public.engagement_entries
     WHERE engagement_id = p_engagement_id AND status = 'ready_to_bill' AND due_rule = 'on_start';
  ELSIF p_status = 'completed' THEN
    UPDATE public.engagement_entries
       SET status = 'ready_to_bill', completed_at = COALESCE(completed_at, now())
     WHERE engagement_id = p_engagement_id AND status = 'pending' AND due_rule = 'on_complete';
    SELECT COALESCE(array_agg(id), ARRAY[]::UUID[]) INTO v_promoted
      FROM public.engagement_entries
     WHERE engagement_id = p_engagement_id AND status = 'ready_to_bill' AND due_rule = 'on_complete';
  END IF;

  SELECT amount_remaining INTO v_remaining FROM public.engagement_summary WHERE engagement_id = p_engagement_id;
  IF p_status = 'completed' AND COALESCE(v_remaining, 0) > 0 THEN
    v_warning := format('This engagement is complete with %s of %s still unbilled. Bill the remaining entries or waive them.',
                        v_remaining, v_engagement.total);
  END IF;

  v_result := public.engagement_payload(p_engagement_id) || jsonb_build_object(
    'replayed', FALSE,
    'promoted_entry_ids', to_jsonb(v_promoted),
    'amount_remaining', v_remaining,
    'warning', v_warning
  );

  INSERT INTO public.operation_receipts (business_id, operation, request_id, input, result)
  VALUES (v_engagement.business_id, 'set_engagement_status', p_request_id, v_input, v_result);

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."set_engagement_status"("p_request_id" "uuid", "p_engagement_id" "uuid", "p_status" "text", "p_actor_key_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_invoice_payment_ledger"("p_invoice_id" "uuid", "p_intent_id" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE i invoices%ROWTYPE; paid numeric; balance numeric;
BEGIN
 SELECT * INTO i FROM invoices WHERE id=p_invoice_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
 SELECT COALESCE(SUM(amount),0) INTO paid FROM payments WHERE invoice_id=i.id AND voided_at IS NULL;
 balance:=GREATEST(0,i.total-paid);
 UPDATE invoices SET amount_paid=paid,balance_due=balance,
 status=CASE WHEN balance=0 THEN 'paid' WHEN paid>0 THEN 'partial' WHEN i.status='cancelled' THEN 'cancelled' ELSE 'sent' END,
 paid_at=CASE WHEN balance=0 THEN COALESCE(i.paid_at,CURRENT_DATE) ELSE NULL END,
 stripe_payment_intent_id=COALESCE(p_intent_id,i.stripe_payment_intent_id) WHERE id=i.id;
END $$;


ALTER FUNCTION "public"."sync_invoice_payment_ledger"("p_invoice_id" "uuid", "p_intent_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."task_operation"("p_business_id" "uuid", "p_request_id" "uuid", "p_action" "text", "p_input" "jsonb", "p_key_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE t work_tasks%ROWTYPE; p billing_policies%ROWTYPE; e task_events%ROWTYPE; k api_keys%ROWTYPE;
 actor uuid; result jsonb; total numeric; seconds bigint; now_at timestamptz:=clock_timestamp(); inv jsonb;
BEGIN
 IF auth.role()='service_role' THEN
   SELECT * INTO k FROM api_keys WHERE id=p_key_id AND revoked_at IS NULL;
   IF NOT FOUND OR (k.business_id IS NOT NULL AND k.business_id<>p_business_id) THEN RAISE EXCEPTION 'Invalid agent key'; END IF;
   actor:=k.user_id;
 ELSE
   IF p_key_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid actor'; END IF;
   actor:=auth.uid();
 END IF;
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM business_members WHERE business_id=p_business_id AND user_id=actor) THEN RAISE EXCEPTION 'Business not found'; END IF;
 -- One lock order for task mutations, usage deduplication and request replay.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_business_id::text||':tasks',0));
 SELECT * INTO e FROM task_events WHERE business_id=p_business_id AND request_id=p_request_id;
 IF FOUND THEN
   IF e.kind<>p_action OR e.input<>p_input THEN RAISE EXCEPTION 'Request ID already used with different input'; END IF;
   RETURN e.result;
 END IF;
 IF p_action='create' THEN
   SELECT * INTO p FROM billing_policies WHERE id=(p_input->>'policy_id')::uuid AND business_id=p_business_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'An approved pricing policy is required'; END IF;
   INSERT INTO work_tasks(business_id,policy_id,title,created_by_key_id) VALUES(p_business_id,p.id,p_input->>'title',p_key_id) RETURNING * INTO t;
 ELSE
   SELECT * INTO t FROM work_tasks WHERE id=(p_input->>'task_id')::uuid AND business_id=p_business_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Task not found'; END IF;
   SELECT * INTO p FROM billing_policies WHERE id=t.policy_id;
   IF t.status='invoiced' THEN RAISE EXCEPTION 'Invoiced tasks are immutable'; END IF;
   IF p_action IN('start','heartbeat','pause','complete') THEN
     IF t.status='completed' THEN RAISE EXCEPTION 'Completed tasks cannot record more time'; END IF;
     IF p_action='start' AND t.status='running' THEN RAISE EXCEPTION 'Task is already running'; END IF;
     IF p_action='heartbeat' AND t.status<>'running' THEN RAISE EXCEPTION 'Start the task before sending heartbeats'; END IF;
     seconds:=CASE WHEN t.status='running' THEN LEAST(120,GREATEST(0,FLOOR(EXTRACT(EPOCH FROM(now_at-t.last_heartbeat_at)))::bigint)) ELSE 0 END;
     -- Time cannot grow beyond the agreed task budget. Usage is handled below.
     IF p.hourly_rate>0 THEN seconds:=LEAST(seconds,GREATEST(0,FLOOR((p.budget-t.usage_cost*p.usage_multiplier)*3600/p.hourly_rate)-t.active_seconds)::bigint); END IF;
     t.active_seconds:=t.active_seconds+seconds;
     total:=ROUND(t.active_seconds::numeric*p.hourly_rate/3600,2)+ROUND(t.usage_cost*p.usage_multiplier,2);
     IF p_action IN('start','heartbeat') AND total>=p.budget THEN RAISE EXCEPTION 'Task budget reached; pause or complete the task'; END IF;
     t.status:=CASE WHEN p_action='complete' THEN 'completed' WHEN p_action='pause' THEN 'paused' ELSE 'running' END;
     -- Preserve fractional elapsed time across heartbeats, without billing expired gaps.
     t.last_heartbeat_at:=CASE WHEN t.status<>'running' THEN NULL WHEN seconds<120 AND t.last_heartbeat_at IS NOT NULL AND p_action='heartbeat' THEN t.last_heartbeat_at+make_interval(secs=>seconds) ELSE now_at END;
   ELSIF p_action='usage' THEN
     IF t.status='completed' THEN RAISE EXCEPTION 'Record usage before completing the task'; END IF;
     IF p_input->>'currency'<>p.currency THEN RAISE EXCEPTION 'Usage currency must match the pricing policy; no implicit conversion'; END IF;
     IF COALESCE(length(p_input->>'provider'),0) NOT BETWEEN 1 AND 200 OR COALESCE(length(p_input->>'provider_request_id'),0) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Provider and request reference are required'; END IF;
     total:=ROUND(t.active_seconds::numeric*p.hourly_rate/3600,2)+ROUND((t.usage_cost+(p_input->>'cost')::numeric)*p.usage_multiplier,2);
     IF total>p.budget THEN RAISE EXCEPTION 'Usage would exceed the approved budget'; END IF;
     INSERT INTO task_usage(task_id,business_id,provider,model,provider_request_id,cost,currency,input_tokens,output_tokens,source)
     VALUES(t.id,p_business_id,p_input->>'provider',p_input->>'model',p_input->>'provider_request_id',(p_input->>'cost')::numeric,p.currency,(p_input->>'input_tokens')::bigint,(p_input->>'output_tokens')::bigint,p_input->>'source');
     t.usage_cost:=t.usage_cost+(p_input->>'cost')::numeric;
   ELSIF p_action='invoice' THEN
     IF p_key_id IS NOT NULL OR auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM business_members WHERE business_id=p_business_id AND user_id=auth.uid() AND role IN('owner','admin')) THEN RAISE EXCEPTION 'A human owner or admin must approve task billing'; END IF;
     IF t.status<>'completed' THEN RAISE EXCEPTION 'Complete the task before reviewing billing'; END IF;
     total:=ROUND(t.active_seconds::numeric*p.hourly_rate/3600,2)+ROUND(t.usage_cost*p.usage_multiplier,2);
     IF total<=0 OR total>p.budget THEN RAISE EXCEPTION 'Task total must be positive and within budget'; END IF;
     inv:=create_invoice_document(p_business_id,p.client_id,jsonb_build_object('currency',p.currency,'issue_date',CURRENT_DATE,'due_date',CURRENT_DATE+30,'notes','Approved task: '||t.title),
       jsonb_build_array(jsonb_build_object('description',t.title||': active time ('||t.active_seconds||' seconds)','quantity',1,'rate',ROUND(t.active_seconds::numeric*p.hourly_rate/3600,2)),
       jsonb_build_object('description','Reported usage cost × '||p.usage_multiplier,'quantity',1,'rate',ROUND(t.usage_cost*p.usage_multiplier,2))),p_request_id);
     t.invoice_id:=(inv->>'id')::uuid; t.status:='invoiced';
   ELSE RAISE EXCEPTION 'Unknown task operation';
   END IF;
   UPDATE work_tasks SET active_seconds=t.active_seconds,last_heartbeat_at=t.last_heartbeat_at,status=t.status,usage_cost=t.usage_cost,invoice_id=t.invoice_id,updated_at=now_at WHERE id=t.id RETURNING * INTO t;
 END IF;
 total:=ROUND(t.active_seconds::numeric*p.hourly_rate/3600,2)+ROUND(t.usage_cost*p.usage_multiplier,2);
 result:=jsonb_build_object('task',to_jsonb(t),'pricing',to_jsonb(p),'time_amount',ROUND(t.active_seconds::numeric*p.hourly_rate/3600,2),'usage_amount',ROUND(t.usage_cost*p.usage_multiplier,2),'total',total,'currency',p.currency,'requires_human_review',t.status<>'invoiced');
 INSERT INTO task_events(task_id,business_id,request_id,kind,input,result,actor_user_id,actor_key_id) VALUES(t.id,p_business_id,p_request_id,p_action,p_input,result,actor,p_key_id);
 RETURN result;
END $$;


ALTER FUNCTION "public"."task_operation"("p_business_id" "uuid", "p_request_id" "uuid", "p_action" "text", "p_input" "jsonb", "p_key_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_engagement"("p_request_id" "uuid", "p_engagement_id" "uuid", "p_name" "text" DEFAULT NULL::"text", "p_starts_on" "date" DEFAULT NULL::"date", "p_target_end" "date" DEFAULT NULL::"date", "p_notes" "text" DEFAULT NULL::"text", "p_actor_key_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_engagement public.engagements%ROWTYPE;
  v_actor RECORD;
  v_receipt public.operation_receipts%ROWTYPE;
  v_input JSONB;
  v_result JSONB;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_engagement FROM public.engagements WHERE id = p_engagement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'engagement_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_actor FROM public.resolve_engagement_actor(v_engagement.business_id, p_actor_key_id, 'write');

  v_input := jsonb_build_object(
    'engagement_id', p_engagement_id, 'name', p_name, 'starts_on', p_starts_on,
    'target_end', p_target_end, 'notes', p_notes
  );

  SELECT * INTO v_receipt FROM public.operation_receipts
   WHERE business_id = v_engagement.business_id AND operation = 'update_engagement' AND request_id = p_request_id;
  IF FOUND THEN
    IF v_receipt.input <> v_input THEN
      RAISE EXCEPTION 'request_id_reused' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_set(v_receipt.result, '{replayed}', 'true'::JSONB);
  END IF;

  IF p_name IS NOT NULL AND char_length(BTRIM(p_name)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.engagements e SET
    name       = COALESCE(NULLIF(BTRIM(COALESCE(p_name, '')), ''), e.name),
    starts_on  = COALESCE(p_starts_on, e.starts_on),
    target_end = COALESCE(p_target_end, e.target_end),
    notes      = COALESCE(NULLIF(BTRIM(COALESCE(p_notes, '')), ''), e.notes)
  WHERE e.id = p_engagement_id;

  v_result := public.engagement_payload(p_engagement_id) || jsonb_build_object('replayed', FALSE);

  INSERT INTO public.operation_receipts (business_id, operation, request_id, input, result)
  VALUES (v_engagement.business_id, 'update_engagement', p_request_id, v_input, v_result);

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."update_engagement"("p_request_id" "uuid", "p_engagement_id" "uuid", "p_name" "text", "p_starts_on" "date", "p_target_end" "date", "p_notes" "text", "p_actor_key_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_payment"("p_payment_id" "uuid", "p_request_id" "text", "p_payment_date" "date" DEFAULT NULL::"date", "p_method" "text" DEFAULT NULL::"text", "p_notes" "text" DEFAULT NULL::"text", "p_reference_number" "text" DEFAULT NULL::"text", "p_amount" numeric DEFAULT NULL::numeric, "p_actor_key_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_after public.payments%ROWTYPE;
  v_invoice public.invoices%ROWTYPE;
  v_audit public.payment_audit%ROWTYPE;
  v_actor RECORD;
  v_input JSONB;
  v_others NUMERIC;
  v_method TEXT;
BEGIN
  IF p_request_id IS NULL OR BTRIM(p_request_id) = '' THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_actor FROM public.resolve_payment_actor(v_payment.business_id, p_actor_key_id);

  v_input := jsonb_build_object(
    'payment_date', p_payment_date, 'method', p_method, 'notes', p_notes,
    'reference_number', p_reference_number, 'amount', ROUND(p_amount, 2)
  );

  SELECT * INTO v_audit FROM public.payment_audit
   WHERE payment_id = p_payment_id AND request_id = p_request_id;
  IF FOUND THEN
    IF v_audit.action <> 'update' OR v_audit.input <> v_input THEN
      RAISE EXCEPTION 'request_id_reused' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_invoice FROM public.invoices WHERE id = v_payment.invoice_id;
    RETURN jsonb_build_object(
      'payment', v_audit.after, 'invoice', to_jsonb(v_invoice), 'replayed', TRUE
    );
  END IF;

  IF v_payment.source = 'stripe' THEN
    RAISE EXCEPTION 'stripe_payment_locked' USING ERRCODE = 'P0001';
  END IF;
  IF v_payment.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'payment_already_voided' USING ERRCODE = 'P0001';
  END IF;

  v_method := NULLIF(BTRIM(COALESCE(p_method, '')), '');
  IF v_method IS NOT NULL THEN
    IF v_method = 'stripe' THEN
      RAISE EXCEPTION 'method_reserved_for_stripe' USING ERRCODE = 'P0001';
    END IF;
    IF v_method NOT IN ('cash', 'check', 'bank_transfer', 'credit_card', 'paypal', 'other') THEN
      RAISE EXCEPTION 'invalid_method' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_amount IS NOT NULL THEN
    IF ROUND(p_amount, 2) <= 0 OR p_amount >= 100000000 THEN
      RAISE EXCEPTION 'invalid_amount' USING ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(SUM(p.amount), 0) INTO v_others
      FROM public.payments p
     WHERE p.invoice_id = v_payment.invoice_id
       AND p.voided_at IS NULL
       AND p.id <> v_payment.id;
    SELECT * INTO v_invoice FROM public.invoices WHERE id = v_payment.invoice_id;
    IF ROUND(v_others + ROUND(p_amount, 2), 2) > v_invoice.total THEN
      RAISE EXCEPTION 'amount_exceeds_invoice_total' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE public.payments p SET
    payment_date     = COALESCE(p_payment_date, p.payment_date),
    payment_method   = COALESCE(v_method, p.payment_method),
    notes            = COALESCE(NULLIF(BTRIM(COALESCE(p_notes, '')), ''), p.notes),
    reference_number = COALESCE(NULLIF(BTRIM(COALESCE(p_reference_number, '')), ''), p.reference_number),
    amount           = COALESCE(ROUND(p_amount, 2), p.amount),
    updated_at       = now()
  WHERE p.id = p_payment_id
  RETURNING p.* INTO v_after;

  v_invoice := public.recompute_invoice_money(v_payment.invoice_id);

  INSERT INTO public.payment_audit (
    payment_id, invoice_id, business_id, action, actor_user_id, actor_key_id,
    request_id, input, before, after
  ) VALUES (
    v_payment.id, v_payment.invoice_id, v_payment.business_id, 'update',
    v_actor.actor_user_id, v_actor.actor_key_id, p_request_id, v_input,
    to_jsonb(v_payment), to_jsonb(v_after)
  );

  RETURN jsonb_build_object(
    'payment', to_jsonb(v_after), 'invoice', to_jsonb(v_invoice), 'replayed', FALSE
  );
END;
$$;


ALTER FUNCTION "public"."update_payment"("p_payment_id" "uuid", "p_request_id" "text", "p_payment_date" "date", "p_method" "text", "p_notes" "text", "p_reference_number" "text", "p_amount" numeric, "p_actor_key_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_has_business_access"("check_business_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.business_members
    WHERE business_members.business_id = check_business_id
    AND business_members.user_id = auth.uid()
  );
END;
$$;


ALTER FUNCTION "public"."user_has_business_access"("check_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_is_business_admin"("check_business_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.business_members
    WHERE business_members.business_id = check_business_id
    AND business_members.user_id = auth.uid()
    AND business_members.role IN ('owner', 'admin')
  );
END;
$$;


ALTER FUNCTION "public"."user_is_business_admin"("check_business_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."void_payment"("p_payment_id" "uuid", "p_request_id" "text", "p_reason" "text", "p_actor_key_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_after public.payments%ROWTYPE;
  v_invoice public.invoices%ROWTYPE;
  v_audit public.payment_audit%ROWTYPE;
  v_actor RECORD;
  v_input JSONB;
  v_reason TEXT;
BEGIN
  IF p_request_id IS NULL OR BTRIM(p_request_id) = '' THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = 'P0001';
  END IF;

  v_reason := NULLIF(BTRIM(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'void_reason_required' USING ERRCODE = 'P0001';
  END IF;
  IF length(v_reason) > 2000 THEN
    RAISE EXCEPTION 'void_reason_too_long' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_actor FROM public.resolve_payment_actor(v_payment.business_id, p_actor_key_id);

  v_input := jsonb_build_object('reason', v_reason);

  SELECT * INTO v_audit FROM public.payment_audit
   WHERE payment_id = p_payment_id AND request_id = p_request_id;
  IF FOUND THEN
    IF v_audit.action <> 'void' OR v_audit.input <> v_input THEN
      RAISE EXCEPTION 'request_id_reused' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_invoice FROM public.invoices WHERE id = v_payment.invoice_id;
    RETURN jsonb_build_object(
      'payment', v_audit.after, 'invoice', to_jsonb(v_invoice), 'replayed', TRUE
    );
  END IF;

  IF v_payment.source = 'stripe' THEN
    RAISE EXCEPTION 'stripe_payment_locked' USING ERRCODE = 'P0001';
  END IF;
  IF v_payment.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'payment_already_voided' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.payments p SET
    voided_at = now(), void_reason = v_reason, updated_at = now()
  WHERE p.id = p_payment_id
  RETURNING p.* INTO v_after;

  v_invoice := public.recompute_invoice_money(v_payment.invoice_id);

  INSERT INTO public.payment_audit (
    payment_id, invoice_id, business_id, action, actor_user_id, actor_key_id,
    request_id, input, before, after
  ) VALUES (
    v_payment.id, v_payment.invoice_id, v_payment.business_id, 'void',
    v_actor.actor_user_id, v_actor.actor_key_id, p_request_id, v_input,
    to_jsonb(v_payment), to_jsonb(v_after)
  );

  RETURN jsonb_build_object(
    'payment', to_jsonb(v_after), 'invoice', to_jsonb(v_invoice), 'replayed', FALSE
  );
END;
$$;


ALTER FUNCTION "public"."void_payment"("p_payment_id" "uuid", "p_request_id" "text", "p_reason" "text", "p_actor_key_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."waive_entry"("p_request_id" "uuid", "p_entry_id" "uuid", "p_reason" "text", "p_actor_key_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_entry public.engagement_entries%ROWTYPE;
  v_actor RECORD;
  v_receipt public.operation_receipts%ROWTYPE;
  v_input JSONB;
  v_result JSONB;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_entry FROM public.engagement_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entry_not_found' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    SELECT * INTO v_actor FROM public.resolve_engagement_actor(v_entry.business_id, p_actor_key_id, 'write');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'engagement_not_found' THEN
      RAISE EXCEPTION 'entry_not_found' USING ERRCODE = 'P0001';
    END IF;
    RAISE;
  END;

  v_input := jsonb_build_object('entry_id', p_entry_id, 'reason', BTRIM(COALESCE(p_reason, '')));

  SELECT * INTO v_receipt FROM public.operation_receipts
   WHERE business_id = v_entry.business_id AND operation = 'waive_entry' AND request_id = p_request_id;
  IF FOUND THEN
    IF v_receipt.input <> v_input THEN
      RAISE EXCEPTION 'request_id_reused' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_set(v_receipt.result, '{replayed}', 'true'::JSONB);
  END IF;

  IF char_length(BTRIM(COALESCE(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'waive_reason_required' USING ERRCODE = 'P0001';
  END IF;
  IF v_entry.status = 'invoiced' THEN
    RAISE EXCEPTION 'entry_already_invoiced' USING ERRCODE = 'P0001';
  END IF;
  IF v_entry.status = 'waived' THEN
    RAISE EXCEPTION 'entry_waived' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.engagement_entries
     SET status = 'waived', waived_reason = LEFT(BTRIM(p_reason), 2000)
   WHERE id = p_entry_id
  RETURNING * INTO v_entry;

  v_result := public.engagement_payload(v_entry.engagement_id) || jsonb_build_object(
    'replayed', FALSE,
    'entry', to_jsonb(v_entry)
  );

  INSERT INTO public.operation_receipts (business_id, operation, request_id, input, result)
  VALUES (v_entry.business_id, 'waive_entry', p_request_id, v_input, v_result);

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."waive_entry"("p_request_id" "uuid", "p_entry_id" "uuid", "p_reason" "text", "p_actor_key_id" "uuid") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_tool_calls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "key_id" "uuid",
    "user_id" "uuid" NOT NULL,
    "tool_name" "text" NOT NULL,
    "status" "text" DEFAULT 'started'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    CONSTRAINT "agent_tool_calls_status_check" CHECK (("status" = ANY (ARRAY['started'::"text", 'succeeded'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."agent_tool_calls" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."api_keys" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_id" "uuid",
    "label" "text" DEFAULT 'API Key'::"text" NOT NULL,
    "key_hash" "text" NOT NULL,
    "last_used_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "key_prefix" "text",
    "permissions" "text"[] DEFAULT ARRAY['read'::"text", 'write'::"text"] NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '90 days'::interval),
    "kind" "text" DEFAULT 'manual'::"text" NOT NULL,
    "oauth_client_id" "uuid",
    CONSTRAINT "api_keys_kind_check" CHECK (("kind" = ANY (ARRAY['manual'::"text", 'oauth'::"text"]))),
    CONSTRAINT "key_permissions" CHECK (("permissions" <@ ARRAY['read'::"text", 'write'::"text", 'send'::"text", 'delete'::"text", 'payments'::"text"]))
);


ALTER TABLE "public"."api_keys" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."billing_policies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "currency" "text" NOT NULL,
    "hourly_rate" numeric(12,4) NOT NULL,
    "usage_multiplier" numeric(8,4) NOT NULL,
    "budget" numeric(12,2) NOT NULL,
    "approved_by" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "billing_policies_budget_check" CHECK ((("budget" > (0)::numeric) AND ("budget" < (100000000)::numeric))),
    CONSTRAINT "billing_policies_currency_check" CHECK (("currency" ~ '^[A-Z]{3}$'::"text")),
    CONSTRAINT "billing_policies_hourly_rate_check" CHECK ((("hourly_rate" >= (0)::numeric) AND ("hourly_rate" < (1000000)::numeric))),
    CONSTRAINT "billing_policies_name_check" CHECK ((("length"("name") >= 1) AND ("length"("name") <= 200))),
    CONSTRAINT "billing_policies_usage_multiplier_check" CHECK ((("usage_multiplier" >= (0)::numeric) AND ("usage_multiplier" <= (100)::numeric)))
);


ALTER TABLE "public"."billing_policies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."business_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'member'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "business_members_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'admin'::"text", 'member'::"text"])))
);


ALTER TABLE "public"."business_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "email" "text",
    "phone" "text",
    "role" "text",
    "is_primary" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."client_contacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "email" "text",
    "phone" "text",
    "website" "text",
    "address_line1" "text",
    "address_line2" "text",
    "city" "text",
    "state" "text",
    "postal_code" "text",
    "country" "text",
    "tax_id" "text",
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "payment_terms" integer DEFAULT 30 NOT NULL,
    "notes" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_via" "text" DEFAULT 'web'::"text",
    "created_by_key_id" "uuid"
);


ALTER TABLE "public"."clients" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."client_financials" WITH ("security_invoker"='on') AS
 SELECT "c"."id" AS "client_id",
    "c"."business_id",
    COALESCE("i"."currency", "c"."currency") AS "currency",
    (COALESCE("sum"("i"."total"), (0)::numeric))::numeric(14,2) AS "total_invoiced",
    (COALESCE("sum"("i"."amount_paid"), (0)::numeric))::numeric(14,2) AS "total_paid",
    (COALESCE("sum"("i"."balance_due"), (0)::numeric))::numeric(14,2) AS "outstanding_balance"
   FROM ("public"."clients" "c"
     LEFT JOIN "public"."invoices" "i" ON ((("i"."client_id" = "c"."id") AND ("i"."business_id" = "c"."business_id") AND ("i"."status" <> ALL (ARRAY['draft'::"text", 'cancelled'::"text"])))))
  GROUP BY "c"."id", "c"."business_id", COALESCE("i"."currency", "c"."currency");


ALTER VIEW "public"."client_financials" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."email_deliveries" (
    "business_id" "uuid" NOT NULL,
    "request_id" "uuid" NOT NULL,
    "document_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "input_hash" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sent_at" timestamp with time zone,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "email_deliveries_kind_check" CHECK (("kind" = ANY (ARRAY['invoice'::"text", 'estimate'::"text"])))
);


ALTER TABLE "public"."email_deliveries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."engagement_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "engagement_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "position" integer NOT NULL,
    "label" "text" NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "percent" numeric(5,2),
    "due_rule" "text" NOT NULL,
    "due_on" "date",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "invoice_id" "uuid",
    "invoice_line_id" "uuid",
    "completed_at" timestamp with time zone,
    "waived_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "engagement_entries_amount_range" CHECK ((("amount" > (0)::numeric) AND ("amount" < (100000000)::numeric))),
    CONSTRAINT "engagement_entries_due_rule_check" CHECK (("due_rule" = ANY (ARRAY['on_start'::"text", 'on_complete'::"text", 'on_milestone'::"text", 'on_date'::"text", 'manual'::"text"]))),
    CONSTRAINT "engagement_entries_invoiced_has_invoice" CHECK ((("status" <> 'invoiced'::"text") OR ("invoice_id" IS NOT NULL))),
    CONSTRAINT "engagement_entries_label_length" CHECK ((("char_length"("btrim"("label")) >= 1) AND ("char_length"("btrim"("label")) <= 200))),
    CONSTRAINT "engagement_entries_on_date_has_date" CHECK ((("due_rule" <> 'on_date'::"text") OR ("due_on" IS NOT NULL))),
    CONSTRAINT "engagement_entries_percent_range" CHECK ((("percent" IS NULL) OR (("percent" > (0)::numeric) AND ("percent" <= (100)::numeric)))),
    CONSTRAINT "engagement_entries_position_range" CHECK ((("position" >= 0) AND ("position" < 100))),
    CONSTRAINT "engagement_entries_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'ready_to_bill'::"text", 'invoiced'::"text", 'waived'::"text"]))),
    CONSTRAINT "engagement_entries_waived_has_reason" CHECK ((("status" <> 'waived'::"text") OR ("char_length"("btrim"(COALESCE("waived_reason", ''::"text"))) > 0)))
);


ALTER TABLE "public"."engagement_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."engagements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "total" numeric(12,2) DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "billing_mode" "text" NOT NULL,
    "starts_on" "date",
    "target_end" "date",
    "notes" "text",
    "source_estimate_id" "uuid",
    "created_via" "text" DEFAULT 'web'::"text" NOT NULL,
    "created_by_key_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "engagements_billing_mode_check" CHECK (("billing_mode" = ANY (ARRAY['percent_split'::"text", 'equal_installments'::"text", 'milestones'::"text", 'manual'::"text"]))),
    CONSTRAINT "engagements_created_via_check" CHECK (("created_via" = ANY (ARRAY['web'::"text", 'agent'::"text"]))),
    CONSTRAINT "engagements_currency_shape" CHECK (("char_length"("currency") = 3)),
    CONSTRAINT "engagements_name_length" CHECK ((("char_length"("btrim"("name")) >= 1) AND ("char_length"("btrim"("name")) <= 200))),
    CONSTRAINT "engagements_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'active'::"text", 'paused'::"text", 'completed'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "engagements_total_range" CHECK ((("total" >= (0)::numeric) AND ("total" < (100000000)::numeric)))
);


ALTER TABLE "public"."engagements" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."engagement_summary" WITH ("security_invoker"='true') AS
 SELECT "e"."id" AS "engagement_id",
    "e"."business_id",
    "e"."client_id",
    "e"."name",
    "e"."status",
    "e"."billing_mode",
    "e"."currency",
    "e"."total",
    "e"."starts_on",
    "e"."target_end",
    "s"."entry_count",
    "s"."amount_billed",
    "s"."amount_waived",
    "round"((("e"."total" - "s"."amount_billed") - "s"."amount_waived"), 2) AS "amount_remaining",
    "s"."ready_count",
    "s"."ready_amount",
    COALESCE("r"."next_ready_entries", '[]'::"jsonb") AS "next_ready_entries"
   FROM (("public"."engagements" "e"
     CROSS JOIN LATERAL ( SELECT ("count"(*))::integer AS "entry_count",
            (COALESCE("sum"("en"."amount") FILTER (WHERE ("en"."status" = 'invoiced'::"text")), (0)::numeric))::numeric(12,2) AS "amount_billed",
            (COALESCE("sum"("en"."amount") FILTER (WHERE ("en"."status" = 'waived'::"text")), (0)::numeric))::numeric(12,2) AS "amount_waived",
            ("count"(*) FILTER (WHERE ("en"."status" = 'ready_to_bill'::"text")))::integer AS "ready_count",
            (COALESCE("sum"("en"."amount") FILTER (WHERE ("en"."status" = 'ready_to_bill'::"text")), (0)::numeric))::numeric(12,2) AS "ready_amount"
           FROM "public"."engagement_entries" "en"
          WHERE ("en"."engagement_id" = "e"."id")) "s")
     LEFT JOIN LATERAL ( SELECT "jsonb_agg"("jsonb_build_object"('id', "x"."id", 'position', "x"."position", 'label', "x"."label", 'amount', "x"."amount", 'due_rule', "x"."due_rule", 'due_on', "x"."due_on") ORDER BY "x"."position") AS "next_ready_entries"
           FROM ( SELECT "en"."id",
                    "en"."position",
                    "en"."label",
                    "en"."amount",
                    "en"."due_rule",
                    "en"."due_on"
                   FROM "public"."engagement_entries" "en"
                  WHERE (("en"."engagement_id" = "e"."id") AND ("en"."status" = 'ready_to_bill'::"text"))
                  ORDER BY "en"."position"
                 LIMIT 10) "x") "r" ON (true));


ALTER VIEW "public"."engagement_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."estimate_line_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "estimate_id" "uuid" NOT NULL,
    "description" "text" NOT NULL,
    "quantity" numeric(18,6) DEFAULT 1 NOT NULL,
    "rate" numeric(18,6) DEFAULT 0 NOT NULL,
    "amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "tax_rate" numeric(9,6) DEFAULT 0 NOT NULL,
    "tax_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "discount_percent" numeric(9,6) DEFAULT 0 NOT NULL,
    "discount_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."estimate_line_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."estimates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "public_id" "text" DEFAULT "public"."generate_public_id"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "estimate_number" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "issue_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "expiry_date" "date",
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "subtotal" numeric(12,2) DEFAULT 0 NOT NULL,
    "discount_type" "text" DEFAULT 'percentage'::"text" NOT NULL,
    "discount_value" numeric(18,6) DEFAULT 0 NOT NULL,
    "discount_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "tax_rate" numeric(9,6) DEFAULT 0 NOT NULL,
    "tax_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "shipping_amount" numeric(10,2) DEFAULT 0 NOT NULL,
    "total" numeric(12,2) DEFAULT 0 NOT NULL,
    "notes" "text",
    "terms" "text",
    "converted_invoice_id" "uuid",
    "client_snapshot" "jsonb",
    "business_snapshot" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_via" "text" DEFAULT 'web'::"text",
    "created_by_key_id" "uuid",
    CONSTRAINT "estimates_discount_type_check" CHECK (("discount_type" = ANY (ARRAY['percentage'::"text", 'fixed'::"text"]))),
    CONSTRAINT "estimates_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'sent'::"text", 'viewed'::"text", 'accepted'::"text", 'declined'::"text", 'expired'::"text", 'converted'::"text"])))
);


ALTER TABLE "public"."estimates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."expenses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "client_id" "uuid",
    "category" "text" DEFAULT 'other'::"text" NOT NULL,
    "description" "text",
    "amount" numeric(10,2) NOT NULL,
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "date" "date" NOT NULL,
    "vendor" "text",
    "receipt_url" "text",
    "is_billable" boolean DEFAULT false NOT NULL,
    "is_billed" boolean DEFAULT false NOT NULL,
    "invoice_id" "uuid",
    "mileage_distance" numeric(10,2),
    "mileage_rate" numeric(6,3),
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_via" "text" DEFAULT 'web'::"text",
    "created_by_key_id" "uuid",
    CONSTRAINT "expenses_category_check" CHECK (("category" = ANY (ARRAY['office'::"text", 'travel'::"text", 'meals'::"text", 'supplies'::"text", 'utilities'::"text", 'software'::"text", 'marketing'::"text", 'professional'::"text", 'insurance'::"text", 'mileage'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."expenses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoice_line_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "description" "text" NOT NULL,
    "quantity" numeric(18,6) DEFAULT 1 NOT NULL,
    "rate" numeric(18,6) DEFAULT 0 NOT NULL,
    "amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "tax_rate" numeric(9,6) DEFAULT 0 NOT NULL,
    "tax_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "discount_percent" numeric(9,6) DEFAULT 0 NOT NULL,
    "discount_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."invoice_line_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "type" "text" DEFAULT 'service'::"text" NOT NULL,
    "rate" numeric(18,6) DEFAULT 0 NOT NULL,
    "unit" "text",
    "tax_rate" numeric(9,6) DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_via" "text" DEFAULT 'web'::"text",
    "created_by_key_id" "uuid",
    CONSTRAINT "items_type_check" CHECK (("type" = ANY (ARRAY['product'::"text", 'service'::"text"])))
);


ALTER TABLE "public"."items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."oauth_authorization_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code_hash" "text" NOT NULL,
    "oauth_client_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "redirect_uri" "text" NOT NULL,
    "code_challenge" "text" NOT NULL,
    "code_challenge_method" "text" DEFAULT 'S256'::"text" NOT NULL,
    "permissions" "text"[] NOT NULL,
    "resource" "text",
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "oauth_authorization_codes_code_challenge_method_check" CHECK (("code_challenge_method" = 'S256'::"text")),
    CONSTRAINT "oauth_authorization_codes_permissions_check" CHECK (("permissions" <@ ARRAY['read'::"text", 'write'::"text", 'send'::"text", 'delete'::"text", 'payments'::"text"]))
);


ALTER TABLE "public"."oauth_authorization_codes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."oauth_clients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "text" NOT NULL,
    "client_name" "text" NOT NULL,
    "redirect_uris" "text"[] NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "oauth_clients_redirect_uris_check" CHECK ((("array_length"("redirect_uris", 1) >= 1) AND ("array_length"("redirect_uris", 1) <= 10)))
);


ALTER TABLE "public"."oauth_clients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."oauth_refresh_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "token_hash" "text" NOT NULL,
    "family_id" "uuid" NOT NULL,
    "oauth_client_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "permissions" "text"[] NOT NULL,
    "api_key_id" "uuid",
    "resource" "text",
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "oauth_refresh_tokens_permissions_check" CHECK (("permissions" <@ ARRAY['read'::"text", 'write'::"text", 'send'::"text", 'delete'::"text", 'payments'::"text"]))
);


ALTER TABLE "public"."oauth_refresh_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."onboarding_state" (
    "business_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "dismissed_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "tour_completed_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."onboarding_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."operation_receipts" (
    "business_id" "uuid" NOT NULL,
    "operation" "text" NOT NULL,
    "request_id" "uuid" NOT NULL,
    "input" "jsonb" NOT NULL,
    "result" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."operation_receipts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payment_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payment_id" "uuid" NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "actor_user_id" "uuid",
    "actor_key_id" "uuid",
    "request_id" "text" NOT NULL,
    "input" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "before" "jsonb" NOT NULL,
    "after" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payment_audit_action_check" CHECK (("action" = ANY (ARRAY['update'::"text", 'void'::"text"]))),
    CONSTRAINT "payment_audit_request_id_check" CHECK ((("length"("request_id") >= 1) AND ("length"("request_id") <= 200)))
);


ALTER TABLE "public"."payment_audit" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "client_id" "uuid" NOT NULL,
    "amount" numeric(12,2) NOT NULL,
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "payment_date" "date" NOT NULL,
    "payment_method" "text" DEFAULT 'other'::"text" NOT NULL,
    "reference_number" "text",
    "notes" "text",
    "stripe_payment_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_via" "text" DEFAULT 'web'::"text",
    "created_by_key_id" "uuid",
    "voided_at" timestamp with time zone,
    "void_reason" "text",
    "updated_at" timestamp with time zone,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    CONSTRAINT "payments_payment_method_check" CHECK (("payment_method" = ANY (ARRAY['cash'::"text", 'check'::"text", 'bank_transfer'::"text", 'credit_card'::"text", 'stripe'::"text", 'paypal'::"text", 'other'::"text"]))),
    CONSTRAINT "payments_source_check" CHECK (("source" = ANY (ARRAY['manual'::"text", 'agent'::"text", 'stripe'::"text"])))
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "full_name" "text",
    "avatar_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rate_limit_counters" (
    "bucket" "text" NOT NULL,
    "window_start" timestamp with time zone NOT NULL,
    "hits" integer DEFAULT 0 NOT NULL,
    "expires_at" timestamp with time zone NOT NULL
);


ALTER TABLE "public"."rate_limit_counters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stripe_events" (
    "id" "text" NOT NULL,
    "type" "text",
    "received_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."stripe_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "task_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "request_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "input" "jsonb" NOT NULL,
    "result" "jsonb" NOT NULL,
    "actor_user_id" "uuid",
    "actor_key_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."task_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_usage" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "task_id" "uuid" NOT NULL,
    "business_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "model" "text",
    "provider_request_id" "text" NOT NULL,
    "cost" numeric(16,6) NOT NULL,
    "currency" "text" NOT NULL,
    "input_tokens" bigint,
    "output_tokens" bigint,
    "source" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "task_usage_cost_check" CHECK ((("cost" >= (0)::numeric) AND ("cost" < (100000000)::numeric))),
    CONSTRAINT "task_usage_input_tokens_check" CHECK (("input_tokens" >= 0)),
    CONSTRAINT "task_usage_output_tokens_check" CHECK (("output_tokens" >= 0)),
    CONSTRAINT "task_usage_source_check" CHECK ((("length"("source") >= 1) AND ("length"("source") <= 1000)))
);


ALTER TABLE "public"."task_usage" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."time_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "client_id" "uuid",
    "project_name" "text",
    "description" "text",
    "date" "date" NOT NULL,
    "start_time" time without time zone,
    "end_time" time without time zone,
    "duration_minutes" integer,
    "hourly_rate" numeric(18,6),
    "amount" numeric(10,2),
    "is_billable" boolean DEFAULT true NOT NULL,
    "is_billed" boolean DEFAULT false NOT NULL,
    "invoice_id" "uuid",
    "is_running" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_via" "text" DEFAULT 'web'::"text",
    "created_by_key_id" "uuid",
    "duration_seconds" bigint DEFAULT 0 NOT NULL,
    "currency" "text" NOT NULL,
    CONSTRAINT "time_duration_nonnegative" CHECK (("duration_seconds" >= 0))
);


ALTER TABLE "public"."time_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."work_tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_id" "uuid" NOT NULL,
    "policy_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "status" "text" DEFAULT 'paused'::"text" NOT NULL,
    "active_seconds" bigint DEFAULT 0 NOT NULL,
    "last_heartbeat_at" timestamp with time zone,
    "usage_cost" numeric(16,6) DEFAULT 0 NOT NULL,
    "invoice_id" "uuid",
    "created_by_key_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "work_tasks_active_seconds_check" CHECK (("active_seconds" >= 0)),
    CONSTRAINT "work_tasks_status_check" CHECK (("status" = ANY (ARRAY['paused'::"text", 'running'::"text", 'completed'::"text", 'invoiced'::"text"]))),
    CONSTRAINT "work_tasks_title_check" CHECK ((("length"("title") >= 1) AND ("length"("title") <= 500))),
    CONSTRAINT "work_tasks_usage_cost_check" CHECK (("usage_cost" >= (0)::numeric))
);


ALTER TABLE "public"."work_tasks" OWNER TO "postgres";


ALTER TABLE ONLY "public"."agent_tool_calls"
    ADD CONSTRAINT "agent_tool_calls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_key_hash_key" UNIQUE ("key_hash");



ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."billing_policies"
    ADD CONSTRAINT "billing_policies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."business_members"
    ADD CONSTRAINT "business_members_business_id_user_id_key" UNIQUE ("business_id", "user_id");



ALTER TABLE ONLY "public"."business_members"
    ADD CONSTRAINT "business_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."businesses"
    ADD CONSTRAINT "businesses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_contacts"
    ADD CONSTRAINT "client_contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_deliveries"
    ADD CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("business_id", "request_id");



ALTER TABLE ONLY "public"."engagement_entries"
    ADD CONSTRAINT "engagement_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."engagement_entries"
    ADD CONSTRAINT "engagement_entries_position_unique" UNIQUE ("engagement_id", "position");



ALTER TABLE ONLY "public"."engagements"
    ADD CONSTRAINT "engagements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."estimate_line_items"
    ADD CONSTRAINT "estimate_line_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."estimates"
    ADD CONSTRAINT "estimates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."estimates"
    ADD CONSTRAINT "estimates_public_id_key" UNIQUE ("public_id");



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoice_line_items"
    ADD CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_public_id_key" UNIQUE ("public_id");



ALTER TABLE ONLY "public"."items"
    ADD CONSTRAINT "items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."oauth_authorization_codes"
    ADD CONSTRAINT "oauth_authorization_codes_code_hash_key" UNIQUE ("code_hash");



ALTER TABLE ONLY "public"."oauth_authorization_codes"
    ADD CONSTRAINT "oauth_authorization_codes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."oauth_clients"
    ADD CONSTRAINT "oauth_clients_client_id_key" UNIQUE ("client_id");



ALTER TABLE ONLY "public"."oauth_clients"
    ADD CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."oauth_refresh_tokens"
    ADD CONSTRAINT "oauth_refresh_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."oauth_refresh_tokens"
    ADD CONSTRAINT "oauth_refresh_tokens_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."onboarding_state"
    ADD CONSTRAINT "onboarding_state_pkey" PRIMARY KEY ("business_id", "user_id");



ALTER TABLE ONLY "public"."operation_receipts"
    ADD CONSTRAINT "operation_receipts_pkey" PRIMARY KEY ("business_id", "operation", "request_id");



ALTER TABLE ONLY "public"."payment_audit"
    ADD CONSTRAINT "payment_audit_payment_id_request_id_key" UNIQUE ("payment_id", "request_id");



ALTER TABLE ONLY "public"."payment_audit"
    ADD CONSTRAINT "payment_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rate_limit_counters"
    ADD CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("bucket", "window_start");



ALTER TABLE ONLY "public"."stripe_events"
    ADD CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_events"
    ADD CONSTRAINT "task_events_business_id_request_id_key" UNIQUE ("business_id", "request_id");



ALTER TABLE ONLY "public"."task_events"
    ADD CONSTRAINT "task_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_usage"
    ADD CONSTRAINT "task_usage_business_id_provider_provider_request_id_key" UNIQUE ("business_id", "provider", "provider_request_id");



ALTER TABLE ONLY "public"."task_usage"
    ADD CONSTRAINT "task_usage_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."work_tasks"
    ADD CONSTRAINT "work_tasks_invoice_id_key" UNIQUE ("invoice_id");



ALTER TABLE ONLY "public"."work_tasks"
    ADD CONSTRAINT "work_tasks_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_api_keys_hash" ON "public"."api_keys" USING "btree" ("key_hash") WHERE ("revoked_at" IS NULL);



CREATE INDEX "idx_api_keys_oauth_client" ON "public"."api_keys" USING "btree" ("oauth_client_id") WHERE ("oauth_client_id" IS NOT NULL);



CREATE INDEX "idx_api_keys_user" ON "public"."api_keys" USING "btree" ("user_id");



CREATE INDEX "idx_business_members_business" ON "public"."business_members" USING "btree" ("business_id");



CREATE INDEX "idx_business_members_user" ON "public"."business_members" USING "btree" ("user_id");



CREATE INDEX "idx_client_contacts_client" ON "public"."client_contacts" USING "btree" ("client_id");



CREATE INDEX "idx_clients_business" ON "public"."clients" USING "btree" ("business_id");



CREATE INDEX "idx_clients_created_via" ON "public"."clients" USING "btree" ("business_id", "created_at" DESC) WHERE ("created_via" = 'agent'::"text");



CREATE INDEX "idx_engagement_entries_business_status" ON "public"."engagement_entries" USING "btree" ("business_id", "status");



CREATE INDEX "idx_engagement_entries_due" ON "public"."engagement_entries" USING "btree" ("business_id", "due_on") WHERE (("due_rule" = 'on_date'::"text") AND ("status" = 'pending'::"text"));



CREATE INDEX "idx_engagement_entries_engagement" ON "public"."engagement_entries" USING "btree" ("engagement_id", "position");



CREATE INDEX "idx_engagement_entries_invoice" ON "public"."engagement_entries" USING "btree" ("invoice_id") WHERE ("invoice_id" IS NOT NULL);



CREATE INDEX "idx_engagements_business" ON "public"."engagements" USING "btree" ("business_id");



CREATE INDEX "idx_engagements_client" ON "public"."engagements" USING "btree" ("client_id");



CREATE INDEX "idx_engagements_status" ON "public"."engagements" USING "btree" ("business_id", "status");



CREATE INDEX "idx_estimate_line_items_estimate" ON "public"."estimate_line_items" USING "btree" ("estimate_id");



CREATE INDEX "idx_estimates_business" ON "public"."estimates" USING "btree" ("business_id");



CREATE INDEX "idx_estimates_client" ON "public"."estimates" USING "btree" ("client_id");



CREATE INDEX "idx_estimates_created_via" ON "public"."estimates" USING "btree" ("business_id", "created_at" DESC) WHERE ("created_via" = 'agent'::"text");



CREATE INDEX "idx_estimates_public_id" ON "public"."estimates" USING "btree" ("public_id");



CREATE INDEX "idx_expenses_business" ON "public"."expenses" USING "btree" ("business_id");



CREATE INDEX "idx_expenses_business_date" ON "public"."expenses" USING "btree" ("business_id", "date");



CREATE INDEX "idx_expenses_created_via" ON "public"."expenses" USING "btree" ("business_id", "created_at" DESC) WHERE ("created_via" = 'agent'::"text");



CREATE INDEX "idx_expenses_date" ON "public"."expenses" USING "btree" ("date");



CREATE INDEX "idx_invoice_line_items_invoice" ON "public"."invoice_line_items" USING "btree" ("invoice_id");



CREATE INDEX "idx_invoices_business" ON "public"."invoices" USING "btree" ("business_id");



CREATE INDEX "idx_invoices_business_issue_date" ON "public"."invoices" USING "btree" ("business_id", "issue_date");



CREATE INDEX "idx_invoices_client" ON "public"."invoices" USING "btree" ("client_id");



CREATE INDEX "idx_invoices_created_via" ON "public"."invoices" USING "btree" ("business_id", "created_at" DESC) WHERE ("created_via" = 'agent'::"text");



CREATE INDEX "idx_invoices_due_date" ON "public"."invoices" USING "btree" ("due_date");



CREATE INDEX "idx_invoices_public_id" ON "public"."invoices" USING "btree" ("public_id");



CREATE INDEX "idx_invoices_status" ON "public"."invoices" USING "btree" ("status");



CREATE INDEX "idx_items_business" ON "public"."items" USING "btree" ("business_id");



CREATE INDEX "idx_items_created_via" ON "public"."items" USING "btree" ("business_id", "created_at" DESC) WHERE ("created_via" = 'agent'::"text");



CREATE INDEX "idx_oauth_codes_expires_at" ON "public"."oauth_authorization_codes" USING "btree" ("expires_at");



CREATE INDEX "idx_oauth_refresh_expires_at" ON "public"."oauth_refresh_tokens" USING "btree" ("expires_at");



CREATE INDEX "idx_oauth_refresh_family" ON "public"."oauth_refresh_tokens" USING "btree" ("family_id");



CREATE INDEX "idx_payment_audit_invoice" ON "public"."payment_audit" USING "btree" ("invoice_id", "created_at" DESC);



CREATE INDEX "idx_payments_business" ON "public"."payments" USING "btree" ("business_id");



CREATE INDEX "idx_payments_business_payment_date" ON "public"."payments" USING "btree" ("business_id", "payment_date");



CREATE INDEX "idx_payments_created_via" ON "public"."payments" USING "btree" ("business_id", "created_at" DESC) WHERE ("created_via" = 'agent'::"text");



CREATE INDEX "idx_payments_date" ON "public"."payments" USING "btree" ("payment_date");



CREATE INDEX "idx_payments_invoice" ON "public"."payments" USING "btree" ("invoice_id");



CREATE INDEX "idx_payments_live_business_date" ON "public"."payments" USING "btree" ("business_id", "payment_date") WHERE ("voided_at" IS NULL);



CREATE INDEX "idx_payments_live_invoice" ON "public"."payments" USING "btree" ("invoice_id") WHERE ("voided_at" IS NULL);



CREATE INDEX "idx_rate_limit_counters_expires_at" ON "public"."rate_limit_counters" USING "btree" ("expires_at");



CREATE INDEX "idx_time_entries_business" ON "public"."time_entries" USING "btree" ("business_id");



CREATE INDEX "idx_time_entries_business_date" ON "public"."time_entries" USING "btree" ("business_id", "date");



CREATE INDEX "idx_time_entries_client" ON "public"."time_entries" USING "btree" ("client_id");



CREATE INDEX "idx_time_entries_created_via" ON "public"."time_entries" USING "btree" ("business_id", "created_at" DESC) WHERE ("created_via" = 'agent'::"text");



CREATE INDEX "idx_time_entries_date" ON "public"."time_entries" USING "btree" ("date");



CREATE UNIQUE INDEX "payments_stripe_payment_id_uniq" ON "public"."payments" USING "btree" ("stripe_payment_id") WHERE ("stripe_payment_id" IS NOT NULL);



CREATE INDEX "work_tasks_business" ON "public"."work_tasks" USING "btree" ("business_id", "created_at", "id");



CREATE CONSTRAINT TRIGGER "engagement_entries_balance" AFTER INSERT OR DELETE OR UPDATE ON "public"."engagement_entries" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "public"."engagement_schedule_balances"();



CREATE CONSTRAINT TRIGGER "engagements_balance" AFTER UPDATE ON "public"."engagements" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "public"."engagement_schedule_balances"();



CREATE OR REPLACE TRIGGER "guard_api_key_columns" BEFORE UPDATE ON "public"."api_keys" FOR EACH ROW EXECUTE FUNCTION "public"."guard_api_key_columns"();



CREATE OR REPLACE TRIGGER "guard_engagement_entry_changes" BEFORE INSERT OR DELETE OR UPDATE ON "public"."engagement_entries" FOR EACH ROW EXECUTE FUNCTION "public"."guard_engagement_entry"();



CREATE OR REPLACE TRIGGER "guard_estimate_client" BEFORE INSERT OR UPDATE ON "public"."estimates" FOR EACH ROW EXECUTE FUNCTION "public"."guard_document_client"();



CREATE OR REPLACE TRIGGER "guard_estimate_delete" BEFORE DELETE ON "public"."estimates" FOR EACH ROW EXECUTE FUNCTION "public"."guard_document_delete"();



CREATE OR REPLACE TRIGGER "guard_expense_currency" BEFORE INSERT OR UPDATE ON "public"."expenses" FOR EACH ROW EXECUTE FUNCTION "public"."guard_work_currency"();



CREATE OR REPLACE TRIGGER "guard_expense_entry" BEFORE INSERT OR DELETE OR UPDATE ON "public"."expenses" FOR EACH ROW EXECUTE FUNCTION "public"."guard_work_entry"();



CREATE OR REPLACE TRIGGER "guard_invoice_client" BEFORE INSERT OR UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."guard_document_client"();



CREATE OR REPLACE TRIGGER "guard_invoice_delete" BEFORE DELETE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."guard_document_delete"();



CREATE OR REPLACE TRIGGER "guard_payment_amount" BEFORE INSERT OR UPDATE ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "public"."guard_payment_amount"();



CREATE OR REPLACE TRIGGER "guard_payment_relations" BEFORE INSERT OR UPDATE ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "public"."guard_payment_relations"();



CREATE OR REPLACE TRIGGER "guard_stripe_invoice_fields" BEFORE INSERT OR UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."guard_stripe_invoice_fields"();



CREATE OR REPLACE TRIGGER "guard_stripe_payment_fields" BEFORE INSERT OR UPDATE ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "public"."guard_stripe_payment_fields"();



CREATE OR REPLACE TRIGGER "guard_task_key" BEFORE INSERT ON "public"."task_events" FOR EACH ROW EXECUTE FUNCTION "public"."guard_task_key"();



CREATE OR REPLACE TRIGGER "guard_time_currency" BEFORE INSERT OR UPDATE ON "public"."time_entries" FOR EACH ROW EXECUTE FUNCTION "public"."guard_work_currency"();



CREATE OR REPLACE TRIGGER "guard_time_entry" BEFORE INSERT OR DELETE OR UPDATE ON "public"."time_entries" FOR EACH ROW EXECUTE FUNCTION "public"."guard_work_entry"();



CREATE OR REPLACE TRIGGER "release_draft_invoice_claims" BEFORE DELETE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."release_draft_invoice_claims"();



CREATE OR REPLACE TRIGGER "update_businesses_updated_at" BEFORE UPDATE ON "public"."businesses" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "update_clients_updated_at" BEFORE UPDATE ON "public"."clients" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "update_engagement_entries_updated_at" BEFORE UPDATE ON "public"."engagement_entries" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "update_engagements_updated_at" BEFORE UPDATE ON "public"."engagements" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "update_estimates_updated_at" BEFORE UPDATE ON "public"."estimates" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "update_expenses_updated_at" BEFORE UPDATE ON "public"."expenses" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "update_invoices_updated_at" BEFORE UPDATE ON "public"."invoices" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "update_items_updated_at" BEFORE UPDATE ON "public"."items" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "update_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "update_time_entries_updated_at" BEFORE UPDATE ON "public"."time_entries" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



ALTER TABLE ONLY "public"."agent_tool_calls"
    ADD CONSTRAINT "agent_tool_calls_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_tool_calls"
    ADD CONSTRAINT "agent_tool_calls_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_oauth_client_id_fkey" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."billing_policies"
    ADD CONSTRAINT "billing_policies_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."billing_policies"
    ADD CONSTRAINT "billing_policies_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."billing_policies"
    ADD CONSTRAINT "billing_policies_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id");



ALTER TABLE ONLY "public"."business_members"
    ADD CONSTRAINT "business_members_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."business_members"
    ADD CONSTRAINT "business_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."client_contacts"
    ADD CONSTRAINT "client_contacts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_created_by_key_id_fkey" FOREIGN KEY ("created_by_key_id") REFERENCES "public"."api_keys"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."email_deliveries"
    ADD CONSTRAINT "email_deliveries_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id");



ALTER TABLE ONLY "public"."engagement_entries"
    ADD CONSTRAINT "engagement_entries_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."engagement_entries"
    ADD CONSTRAINT "engagement_entries_engagement_id_fkey" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."engagement_entries"
    ADD CONSTRAINT "engagement_entries_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."engagements"
    ADD CONSTRAINT "engagements_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."engagements"
    ADD CONSTRAINT "engagements_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."engagements"
    ADD CONSTRAINT "engagements_created_by_key_id_fkey" FOREIGN KEY ("created_by_key_id") REFERENCES "public"."api_keys"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."engagements"
    ADD CONSTRAINT "engagements_source_estimate_id_fkey" FOREIGN KEY ("source_estimate_id") REFERENCES "public"."estimates"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."estimate_line_items"
    ADD CONSTRAINT "estimate_line_items_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."estimates"
    ADD CONSTRAINT "estimates_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."estimates"
    ADD CONSTRAINT "estimates_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."estimates"
    ADD CONSTRAINT "estimates_created_by_key_id_fkey" FOREIGN KEY ("created_by_key_id") REFERENCES "public"."api_keys"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_created_by_key_id_fkey" FOREIGN KEY ("created_by_key_id") REFERENCES "public"."api_keys"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."estimates"
    ADD CONSTRAINT "fk_estimates_converted_invoice" FOREIGN KEY ("converted_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;



ALTER TABLE ONLY "public"."invoice_line_items"
    ADD CONSTRAINT "invoice_line_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_created_by_key_id_fkey" FOREIGN KEY ("created_by_key_id") REFERENCES "public"."api_keys"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_from_estimate_id_fkey" FOREIGN KEY ("from_estimate_id") REFERENCES "public"."estimates"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."items"
    ADD CONSTRAINT "items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."items"
    ADD CONSTRAINT "items_created_by_key_id_fkey" FOREIGN KEY ("created_by_key_id") REFERENCES "public"."api_keys"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."oauth_authorization_codes"
    ADD CONSTRAINT "oauth_authorization_codes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."oauth_authorization_codes"
    ADD CONSTRAINT "oauth_authorization_codes_oauth_client_id_fkey" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."oauth_authorization_codes"
    ADD CONSTRAINT "oauth_authorization_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."oauth_refresh_tokens"
    ADD CONSTRAINT "oauth_refresh_tokens_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."oauth_refresh_tokens"
    ADD CONSTRAINT "oauth_refresh_tokens_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."oauth_refresh_tokens"
    ADD CONSTRAINT "oauth_refresh_tokens_oauth_client_id_fkey" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."oauth_refresh_tokens"
    ADD CONSTRAINT "oauth_refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."onboarding_state"
    ADD CONSTRAINT "onboarding_state_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."onboarding_state"
    ADD CONSTRAINT "onboarding_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."operation_receipts"
    ADD CONSTRAINT "operation_receipts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_audit"
    ADD CONSTRAINT "payment_audit_actor_key_id_fkey" FOREIGN KEY ("actor_key_id") REFERENCES "public"."api_keys"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payment_audit"
    ADD CONSTRAINT "payment_audit_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."payment_audit"
    ADD CONSTRAINT "payment_audit_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_audit"
    ADD CONSTRAINT "payment_audit_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payment_audit"
    ADD CONSTRAINT "payment_audit_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_created_by_key_id_fkey" FOREIGN KEY ("created_by_key_id") REFERENCES "public"."api_keys"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_events"
    ADD CONSTRAINT "task_events_actor_key_id_fkey" FOREIGN KEY ("actor_key_id") REFERENCES "public"."api_keys"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."task_events"
    ADD CONSTRAINT "task_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."task_events"
    ADD CONSTRAINT "task_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id");



ALTER TABLE ONLY "public"."task_events"
    ADD CONSTRAINT "task_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."work_tasks"("id");



ALTER TABLE ONLY "public"."task_usage"
    ADD CONSTRAINT "task_usage_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id");



ALTER TABLE ONLY "public"."task_usage"
    ADD CONSTRAINT "task_usage_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."work_tasks"("id");



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_created_by_key_id_fkey" FOREIGN KEY ("created_by_key_id") REFERENCES "public"."api_keys"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."time_entries"
    ADD CONSTRAINT "time_entries_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."work_tasks"
    ADD CONSTRAINT "work_tasks_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."work_tasks"
    ADD CONSTRAINT "work_tasks_created_by_key_id_fkey" FOREIGN KEY ("created_by_key_id") REFERENCES "public"."api_keys"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."work_tasks"
    ADD CONSTRAINT "work_tasks_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."work_tasks"
    ADD CONSTRAINT "work_tasks_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "public"."billing_policies"("id");



CREATE POLICY "Members can add client contacts" ON "public"."client_contacts" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."id" = "client_contacts"."client_id") AND "public"."user_has_business_access"("c"."business_id")))));



CREATE POLICY "Members can add clients" ON "public"."clients" FOR INSERT WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can add estimate line items" ON "public"."estimate_line_items" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."estimates" "e"
  WHERE (("e"."id" = "estimate_line_items"."estimate_id") AND "public"."user_has_business_access"("e"."business_id")))));



CREATE POLICY "Members can add expenses" ON "public"."expenses" FOR INSERT WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can add invoice line items" ON "public"."invoice_line_items" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."invoices" "i"
  WHERE (("i"."id" = "invoice_line_items"."invoice_id") AND "public"."user_has_business_access"("i"."business_id")))));



CREATE POLICY "Members can add items" ON "public"."items" FOR INSERT WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can create engagement entries" ON "public"."engagement_entries" FOR INSERT WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can create engagements" ON "public"."engagements" FOR INSERT WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can create estimates" ON "public"."estimates" FOR INSERT WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can create invoices" ON "public"."invoices" FOR INSERT WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can delete client contacts" ON "public"."client_contacts" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."id" = "client_contacts"."client_id") AND "public"."user_has_business_access"("c"."business_id")))));



CREATE POLICY "Members can delete clients" ON "public"."clients" FOR DELETE USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can delete engagement entries" ON "public"."engagement_entries" FOR DELETE USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can delete engagements" ON "public"."engagements" FOR DELETE USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can delete estimate line items" ON "public"."estimate_line_items" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."estimates" "e"
  WHERE (("e"."id" = "estimate_line_items"."estimate_id") AND "public"."user_has_business_access"("e"."business_id")))));



CREATE POLICY "Members can delete estimates" ON "public"."estimates" FOR DELETE USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can delete expenses" ON "public"."expenses" FOR DELETE USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can delete invoice line items" ON "public"."invoice_line_items" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."invoices" "i"
  WHERE (("i"."id" = "invoice_line_items"."invoice_id") AND "public"."user_has_business_access"("i"."business_id")))));



CREATE POLICY "Members can delete invoices" ON "public"."invoices" FOR DELETE USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can delete items" ON "public"."items" FOR DELETE USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can delete time entries" ON "public"."time_entries" FOR DELETE USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can edit client contacts" ON "public"."client_contacts" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."id" = "client_contacts"."client_id") AND "public"."user_has_business_access"("c"."business_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."id" = "client_contacts"."client_id") AND "public"."user_has_business_access"("c"."business_id")))));



CREATE POLICY "Members can edit clients" ON "public"."clients" FOR UPDATE USING ("public"."user_has_business_access"("business_id")) WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can edit engagement entries" ON "public"."engagement_entries" FOR UPDATE USING ("public"."user_has_business_access"("business_id")) WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can edit engagements" ON "public"."engagements" FOR UPDATE USING ("public"."user_has_business_access"("business_id")) WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can edit estimate line items" ON "public"."estimate_line_items" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."estimates" "e"
  WHERE (("e"."id" = "estimate_line_items"."estimate_id") AND "public"."user_has_business_access"("e"."business_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."estimates" "e"
  WHERE (("e"."id" = "estimate_line_items"."estimate_id") AND "public"."user_has_business_access"("e"."business_id")))));



CREATE POLICY "Members can edit estimates" ON "public"."estimates" FOR UPDATE USING ("public"."user_has_business_access"("business_id")) WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can edit expenses" ON "public"."expenses" FOR UPDATE USING ("public"."user_has_business_access"("business_id")) WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can edit invoice line items" ON "public"."invoice_line_items" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."invoices" "i"
  WHERE (("i"."id" = "invoice_line_items"."invoice_id") AND "public"."user_has_business_access"("i"."business_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."invoices" "i"
  WHERE (("i"."id" = "invoice_line_items"."invoice_id") AND "public"."user_has_business_access"("i"."business_id")))));



CREATE POLICY "Members can edit invoices" ON "public"."invoices" FOR UPDATE USING ("public"."user_has_business_access"("business_id")) WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can edit items" ON "public"."items" FOR UPDATE USING ("public"."user_has_business_access"("business_id")) WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can edit time entries" ON "public"."time_entries" FOR UPDATE USING ("public"."user_has_business_access"("business_id")) WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can log time" ON "public"."time_entries" FOR INSERT WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can record payments" ON "public"."payments" FOR INSERT WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can view engagement entries" ON "public"."engagement_entries" FOR SELECT USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can view engagements" ON "public"."engagements" FOR SELECT USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Members can view payments" ON "public"."payments" FOR SELECT USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Owners can delete businesses" ON "public"."businesses" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."business_members"
  WHERE (("business_members"."business_id" = "businesses"."id") AND ("business_members"."user_id" = "auth"."uid"()) AND ("business_members"."role" = 'owner'::"text")))));



CREATE POLICY "Owners/admins can manage members" ON "public"."business_members" USING ("public"."user_is_business_admin"("business_id"));



CREATE POLICY "Owners/admins can update businesses" ON "public"."businesses" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."business_members"
  WHERE (("business_members"."business_id" = "businesses"."id") AND ("business_members"."user_id" = "auth"."uid"()) AND ("business_members"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text"])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."business_members"
  WHERE (("business_members"."business_id" = "businesses"."id") AND ("business_members"."user_id" = "auth"."uid"()) AND ("business_members"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text"]))))));



CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can view client contacts" ON "public"."client_contacts" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."id" = "client_contacts"."client_id") AND "public"."user_has_business_access"("c"."business_id")))));



CREATE POLICY "Users can view clients" ON "public"."clients" FOR SELECT USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Users can view estimate line items" ON "public"."estimate_line_items" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."estimates" "e"
  WHERE (("e"."id" = "estimate_line_items"."estimate_id") AND "public"."user_has_business_access"("e"."business_id")))));



CREATE POLICY "Users can view estimates" ON "public"."estimates" FOR SELECT USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Users can view expenses" ON "public"."expenses" FOR SELECT USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Users can view invoice line items" ON "public"."invoice_line_items" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."invoices" "i"
  WHERE (("i"."id" = "invoice_line_items"."invoice_id") AND "public"."user_has_business_access"("i"."business_id")))));



CREATE POLICY "Users can view invoices" ON "public"."invoices" FOR SELECT USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Users can view items" ON "public"."items" FOR SELECT USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Users can view members of their businesses" ON "public"."business_members" FOR SELECT USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "Users can view own profile" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can view their businesses" ON "public"."businesses" FOR SELECT USING ("public"."user_has_business_access"("id"));



CREATE POLICY "Users can view time entries" ON "public"."time_entries" FOR SELECT USING ("public"."user_has_business_access"("business_id"));



ALTER TABLE "public"."agent_tool_calls" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."api_keys" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "api_keys_delete_own" ON "public"."api_keys" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "api_keys_insert_own" ON "public"."api_keys" FOR INSERT WITH CHECK ((("user_id" = "auth"."uid"()) AND ("kind" = 'manual'::"text") AND ("oauth_client_id" IS NULL) AND (("business_id" IS NULL) OR "public"."user_has_business_access"("business_id")) AND ("expires_at" IS NOT NULL) AND ("expires_at" <= ("now"() + '366 days'::interval)) AND (EXISTS ( SELECT 1 FROM "public"."business_members" WHERE ("business_members"."user_id" = "auth"."uid"())))));



CREATE POLICY "api_keys_select_own" ON "public"."api_keys" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "api_keys_update_own" ON "public"."api_keys" FOR UPDATE USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."billing_policies" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."business_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."businesses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."client_contacts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."clients" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "delivery_insert" ON "public"."email_deliveries" FOR INSERT TO "authenticated" WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "delivery_read" ON "public"."email_deliveries" FOR SELECT TO "authenticated" USING ("public"."user_has_business_access"("business_id"));



CREATE POLICY "delivery_update" ON "public"."email_deliveries" FOR UPDATE TO "authenticated" USING ("public"."user_has_business_access"("business_id")) WITH CHECK ("public"."user_has_business_access"("business_id"));



ALTER TABLE "public"."email_deliveries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."engagement_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."engagements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."estimate_line_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."estimates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "events_read" ON "public"."task_events" FOR SELECT TO "authenticated" USING (("business_id" IN ( SELECT "business_members"."business_id"
   FROM "public"."business_members"
  WHERE ("business_members"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."expenses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."invoice_line_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."invoices" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."oauth_authorization_codes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."oauth_clients" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."oauth_refresh_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."onboarding_state" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "onboarding_state_insert_own" ON "public"."onboarding_state" FOR INSERT WITH CHECK ((("user_id" = "auth"."uid"()) AND "public"."user_has_business_access"("business_id")));



CREATE POLICY "onboarding_state_select_own" ON "public"."onboarding_state" FOR SELECT USING ((("user_id" = "auth"."uid"()) AND "public"."user_has_business_access"("business_id")));



CREATE POLICY "onboarding_state_update_own" ON "public"."onboarding_state" FOR UPDATE USING ((("user_id" = "auth"."uid"()) AND "public"."user_has_business_access"("business_id")));



ALTER TABLE "public"."operation_receipts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payment_audit" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payment_audit_read" ON "public"."payment_audit" FOR SELECT TO "authenticated" USING (("business_id" IN ( SELECT "business_members"."business_id"
   FROM "public"."business_members"
  WHERE ("business_members"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "policy_approve" ON "public"."billing_policies" FOR INSERT TO "authenticated" WITH CHECK ((("approved_by" = "auth"."uid"()) AND ("business_id" IN ( SELECT "business_members"."business_id"
   FROM "public"."business_members"
  WHERE (("business_members"."user_id" = "auth"."uid"()) AND ("business_members"."role" = ANY (ARRAY['owner'::"text", 'admin'::"text"]))))) AND (EXISTS ( SELECT 1
   FROM "public"."clients" "c"
  WHERE (("c"."id" = "billing_policies"."client_id") AND ("c"."business_id" = "billing_policies"."business_id"))))));



CREATE POLICY "policy_read" ON "public"."billing_policies" FOR SELECT TO "authenticated" USING (("business_id" IN ( SELECT "business_members"."business_id"
   FROM "public"."business_members"
  WHERE ("business_members"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rate_limit_counters" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "receipts_insert" ON "public"."operation_receipts" FOR INSERT TO "authenticated" WITH CHECK ("public"."user_has_business_access"("business_id"));



CREATE POLICY "receipts_read" ON "public"."operation_receipts" FOR SELECT TO "authenticated" USING ("public"."user_has_business_access"("business_id"));



ALTER TABLE "public"."stripe_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."task_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."task_usage" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tasks_read" ON "public"."work_tasks" FOR SELECT TO "authenticated" USING (("business_id" IN ( SELECT "business_members"."business_id"
   FROM "public"."business_members"
  WHERE ("business_members"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."time_entries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tool_calls_read" ON "public"."agent_tool_calls" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "usage_read" ON "public"."task_usage" FOR SELECT TO "authenticated" USING (("business_id" IN ( SELECT "business_members"."business_id"
   FROM "public"."business_members"
  WHERE ("business_members"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."work_tasks" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."allocate_document_number"("p_business_id" "uuid", "p_kind" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."allocate_document_number"("p_business_id" "uuid", "p_kind" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."allocate_document_number"("p_business_id" "uuid", "p_kind" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."consume_rate_limit"("p_bucket" "text", "p_limit" integer, "p_window_seconds" integer, "p_cost" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."consume_rate_limit"("p_bucket" "text", "p_limit" integer, "p_window_seconds" integer, "p_cost" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."convert_estimate_to_engagement"("p_request_id" "uuid", "p_estimate_id" "uuid", "p_billing_mode" "text", "p_entries" "jsonb", "p_installments" integer, "p_actor_key_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."convert_estimate_to_engagement"("p_request_id" "uuid", "p_estimate_id" "uuid", "p_billing_mode" "text", "p_entries" "jsonb", "p_installments" integer, "p_actor_key_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."convert_estimate_to_engagement"("p_request_id" "uuid", "p_estimate_id" "uuid", "p_billing_mode" "text", "p_entries" "jsonb", "p_installments" integer, "p_actor_key_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."convert_estimate_to_invoice"("p_estimate_id" "uuid", "p_public_id" "text", "p_issue_date" "date", "p_due_date" "date", "p_line_items" "jsonb", "p_subtotal" numeric, "p_total" numeric, "p_created_via" "text", "p_created_by_key_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."convert_estimate_to_invoice"("p_estimate_id" "uuid", "p_public_id" "text", "p_issue_date" "date", "p_due_date" "date", "p_line_items" "jsonb", "p_subtotal" numeric, "p_total" numeric, "p_created_via" "text", "p_created_by_key_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."convert_estimate_to_invoice"("p_estimate_id" "uuid", "p_public_id" "text", "p_issue_date" "date", "p_due_date" "date", "p_line_items" "jsonb", "p_subtotal" numeric, "p_total" numeric, "p_created_via" "text", "p_created_by_key_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."businesses" TO "anon";
GRANT ALL ON TABLE "public"."businesses" TO "authenticated";
GRANT ALL ON TABLE "public"."businesses" TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_business_with_owner"("business_name" "text", "business_email" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_business_with_owner"("business_name" "text", "business_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_business_with_owner"("business_name" "text", "business_email" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_engagement_with_schedule"("p_request_id" "uuid", "p_business_id" "uuid", "p_client_id" "uuid", "p_name" "text", "p_total" numeric, "p_currency" "text", "p_billing_mode" "text", "p_entries" "jsonb", "p_installments" integer, "p_status" "text", "p_starts_on" "date", "p_target_end" "date", "p_notes" "text", "p_source_estimate_id" "uuid", "p_actor_key_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_engagement_with_schedule"("p_request_id" "uuid", "p_business_id" "uuid", "p_client_id" "uuid", "p_name" "text", "p_total" numeric, "p_currency" "text", "p_billing_mode" "text", "p_entries" "jsonb", "p_installments" integer, "p_status" "text", "p_starts_on" "date", "p_target_end" "date", "p_notes" "text", "p_source_estimate_id" "uuid", "p_actor_key_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."create_engagement_with_schedule"("p_request_id" "uuid", "p_business_id" "uuid", "p_client_id" "uuid", "p_name" "text", "p_total" numeric, "p_currency" "text", "p_billing_mode" "text", "p_entries" "jsonb", "p_installments" integer, "p_status" "text", "p_starts_on" "date", "p_target_end" "date", "p_notes" "text", "p_source_estimate_id" "uuid", "p_actor_key_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_estimate_document"("p_business_id" "uuid", "p_client_id" "uuid", "p_patch" "jsonb", "p_lines" "jsonb", "p_request_id" "uuid", "p_key_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_estimate_document"("p_business_id" "uuid", "p_client_id" "uuid", "p_patch" "jsonb", "p_lines" "jsonb", "p_request_id" "uuid", "p_key_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."create_estimate_document"("p_business_id" "uuid", "p_client_id" "uuid", "p_patch" "jsonb", "p_lines" "jsonb", "p_request_id" "uuid", "p_key_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_invoice_document"("p_business_id" "uuid", "p_client_id" "uuid", "p_patch" "jsonb", "p_lines" "jsonb", "p_request_id" "uuid", "p_time_ids" "uuid"[], "p_expense_ids" "uuid"[], "p_key_id" "uuid", "p_engagement_entry_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_invoice_document"("p_business_id" "uuid", "p_client_id" "uuid", "p_patch" "jsonb", "p_lines" "jsonb", "p_request_id" "uuid", "p_time_ids" "uuid"[], "p_expense_ids" "uuid"[], "p_key_id" "uuid", "p_engagement_entry_ids" "uuid"[]) TO "service_role";
GRANT ALL ON FUNCTION "public"."create_invoice_document"("p_business_id" "uuid", "p_client_id" "uuid", "p_patch" "jsonb", "p_lines" "jsonb", "p_request_id" "uuid", "p_time_ids" "uuid"[], "p_expense_ids" "uuid"[], "p_key_id" "uuid", "p_engagement_entry_ids" "uuid"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."create_work_entry_once"("p_business_id" "uuid", "p_kind" "text", "p_record" "jsonb", "p_request_id" "uuid", "p_key_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_work_entry_once"("p_business_id" "uuid", "p_kind" "text", "p_record" "jsonb", "p_request_id" "uuid", "p_key_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."create_work_entry_once"("p_business_id" "uuid", "p_kind" "text", "p_record" "jsonb", "p_request_id" "uuid", "p_key_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."dashboard_summary"("p_business_id" "uuid", "p_currency" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."dashboard_summary"("p_business_id" "uuid", "p_currency" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dashboard_summary"("p_business_id" "uuid", "p_currency" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."engagement_payload"("p_engagement_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."engagement_payload"("p_engagement_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."engagement_schedule_balances"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."engagement_schedule_balances"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."expand_engagement_schedule"("p_billing_mode" "text", "p_total" numeric, "p_entries" "jsonb", "p_installments" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."expand_engagement_schedule"("p_billing_mode" "text", "p_total" numeric, "p_entries" "jsonb", "p_installments" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."expand_engagement_schedule"("p_billing_mode" "text", "p_total" numeric, "p_entries" "jsonb", "p_installments" integer) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."generate_public_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."generate_public_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_public_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_agent_activity"("p_business_ids" "uuid"[], "p_limit" integer, "p_before" timestamp with time zone, "p_before_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_agent_activity"("p_business_ids" "uuid"[], "p_limit" integer, "p_before" timestamp with time zone, "p_before_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_agent_activity"("p_business_ids" "uuid"[], "p_limit" integer, "p_before" timestamp with time zone, "p_before_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_public_estimate"("p_public_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_public_estimate"("p_public_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_estimate"("p_public_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_estimate"("p_public_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_public_invoice"("p_public_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_public_invoice"("p_public_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_public_invoice"("p_public_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_report_summary"("p_business_id" "uuid", "p_start" "date", "p_end" "date", "p_prev_start" "date", "p_prev_end" "date", "p_bucket" "text", "p_currency" "text", "p_aging_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_report_summary"("p_business_id" "uuid", "p_start" "date", "p_end" "date", "p_prev_start" "date", "p_prev_end" "date", "p_bucket" "text", "p_currency" "text", "p_aging_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_report_summary"("p_business_id" "uuid", "p_start" "date", "p_end" "date", "p_prev_start" "date", "p_prev_end" "date", "p_bucket" "text", "p_currency" "text", "p_aging_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."guard_api_key_columns"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_api_key_columns"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."guard_document_client"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_document_client"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."guard_document_delete"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_document_delete"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."guard_engagement_entry"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_engagement_entry"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."guard_payment_amount"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_payment_amount"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."guard_payment_relations"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_payment_relations"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."guard_stripe_invoice_fields"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_stripe_invoice_fields"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."guard_stripe_payment_fields"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_stripe_payment_fields"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."guard_task_key"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_task_key"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."guard_work_currency"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_work_currency"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."guard_work_entry"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_work_entry"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_new_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."mark_entry_complete"("p_request_id" "uuid", "p_entry_id" "uuid", "p_actor_key_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mark_entry_complete"("p_request_id" "uuid", "p_entry_id" "uuid", "p_actor_key_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."mark_entry_complete"("p_request_id" "uuid", "p_entry_id" "uuid", "p_actor_key_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."peek_rate_limit"("p_bucket" "text", "p_limit" integer, "p_window_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."peek_rate_limit"("p_bucket" "text", "p_limit" integer, "p_window_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."promote_due_entries"("p_business_id" "uuid", "p_actor_key_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."promote_due_entries"("p_business_id" "uuid", "p_actor_key_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."promote_due_entries"("p_business_id" "uuid", "p_actor_key_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."prune_rate_limit_counters"("p_max_rows" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prune_rate_limit_counters"("p_max_rows" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."public_business_snapshot"("snap" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."public_business_snapshot"("snap" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."public_client_snapshot"("snap" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."public_client_snapshot"("snap" "jsonb") TO "service_role";



GRANT ALL ON TABLE "public"."invoices" TO "anon";
GRANT ALL ON TABLE "public"."invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."invoices" TO "service_role";



REVOKE ALL ON FUNCTION "public"."recompute_invoice_money"("p_invoice_id" "uuid", "p_paid_at_hint" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."recompute_invoice_money"("p_invoice_id" "uuid", "p_paid_at_hint" "date") TO "service_role";
GRANT ALL ON FUNCTION "public"."recompute_invoice_money"("p_invoice_id" "uuid", "p_paid_at_hint" "date") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."record_invoice_payment"("p_invoice_id" "uuid", "p_amount" numeric, "p_payment_date" "date", "p_payment_method" "text", "p_reference_number" "text", "p_notes" "text", "p_created_via" "text", "p_created_by_key_id" "uuid", "p_stripe_payment_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_invoice_payment"("p_invoice_id" "uuid", "p_amount" numeric, "p_payment_date" "date", "p_payment_method" "text", "p_reference_number" "text", "p_notes" "text", "p_created_via" "text", "p_created_by_key_id" "uuid", "p_stripe_payment_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_invoice_payment"("p_invoice_id" "uuid", "p_amount" numeric, "p_payment_date" "date", "p_payment_method" "text", "p_reference_number" "text", "p_notes" "text", "p_created_via" "text", "p_created_by_key_id" "uuid", "p_stripe_payment_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_payment_once"("p_invoice_id" "uuid", "p_amount" numeric, "p_payment_date" "date", "p_request_id" "uuid", "p_payment_method" "text", "p_reference_number" "text", "p_notes" "text", "p_created_via" "text", "p_created_by_key_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_payment_once"("p_invoice_id" "uuid", "p_amount" numeric, "p_payment_date" "date", "p_request_id" "uuid", "p_payment_method" "text", "p_reference_number" "text", "p_notes" "text", "p_created_via" "text", "p_created_by_key_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."record_payment_once"("p_invoice_id" "uuid", "p_amount" numeric, "p_payment_date" "date", "p_request_id" "uuid", "p_payment_method" "text", "p_reference_number" "text", "p_notes" "text", "p_created_via" "text", "p_created_by_key_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."record_stripe_payment"("p_invoice_id" "uuid", "p_amount" numeric, "p_payment_date" "date", "p_provider_id" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_stripe_payment"("p_invoice_id" "uuid", "p_amount" numeric, "p_payment_date" "date", "p_provider_id" "text", "p_notes" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_draft_invoice_claims"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_draft_invoice_claims"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_estimate_line_items"("p_estimate_id" "uuid", "p_line_items" "jsonb", "p_estimate_patch" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_estimate_line_items"("p_estimate_id" "uuid", "p_line_items" "jsonb", "p_estimate_patch" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace_estimate_line_items"("p_estimate_id" "uuid", "p_line_items" "jsonb", "p_estimate_patch" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."replace_invoice_line_items"("p_invoice_id" "uuid", "p_line_items" "jsonb", "p_invoice_patch" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."replace_invoice_line_items"("p_invoice_id" "uuid", "p_line_items" "jsonb", "p_invoice_patch" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."replace_invoice_line_items"("p_invoice_id" "uuid", "p_line_items" "jsonb", "p_invoice_patch" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."resolve_engagement_actor"("p_business_id" "uuid", "p_actor_key_id" "uuid", "p_permission" "text", OUT "actor_user_id" "uuid", OUT "actor_key_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_engagement_actor"("p_business_id" "uuid", "p_actor_key_id" "uuid", "p_permission" "text", OUT "actor_user_id" "uuid", OUT "actor_key_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."resolve_payment_actor"("p_business_id" "uuid", "p_actor_key_id" "uuid", OUT "actor_user_id" "uuid", OUT "actor_key_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_payment_actor"("p_business_id" "uuid", "p_actor_key_id" "uuid", OUT "actor_user_id" "uuid", OUT "actor_key_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."respond_to_estimate"("p_public_id" "text", "p_response" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."respond_to_estimate"("p_public_id" "text", "p_response" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."respond_to_estimate"("p_public_id" "text", "p_response" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_engagement_status"("p_request_id" "uuid", "p_engagement_id" "uuid", "p_status" "text", "p_actor_key_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_engagement_status"("p_request_id" "uuid", "p_engagement_id" "uuid", "p_status" "text", "p_actor_key_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."set_engagement_status"("p_request_id" "uuid", "p_engagement_id" "uuid", "p_status" "text", "p_actor_key_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."sync_invoice_payment_ledger"("p_invoice_id" "uuid", "p_intent_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_invoice_payment_ledger"("p_invoice_id" "uuid", "p_intent_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."task_operation"("p_business_id" "uuid", "p_request_id" "uuid", "p_action" "text", "p_input" "jsonb", "p_key_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."task_operation"("p_business_id" "uuid", "p_request_id" "uuid", "p_action" "text", "p_input" "jsonb", "p_key_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."task_operation"("p_business_id" "uuid", "p_request_id" "uuid", "p_action" "text", "p_input" "jsonb", "p_key_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."update_engagement"("p_request_id" "uuid", "p_engagement_id" "uuid", "p_name" "text", "p_starts_on" "date", "p_target_end" "date", "p_notes" "text", "p_actor_key_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_engagement"("p_request_id" "uuid", "p_engagement_id" "uuid", "p_name" "text", "p_starts_on" "date", "p_target_end" "date", "p_notes" "text", "p_actor_key_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."update_engagement"("p_request_id" "uuid", "p_engagement_id" "uuid", "p_name" "text", "p_starts_on" "date", "p_target_end" "date", "p_notes" "text", "p_actor_key_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."update_payment"("p_payment_id" "uuid", "p_request_id" "text", "p_payment_date" "date", "p_method" "text", "p_notes" "text", "p_reference_number" "text", "p_amount" numeric, "p_actor_key_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_payment"("p_payment_id" "uuid", "p_request_id" "text", "p_payment_date" "date", "p_method" "text", "p_notes" "text", "p_reference_number" "text", "p_amount" numeric, "p_actor_key_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."update_payment"("p_payment_id" "uuid", "p_request_id" "text", "p_payment_date" "date", "p_method" "text", "p_notes" "text", "p_reference_number" "text", "p_amount" numeric, "p_actor_key_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."update_updated_at"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."user_has_business_access"("check_business_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."user_has_business_access"("check_business_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_has_business_access"("check_business_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."user_is_business_admin"("check_business_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."user_is_business_admin"("check_business_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_is_business_admin"("check_business_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."void_payment"("p_payment_id" "uuid", "p_request_id" "text", "p_reason" "text", "p_actor_key_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."void_payment"("p_payment_id" "uuid", "p_request_id" "text", "p_reason" "text", "p_actor_key_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."void_payment"("p_payment_id" "uuid", "p_request_id" "text", "p_reason" "text", "p_actor_key_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."waive_entry"("p_request_id" "uuid", "p_entry_id" "uuid", "p_reason" "text", "p_actor_key_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."waive_entry"("p_request_id" "uuid", "p_entry_id" "uuid", "p_reason" "text", "p_actor_key_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."waive_entry"("p_request_id" "uuid", "p_entry_id" "uuid", "p_reason" "text", "p_actor_key_id" "uuid") TO "authenticated";



GRANT ALL ON TABLE "public"."agent_tool_calls" TO "service_role";
GRANT SELECT ON TABLE "public"."agent_tool_calls" TO "authenticated";



GRANT ALL ON TABLE "public"."api_keys" TO "anon";
GRANT ALL ON TABLE "public"."api_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."api_keys" TO "service_role";



GRANT ALL ON TABLE "public"."billing_policies" TO "service_role";
GRANT SELECT,INSERT ON TABLE "public"."billing_policies" TO "authenticated";



GRANT ALL ON TABLE "public"."business_members" TO "anon";
GRANT ALL ON TABLE "public"."business_members" TO "authenticated";
GRANT ALL ON TABLE "public"."business_members" TO "service_role";



GRANT ALL ON TABLE "public"."client_contacts" TO "anon";
GRANT ALL ON TABLE "public"."client_contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."client_contacts" TO "service_role";



GRANT ALL ON TABLE "public"."clients" TO "anon";
GRANT ALL ON TABLE "public"."clients" TO "authenticated";
GRANT ALL ON TABLE "public"."clients" TO "service_role";



GRANT SELECT,TRIGGER,MAINTAIN ON TABLE "public"."client_financials" TO "authenticated";
GRANT ALL ON TABLE "public"."client_financials" TO "service_role";



GRANT ALL ON TABLE "public"."email_deliveries" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."email_deliveries" TO "authenticated";



GRANT ALL ON TABLE "public"."engagement_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."engagement_entries" TO "service_role";



GRANT ALL ON TABLE "public"."engagements" TO "authenticated";
GRANT ALL ON TABLE "public"."engagements" TO "service_role";



GRANT SELECT,TRIGGER,MAINTAIN ON TABLE "public"."engagement_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."engagement_summary" TO "service_role";



GRANT ALL ON TABLE "public"."estimate_line_items" TO "anon";
GRANT ALL ON TABLE "public"."estimate_line_items" TO "authenticated";
GRANT ALL ON TABLE "public"."estimate_line_items" TO "service_role";



GRANT ALL ON TABLE "public"."estimates" TO "anon";
GRANT ALL ON TABLE "public"."estimates" TO "authenticated";
GRANT ALL ON TABLE "public"."estimates" TO "service_role";



GRANT ALL ON TABLE "public"."expenses" TO "anon";
GRANT ALL ON TABLE "public"."expenses" TO "authenticated";
GRANT ALL ON TABLE "public"."expenses" TO "service_role";



GRANT ALL ON TABLE "public"."invoice_line_items" TO "anon";
GRANT ALL ON TABLE "public"."invoice_line_items" TO "authenticated";
GRANT ALL ON TABLE "public"."invoice_line_items" TO "service_role";



GRANT ALL ON TABLE "public"."items" TO "anon";
GRANT ALL ON TABLE "public"."items" TO "authenticated";
GRANT ALL ON TABLE "public"."items" TO "service_role";



GRANT ALL ON TABLE "public"."oauth_authorization_codes" TO "service_role";



GRANT ALL ON TABLE "public"."oauth_clients" TO "service_role";



GRANT ALL ON TABLE "public"."oauth_refresh_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."onboarding_state" TO "anon";
GRANT ALL ON TABLE "public"."onboarding_state" TO "authenticated";
GRANT ALL ON TABLE "public"."onboarding_state" TO "service_role";



GRANT ALL ON TABLE "public"."operation_receipts" TO "anon";
GRANT ALL ON TABLE "public"."operation_receipts" TO "authenticated";
GRANT ALL ON TABLE "public"."operation_receipts" TO "service_role";



GRANT ALL ON TABLE "public"."payment_audit" TO "service_role";
GRANT SELECT ON TABLE "public"."payment_audit" TO "authenticated";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."rate_limit_counters" TO "service_role";



GRANT ALL ON TABLE "public"."stripe_events" TO "service_role";



GRANT ALL ON TABLE "public"."task_events" TO "service_role";
GRANT SELECT ON TABLE "public"."task_events" TO "authenticated";



GRANT ALL ON TABLE "public"."task_usage" TO "service_role";
GRANT SELECT ON TABLE "public"."task_usage" TO "authenticated";



GRANT ALL ON TABLE "public"."time_entries" TO "anon";
GRANT ALL ON TABLE "public"."time_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."time_entries" TO "service_role";



GRANT ALL ON TABLE "public"."work_tasks" TO "service_role";
GRANT SELECT ON TABLE "public"."work_tasks" TO "authenticated";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";








-- Auth: the trigger that creates a profile row for each new user.
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
-- Storage: buckets.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES ('logos', 'logos', 't', NULL, NULL) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES ('receipts', 'receipts', 'f', NULL, NULL) ON CONFLICT (id) DO NOTHING;
-- Storage: object policies.
CREATE POLICY "Members can insert receipts to their business folder" ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'receipts'::text) AND (owner = auth.uid()) AND (((storage.foldername(name))[1])::uuid IN ( SELECT business_members.business_id
   FROM public.business_members
  WHERE (business_members.user_id = auth.uid())))));
CREATE POLICY "Members can update logos in their business folder" ON storage.objects AS PERMISSIVE FOR UPDATE TO authenticated USING (((bucket_id = 'logos'::text) AND (owner = auth.uid()) AND (((storage.foldername(name))[1])::uuid IN ( SELECT business_members.business_id
   FROM public.business_members
  WHERE (business_members.user_id = auth.uid()))))) WITH CHECK (((bucket_id = 'logos'::text) AND (owner = auth.uid()) AND (((storage.foldername(name))[1])::uuid IN ( SELECT business_members.business_id
   FROM public.business_members
  WHERE (business_members.user_id = auth.uid())))));
CREATE POLICY "Members can upload logos to their business folder" ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'logos'::text) AND (owner = auth.uid()) AND (((storage.foldername(name))[1])::uuid IN ( SELECT business_members.business_id
   FROM public.business_members
  WHERE (business_members.user_id = auth.uid())))));
CREATE POLICY "Owners can delete their receipts" ON storage.objects AS PERMISSIVE FOR DELETE TO authenticated USING (((bucket_id = 'receipts'::text) AND (owner = auth.uid())));
CREATE POLICY "Owners can read their receipts" ON storage.objects AS PERMISSIVE FOR SELECT TO authenticated USING (((bucket_id = 'receipts'::text) AND (owner = auth.uid())));
CREATE POLICY "Owners can update their receipts" ON storage.objects AS PERMISSIVE FOR UPDATE TO authenticated USING (((bucket_id = 'receipts'::text) AND (owner = auth.uid()))) WITH CHECK (((bucket_id = 'receipts'::text) AND (owner = auth.uid())));

-- Privileges, stated explicitly. Supabase grants every new function and
-- table to anon and authenticated by default, so each object below first
-- loses every grant and then gets back exactly what it needs.
REVOKE ALL ON FUNCTION public.allocate_document_number(uuid,text) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.allocate_document_number(uuid,text) TO authenticated; GRANT EXECUTE ON FUNCTION public.allocate_document_number(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.consume_rate_limit(text,integer,integer,integer) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.consume_rate_limit(text,integer,integer,integer) TO service_role;
REVOKE ALL ON FUNCTION public.convert_estimate_to_engagement(uuid,uuid,text,jsonb,integer,uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.convert_estimate_to_engagement(uuid,uuid,text,jsonb,integer,uuid) TO authenticated; GRANT EXECUTE ON FUNCTION public.convert_estimate_to_engagement(uuid,uuid,text,jsonb,integer,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.convert_estimate_to_invoice(uuid,text,date,date,jsonb,numeric,numeric,text,uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.convert_estimate_to_invoice(uuid,text,date,date,jsonb,numeric,numeric,text,uuid) TO authenticated; GRANT EXECUTE ON FUNCTION public.convert_estimate_to_invoice(uuid,text,date,date,jsonb,numeric,numeric,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.create_business_with_owner(text,text) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.create_business_with_owner(text,text) TO authenticated; GRANT EXECUTE ON FUNCTION public.create_business_with_owner(text,text) TO service_role;
REVOKE ALL ON FUNCTION public.create_engagement_with_schedule(uuid,uuid,uuid,text,numeric,text,text,jsonb,integer,text,date,date,text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.create_engagement_with_schedule(uuid,uuid,uuid,text,numeric,text,text,jsonb,integer,text,date,date,text,uuid,uuid) TO authenticated; GRANT EXECUTE ON FUNCTION public.create_engagement_with_schedule(uuid,uuid,uuid,text,numeric,text,text,jsonb,integer,text,date,date,text,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.create_estimate_document(uuid,uuid,jsonb,jsonb,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.create_estimate_document(uuid,uuid,jsonb,jsonb,uuid,uuid) TO authenticated; GRANT EXECUTE ON FUNCTION public.create_estimate_document(uuid,uuid,jsonb,jsonb,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.create_invoice_document(uuid,uuid,jsonb,jsonb,uuid,uuid[],uuid[],uuid,uuid[]) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.create_invoice_document(uuid,uuid,jsonb,jsonb,uuid,uuid[],uuid[],uuid,uuid[]) TO authenticated; GRANT EXECUTE ON FUNCTION public.create_invoice_document(uuid,uuid,jsonb,jsonb,uuid,uuid[],uuid[],uuid,uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.create_work_entry_once(uuid,text,jsonb,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.create_work_entry_once(uuid,text,jsonb,uuid,uuid) TO authenticated; GRANT EXECUTE ON FUNCTION public.create_work_entry_once(uuid,text,jsonb,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.dashboard_summary(uuid,text) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.dashboard_summary(uuid,text) TO authenticated; GRANT EXECUTE ON FUNCTION public.dashboard_summary(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.engagement_payload(uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.engagement_payload(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.engagement_schedule_balances() FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.engagement_schedule_balances() TO service_role;
REVOKE ALL ON FUNCTION public.expand_engagement_schedule(text,numeric,jsonb,integer) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.expand_engagement_schedule(text,numeric,jsonb,integer) TO authenticated; GRANT EXECUTE ON FUNCTION public.expand_engagement_schedule(text,numeric,jsonb,integer) TO service_role;
REVOKE ALL ON FUNCTION public.generate_public_id() FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.generate_public_id() TO authenticated; GRANT EXECUTE ON FUNCTION public.generate_public_id() TO service_role;
REVOKE ALL ON FUNCTION public.get_agent_activity(uuid[],integer,timestamp with time zone,uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.get_agent_activity(uuid[],integer,timestamp with time zone,uuid) TO authenticated; GRANT EXECUTE ON FUNCTION public.get_agent_activity(uuid[],integer,timestamp with time zone,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.get_public_estimate(text) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.get_public_estimate(text) TO anon; GRANT EXECUTE ON FUNCTION public.get_public_estimate(text) TO authenticated; GRANT EXECUTE ON FUNCTION public.get_public_estimate(text) TO service_role;
REVOKE ALL ON FUNCTION public.get_public_invoice(text) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.get_public_invoice(text) TO PUBLIC; GRANT EXECUTE ON FUNCTION public.get_public_invoice(text) TO anon; GRANT EXECUTE ON FUNCTION public.get_public_invoice(text) TO authenticated; GRANT EXECUTE ON FUNCTION public.get_public_invoice(text) TO service_role;
REVOKE ALL ON FUNCTION public.get_report_summary(uuid,date,date,date,date,text,text,integer) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.get_report_summary(uuid,date,date,date,date,text,text,integer) TO authenticated; GRANT EXECUTE ON FUNCTION public.get_report_summary(uuid,date,date,date,date,text,text,integer) TO service_role;
REVOKE ALL ON FUNCTION public.guard_api_key_columns() FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.guard_api_key_columns() TO service_role;
REVOKE ALL ON FUNCTION public.guard_document_client() FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.guard_document_client() TO service_role;
REVOKE ALL ON FUNCTION public.guard_document_delete() FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.guard_document_delete() TO service_role;
REVOKE ALL ON FUNCTION public.guard_engagement_entry() FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.guard_engagement_entry() TO service_role;
REVOKE ALL ON FUNCTION public.guard_payment_amount() FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.guard_payment_amount() TO service_role;
REVOKE ALL ON FUNCTION public.guard_payment_relations() FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.guard_payment_relations() TO service_role;
REVOKE ALL ON FUNCTION public.guard_stripe_invoice_fields() FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.guard_stripe_invoice_fields() TO service_role;
REVOKE ALL ON FUNCTION public.guard_stripe_payment_fields() FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.guard_stripe_payment_fields() TO service_role;
REVOKE ALL ON FUNCTION public.guard_task_key() FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.guard_task_key() TO service_role;
REVOKE ALL ON FUNCTION public.guard_work_currency() FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.guard_work_currency() TO service_role;
REVOKE ALL ON FUNCTION public.guard_work_entry() FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.guard_work_entry() TO service_role;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
REVOKE ALL ON FUNCTION public.mark_entry_complete(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.mark_entry_complete(uuid,uuid,uuid) TO authenticated; GRANT EXECUTE ON FUNCTION public.mark_entry_complete(uuid,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.peek_rate_limit(text,integer,integer) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.peek_rate_limit(text,integer,integer) TO service_role;
REVOKE ALL ON FUNCTION public.promote_due_entries(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.promote_due_entries(uuid,uuid) TO authenticated; GRANT EXECUTE ON FUNCTION public.promote_due_entries(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.prune_rate_limit_counters(integer) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.prune_rate_limit_counters(integer) TO service_role;
REVOKE ALL ON FUNCTION public.public_business_snapshot(jsonb) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.public_business_snapshot(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.public_client_snapshot(jsonb) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.public_client_snapshot(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.recompute_invoice_money(uuid,date) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.recompute_invoice_money(uuid,date) TO authenticated; GRANT EXECUTE ON FUNCTION public.recompute_invoice_money(uuid,date) TO service_role;
REVOKE ALL ON FUNCTION public.record_invoice_payment(uuid,numeric,date,text,text,text,text,uuid,text) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.record_invoice_payment(uuid,numeric,date,text,text,text,text,uuid,text) TO authenticated; GRANT EXECUTE ON FUNCTION public.record_invoice_payment(uuid,numeric,date,text,text,text,text,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.record_payment_once(uuid,numeric,date,uuid,text,text,text,text,uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.record_payment_once(uuid,numeric,date,uuid,text,text,text,text,uuid) TO authenticated; GRANT EXECUTE ON FUNCTION public.record_payment_once(uuid,numeric,date,uuid,text,text,text,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.record_stripe_payment(uuid,numeric,date,text,text) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.record_stripe_payment(uuid,numeric,date,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.release_draft_invoice_claims() FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.release_draft_invoice_claims() TO service_role;
REVOKE ALL ON FUNCTION public.replace_estimate_line_items(uuid,jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.replace_estimate_line_items(uuid,jsonb,jsonb) TO authenticated; GRANT EXECUTE ON FUNCTION public.replace_estimate_line_items(uuid,jsonb,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.replace_invoice_line_items(uuid,jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.replace_invoice_line_items(uuid,jsonb,jsonb) TO authenticated; GRANT EXECUTE ON FUNCTION public.replace_invoice_line_items(uuid,jsonb,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.resolve_engagement_actor(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.resolve_engagement_actor(uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.resolve_payment_actor(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.resolve_payment_actor(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.respond_to_estimate(text,text) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.respond_to_estimate(text,text) TO PUBLIC; GRANT EXECUTE ON FUNCTION public.respond_to_estimate(text,text) TO anon; GRANT EXECUTE ON FUNCTION public.respond_to_estimate(text,text) TO authenticated; GRANT EXECUTE ON FUNCTION public.respond_to_estimate(text,text) TO service_role;
REVOKE ALL ON FUNCTION public.set_engagement_status(uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.set_engagement_status(uuid,uuid,text,uuid) TO authenticated; GRANT EXECUTE ON FUNCTION public.set_engagement_status(uuid,uuid,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.sync_invoice_payment_ledger(uuid,text) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.sync_invoice_payment_ledger(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.task_operation(uuid,uuid,text,jsonb,uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.task_operation(uuid,uuid,text,jsonb,uuid) TO authenticated; GRANT EXECUTE ON FUNCTION public.task_operation(uuid,uuid,text,jsonb,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.update_engagement(uuid,uuid,text,date,date,text,uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.update_engagement(uuid,uuid,text,date,date,text,uuid) TO authenticated; GRANT EXECUTE ON FUNCTION public.update_engagement(uuid,uuid,text,date,date,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.update_payment(uuid,text,date,text,text,text,numeric,uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.update_payment(uuid,text,date,text,text,text,numeric,uuid) TO authenticated; GRANT EXECUTE ON FUNCTION public.update_payment(uuid,text,date,text,text,text,numeric,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.update_updated_at() FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.update_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.user_has_business_access(uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.user_has_business_access(uuid) TO PUBLIC; GRANT EXECUTE ON FUNCTION public.user_has_business_access(uuid) TO anon; GRANT EXECUTE ON FUNCTION public.user_has_business_access(uuid) TO authenticated; GRANT EXECUTE ON FUNCTION public.user_has_business_access(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.user_is_business_admin(uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.user_is_business_admin(uuid) TO PUBLIC; GRANT EXECUTE ON FUNCTION public.user_is_business_admin(uuid) TO anon; GRANT EXECUTE ON FUNCTION public.user_is_business_admin(uuid) TO authenticated; GRANT EXECUTE ON FUNCTION public.user_is_business_admin(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.void_payment(uuid,text,text,uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.void_payment(uuid,text,text,uuid) TO authenticated; GRANT EXECUTE ON FUNCTION public.void_payment(uuid,text,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.waive_entry(uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated, service_role; GRANT EXECUTE ON FUNCTION public.waive_entry(uuid,uuid,text,uuid) TO authenticated; GRANT EXECUTE ON FUNCTION public.waive_entry(uuid,uuid,text,uuid) TO service_role;
REVOKE ALL ON TABLE public.agent_tool_calls FROM PUBLIC, anon, authenticated, service_role; GRANT SELECT ON TABLE public.agent_tool_calls TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.agent_tool_calls TO service_role;
REVOKE ALL ON TABLE public.api_keys FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.api_keys TO anon; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.api_keys TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.api_keys TO service_role;
REVOKE ALL ON TABLE public.billing_policies FROM PUBLIC, anon, authenticated, service_role; GRANT INSERT, SELECT ON TABLE public.billing_policies TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.billing_policies TO service_role;
REVOKE ALL ON TABLE public.business_members FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.business_members TO anon; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.business_members TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.business_members TO service_role;
REVOKE ALL ON TABLE public.businesses FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.businesses TO anon; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.businesses TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.businesses TO service_role;
REVOKE ALL ON TABLE public.client_contacts FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.client_contacts TO anon; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.client_contacts TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.client_contacts TO service_role;
REVOKE ALL ON TABLE public.client_financials FROM PUBLIC, anon, authenticated, service_role; GRANT MAINTAIN, SELECT, TRIGGER ON TABLE public.client_financials TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.client_financials TO service_role;
REVOKE ALL ON TABLE public.clients FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.clients TO anon; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.clients TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.clients TO service_role;
REVOKE ALL ON TABLE public.email_deliveries FROM PUBLIC, anon, authenticated, service_role; GRANT INSERT, SELECT, UPDATE ON TABLE public.email_deliveries TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.email_deliveries TO service_role;
REVOKE ALL ON TABLE public.engagement_entries FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.engagement_entries TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.engagement_entries TO service_role;
REVOKE ALL ON TABLE public.engagement_summary FROM PUBLIC, anon, authenticated, service_role; GRANT MAINTAIN, SELECT, TRIGGER ON TABLE public.engagement_summary TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.engagement_summary TO service_role;
REVOKE ALL ON TABLE public.engagements FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.engagements TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.engagements TO service_role;
REVOKE ALL ON TABLE public.estimate_line_items FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.estimate_line_items TO anon; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.estimate_line_items TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.estimate_line_items TO service_role;
REVOKE ALL ON TABLE public.estimates FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.estimates TO anon; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.estimates TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.estimates TO service_role;
REVOKE ALL ON TABLE public.expenses FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.expenses TO anon; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.expenses TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.expenses TO service_role;
REVOKE ALL ON TABLE public.invoice_line_items FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.invoice_line_items TO anon; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.invoice_line_items TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.invoice_line_items TO service_role;
REVOKE ALL ON TABLE public.invoices FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.invoices TO anon; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.invoices TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.invoices TO service_role;
REVOKE ALL ON TABLE public.items FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.items TO anon; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.items TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.items TO service_role;
REVOKE ALL ON TABLE public.oauth_authorization_codes FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.oauth_authorization_codes TO service_role;
REVOKE ALL ON TABLE public.oauth_clients FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.oauth_clients TO service_role;
REVOKE ALL ON TABLE public.oauth_refresh_tokens FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.oauth_refresh_tokens TO service_role;
REVOKE ALL ON TABLE public.onboarding_state FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.onboarding_state TO anon; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.onboarding_state TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.onboarding_state TO service_role;
REVOKE ALL ON TABLE public.operation_receipts FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.operation_receipts TO anon; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.operation_receipts TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.operation_receipts TO service_role;
REVOKE ALL ON TABLE public.payment_audit FROM PUBLIC, anon, authenticated, service_role; GRANT SELECT ON TABLE public.payment_audit TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.payment_audit TO service_role;
REVOKE ALL ON TABLE public.payments FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.payments TO anon; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.payments TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.payments TO service_role;
REVOKE ALL ON TABLE public.profiles FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.profiles TO anon; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.profiles TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.profiles TO service_role;
REVOKE ALL ON TABLE public.rate_limit_counters FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.rate_limit_counters TO service_role;
REVOKE ALL ON TABLE public.stripe_events FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.stripe_events TO service_role;
REVOKE ALL ON TABLE public.task_events FROM PUBLIC, anon, authenticated, service_role; GRANT SELECT ON TABLE public.task_events TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.task_events TO service_role;
REVOKE ALL ON TABLE public.task_usage FROM PUBLIC, anon, authenticated, service_role; GRANT SELECT ON TABLE public.task_usage TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.task_usage TO service_role;
REVOKE ALL ON TABLE public.time_entries FROM PUBLIC, anon, authenticated, service_role; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.time_entries TO anon; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.time_entries TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.time_entries TO service_role;
REVOKE ALL ON TABLE public.work_tasks FROM PUBLIC, anon, authenticated, service_role; GRANT SELECT ON TABLE public.work_tasks TO authenticated; GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE public.work_tasks TO service_role;

-- Install accounts. Billr is an internal tool: the first account to sign up
-- owns the installation. After that the server admits a new account only when
-- it runs with BILLR_OPEN_SIGNUP=true, or when the account already belongs to
-- a business an owner added it to. create_business_with_owner refuses anyone
-- not listed here, so an account made directly against Supabase Auth gets no
-- workspace.
CREATE TABLE public.install_accounts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  admitted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.install_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.install_accounts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.install_accounts TO service_role;

CREATE FUNCTION public.install_has_account() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM public.install_accounts) $$;

-- TRUE: admitted (and recorded). FALSE: refused. NULL: no such user, which is
-- what Supabase Auth's sign-up returns for an address that already exists.
CREATE FUNCTION public.admit_install_account(p_user_id uuid, p_open boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL THEN RETURN NULL; END IF;
  -- One decision at a time, so two first sign-ups cannot both be first.
  PERFORM pg_advisory_xact_lock(hashtext('billr.install_accounts'));
  IF EXISTS (SELECT 1 FROM public.install_accounts WHERE user_id = p_user_id) THEN RETURN TRUE; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN RETURN NULL; END IF;
  IF coalesce(p_open, false)
     OR NOT EXISTS (SELECT 1 FROM public.install_accounts)
     OR EXISTS (SELECT 1 FROM public.business_members WHERE user_id = p_user_id) THEN
    INSERT INTO public.install_accounts (user_id) VALUES (p_user_id) ON CONFLICT DO NOTHING;
    RETURN TRUE;
  END IF;
  RETURN FALSE;
END $$;

REVOKE ALL ON FUNCTION public.install_has_account() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admit_install_account(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.install_has_account() TO service_role;
GRANT EXECUTE ON FUNCTION public.admit_install_account(uuid, boolean) TO service_role;
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.admit_install_account(uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.admit_install_account(uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.install_has_account()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.install_has_account()', 'EXECUTE') THEN
    RAISE EXCEPTION 'install account functions must be service-role only';
  END IF;
END $$;
