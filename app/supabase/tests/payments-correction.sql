-- Payment corrections: update_payment and void_payment.
--
-- The bug this exists for: an agent backfilled already-paid invoices with
-- payment_date set to the day of the backfill, so every one of those payments
-- landed in one month of the revenue report. The first block below is exactly
-- that recovery, asserted end to end: move the date, watch the month move.
BEGIN;
INSERT INTO auth.users(id,email) VALUES
 ('10000000-0000-4000-8000-000000000001','owner@example.test'),
 ('10000000-0000-4000-8000-000000000002','other@example.test');
INSERT INTO businesses(id,name) VALUES
 ('20000000-0000-4000-8000-000000000001','Test business'),
 ('20000000-0000-4000-8000-000000000002','Other business');
INSERT INTO business_members(business_id,user_id,role) VALUES
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','owner'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','owner');
INSERT INTO clients(id,business_id,name) VALUES
 ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Client'),
 ('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','Other client');
INSERT INTO api_keys(id,user_id,business_id,label,key_hash,permissions) VALUES
 ('50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Agent','hash-agent',ARRAY['read','write','payments']),
 ('50000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Reader','hash-reader',ARRAY['read']);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);

-- 1. A wrong payment date moves, and the revenue report moves with it.
DO $$
DECLARE
 b uuid:='20000000-0000-4000-8000-000000000001'; c uuid:='30000000-0000-4000-8000-000000000001';
 inv jsonb; pay uuid; r jsonb; report jsonb; wrong date:=DATE '2026-09-21'; right_day date:=DATE '2026-06-15';
BEGIN
 inv:=create_invoice_document(b,c,'{}','[{"description":"Backfilled work","quantity":1,"rate":100}]',gen_random_uuid());
 r:=record_payment_once((inv->>'id')::uuid,100,wrong,gen_random_uuid());
 pay:=(r->>'payment_id')::uuid;
 IF (SELECT status FROM invoices WHERE id=(inv->>'id')::uuid)<>'paid' THEN RAISE EXCEPTION 'Setup did not mark the invoice paid'; END IF;
 IF (SELECT source FROM payments WHERE id=pay)<>'manual' THEN RAISE EXCEPTION 'A browser payment was not recorded as manual'; END IF;

 report:=get_report_summary(b,DATE '2026-09-01',DATE '2026-09-30',NULL,NULL,'month','USD');
 IF (report->'totals'->'current'->>'collected')::numeric<>100 THEN RAISE EXCEPTION 'Setup: September did not hold the money'; END IF;

 r:=update_payment(pay,'fix-'||pay::text,right_day);
 IF (r->'payment'->>'payment_date')<>right_day::text THEN RAISE EXCEPTION 'update_payment did not move the date'; END IF;
 IF (SELECT updated_at FROM payments WHERE id=pay) IS NULL THEN RAISE EXCEPTION 'update_payment did not stamp updated_at'; END IF;

 report:=get_report_summary(b,DATE '2026-09-01',DATE '2026-09-30',NULL,NULL,'month','USD');
 IF (report->'totals'->'current'->>'collected')::numeric<>0 THEN RAISE EXCEPTION 'The money did not leave the wrong month'; END IF;
 report:=get_report_summary(b,DATE '2026-06-01',DATE '2026-06-30',NULL,NULL,'month','USD');
 IF (report->'totals'->'current'->>'collected')::numeric<>100 THEN RAISE EXCEPTION 'The money did not land in the right month'; END IF;

 -- 2. A replayed request_id returns the same answer and changes nothing twice.
 IF (update_payment(pay,'fix-'||pay::text,right_day)->>'replayed')<>'true' THEN RAISE EXCEPTION 'Replay was not reported as a replay'; END IF;
 IF (SELECT COUNT(*) FROM payment_audit WHERE payment_id=pay)<>1 THEN RAISE EXCEPTION 'Replay wrote a second audit row'; END IF;
 BEGIN
  PERFORM update_payment(pay,'fix-'||pay::text,DATE '2026-07-01');
  RAISE EXCEPTION 'TEST FAILED a request ID was reused with different input';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'request_id_reused' THEN RAISE; END IF; END;

 -- 3. The audit row carries the whole before and after payment.
 IF NOT EXISTS(
   SELECT 1 FROM payment_audit a
    WHERE a.payment_id=pay AND a.action='update'
      AND a.invoice_id=(inv->>'id')::uuid AND a.business_id=b
      AND a.actor_user_id='10000000-0000-4000-8000-000000000001' AND a.actor_key_id IS NULL
      AND (a.before->>'payment_date')=wrong::text AND (a.after->>'payment_date')=right_day::text
 ) THEN RAISE EXCEPTION 'The audit row does not describe the correction'; END IF;

 -- 4. Correcting the amount downwards flips paid back to partial.
 r:=update_payment(pay,'reduce-'||pay::text,NULL,NULL,NULL,NULL,40);
 IF (r->'invoice'->>'status')<>'partial' THEN RAISE EXCEPTION 'A reduced amount did not reopen the invoice'; END IF;
 IF (r->'invoice'->>'amount_paid')::numeric<>40 OR (r->'invoice'->>'balance_due')::numeric<>60 THEN RAISE EXCEPTION 'The invoice money columns were not recomputed'; END IF;
 IF (SELECT paid_at FROM invoices WHERE id=(inv->>'id')::uuid) IS NOT NULL THEN RAISE EXCEPTION 'paid_at survived the reopening'; END IF;

 -- 5. An amount larger than the invoice total is refused.
 BEGIN
  PERFORM update_payment(pay,'toobig-'||pay::text,NULL,NULL,NULL,NULL,101);
  RAISE EXCEPTION 'TEST FAILED an overpayment was accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'amount_exceeds_invoice_total' THEN RAISE; END IF; END;

 -- 6. Voiding reopens the whole balance and the row stays, struck out, with a reason.
 r:=void_payment(pay,'void-'||pay::text,'Recorded against the wrong invoice');
 IF (r->'invoice'->>'status')<>'sent' THEN RAISE EXCEPTION 'A voided payment did not reopen the invoice'; END IF;
 IF (r->'invoice'->>'balance_due')::numeric<>100 OR (r->'invoice'->>'amount_paid')::numeric<>0 THEN RAISE EXCEPTION 'The void did not clear the ledger'; END IF;
 IF NOT EXISTS(SELECT 1 FROM payments WHERE id=pay AND voided_at IS NOT NULL AND void_reason='Recorded against the wrong invoice') THEN RAISE EXCEPTION 'The voided row was deleted or lost its reason'; END IF;
 IF (SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id=(inv->>'id')::uuid AND voided_at IS NULL)<>0 THEN RAISE EXCEPTION 'A voided payment still counts as money'; END IF;

 report:=get_report_summary(b,DATE '2026-06-01',DATE '2026-06-30',NULL,NULL,'month','USD');
 IF (report->'totals'->'current'->>'collected')::numeric<>0 THEN RAISE EXCEPTION 'A voided payment is still in the revenue report'; END IF;
 IF (dashboard_summary(b,'USD')->>'totalRevenue')::numeric<>0 THEN RAISE EXCEPTION 'A voided payment is still in the dashboard revenue'; END IF;

 -- 7. A voided payment cannot be edited or voided again.
 BEGIN
  PERFORM update_payment(pay,'again-'||pay::text,DATE '2026-05-01');
  RAISE EXCEPTION 'TEST FAILED a voided payment was edited';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'payment_already_voided' THEN RAISE; END IF; END;
 BEGIN
  PERFORM void_payment(pay,'again-'||pay::text,'Second void');
  RAISE EXCEPTION 'TEST FAILED a payment was voided twice';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'payment_already_voided' THEN RAISE; END IF; END;
 BEGIN
  PERFORM void_payment(pay,'noreason-'||pay::text,'   ');
  RAISE EXCEPTION 'TEST FAILED a payment was voided without a reason';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'void_reason_required' THEN RAISE; END IF; END;

 PERFORM set_config('billr.test_invoice',inv->>'id',true);
END $$;

-- 8. Stripe money is not editable from the app: refunds are the path for cards.
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
DO $$
DECLARE v_invoice uuid:=current_setting('billr.test_invoice')::uuid; pay uuid;
BEGIN
 PERFORM record_stripe_payment(v_invoice,100,CURRENT_DATE,'pi_correction_test');
 SELECT id INTO pay FROM payments WHERE stripe_payment_id='pi_correction_test';
 IF (SELECT source FROM payments WHERE id=pay)<>'stripe' THEN RAISE EXCEPTION 'A Stripe payment was not marked as stripe'; END IF;
 BEGIN
  PERFORM update_payment(pay,'stripe-edit','2026-01-01',NULL,NULL,NULL,NULL,'50000000-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'TEST FAILED Stripe money was edited';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'stripe_payment_locked' THEN RAISE; END IF; END;
 BEGIN
  PERFORM void_payment(pay,'stripe-void','Wrong','50000000-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'TEST FAILED Stripe money was voided';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'stripe_payment_locked' THEN RAISE; END IF; END;
 PERFORM set_config('billr.stripe_payment',pay::text,true);
END $$;

-- 9. The MCP path: the actor is the API key's owner, and the key must carry the
-- payments permission. A key with no payments permission is refused even though
-- the HTTP layer already authenticated it.
DO $$
DECLARE b uuid:='20000000-0000-4000-8000-000000000001'; c uuid:='30000000-0000-4000-8000-000000000001';
 inv jsonb; pay uuid; r jsonb;
BEGIN
 inv:=create_invoice_document(b,c,'{}','[{"description":"Agent work","quantity":1,"rate":80}]',gen_random_uuid());
 r:=record_payment_once((inv->>'id')::uuid,80,CURRENT_DATE,gen_random_uuid(),'bank_transfer',NULL,NULL,'agent','50000000-0000-4000-8000-000000000001');
 pay:=(r->>'payment_id')::uuid;
 IF (SELECT source FROM payments WHERE id=pay)<>'agent' THEN RAISE EXCEPTION 'An agent payment was not marked as agent'; END IF;
 BEGIN
  PERFORM update_payment(pay,'agent-edit',DATE '2026-03-03',NULL,NULL,NULL,NULL,'50000000-0000-4000-8000-000000000002');
  RAISE EXCEPTION 'TEST FAILED a read only key edited a payment';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'key_cannot_edit_payments' THEN RAISE; END IF; END;
 BEGIN
  PERFORM update_payment(pay,'agent-edit',DATE '2026-03-03');
  RAISE EXCEPTION 'TEST FAILED a service role call with no key was accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'invalid_actor' THEN RAISE; END IF; END;
 r:=update_payment(pay,'agent-edit',DATE '2026-03-03',NULL,NULL,NULL,NULL,'50000000-0000-4000-8000-000000000001');
 IF (r->'payment'->>'payment_date')<>'2026-03-03' THEN RAISE EXCEPTION 'The agent correction did not apply'; END IF;
 IF NOT EXISTS(SELECT 1 FROM payment_audit WHERE payment_id=pay
   AND actor_key_id='50000000-0000-4000-8000-000000000001'
   AND actor_user_id='10000000-0000-4000-8000-000000000001')
 THEN RAISE EXCEPTION 'The agent audit row does not name the key and its owner'; END IF;
END $$;

-- 10. Another tenant's member cannot reach the payment, and the error does not
-- reveal that it exists.
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','',true);
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
DO $$
DECLARE pay uuid:=current_setting('billr.stripe_payment')::uuid;
BEGIN
 BEGIN
  PERFORM update_payment(pay,'cross-tenant',DATE '2026-01-01');
  RAISE EXCEPTION 'TEST FAILED another tenant edited a payment';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'payment_not_found' THEN RAISE; END IF; END;
 BEGIN
  PERFORM void_payment(pay,'cross-tenant','Not mine');
  RAISE EXCEPTION 'TEST FAILED another tenant voided a payment';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'payment_not_found' THEN RAISE; END IF; END;
 IF EXISTS(SELECT 1 FROM payment_audit) THEN RAISE EXCEPTION 'RLS exposed another business audit trail'; END IF;
END $$;
ROLLBACK;
