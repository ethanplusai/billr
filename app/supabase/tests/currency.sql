-- Work currency: time carries the currency of its client when it is logged,
-- billed work keeps that currency when the client's currency changes later,
-- and a malformed currency is refused.
BEGIN;
INSERT INTO auth.users(id,email) VALUES ('10000000-0000-4000-8000-000000000001','owner@example.test');
INSERT INTO businesses(id,name) VALUES ('20000000-0000-4000-8000-000000000001','Test business');
INSERT INTO business_members(business_id,user_id,role) VALUES
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','owner');
INSERT INTO clients(id,business_id,name) VALUES
 ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Client');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
DO $$
DECLARE t uuid; invoice jsonb;
BEGIN
 INSERT INTO time_entries(business_id,client_id,description,date,duration_seconds,hourly_rate,is_billable)
 VALUES('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','Billed time',CURRENT_DATE,36,100,true)
 RETURNING id INTO t;
 IF (SELECT currency FROM time_entries WHERE id=t) IS DISTINCT FROM
    (SELECT currency FROM clients WHERE id='30000000-0000-4000-8000-000000000001') THEN
  RAISE EXCEPTION 'TEST FAILED: new time did not take the client currency';
 END IF;
 invoice:=create_invoice_document('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','{}','[]',gen_random_uuid(),ARRAY[t]);
 UPDATE clients SET currency='EUR' WHERE id='30000000-0000-4000-8000-000000000001';
 IF NOT EXISTS(SELECT 1 FROM time_entries WHERE id=t AND currency='USD' AND amount=1 AND is_billed) THEN
  RAISE EXCEPTION 'TEST FAILED: billed time changed currency or amount with the client';
 END IF;
 BEGIN
  INSERT INTO time_entries(business_id,client_id,description,date,duration_seconds,hourly_rate,currency)
  VALUES('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','Bad currency',CURRENT_DATE,60,100,'usd');
  RAISE EXCEPTION 'TEST FAILED: a lower-case currency was accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='guard_time_entry' AND tgenabled='O') THEN
  RAISE EXCEPTION 'TEST FAILED: billed work is not protected by guard_time_entry';
 END IF;
END $$;
ROLLBACK;
