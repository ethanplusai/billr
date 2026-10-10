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
DECLARE b uuid:='20000000-0000-4000-8000-000000000001'; p uuid; t uuid; r jsonb; request uuid:=gen_random_uuid();
BEGIN
 INSERT INTO billing_policies(business_id,client_id,name,currency,hourly_rate,usage_multiplier,budget)
 VALUES(b,'30000000-0000-4000-8000-000000000001','Agreed pricing','USD',100,1.5,50) RETURNING id INTO p;
 r:=task_operation(b,request,'create',jsonb_build_object('policy_id',p,'title','Test task'));
 t:=(r->'task'->>'id')::uuid;
 IF task_operation(b,request,'create',jsonb_build_object('policy_id',p,'title','Test task'))<>r THEN RAISE EXCEPTION 'Task replay changed result'; END IF;
 PERFORM task_operation(b,gen_random_uuid(),'start',jsonb_build_object('task_id',t));
 PERFORM task_operation(b,gen_random_uuid(),'usage',jsonb_build_object('task_id',t,'provider','example','provider_request_id','req-1','cost',2,'currency','USD','source','Provider usage response'));
 BEGIN
   PERFORM task_operation(b,gen_random_uuid(),'usage',jsonb_build_object('task_id',t,'provider','example','provider_request_id','req-1','cost',2,'currency','USD','source','Provider usage response'));
   RAISE EXCEPTION 'TEST FAILED duplicate usage accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
   PERFORM task_operation(b,gen_random_uuid(),'usage',jsonb_build_object('task_id',t,'provider','example','provider_request_id','req-2','cost',2,'currency','EUR','source','Provider usage response'));
   RAISE EXCEPTION 'TEST FAILED mixed currency accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Usage currency%' THEN RAISE; END IF; END;
 BEGIN
   PERFORM task_operation(b,gen_random_uuid(),'usage',jsonb_build_object('task_id',t,'provider','example','provider_request_id','req-3','cost',100,'currency','USD','source','Provider usage response'));
   RAISE EXCEPTION 'TEST FAILED budget exceeded';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Usage would exceed%' THEN RAISE; END IF; END;
 r:=task_operation(b,gen_random_uuid(),'complete',jsonb_build_object('task_id',t));
 IF (r->>'usage_amount')::numeric<>3 THEN RAISE EXCEPTION 'Wrong usage markup'; END IF;
 r:=task_operation(b,gen_random_uuid(),'invoice',jsonb_build_object('task_id',t));
 IF (r->'task'->>'invoice_id') IS NULL THEN RAISE EXCEPTION 'No draft invoice'; END IF;
 IF (SELECT total FROM invoices WHERE id=(r->'task'->>'invoice_id')::uuid)<>3 THEN RAISE EXCEPTION 'Incorrect task invoice'; END IF;
 DELETE FROM invoices WHERE id=(r->'task'->>'invoice_id')::uuid;
 IF (SELECT status FROM work_tasks WHERE id=t)<>'completed' THEN RAISE EXCEPTION 'Deleted draft did not release task'; END IF;
 r:=task_operation(b,gen_random_uuid(),'invoice',jsonb_build_object('task_id',t));
 IF (r->'task'->>'invoice_id') IS NULL THEN RAISE EXCEPTION 'Released task could not be approved again'; END IF;

END $$;
-- Simulate a crashed agent without waiting ten minutes in the test suite.
DO $$
DECLARE r jsonb; p uuid;
BEGIN
 SELECT id INTO p FROM billing_policies WHERE business_id='20000000-0000-4000-8000-000000000001' LIMIT 1;
 r:=task_operation('20000000-0000-4000-8000-000000000001',gen_random_uuid(),'create',jsonb_build_object('policy_id',p,'title','Lease test'));
 PERFORM set_config('billr.test_task_id',r->'task'->>'id',true);
 PERFORM task_operation('20000000-0000-4000-8000-000000000001',gen_random_uuid(),'start',jsonb_build_object('task_id',current_setting('billr.test_task_id')));
END $$;
RESET ROLE;
UPDATE work_tasks SET last_heartbeat_at=clock_timestamp()-interval '10 minutes' WHERE id=current_setting('billr.test_task_id')::uuid;
SET LOCAL ROLE authenticated;
DO $$
DECLARE r jsonb; request uuid:=gen_random_uuid(); input jsonb:=jsonb_build_object('task_id',current_setting('billr.test_task_id'));
BEGIN
 r:=task_operation('20000000-0000-4000-8000-000000000001',request,'heartbeat',input);
 IF (r->'task'->>'active_seconds')::bigint<>120 THEN RAISE EXCEPTION 'Expired lease charged more than 120 seconds'; END IF;
 IF task_operation('20000000-0000-4000-8000-000000000001',request,'heartbeat',input)<>r THEN RAISE EXCEPTION 'Heartbeat replay changed cost'; END IF;
 PERFORM task_operation('20000000-0000-4000-8000-000000000001',gen_random_uuid(),'pause',input);
END $$;
RESET ROLE;
UPDATE work_tasks SET last_heartbeat_at=clock_timestamp()-interval '10 minutes' WHERE id=current_setting('billr.test_task_id')::uuid;
SET LOCAL ROLE authenticated;
DO $$
DECLARE r jsonb;
BEGIN
 r:=task_operation('20000000-0000-4000-8000-000000000001',gen_random_uuid(),'complete',jsonb_build_object('task_id',current_setting('billr.test_task_id')));
 IF (r->'task'->>'active_seconds')::bigint<>120 THEN RAISE EXCEPTION 'Paused time was billed'; END IF;
END $$;
ROLLBACK;
