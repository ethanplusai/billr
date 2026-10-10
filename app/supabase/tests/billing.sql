BEGIN;
INSERT INTO auth.users(id,email) VALUES ('10000000-0000-4000-8000-000000000001','owner@example.test'),('10000000-0000-4000-8000-000000000002','other@example.test');
INSERT INTO businesses(id,name) VALUES ('20000000-0000-4000-8000-000000000001','Test business'),('20000000-0000-4000-8000-000000000002','Other business');
INSERT INTO business_members(business_id,user_id,role) VALUES
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','owner'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','owner');
INSERT INTO clients(id,business_id,name) VALUES
 ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Client'),
 ('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','Other client');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
DO $$
DECLARE v_time UUID; first_invoice JSONB; replay JSONB; b UUID:='20000000-0000-4000-8000-000000000001'; c UUID:='30000000-0000-4000-8000-000000000001';
BEGIN
 INSERT INTO time_entries(business_id,client_id,description,date,duration_seconds,hourly_rate,is_billable)
 VALUES(b,c,'36 seconds',CURRENT_DATE,36,100,true) RETURNING id INTO v_time;
 IF (SELECT amount FROM time_entries WHERE id=v_time)<>1 THEN RAISE EXCEPTION 'Incorrect second-based amount'; END IF;
 first_invoice:=create_invoice_document(b,c,'{}','[]','40000000-0000-4000-8000-000000000001',ARRAY[v_time]);
 IF (first_invoice->>'total')::NUMERIC<>1 THEN RAISE EXCEPTION 'Billing changed the measured amount'; END IF;
 replay:=create_invoice_document(b,c,'{}','[]','40000000-0000-4000-8000-000000000001',ARRAY[v_time]);
 IF first_invoice<>replay THEN RAISE EXCEPTION 'Retry did not return the same invoice'; END IF;
 BEGIN
   PERFORM create_invoice_document(b,c,'{}','[]','40000000-0000-4000-8000-000000000002',ARRAY[v_time]);
   RAISE EXCEPTION 'TEST FAILED: work was invoiced twice';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF; END;
 BEGIN
   UPDATE time_entries SET hourly_rate=200 WHERE id=v_time;
   RAISE EXCEPTION 'TEST FAILED: billed time was edited';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF; END;
 BEGIN
   INSERT INTO time_entries(business_id,client_id,description,date,duration_seconds) VALUES(b,'30000000-0000-4000-8000-000000000002','Wrong client',CURRENT_DATE,60);
   RAISE EXCEPTION 'TEST FAILED: cross-tenant client accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST FAILED:%' THEN RAISE; END IF; END;
 IF EXISTS(SELECT 1 FROM clients WHERE id='30000000-0000-4000-8000-000000000002') THEN RAISE EXCEPTION 'RLS exposed another client'; END IF;
 DELETE FROM invoices WHERE id=(first_invoice->>'id')::UUID;
 IF (SELECT is_billed OR invoice_id IS NOT NULL FROM time_entries WHERE id=v_time) THEN RAISE EXCEPTION 'Draft deletion did not release work'; END IF;
END $$;
DO $$
DECLARE b uuid:='20000000-0000-4000-8000-000000000001'; c uuid:='30000000-0000-4000-8000-000000000001'; r jsonb; same jsonb; v_request uuid:=gen_random_uuid(); inv jsonb;
BEGIN
 r:=create_work_entry_once(b,'time',jsonb_build_object('client_id',c,'date',CURRENT_DATE,'description','Retry time','duration_seconds',36,'hourly_rate',100,'currency','USD'),v_request);
 same:=create_work_entry_once(b,'time',jsonb_build_object('client_id',c,'date',CURRENT_DATE,'description','Retry time','duration_seconds',36,'hourly_rate',100,'currency','USD'),v_request);
 IF r<>same OR (r->>'amount')::numeric<>1 THEN RAISE EXCEPTION 'Work replay or amount failed'; END IF;
 r:=create_work_entry_once(b,'expense',jsonb_build_object('client_id',c,'date',CURRENT_DATE,'description','Retry expense','amount',2,'currency','USD','category','software'),gen_random_uuid());
 v_request:=gen_random_uuid();
 r:=create_estimate_document(b,c,'{}','[{"description":"Work","quantity":1,"rate":10}]',v_request);
 IF r<>create_estimate_document(b,c,'{}','[{"description":"Work","quantity":1,"rate":10}]',v_request) THEN RAISE EXCEPTION 'Estimate replay failed'; END IF;
 inv:=create_invoice_document(b,c,'{}','[{"description":"Payment test","quantity":1,"rate":10}]',gen_random_uuid());
 v_request:=gen_random_uuid();
 r:=record_payment_once((inv->>'id')::uuid,4,CURRENT_DATE,v_request);
 same:=record_payment_once((inv->>'id')::uuid,4,CURRENT_DATE,v_request);
 IF r<>same OR (SELECT SUM(amount) FROM payments WHERE invoice_id=(inv->>'id')::uuid)<>4 THEN RAISE EXCEPTION 'Payment retry duplicated money'; END IF;
END $$;
ROLLBACK;
