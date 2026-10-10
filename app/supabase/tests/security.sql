-- Regression assertions for the database security model. Each block reproduces
-- something an attacker or a stale client could try, and must keep failing.
BEGIN;

INSERT INTO auth.users(id,email) VALUES
 ('50000000-0000-4000-8000-000000000001','alice@security.test'),
 ('50000000-0000-4000-8000-000000000002','mallory@security.test'),
 ('50000000-0000-4000-8000-000000000003','drifter@security.test');
INSERT INTO businesses(id,name) VALUES
 ('51000000-0000-4000-8000-000000000001','Alice Co'),
 ('51000000-0000-4000-8000-000000000002','Mallory Co');
INSERT INTO business_members(business_id,user_id,role) VALUES
 ('51000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','owner'),
 ('51000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000002','owner');
INSERT INTO install_accounts(user_id) VALUES
 ('50000000-0000-4000-8000-000000000001'),
 ('50000000-0000-4000-8000-000000000002');
INSERT INTO clients(id,business_id,name,notes) VALUES
 ('52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001','Alice Client','private note');
INSERT INTO engagements(id,business_id,client_id,name,total,billing_mode,status) VALUES
 ('54000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000001','Alice Engagement',1000,'equal_installments','active');
INSERT INTO engagement_entries(id,engagement_id,business_id,position,label,amount,due_rule,status) VALUES
 ('55000000-0000-4000-8000-000000000001','54000000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000001',0,'Deposit',500,'on_start','ready_to_bill');
INSERT INTO stripe_events(id,type) VALUES ('evt_security_fixture','payment_intent.succeeded');
INSERT INTO rate_limit_counters(bucket,window_start,hits,expires_at)
 VALUES ('security-fixture',date_trunc('hour',now()),1,now()+INTERVAL '1 hour');
INSERT INTO api_keys(id,user_id,business_id,label,key_hash,key_prefix,permissions)
 VALUES ('53000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',
         '51000000-0000-4000-8000-000000000001','alice key','security-hash-alice','billr_sk_sec',ARRAY['read','write']);
-- Fixtures for line item arithmetic and public estimate status.
INSERT INTO invoices(id,business_id,client_id,invoice_number,status,issue_date,due_date,
                     currency,subtotal,total,balance_due) VALUES
 ('56000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000001','INV-9001','draft',CURRENT_DATE,CURRENT_DATE+30,'USD',0,0,0),
 ('56000000-0000-4000-8000-000000000002','51000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000001','INV-9002','draft',CURRENT_DATE,CURRENT_DATE+30,'USD',1000,1000,1000);
-- Issued after the fact, because guard_document_client only freezes the money
-- once the document has left draft.
UPDATE invoices SET status='sent' WHERE id='56000000-0000-4000-8000-000000000002';
INSERT INTO estimates(id,public_id,business_id,client_id,estimate_number,status,total) VALUES
 ('57000000-0000-4000-8000-000000000001','pub0000000000000000000000000001',
  '51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001','EST-9001','sent',500),
 ('57000000-0000-4000-8000-000000000002','pub0000000000000000000000000002',
  '51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001','EST-9002','declined',500),
 ('57000000-0000-4000-8000-000000000003','pub0000000000000000000000000003',
  '51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001','EST-9003','expired',500);

-- ---------------------------------------------------------------------------
-- Structural assertions, evaluated as the migration owner.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_bad TEXT;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAILED: tables without RLS: %', v_bad;
  END IF;

  -- Only the three public document RPCs, and the two helpers that RLS policies call as the querying role.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
     AND p.proname NOT IN ('get_public_invoice','get_public_estimate','respond_to_estimate',
                           'user_has_business_access','user_is_business_admin');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAILED: anon can execute %', v_bad;
  END IF;

  -- Every function in public pins its search_path, definer or not.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND 'search_path=public, pg_temp' <> ALL(COALESCE(p.proconfig, ARRAY['(none)']));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAILED: unpinned search_path on %', v_bad;
  END IF;

  -- No client role reaches a server-only table.
  SELECT string_agg(t || '/' || r, ', ') INTO v_bad
    FROM unnest(ARRAY['stripe_events','rate_limit_counters','oauth_clients',
                      'oauth_authorization_codes','oauth_refresh_tokens','install_accounts']) t
    CROSS JOIN unnest(ARRAY['anon','authenticated']) r
   WHERE has_table_privilege(r, ('public.'||t)::regclass, 'SELECT')
      OR has_table_privilege(r, ('public.'||t)::regclass, 'INSERT')
      OR has_table_privilege(r, ('public.'||t)::regclass, 'UPDATE')
      OR has_table_privilege(r, ('public.'||t)::regclass, 'DELETE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAILED: server-only tables granted: %', v_bad;
  END IF;

  -- The public snapshot projections stay allow-lists. A column added to
  -- businesses or clients must never widen the public payload.
  IF public.public_business_snapshot(
       '{"name":"Shown","tax_id":"HIDDEN","internal_note":"HIDDEN","schedule_templates":[{"key":"HIDDEN"}],"next_invoice_number":42}'::JSONB)
     <> '{"name":"Shown"}'::JSONB THEN
    RAISE EXCEPTION 'TEST FAILED: business snapshot leaked a private key';
  END IF;
  IF public.public_client_snapshot(
       '{"name":"Shown","notes":"HIDDEN","business_id":"HIDDEN","total_paid":99,
         "outstanding_balance":1,"tax_id":"HIDDEN"}'::JSONB)
     <> '{"name":"Shown"}'::JSONB THEN
    RAISE EXCEPTION 'TEST FAILED: client snapshot leaked a private key';
  END IF;

  -- payments corrections stay RPC-only, business creation stays RPC-only.
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.payments'::regclass AND polcmd IN ('w','d','*')) THEN
    RAISE EXCEPTION 'TEST FAILED: payments carries an UPDATE/DELETE/ALL policy';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.businesses'::regclass AND polcmd IN ('a','*')) THEN
    RAISE EXCEPTION 'TEST FAILED: businesses carries an INSERT/ALL policy';
  END IF;

  -- The logo UPDATE policy must constrain the object path, not just the owner.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname = 'objects' AND p.polcmd = 'w'
       AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%business_members%'
       AND pg_get_expr(p.polqual, p.polrelid) LIKE '%business_members%'
       AND pg_get_expr(p.polqual, p.polrelid) LIKE '%logos%'
  ) THEN
    RAISE EXCEPTION 'TEST FAILED: the logos UPDATE policy lost its folder scoping';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- As anon: nothing but the public document RPCs.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims','{"role":"anon"}',true);
SELECT set_config('request.jwt.claim.role','anon',true);
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM stripe_events;
    RAISE EXCEPTION 'TEST FAILED: anon read stripe_events';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    DELETE FROM stripe_events;
    RAISE EXCEPTION 'TEST FAILED: anon deleted stripe_events';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    INSERT INTO stripe_events(id,type) VALUES ('evt_forged','x');
    RAISE EXCEPTION 'TEST FAILED: anon forged a stripe event';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    PERFORM 1 FROM rate_limit_counters;
    RAISE EXCEPTION 'TEST FAILED: anon read rate_limit_counters';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    INSERT INTO businesses(name) VALUES ('anon business');
    RAISE EXCEPTION 'TEST FAILED: anon created a business row';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    PERFORM public.create_business_with_owner('anon business','a@b.test');
    RAISE EXCEPTION 'TEST FAILED: anon called create_business_with_owner';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    PERFORM public.get_report_summary('51000000-0000-4000-8000-000000000001',CURRENT_DATE-30,CURRENT_DATE);
    RAISE EXCEPTION 'TEST FAILED: anon called get_report_summary';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- As Alice: the ledger may only grow through the RPCs, and only upwards.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"50000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SELECT set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
DO $$
DECLARE
  b UUID := '51000000-0000-4000-8000-000000000001';
  c UUID := '52000000-0000-4000-8000-000000000001';
  inv JSONB; v_invoice UUID; v_payment UUID; v_key UUID := '53000000-0000-4000-8000-000000000001';
  v_hash TEXT; v_perms TEXT[]; v_expires TIMESTAMPTZ;
BEGIN
  inv := create_invoice_document(b,c,'{}','[{"description":"Work","quantity":1,"rate":100}]',gen_random_uuid());
  v_invoice := (inv->>'id')::UUID;
  UPDATE invoices SET status='sent' WHERE id=v_invoice;
  PERFORM record_payment_once(v_invoice,40,CURRENT_DATE,gen_random_uuid());
  SELECT id INTO v_payment FROM payments WHERE invoice_id=v_invoice;

  -- record_invoice_payment is granted to authenticated and only checks that the
  -- amount is non-zero, so the sign rule has to live on the table.
  BEGIN
    PERFORM record_invoice_payment(v_invoice,-25,CURRENT_DATE);
    RAISE EXCEPTION 'TEST FAILED: a client role posted a negative payment';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF; END;

  BEGIN
    INSERT INTO payments(business_id,invoice_id,client_id,amount,currency,payment_date)
    SELECT business_id,id,client_id,-25,currency,CURRENT_DATE FROM invoices WHERE id=v_invoice;
    RAISE EXCEPTION 'TEST FAILED: a direct negative payment was accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF; END;

  -- Corrections must go through update_payment / void_payment, which write
  -- payment_audit. A direct UPDATE or DELETE has no policy and matches nothing.
  UPDATE payments SET amount=1 WHERE id=v_payment;
  IF (SELECT amount FROM payments WHERE id=v_payment) <> 40 THEN
    RAISE EXCEPTION 'TEST FAILED: a payment was edited outside update_payment';
  END IF;
  DELETE FROM payments WHERE id=v_payment;
  IF NOT EXISTS (SELECT 1 FROM payments WHERE id=v_payment) THEN
    RAISE EXCEPTION 'TEST FAILED: a payment was deleted outside void_payment';
  END IF;

  -- The sanctioned corrections still work and still leave an audit row.
  PERFORM void_payment(v_payment,'sec-void','wrong invoice');
  IF NOT EXISTS (SELECT 1 FROM payment_audit WHERE payment_id=v_payment AND action='void') THEN
    RAISE EXCEPTION 'TEST FAILED: void_payment stopped writing payment_audit';
  END IF;

  -- Dropping the payments DELETE policy must not have touched anything else:
  -- an unpaid draft is still deletable.
  inv := create_invoice_document(b,c,'{}','[{"description":"Draft","quantity":1,"rate":10}]',gen_random_uuid());
  DELETE FROM invoices WHERE id=(inv->>'id')::UUID;
  IF EXISTS (SELECT 1 FROM invoices WHERE id=(inv->>'id')::UUID) THEN
    RAISE EXCEPTION 'TEST FAILED: an unpaid draft could no longer be deleted';
  END IF;

  -- Business creation stays behind the RPC.
  BEGIN
    INSERT INTO businesses(name) VALUES ('direct');
    RAISE EXCEPTION 'TEST FAILED: a client role inserted a business row';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF; END;
  IF (create_business_with_owner('Fresh','f@example.test')).name <> 'Fresh' THEN
    RAISE EXCEPTION 'TEST FAILED: the business creation RPC did not create the business';
  END IF;

  -- API keys: self-scoped, manual, expiring, and immutable once written.
  BEGIN
    INSERT INTO api_keys(user_id,business_id,label,key_hash,key_prefix,expires_at)
    VALUES ('50000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000002',
            'cross','sec-cross','p1',now()+INTERVAL '90 days');
    RAISE EXCEPTION 'TEST FAILED: a key was scoped to another tenant';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF; END;

  BEGIN
    INSERT INTO api_keys(user_id,label,key_hash,key_prefix,kind,expires_at)
    VALUES ('50000000-0000-4000-8000-000000000001','fake oauth','sec-oauth','p2','oauth',now()+INTERVAL '90 days');
    RAISE EXCEPTION 'TEST FAILED: a client role minted an oauth token row';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF; END;

  BEGIN
    INSERT INTO api_keys(user_id,label,key_hash,key_prefix,expires_at)
    VALUES ('50000000-0000-4000-8000-000000000001','forever','sec-forever','p3',NULL);
    RAISE EXCEPTION 'TEST FAILED: a key with no expiry was accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF; END;

  SELECT key_hash,permissions,expires_at INTO v_hash,v_perms,v_expires FROM api_keys WHERE id=v_key;
  UPDATE api_keys
     SET permissions=ARRAY['read','write','send','delete','payments'],
         key_hash='attacker-chosen',
         business_id='51000000-0000-4000-8000-000000000002',
         expires_at=now()+INTERVAL '50 years'
   WHERE id=v_key;
  IF (SELECT key_hash FROM api_keys WHERE id=v_key) <> v_hash
     OR (SELECT permissions FROM api_keys WHERE id=v_key) <> v_perms
     OR (SELECT expires_at FROM api_keys WHERE id=v_key) <> v_expires
     OR (SELECT business_id FROM api_keys WHERE id=v_key) <> b THEN
    RAISE EXCEPTION 'TEST FAILED: an existing key was rewritten by its owner';
  END IF;
  -- Revoking, the one thing the app does, still works.
  UPDATE api_keys SET revoked_at=now() WHERE id=v_key;
  IF (SELECT revoked_at FROM api_keys WHERE id=v_key) IS NULL THEN
    RAISE EXCEPTION 'TEST FAILED: an owner can no longer revoke their key';
  END IF;

  -- The release-on-delete exemption in guard_engagement_entry may only be
  -- claimed from inside the invoice delete trigger. Setting the GUC by hand
  -- used to release an entry that was still on a live invoice, so the same
  -- milestone could be billed twice.
  inv := create_invoice_document(b,c,'{}','[]',gen_random_uuid(),'{}'::UUID[],'{}'::UUID[],NULL,
                                 ARRAY['55000000-0000-4000-8000-000000000001']::UUID[]);
  IF (SELECT status FROM engagement_entries WHERE id='55000000-0000-4000-8000-000000000001') <> 'invoiced' THEN
    RAISE EXCEPTION 'TEST FAILED: the engagement entry was not claimed by the invoice';
  END IF;
  PERFORM set_config('billr.releasing_invoice', (inv->>'id'), TRUE);
  BEGIN
    UPDATE engagement_entries
       SET status='ready_to_bill', invoice_id=NULL, invoice_line_id=NULL
     WHERE id='55000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'TEST FAILED: a hand-set GUC released an invoiced entry';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF; END;
  PERFORM set_config('billr.releasing_invoice', '', TRUE);
  -- Deleting the draft is still the one thing that does release it.
  DELETE FROM invoices WHERE id=(inv->>'id')::UUID;
  IF (SELECT status FROM engagement_entries WHERE id='55000000-0000-4000-8000-000000000001') <> 'ready_to_bill' THEN
    RAISE EXCEPTION 'TEST FAILED: deleting the draft no longer releases its entry';
  END IF;
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- As Mallory: another tenant's ids answer exactly like ids that do not exist.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"50000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
SELECT set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000002',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
DO $$
DECLARE
  -- Alice's entry, named directly: RLS hides it from this session, which is
  -- exactly the point. The id is only a probe.
  v_entry UUID := '55000000-0000-4000-8000-000000000001';
  v_real TEXT; v_fake TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM engagement_entries WHERE id=v_entry) THEN
    RAISE EXCEPTION 'TEST FAILED: another tenant''s engagement entry is visible';
  END IF;

  BEGIN PERFORM mark_entry_complete(gen_random_uuid(), v_entry);
  EXCEPTION WHEN OTHERS THEN v_real := SQLERRM; END;
  BEGIN PERFORM mark_entry_complete(gen_random_uuid(), gen_random_uuid());
  EXCEPTION WHEN OTHERS THEN v_fake := SQLERRM; END;
  IF v_real IS DISTINCT FROM v_fake THEN
    RAISE EXCEPTION 'TEST FAILED: mark_entry_complete is an existence oracle (% vs %)', v_real, v_fake;
  END IF;

  BEGIN PERFORM waive_entry(gen_random_uuid(), v_entry, 'reason');
  EXCEPTION WHEN OTHERS THEN v_real := SQLERRM; END;
  BEGIN PERFORM waive_entry(gen_random_uuid(), gen_random_uuid(), 'reason');
  EXCEPTION WHEN OTHERS THEN v_fake := SQLERRM; END;
  IF v_real IS DISTINCT FROM v_fake THEN
    RAISE EXCEPTION 'TEST FAILED: waive_entry is an existence oracle (% vs %)', v_real, v_fake;
  END IF;

  -- Nothing of Alice's is visible or writable.
  IF EXISTS (SELECT 1 FROM clients WHERE business_id='51000000-0000-4000-8000-000000000001')
     OR EXISTS (SELECT 1 FROM invoices WHERE business_id='51000000-0000-4000-8000-000000000001')
     OR EXISTS (SELECT 1 FROM payments WHERE business_id='51000000-0000-4000-8000-000000000001')
     OR EXISTS (SELECT 1 FROM api_keys WHERE key_prefix='billr_sk_sec')
     OR EXISTS (SELECT 1 FROM businesses WHERE id='51000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'TEST FAILED: another tenant''s rows are visible';
  END IF;

  BEGIN
    INSERT INTO business_members(business_id,user_id,role)
    VALUES ('51000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002','owner');
    RAISE EXCEPTION 'TEST FAILED: a user joined a business they do not belong to';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF; END;

  BEGIN
    PERFORM 1 FROM stripe_events;
    RAISE EXCEPTION 'TEST FAILED: authenticated read stripe_events';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- replace_invoice_line_items derives the money.
-- As Alice, who owns the invoice: this is not a tenancy test, it is an
-- arithmetic one. Each block tries to write money the lines do not add up to.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"50000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SELECT set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
DO $$
DECLARE
  v_draft UUID := '56000000-0000-4000-8000-000000000001';
  v_sent UUID := '56000000-0000-4000-8000-000000000002';
  v_amount NUMERIC; v_total NUMERIC; v_discount NUMERIC; v_count INTEGER;
BEGIN
  -- A line that says 10 x 100 but claims an amount of 3, under a claimed
  -- total of 12. Both lies are now overwritten by the derived figures.
  PERFORM replace_invoice_line_items(
    v_draft,
    '[{"description":"Consulting","quantity":10,"rate":100,"amount":3,"discount_percent":0}]'::JSONB,
    '{"subtotal":12,"total":12,"tax_rate":0,"shipping_amount":0,"discount_type":"percentage","discount_value":0}'::JSONB);
  SELECT amount INTO v_amount FROM invoice_line_items WHERE invoice_id=v_draft;
  SELECT total INTO v_total FROM invoices WHERE id=v_draft;
  IF v_amount <> 1000 THEN
    RAISE EXCEPTION 'TEST FAILED: line amount was taken from the caller (%)', v_amount;
  END IF;
  IF v_total <> 1000 THEN
    RAISE EXCEPTION 'TEST FAILED: invoice total was taken from the caller (%)', v_total;
  END IF;

  -- A per-line discount is derived from the percentage, not supplied.
  PERFORM replace_invoice_line_items(
    v_draft,
    '[{"description":"Consulting","quantity":10,"rate":100,"amount":1000,"discount_percent":10,"discount_amount":999}]'::JSONB,
    '{"tax_rate":0,"shipping_amount":0,"discount_type":"percentage","discount_value":0}'::JSONB);
  SELECT amount, discount_amount INTO v_amount, v_discount
    FROM invoice_line_items WHERE invoice_id=v_draft;
  SELECT total INTO v_total FROM invoices WHERE id=v_draft;
  IF v_amount <> 900 OR v_discount <> 100 OR v_total <> 900 THEN
    RAISE EXCEPTION 'TEST FAILED: per-line discount arithmetic (% / % / %)', v_amount, v_discount, v_total;
  END IF;

  -- Negative quantity, negative rate and an out of range percentage are all
  -- refused, and the refusal happens before anything is deleted.
  BEGIN
    PERFORM replace_invoice_line_items(v_draft,
      '[{"description":"Credit","quantity":-5,"rate":100}]'::JSONB, '{}'::JSONB);
    RAISE EXCEPTION 'TEST FAILED: a negative quantity was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM replace_invoice_line_items(v_draft,
      '[{"description":"Credit","quantity":5,"rate":-100}]'::JSONB, '{}'::JSONB);
    RAISE EXCEPTION 'TEST FAILED: a negative rate was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM replace_invoice_line_items(v_draft,
      '[{"description":"Huge","quantity":99999999,"rate":99999999}]'::JSONB, '{}'::JSONB);
    RAISE EXCEPTION 'TEST FAILED: an unbounded line was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM replace_invoice_line_items(v_draft,
      '[{"description":"Off","quantity":1,"rate":100,"discount_percent":150}]'::JSONB, '{}'::JSONB);
    RAISE EXCEPTION 'TEST FAILED: a discount over 100 percent was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF;
  END;

  SELECT count(*), max(amount) INTO v_count, v_amount
    FROM invoice_line_items WHERE invoice_id=v_draft;
  IF v_count <> 1 OR v_amount <> 900 THEN
    RAISE EXCEPTION 'TEST FAILED: a refused save still changed the line items (% rows)', v_count;
  END IF;

  -- The recomputed total is what makes this bite on an issued invoice:
  -- rewriting its lines moves its total, and guard_document_client refuses
  -- a total change on a non-draft document.
  BEGIN
    PERFORM replace_invoice_line_items(v_sent,
      '[{"description":"Rewritten","quantity":1,"rate":50}]'::JSONB,
      '{"tax_rate":0,"shipping_amount":0,"discount_type":"percentage","discount_value":0}'::JSONB);
    RAISE EXCEPTION 'TEST FAILED: an issued invoice was re-priced through its line items';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF;
  END;
  SELECT total INTO v_total FROM invoices WHERE id=v_sent;
  IF v_total <> 1000 THEN
    RAISE EXCEPTION 'TEST FAILED: the issued invoice total moved (%)', v_total;
  END IF;
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- get_public_estimate does not serve a declined or expired quote to anybody
-- holding the link.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE anon;
DO $$
BEGIN
  IF get_public_estimate('pub0000000000000000000000000001') IS NULL THEN
    RAISE EXCEPTION 'TEST FAILED: a sent estimate is no longer publicly readable';
  END IF;
  IF get_public_estimate('pub0000000000000000000000000002') IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAILED: a declined estimate is still publicly readable';
  END IF;
  IF get_public_estimate('pub0000000000000000000000000003') IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAILED: an expired estimate is still publicly readable';
  END IF;
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- An account that belongs to no business cannot create an API key, not even
-- one with no business scope. A member still can.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"50000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000003',true);
DO $$
BEGIN
  BEGIN
    INSERT INTO api_keys(user_id,label,key_hash,key_prefix,expires_at)
    VALUES ('50000000-0000-4000-8000-000000000003','stray','sec-stray','p5',now()+INTERVAL '90 days');
    RAISE EXCEPTION 'TEST FAILED: an account with no business created an API key';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF; END;
END $$;
SELECT set_config('request.jwt.claims','{"sub":"50000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SELECT set_config('request.jwt.claim.sub','50000000-0000-4000-8000-000000000001',true);
INSERT INTO api_keys(user_id,label,key_hash,key_prefix,expires_at)
 VALUES ('50000000-0000-4000-8000-000000000001','member key','sec-member','p6',now()+INTERVAL '90 days');
RESET ROLE;

ROLLBACK;
