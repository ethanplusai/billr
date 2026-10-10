-- Engagements: the schedule math, the three money
-- invariants, the lifecycle RPCs and the tenant boundary.
--
-- The block marked SHARED CASES below is the same list of splits asserted in
-- src/lib/engagements/schedule.test.ts against the TypeScript expansion the UI
-- previews with. If the two ever disagree, one of these two files fails, which
-- is the point: a preview that lies about what will be written is worse than
-- no preview.
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
INSERT INTO clients(id,business_id,name,currency) VALUES
 ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Client','USD'),
 ('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','Other client','USD');
INSERT INTO api_keys(id,user_id,business_id,label,key_hash,permissions) VALUES
 ('50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Agent','hash-engagement-agent',ARRAY['read','write']),
 ('50000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Reader','hash-engagement-reader',ARRAY['read']);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);

-- 1. SHARED CASES: the schedule expansion, cent for cent.
DO $$
DECLARE
 v jsonb;
 v_amounts numeric[];
BEGIN
 -- 50/50 of 1000
 SELECT array_agg((e->>'amount')::numeric ORDER BY (e->>'position')::int) INTO v_amounts
   FROM jsonb_array_elements(expand_engagement_schedule('percent_split',1000,'[{"percent":50},{"percent":50}]')) e;
 IF v_amounts <> ARRAY[500,500]::numeric[] THEN RAISE EXCEPTION '50/50 of 1000 expanded to %', v_amounts; END IF;

 -- 30/70 of 999.99: the rounding lands on the last entry
 SELECT array_agg((e->>'amount')::numeric ORDER BY (e->>'position')::int) INTO v_amounts
   FROM jsonb_array_elements(expand_engagement_schedule('percent_split',999.99,'[{"percent":30},{"percent":70}]')) e;
 IF v_amounts <> ARRAY[300.00,699.99]::numeric[] THEN RAISE EXCEPTION '30/70 of 999.99 expanded to %', v_amounts; END IF;

 -- thirds of 100 as percentages
 SELECT array_agg((e->>'amount')::numeric ORDER BY (e->>'position')::int) INTO v_amounts
   FROM jsonb_array_elements(expand_engagement_schedule('percent_split',100,'[{"percent":33.33},{"percent":33.33},{"percent":33.34}]')) e;
 IF v_amounts <> ARRAY[33.33,33.33,33.34]::numeric[] THEN RAISE EXCEPTION 'thirds of 100 expanded to %', v_amounts; END IF;

 -- 3 equal of 100
 SELECT array_agg((e->>'amount')::numeric ORDER BY (e->>'position')::int) INTO v_amounts
   FROM jsonb_array_elements(expand_engagement_schedule('equal_installments',100,'[]',3)) e;
 IF v_amounts <> ARRAY[33.33,33.33,33.34]::numeric[] THEN RAISE EXCEPTION '3 equal of 100 expanded to %', v_amounts; END IF;

 -- 3 equal of 1000
 SELECT array_agg((e->>'amount')::numeric ORDER BY (e->>'position')::int) INTO v_amounts
   FROM jsonb_array_elements(expand_engagement_schedule('equal_installments',1000,'[]',3)) e;
 IF v_amounts <> ARRAY[333.33,333.33,333.34]::numeric[] THEN RAISE EXCEPTION '3 equal of 1000 expanded to %', v_amounts; END IF;

 -- 7 equal of 100
 SELECT array_agg((e->>'amount')::numeric ORDER BY (e->>'position')::int) INTO v_amounts
   FROM jsonb_array_elements(expand_engagement_schedule('equal_installments',100,'[]',7)) e;
 IF v_amounts <> ARRAY[14.29,14.29,14.29,14.29,14.29,14.29,14.26]::numeric[] THEN RAISE EXCEPTION '7 equal of 100 expanded to %', v_amounts; END IF;

 -- 10 equal of 1000.05: every half cent rounds up and the last entry absorbs it
 SELECT array_agg((e->>'amount')::numeric ORDER BY (e->>'position')::int) INTO v_amounts
   FROM jsonb_array_elements(expand_engagement_schedule('equal_installments',1000.05,'[]',10)) e;
 IF v_amounts <> ARRAY[100.01,100.01,100.01,100.01,100.01,100.01,100.01,100.01,100.01,99.96]::numeric[]
   THEN RAISE EXCEPTION '10 equal of 1000.05 expanded to %', v_amounts; END IF;

 -- 10 equal of 0.1
 SELECT array_agg((e->>'amount')::numeric ORDER BY (e->>'position')::int) INTO v_amounts
   FROM jsonb_array_elements(expand_engagement_schedule('equal_installments',0.1,'[]',10)) e;
 IF v_amounts <> ARRAY[0.01,0.01,0.01,0.01,0.01,0.01,0.01,0.01,0.01,0.01]::numeric[]
   THEN RAISE EXCEPTION '10 equal of 0.1 expanded to %', v_amounts; END IF;

 -- Default due rules: start, milestones in the middle, completion at the end.
 v := expand_engagement_schedule('equal_installments',400,'[]',4);
 IF (v->0->>'due_rule')<>'on_start' OR (v->1->>'due_rule')<>'on_milestone'
    OR (v->2->>'due_rule')<>'on_milestone' OR (v->3->>'due_rule')<>'on_complete'
   THEN RAISE EXCEPTION 'The default due rules changed: %', v; END IF;
 IF (v->0->>'label')<>'Installment 1 of 4' THEN RAISE EXCEPTION 'Unlabelled installments lost their names: %', v; END IF;

 -- A single entry is due on completion; a manual engagement waits for a person.
 IF (expand_engagement_schedule('milestones',400,'[{"amount":400}]')->0->>'due_rule')<>'on_complete'
   THEN RAISE EXCEPTION 'A single entry is not due on completion'; END IF;
 IF (expand_engagement_schedule('manual',400,'[{"amount":100},{"amount":300}]')->0->>'due_rule')<>'manual'
   THEN RAISE EXCEPTION 'A manual engagement fires itself'; END IF;

 -- A date only means something on an on_date entry.
 v := expand_engagement_schedule('milestones',100,'[{"amount":100,"due_rule":"on_complete","due_on":"2026-10-01"}]');
 IF (v->0->>'due_on') IS NOT NULL THEN RAISE EXCEPTION 'A stale date survived on a non dated entry'; END IF;
 v := expand_engagement_schedule('milestones',100,'[{"amount":100,"due_rule":"on_date","due_on":"2026-10-01"}]');
 IF (v->0->>'due_on')<>'2026-10-01' THEN RAISE EXCEPTION 'A dated entry lost its date'; END IF;
END $$;

-- 2. SHARED CASES: every refusal, with the same code the TypeScript raises.
DO $$
DECLARE
 v_case record;
BEGIN
 FOR v_case IN SELECT * FROM (VALUES
   ('percent_must_total_100','percent_split',1000::numeric,'[{"percent":30},{"percent":60}]'::jsonb,NULL::int),
   ('invalid_percent','percent_split',1000,'[{"percent":100},{}]',NULL),
   ('entries_must_total_engagement','milestones',10000,'[{"amount":2500},{"amount":2500}]',NULL),
   ('entry_amount_required','milestones',100,'[{"label":"Kickoff"}]',NULL),
   ('invalid_total','equal_installments',0,'[]',2),
   ('invalid_total','equal_installments',-100,'[]',2),
   ('invalid_installments','equal_installments',100,'[]',NULL),
   ('invalid_installments','equal_installments',100,'[]',101),
   ('entries_required','milestones',100,'[]',NULL),
   ('due_on_required','milestones',100,'[{"amount":100,"due_rule":"on_date"}]',NULL),
   ('invalid_entry_amount','equal_installments',0.01,'[]',3),
   ('invalid_billing_mode','retainer',100,'[]',2)
 ) AS t(code,mode,total,entries,installments) LOOP
  BEGIN
   PERFORM expand_engagement_schedule(v_case.mode,v_case.total,v_case.entries,v_case.installments);
   RAISE EXCEPTION 'TEST FAILED expected % for % %', v_case.code, v_case.mode, v_case.entries;
  EXCEPTION WHEN raise_exception THEN
   IF SQLERRM <> v_case.code THEN RAISE EXCEPTION 'Expected % but got % for % %', v_case.code, SQLERRM, v_case.mode, v_case.entries; END IF;
  END;
 END LOOP;
END $$;

-- 3. The seeded schedule templates are the ones the app ships
--    (DEFAULT_SCHEDULE_TEMPLATES in src/lib/engagements/schedule.ts).
DO $$
DECLARE v jsonb;
BEGIN
 SELECT schedule_templates INTO v FROM businesses WHERE id='20000000-0000-4000-8000-000000000001';
 IF jsonb_array_length(v)<>4 THEN RAISE EXCEPTION 'A new business did not get the four schedule templates'; END IF;
 IF (SELECT array_agg(t->>'key' ORDER BY ord) FROM jsonb_array_elements(v) WITH ORDINALITY AS x(t,ord))
    <> ARRAY['50_50','30_70','design_build_launch','10_equal']
   THEN RAISE EXCEPTION 'The seeded templates are not the ones the app expects: %', v; END IF;
 IF (v->0->'entries'->0->>'percent')<>'50' OR (v->1->'entries'->0->>'percent')<>'30'
   THEN RAISE EXCEPTION 'The deposit templates lost their percentages'; END IF;
 IF (v->2->>'installments')<>'3' OR (v->3->>'installments')<>'10'
   THEN RAISE EXCEPTION 'The installment templates lost their counts'; END IF;
END $$;

-- 4. Creating an engagement, replaying it, and the schedule it writes.
DO $$
DECLARE
 b uuid:='20000000-0000-4000-8000-000000000001'; c uuid:='30000000-0000-4000-8000-000000000001';
 req uuid:=gen_random_uuid(); r jsonb; eng uuid; s record;
BEGIN
 r:=create_engagement_with_schedule(req,b,c,'Website rebuild',12000,'USD','percent_split',
   '[{"label":"Deposit","percent":50,"due_rule":"on_start"},{"label":"On completion","percent":50,"due_rule":"on_complete"}]');
 eng:=(r->'engagement'->>'id')::uuid;
 PERFORM set_config('billr.engagement',eng::text,true);

 IF (r->'engagement'->>'status')<>'draft' THEN RAISE EXCEPTION 'A new engagement did not start as a draft'; END IF;
 IF (r->'engagement'->>'created_via')<>'web' THEN RAISE EXCEPTION 'A browser write was not recorded as web'; END IF;
 IF jsonb_array_length(r->'entries')<>2 THEN RAISE EXCEPTION 'The schedule was not written'; END IF;
 IF (r->'entries'->0->>'amount')::numeric<>6000 OR (r->'entries'->1->>'amount')::numeric<>6000
   THEN RAISE EXCEPTION 'The 50/50 split did not write 6000 twice: %', r->'entries'; END IF;
 IF (r->'entries'->0->>'status')<>'pending' THEN RAISE EXCEPTION 'A draft engagement pre-billed itself'; END IF;
 IF (r->>'replayed')<>'false' THEN RAISE EXCEPTION 'A first call reported itself as a replay'; END IF;

 -- Derived money, from the view.
 SELECT * INTO s FROM engagement_summary WHERE engagement_id=eng;
 IF s.amount_billed<>0 OR s.amount_remaining<>12000 OR s.ready_count<>0
   THEN RAISE EXCEPTION 'The summary of a fresh engagement is wrong: % % %', s.amount_billed, s.amount_remaining, s.ready_count; END IF;

 -- A replay returns the same engagement and creates nothing.
 r:=create_engagement_with_schedule(req,b,c,'Website rebuild',12000,'USD','percent_split',
   '[{"label":"Deposit","percent":50,"due_rule":"on_start"},{"label":"On completion","percent":50,"due_rule":"on_complete"}]');
 IF (r->'engagement'->>'id')::uuid<>eng THEN RAISE EXCEPTION 'A replay created a second engagement'; END IF;
 IF (r->>'replayed')<>'true' THEN RAISE EXCEPTION 'A replay was not reported as one'; END IF;
 IF (SELECT COUNT(*) FROM engagements WHERE business_id=b)<>1 THEN RAISE EXCEPTION 'A replay wrote a second row'; END IF;

 -- The same request id with different input is an error, not a second write.
 BEGIN
  PERFORM create_engagement_with_schedule(req,b,c,'Website rebuild',24000,'USD','percent_split',
    '[{"percent":50},{"percent":50}]');
  RAISE EXCEPTION 'TEST FAILED a request id was reused with different input';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'request_id_reused' THEN RAISE; END IF; END;

 -- Another tenant's client is not reachable, and says nothing about itself.
 BEGIN
  PERFORM create_engagement_with_schedule(gen_random_uuid(),b,'30000000-0000-4000-8000-000000000002','Cross tenant',100,'USD','equal_installments','[]',2);
  RAISE EXCEPTION 'TEST FAILED an engagement was created against another business client';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'client_not_found' THEN RAISE; END IF; END;

 -- A schedule that does not add up never reaches the table.
 BEGIN
  PERFORM create_engagement_with_schedule(gen_random_uuid(),b,c,'Bad split',1000,'USD','percent_split','[{"percent":30},{"percent":30}]');
  RAISE EXCEPTION 'TEST FAILED an unbalanced percent split was accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'percent_must_total_100' THEN RAISE; END IF; END;
END $$;

-- 5. The schedule must add up: the deferred balance trigger.
DO $$
DECLARE eng uuid:=current_setting('billr.engagement')::uuid; v_entry uuid;
BEGIN
 SELECT id INTO v_entry FROM engagement_entries WHERE engagement_id=eng ORDER BY position LIMIT 1;

 -- Editing one entry's amount unbalances the engagement, and the commit check
 -- (forced here with SET CONSTRAINTS) refuses it.
 BEGIN
  UPDATE engagement_entries SET amount=7000 WHERE id=v_entry;
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'TEST FAILED an entry was edited out of balance';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'engagement_schedule_unbalanced' THEN RAISE; END IF; END;

 -- Deleting an entry unbalances it too.
 BEGIN
  DELETE FROM engagement_entries WHERE id=v_entry;
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'TEST FAILED an entry was deleted out of balance';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'engagement_schedule_unbalanced' THEN RAISE; END IF; END;

 -- Moving the total without moving the schedule is refused from the other side.
 BEGIN
  UPDATE engagements SET total=13000 WHERE id=eng;
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'TEST FAILED a total moved away from its schedule';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'engagement_schedule_unbalanced' THEN RAISE; END IF; END;

 -- Rewriting the whole schedule inside one transaction IS allowed: this is
 -- why the trigger is deferred rather than a per row check.
 UPDATE engagement_entries SET amount=5000 WHERE id=v_entry;
 UPDATE engagement_entries SET amount=7000 WHERE engagement_id=eng AND id<>v_entry;
 SET CONSTRAINTS ALL IMMEDIATE;
 IF (SELECT SUM(amount) FROM engagement_entries WHERE engagement_id=eng)<>12000
   THEN RAISE EXCEPTION 'The rewritten schedule does not add up'; END IF;
 -- Put it back.
 UPDATE engagement_entries SET amount=6000 WHERE engagement_id=eng;
 SET CONSTRAINTS ALL IMMEDIATE;

 -- Two entries cannot hold the same position.
 BEGIN
  UPDATE engagement_entries SET position=0 WHERE engagement_id=eng AND position=1;
  RAISE EXCEPTION 'TEST FAILED two entries share a position';
 EXCEPTION WHEN unique_violation THEN NULL; END;

 -- Hand the balance check back to commit time for the rest of this file:
 -- SET CONSTRAINTS lasts for the whole transaction, and leaving it immediate
 -- would make writing a schedule row by row impossible below.
 SET CONSTRAINTS ALL DEFERRED;
END $$;

-- 6. The lifecycle: active fires the deposit, a milestone fires itself,
--    completion fires the rest and reports what is left.
DO $$
DECLARE
 b uuid:='20000000-0000-4000-8000-000000000001'; c uuid:='30000000-0000-4000-8000-000000000001';
 eng uuid; r jsonb; e1 uuid; e2 uuid; e3 uuid; s record;
BEGIN
 r:=create_engagement_with_schedule(gen_random_uuid(),b,c,'Brand refresh',9000,'USD','milestones',
   '[{"label":"Kickoff","amount":3000,"due_rule":"on_start"},
     {"label":"Concepts","amount":3000,"due_rule":"on_milestone"},
     {"label":"Handover","amount":3000,"due_rule":"on_complete"}]');
 eng:=(r->'engagement'->>'id')::uuid;
 SELECT id INTO e1 FROM engagement_entries WHERE engagement_id=eng AND position=0;
 SELECT id INTO e2 FROM engagement_entries WHERE engagement_id=eng AND position=1;
 SELECT id INTO e3 FROM engagement_entries WHERE engagement_id=eng AND position=2;
 PERFORM set_config('billr.lifecycle',eng::text,true);

 -- Starting the work makes the deposit billable and nothing else.
 r:=set_engagement_status(gen_random_uuid(),eng,'active');
 IF (SELECT status FROM engagement_entries WHERE id=e1)<>'ready_to_bill' THEN RAISE EXCEPTION 'Starting did not fire the deposit'; END IF;
 IF (SELECT status FROM engagement_entries WHERE id=e2)<>'pending' THEN RAISE EXCEPTION 'Starting fired a milestone early'; END IF;
 IF jsonb_array_length(r->'promoted_entry_ids')<>1 THEN RAISE EXCEPTION 'The promoted entries were not reported'; END IF;

 -- The milestone happening makes that entry billable.
 r:=mark_entry_complete(gen_random_uuid(),e2);
 IF (r->>'became_ready_to_bill')<>'true' THEN RAISE EXCEPTION 'A completed milestone did not become billable'; END IF;
 IF (SELECT status FROM engagement_entries WHERE id=e2)<>'ready_to_bill' THEN RAISE EXCEPTION 'The milestone entry is not ready to bill'; END IF;
 IF (SELECT completed_at FROM engagement_entries WHERE id=e2) IS NULL THEN RAISE EXCEPTION 'The milestone was not stamped complete'; END IF;

 -- A completion entry keeps its own rule: marking it complete records the
 -- fact without overriding the schedule.
 r:=mark_entry_complete(gen_random_uuid(),e3);
 IF (r->>'became_ready_to_bill')<>'false' THEN RAISE EXCEPTION 'An on_complete entry was fired by hand'; END IF;
 IF (SELECT status FROM engagement_entries WHERE id=e3)<>'pending' THEN RAISE EXCEPTION 'An on_complete entry left pending early'; END IF;

 SELECT * INTO s FROM engagement_summary WHERE engagement_id=eng;
 IF s.ready_count<>2 OR s.ready_amount<>6000 THEN RAISE EXCEPTION 'The ready to bill rollup is wrong: % %', s.ready_count, s.ready_amount; END IF;
 IF jsonb_array_length(s.next_ready_entries)<>2 THEN RAISE EXCEPTION 'next_ready_entries does not list the billable work'; END IF;

 -- Completing the engagement fires the rest and warns about what is unbilled.
 r:=set_engagement_status(gen_random_uuid(),eng,'completed');
 IF (SELECT status FROM engagement_entries WHERE id=e3)<>'ready_to_bill' THEN RAISE EXCEPTION 'Completion did not fire the final entry'; END IF;
 IF (r->>'amount_remaining')::numeric<>9000 THEN RAISE EXCEPTION 'Completion misreported the remaining amount'; END IF;
 IF r->>'warning' IS NULL THEN RAISE EXCEPTION 'Completion with money unbilled did not warn'; END IF;

 -- A closed engagement is closed.
 BEGIN
  PERFORM set_engagement_status(gen_random_uuid(),eng,'active');
  RAISE EXCEPTION 'TEST FAILED a completed engagement was reopened';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'engagement_closed' THEN RAISE; END IF; END;
END $$;

-- 7. Waiving money, and what it does to the remaining balance.
DO $$
DECLARE
 eng uuid:=current_setting('billr.lifecycle')::uuid; e3 uuid; r jsonb; req uuid:=gen_random_uuid(); s record;
BEGIN
 SELECT id INTO e3 FROM engagement_entries WHERE engagement_id=eng AND position=2;

 BEGIN
  PERFORM waive_entry(gen_random_uuid(),e3,'   ');
  RAISE EXCEPTION 'TEST FAILED money was waived with no reason';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'waive_reason_required' THEN RAISE; END IF; END;

 r:=waive_entry(req,e3,'Client absorbed the handover work');
 IF (r->'entry'->>'status')<>'waived' THEN RAISE EXCEPTION 'The entry was not waived'; END IF;
 SELECT * INTO s FROM engagement_summary WHERE engagement_id=eng;
 IF s.amount_waived<>3000 OR s.amount_remaining<>6000
   THEN RAISE EXCEPTION 'Waived money did not leave the remaining balance: % %', s.amount_waived, s.amount_remaining; END IF;
 IF (SELECT SUM(amount) FROM engagement_entries WHERE engagement_id=eng)<>9000
   THEN RAISE EXCEPTION 'Waiving changed the agreed schedule'; END IF;

 -- Replays are answers, not second waivers.
 IF (waive_entry(req,e3,'Client absorbed the handover work')->>'replayed')<>'true'
   THEN RAISE EXCEPTION 'A replayed waiver was not reported as a replay'; END IF;
 BEGIN
  PERFORM waive_entry(gen_random_uuid(),e3,'Second waiver');
  RAISE EXCEPTION 'TEST FAILED an entry was waived twice';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'entry_waived' THEN RAISE; END IF; END;
END $$;

-- 8. Billed is billed: an invoiced entry is frozen and cannot be deleted.
DO $$
DECLARE
 b uuid:='20000000-0000-4000-8000-000000000001'; c uuid:='30000000-0000-4000-8000-000000000001';
 eng uuid:=current_setting('billr.lifecycle')::uuid; e1 uuid; inv jsonb; s record;
BEGIN
 SELECT id INTO e1 FROM engagement_entries WHERE engagement_id=eng AND position=0;
 inv:=create_invoice_document(b,c,'{}','[{"description":"Kickoff","quantity":1,"rate":3000}]',gen_random_uuid());

 -- This is the link part B's create_invoice will write.
 UPDATE engagement_entries SET status='invoiced', invoice_id=(inv->>'id')::uuid WHERE id=e1;

 SELECT * INTO s FROM engagement_summary WHERE engagement_id=eng;
 IF s.amount_billed<>3000 OR s.amount_remaining<>3000
   THEN RAISE EXCEPTION 'Billed money is not counted: % %', s.amount_billed, s.amount_remaining; END IF;

 BEGIN
  UPDATE engagement_entries SET amount=4000 WHERE id=e1;
  RAISE EXCEPTION 'TEST FAILED a billed amount was edited';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'entry_invoiced_immutable' THEN RAISE; END IF; END;

 BEGIN
  DELETE FROM engagement_entries WHERE id=e1;
  RAISE EXCEPTION 'TEST FAILED a billed entry was deleted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'entry_invoiced_immutable' THEN RAISE; END IF; END;

 BEGIN
  UPDATE engagement_entries SET invoice_id=NULL, status='pending' WHERE id=e1;
  RAISE EXCEPTION 'TEST FAILED a billed entry was unbilled';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'entry_invoiced_immutable' THEN RAISE; END IF; END;

 BEGIN
  PERFORM waive_entry(gen_random_uuid(),e1,'Trying to waive billed money');
  RAISE EXCEPTION 'TEST FAILED billed money was waived';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'entry_already_invoiced' THEN RAISE; END IF; END;

 -- An entry cannot claim to be invoiced without naming its invoice.
 BEGIN
  UPDATE engagement_entries SET status='invoiced' WHERE engagement_id=eng AND position=1;
  RAISE EXCEPTION 'TEST FAILED an entry was billed with no invoice';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

-- 9. A cancelled engagement takes no more money.
DO $$
DECLARE
 b uuid:='20000000-0000-4000-8000-000000000001'; c uuid:='30000000-0000-4000-8000-000000000001';
 eng uuid; e1 uuid; inv jsonb;
BEGIN
 eng:=(create_engagement_with_schedule(gen_random_uuid(),b,c,'Cancelled work',2000,'USD','equal_installments','[]',2)->'engagement'->>'id')::uuid;
 SELECT id INTO e1 FROM engagement_entries WHERE engagement_id=eng AND position=0;
 PERFORM set_engagement_status(gen_random_uuid(),eng,'active');
 PERFORM set_engagement_status(gen_random_uuid(),eng,'cancelled');

 inv:=create_invoice_document(b,c,'{}','[{"description":"Work","quantity":1,"rate":1000}]',gen_random_uuid());
 BEGIN
  UPDATE engagement_entries SET status='invoiced', invoice_id=(inv->>'id')::uuid WHERE id=e1;
  RAISE EXCEPTION 'TEST FAILED a cancelled engagement was billed';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'engagement_cancelled' THEN RAISE; END IF; END;
END $$;

-- 10. The scheduled date sweep, which the read paths call instead of a cron.
DO $$
DECLARE
 b uuid:='20000000-0000-4000-8000-000000000001'; c uuid:='30000000-0000-4000-8000-000000000001';
 eng uuid; draft uuid; past uuid; future uuid; r jsonb;
BEGIN
 eng:=(create_engagement_with_schedule(gen_random_uuid(),b,c,'Retainer',2000,'USD','milestones',
   '[{"label":"Month one","amount":1000,"due_rule":"on_date","due_on":"2020-01-01"},
     {"label":"Month two","amount":1000,"due_rule":"on_date","due_on":"2999-01-01"}]')->'engagement'->>'id')::uuid;
 SELECT id INTO past FROM engagement_entries WHERE engagement_id=eng AND position=0;
 SELECT id INTO future FROM engagement_entries WHERE engagement_id=eng AND position=1;

 -- A draft engagement does not bill itself, however old the date.
 r:=promote_due_entries(b);
 IF (SELECT status FROM engagement_entries WHERE id=past)<>'pending' THEN RAISE EXCEPTION 'A draft engagement swept itself'; END IF;

 PERFORM set_engagement_status(gen_random_uuid(),eng,'active');
 r:=promote_due_entries(b);
 IF (SELECT status FROM engagement_entries WHERE id=past)<>'ready_to_bill' THEN RAISE EXCEPTION 'A date that has passed did not become billable'; END IF;
 IF (SELECT status FROM engagement_entries WHERE id=future)<>'pending' THEN RAISE EXCEPTION 'A future date was swept early'; END IF;
 IF (r->>'promoted')::int<1 THEN RAISE EXCEPTION 'The sweep did not report what it promoted'; END IF;

 -- Running it again changes nothing, which is why it needs no request id.
 IF (promote_due_entries(b)->>'promoted')::int<>0 THEN RAISE EXCEPTION 'The sweep promoted the same entry twice'; END IF;
END $$;

-- 11. Part B: billing a schedule entry onto a real invoice.
--     The deposit goes out, the remaining balance is right, and the final
--     entry can only be billed once.
DO $$
DECLARE
 b uuid:='20000000-0000-4000-8000-000000000001'; c uuid:='30000000-0000-4000-8000-000000000001';
 eng uuid; deposit uuid; final uuid; inv jsonb; inv2 jsonb; s record; req uuid:=gen_random_uuid();
 line record;
BEGIN
 eng:=(create_engagement_with_schedule(gen_random_uuid(),b,c,'Billed rebuild',10000,'USD','percent_split',
   '[{"label":"Deposit","percent":40,"due_rule":"on_start"},{"label":"On completion","percent":60,"due_rule":"on_complete"}]')
   ->'engagement'->>'id')::uuid;
 SELECT id INTO deposit FROM engagement_entries WHERE engagement_id=eng AND position=0;
 SELECT id INTO final FROM engagement_entries WHERE engagement_id=eng AND position=1;
 PERFORM set_config('billr.billed',eng::text,true);

 -- A draft engagement is not billable: the agreement has not started.
 BEGIN
  PERFORM create_invoice_document(b,c,'{}','[]',gen_random_uuid(),'{}','{}',NULL,ARRAY[deposit]);
  RAISE EXCEPTION 'TEST FAILED a draft engagement was billed';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'engagement_not_billable' THEN RAISE; END IF; END;

 PERFORM set_engagement_status(gen_random_uuid(),eng,'active');

 -- The entry waiting on completion has not fired yet.
 BEGIN
  PERFORM create_invoice_document(b,c,'{}','[]',gen_random_uuid(),'{}','{}',NULL,ARRAY[final]);
  RAISE EXCEPTION 'TEST FAILED an entry was billed before its rule fired';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'engagement_entry_not_ready' THEN RAISE; END IF; END;

 -- Bill the deposit. One line, the entry amount, labelled with the engagement.
 inv:=create_invoice_document(b,c,'{}','[]',req,'{}','{}',NULL,ARRAY[deposit]);
 IF (inv->>'total')::numeric<>4000 THEN RAISE EXCEPTION 'The deposit invoice totals %', inv->>'total'; END IF;
 IF (SELECT COUNT(*) FROM invoice_line_items WHERE invoice_id=(inv->>'id')::uuid)<>1
   THEN RAISE EXCEPTION 'Billing one entry did not write one line'; END IF;
 SELECT * INTO line FROM invoice_line_items WHERE invoice_id=(inv->>'id')::uuid;
 IF line.description<>'Billed rebuild: Deposit' THEN RAISE EXCEPTION 'The line is not labelled with the engagement: %', line.description; END IF;
 IF line.quantity<>1 OR line.rate<>4000 THEN RAISE EXCEPTION 'The line is not quantity 1 at the entry amount'; END IF;

 -- The entry now points at the invoice AND at the exact line it became.
 IF (SELECT status FROM engagement_entries WHERE id=deposit)<>'invoiced' THEN RAISE EXCEPTION 'The deposit was not marked invoiced'; END IF;
 IF (SELECT invoice_id FROM engagement_entries WHERE id=deposit)<>(inv->>'id')::uuid THEN RAISE EXCEPTION 'The deposit does not name its invoice'; END IF;
 IF (SELECT invoice_line_id FROM engagement_entries WHERE id=deposit)<>line.id THEN RAISE EXCEPTION 'The deposit does not name its line'; END IF;

 SELECT * INTO s FROM engagement_summary WHERE engagement_id=eng;
 IF s.amount_billed<>4000 OR s.amount_remaining<>6000
   THEN RAISE EXCEPTION 'Billing the deposit left the wrong balance: % %', s.amount_billed, s.amount_remaining; END IF;

 -- A replay of the SAME request id returns the SAME invoice and touches
 -- nothing: no second invoice, no second claim.
 inv2:=create_invoice_document(b,c,'{}','[]',req,'{}','{}',NULL,ARRAY[deposit]);
 IF (inv2->>'id')<>(inv->>'id') THEN RAISE EXCEPTION 'A replay created a second invoice'; END IF;
 IF (SELECT COUNT(*) FROM invoice_line_items WHERE invoice_id=(inv->>'id')::uuid)<>1
   THEN RAISE EXCEPTION 'A replay wrote the line a second time'; END IF;
 IF (SELECT invoice_line_id FROM engagement_entries WHERE id=deposit)<>line.id
   THEN RAISE EXCEPTION 'A replay relinked the entry'; END IF;

 -- Billing it again on a NEW request is the whole point of this feature.
 BEGIN
  PERFORM create_invoice_document(b,c,'{}','[]',gen_random_uuid(),'{}','{}',NULL,ARRAY[deposit]);
  RAISE EXCEPTION 'TEST FAILED an entry was billed twice';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'engagement_entry_already_invoiced' THEN RAISE; END IF; END;

 -- The final entry fires on completion and then bills once, for the rest.
 PERFORM set_engagement_status(gen_random_uuid(),eng,'completed');
 inv2:=create_invoice_document(b,c,'{}','[]',gen_random_uuid(),'{}','{}',NULL,ARRAY[final]);
 IF (inv2->>'total')::numeric<>6000 THEN RAISE EXCEPTION 'The final invoice totals %', inv2->>'total'; END IF;
 SELECT * INTO s FROM engagement_summary WHERE engagement_id=eng;
 IF s.amount_billed<>10000 OR s.amount_remaining<>0
   THEN RAISE EXCEPTION 'The engagement did not bill out to zero: % %', s.amount_billed, s.amount_remaining; END IF;

 -- Sending the invoice changes nothing about the entry.
 UPDATE invoices SET status='sent' WHERE id=(inv2->>'id')::uuid;
 IF (SELECT status FROM engagement_entries WHERE id=final)<>'invoiced'
   THEN RAISE EXCEPTION 'Sending the invoice moved the entry'; END IF;
END $$;

-- 12. Part B: everything create_invoice refuses.
DO $$
DECLARE
 b uuid:='20000000-0000-4000-8000-000000000001'; c uuid:='30000000-0000-4000-8000-000000000001';
 eng uuid; other_eng uuid; entry uuid; other_entry uuid; manual_entry uuid; other_client uuid;
 cancelled_eng uuid; cancelled_entry uuid; inv jsonb;
BEGIN
 INSERT INTO clients(id,business_id,name,currency) VALUES (gen_random_uuid(),b,'Second client','USD')
 RETURNING id INTO other_client;

 eng:=(create_engagement_with_schedule(gen_random_uuid(),b,c,'Refusals',1000,'USD','equal_installments','[]',2,'active')
   ->'engagement'->>'id')::uuid;
 SELECT id INTO entry FROM engagement_entries WHERE engagement_id=eng AND position=0;

 -- Another client's schedule cannot be billed to this client.
 other_eng:=(create_engagement_with_schedule(gen_random_uuid(),b,other_client,'Other client work',500,'USD','equal_installments','[]',1,'active')
   ->'engagement'->>'id')::uuid;
 SELECT id INTO other_entry FROM engagement_entries WHERE engagement_id=other_eng AND position=0;
 UPDATE engagement_entries SET status='ready_to_bill' WHERE id=other_entry;
 BEGIN
  PERFORM create_invoice_document(b,c,'{}','[]',gen_random_uuid(),'{}','{}',NULL,ARRAY[other_entry]);
  RAISE EXCEPTION 'TEST FAILED an entry was billed to the wrong client';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'engagement_entry_client_mismatch' THEN RAISE; END IF; END;

 -- A currency the invoice is not in is refused rather than converted.
 BEGIN
  PERFORM create_invoice_document(b,c,'{"currency":"EUR"}','[]',gen_random_uuid(),'{}','{}',NULL,ARRAY[entry]);
  RAISE EXCEPTION 'TEST FAILED an engagement was billed in another currency';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'engagement_entry_currency_mismatch' THEN RAISE; END IF; END;

 -- The same entry twice in one call is a mistake, not a double line.
 BEGIN
  PERFORM create_invoice_document(b,c,'{}','[]',gen_random_uuid(),'{}','{}',NULL,ARRAY[entry,entry]);
  RAISE EXCEPTION 'TEST FAILED an entry was billed twice on one invoice';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'duplicate_engagement_entry_ids' THEN RAISE; END IF; END;

 -- A missing entry and another tenant's entry answer identically.
 BEGIN
  PERFORM create_invoice_document(b,c,'{}','[]',gen_random_uuid(),'{}','{}',NULL,ARRAY['40000000-0000-4000-8000-0000000000fe'::uuid]);
  RAISE EXCEPTION 'TEST FAILED a missing entry was billed';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'engagement_entry_not_found' THEN RAISE; END IF; END;

 -- A cancelled engagement takes no more money, through this path either.
 cancelled_eng:=(create_engagement_with_schedule(gen_random_uuid(),b,c,'Cancelled billing',800,'USD','equal_installments','[]',2,'active')
   ->'engagement'->>'id')::uuid;
 SELECT id INTO cancelled_entry FROM engagement_entries WHERE engagement_id=cancelled_eng AND position=0;
 PERFORM set_engagement_status(gen_random_uuid(),cancelled_eng,'cancelled');
 BEGIN
  PERFORM create_invoice_document(b,c,'{}','[]',gen_random_uuid(),'{}','{}',NULL,ARRAY[cancelled_entry]);
  RAISE EXCEPTION 'TEST FAILED a cancelled engagement was billed';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'engagement_not_billable' THEN RAISE; END IF; END;

 -- A manual entry is billable while still pending: raising the invoice IS the
 -- decision its due rule was waiting for.
 manual_entry:=(create_engagement_with_schedule(gen_random_uuid(),b,c,'Manual work',600,'USD','manual',
   '[{"label":"When we agree","amount":600}]',NULL,'active')->'entries'->0->>'id')::uuid;
 IF (SELECT status FROM engagement_entries WHERE id=manual_entry)<>'pending'
   THEN RAISE EXCEPTION 'A manual entry fired itself'; END IF;
 inv:=create_invoice_document(b,c,'{}','[]',gen_random_uuid(),'{}','{}',NULL,ARRAY[manual_entry]);
 IF (SELECT status FROM engagement_entries WHERE id=manual_entry)<>'invoiced'
   THEN RAISE EXCEPTION 'A manual entry could not be billed'; END IF;

 -- Entries and written out lines can share one invoice.
 inv:=create_invoice_document(b,c,'{}','[{"description":"Extra work","quantity":2,"rate":50}]',
   gen_random_uuid(),'{}','{}',NULL,ARRAY[entry]);
 IF (SELECT COUNT(*) FROM invoice_line_items WHERE invoice_id=(inv->>'id')::uuid)<>2
   THEN RAISE EXCEPTION 'A mixed invoice did not carry both lines'; END IF;
 IF (inv->>'total')::numeric<>600 THEN RAISE EXCEPTION 'A mixed invoice totals %', inv->>'total'; END IF;
 IF (SELECT invoice_line_id FROM engagement_entries WHERE id=entry)
    <>(SELECT id FROM invoice_line_items WHERE invoice_id=(inv->>'id')::uuid AND sort_order=1)
   THEN RAISE EXCEPTION 'The entry was linked to the wrong line of a mixed invoice'; END IF;
END $$;

-- 13. Part B: deleting a draft invoice releases the entries it claimed, and
--     nothing else can unbill them.
DO $$
DECLARE
 b uuid:='20000000-0000-4000-8000-000000000001'; c uuid:='30000000-0000-4000-8000-000000000001';
 eng uuid; entry uuid; inv jsonb; s record;
BEGIN
 eng:=(create_engagement_with_schedule(gen_random_uuid(),b,c,'Released work',2400,'USD','equal_installments','[]',2,'active')
   ->'engagement'->>'id')::uuid;
 SELECT id INTO entry FROM engagement_entries WHERE engagement_id=eng AND position=0;

 inv:=create_invoice_document(b,c,'{}','[]',gen_random_uuid(),'{}','{}',NULL,ARRAY[entry]);
 SELECT * INTO s FROM engagement_summary WHERE engagement_id=eng;
 IF s.amount_billed<>1200 THEN RAISE EXCEPTION 'The entry was not billed before the release test'; END IF;

 -- Pretending to be the release path for ANOTHER invoice does not work.
 BEGIN
  PERFORM set_config('billr.releasing_invoice',gen_random_uuid()::text,true);
  UPDATE engagement_entries SET status='ready_to_bill', invoice_id=NULL, invoice_line_id=NULL WHERE id=entry;
  RAISE EXCEPTION 'TEST FAILED an entry was released against the wrong invoice';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'entry_invoiced_immutable' THEN RAISE; END IF; END;
 PERFORM set_config('billr.releasing_invoice','',true);

 -- Deleting the DRAFT releases it, back to ready to bill rather than to
 -- whatever it was before: the rule that made it billable already fired.
 DELETE FROM invoices WHERE id=(inv->>'id')::uuid;
 IF (SELECT status FROM engagement_entries WHERE id=entry)<>'ready_to_bill'
   THEN RAISE EXCEPTION 'Deleting the draft did not release the entry'; END IF;
 IF (SELECT invoice_id FROM engagement_entries WHERE id=entry) IS NOT NULL
    OR (SELECT invoice_line_id FROM engagement_entries WHERE id=entry) IS NOT NULL
   THEN RAISE EXCEPTION 'A released entry still names an invoice'; END IF;
 SELECT * INTO s FROM engagement_summary WHERE engagement_id=eng;
 IF s.amount_billed<>0 OR s.amount_remaining<>2400
   THEN RAISE EXCEPTION 'A released entry did not return to the remaining balance: % %', s.amount_billed, s.amount_remaining; END IF;

 -- And it can be billed again, which is the point of releasing it.
 inv:=create_invoice_document(b,c,'{}','[]',gen_random_uuid(),'{}','{}',NULL,ARRAY[entry]);
 IF (SELECT status FROM engagement_entries WHERE id=entry)<>'invoiced'
   THEN RAISE EXCEPTION 'A released entry could not be billed again'; END IF;

 -- A SENT invoice is not deletable at all (guard_document_delete), so the
 -- release path is never reached for one. Were that guard ever relaxed, the
 -- ON DELETE RESTRICT on engagement_entries.invoice_id would still refuse
 -- rather than orphan billed money, which is what this block asserts.
 UPDATE invoices SET status='sent' WHERE id=(inv->>'id')::uuid;
 BEGIN
  DELETE FROM invoices WHERE id=(inv->>'id')::uuid;
  RAISE EXCEPTION 'TEST FAILED a sent invoice carrying a billed entry was deleted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF; END;
 IF (SELECT status FROM engagement_entries WHERE id=entry)<>'invoiced'
   THEN RAISE EXCEPTION 'A refused delete still released the entry'; END IF;
END $$;

-- 14. Part B: an accepted estimate becomes an engagement, once.
DO $$
DECLARE
 b uuid:='20000000-0000-4000-8000-000000000001'; c uuid:='30000000-0000-4000-8000-000000000001';
 est uuid:=gen_random_uuid(); est2 uuid:=gen_random_uuid(); r jsonb; eng uuid; req uuid:=gen_random_uuid();
BEGIN
 INSERT INTO estimates(id,public_id,business_id,client_id,estimate_number,status,issue_date,currency,subtotal,total)
 VALUES (est,'pub-eng-1',b,c,'EST-9001','accepted',CURRENT_DATE,'EUR',7500,7500),
        (est2,'pub-eng-2',b,c,'EST-9002','accepted',CURRENT_DATE,'USD',3000,3000);
 INSERT INTO estimate_line_items(estimate_id,description,quantity,rate,amount,sort_order)
 VALUES (est,'Quoted work',1,7500,7500,0),(est2,'Other quoted work',1,3000,3000,0);

 r:=convert_estimate_to_engagement(req,est,'percent_split',
   '[{"label":"Deposit","percent":50,"due_rule":"on_start"},{"label":"On delivery","percent":50,"due_rule":"on_complete"}]');
 eng:=(r->'engagement'->>'id')::uuid;

 -- The agreed number and the currency come off the estimate, never the caller.
 IF (r->'engagement'->>'total')::numeric<>7500 THEN RAISE EXCEPTION 'The conversion lost the quoted total: %', r->'engagement'->>'total'; END IF;
 IF (r->'engagement'->>'currency')<>'EUR' THEN RAISE EXCEPTION 'The conversion lost the quoted currency: %', r->'engagement'->>'currency'; END IF;
 IF (r->'engagement'->>'client_id')::uuid<>c THEN RAISE EXCEPTION 'The conversion lost the client'; END IF;
 IF (r->'engagement'->>'source_estimate_id')::uuid<>est THEN RAISE EXCEPTION 'The engagement does not point back at its estimate'; END IF;
 IF (r->'engagement'->>'status')<>'draft' THEN RAISE EXCEPTION 'A converted engagement started itself'; END IF;
 IF jsonb_array_length(r->'entries')<>2 THEN RAISE EXCEPTION 'The converted schedule was not written'; END IF;
 IF (r->'entries'->0->>'amount')::numeric<>3750 THEN RAISE EXCEPTION 'The converted split is wrong: %', r->'entries'; END IF;
 IF (SELECT SUM(amount) FROM engagement_entries WHERE engagement_id=eng)<>7500
   THEN RAISE EXCEPTION 'The converted schedule does not add up to the quote'; END IF;

 -- A replay is an answer, not a second engagement.
 IF (convert_estimate_to_engagement(req,est,'percent_split',
     '[{"label":"Deposit","percent":50,"due_rule":"on_start"},{"label":"On delivery","percent":50,"due_rule":"on_complete"}]')
     ->>'replayed')<>'true' THEN RAISE EXCEPTION 'A replayed conversion was not reported as one'; END IF;
 IF (SELECT COUNT(*) FROM engagements WHERE source_estimate_id=est)<>1
   THEN RAISE EXCEPTION 'A replay converted the estimate twice'; END IF;

 -- A second conversion of the same quote is refused, from both sides.
 BEGIN
  PERFORM convert_estimate_to_engagement(gen_random_uuid(),est,'equal_installments','[]',2);
  RAISE EXCEPTION 'TEST FAILED an estimate became two engagements';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'estimate_already_an_engagement' THEN RAISE; END IF; END;

 BEGIN
  PERFORM convert_estimate_to_invoice(est,'pub-eng-1-inv',CURRENT_DATE,CURRENT_DATE+30,'[{"description":"x","quantity":1,"rate":1,"amount":1}]',7500,7500);
  RAISE EXCEPTION 'TEST FAILED an estimate became an engagement AND an invoice';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'estimate_already_an_engagement' THEN RAISE; END IF; END;

 -- The other direction: an estimate already converted to an invoice cannot
 -- also become an engagement.
 PERFORM convert_estimate_to_invoice(est2,'pub-eng-2-inv',CURRENT_DATE,CURRENT_DATE+30,'[{"description":"x","quantity":1,"rate":1,"amount":1}]',3000,3000);
 BEGIN
  PERFORM convert_estimate_to_engagement(gen_random_uuid(),est2,'equal_installments','[]',2);
  RAISE EXCEPTION 'TEST FAILED a billed estimate also became an engagement';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'estimate_already_converted' THEN RAISE; END IF; END;

 -- And the whole schedule can be billed out of the converted engagement.
 PERFORM set_engagement_status(gen_random_uuid(),eng,'active');
 IF (SELECT status FROM engagement_entries WHERE engagement_id=eng AND position=0)<>'ready_to_bill'
   THEN RAISE EXCEPTION 'Starting a converted engagement did not fire its deposit'; END IF;
END $$;

-- 15. The tenant boundary, from the other business's owner.
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
DO $$
DECLARE eng uuid:=current_setting('billr.engagement')::uuid; e uuid;
BEGIN
 IF (SELECT COUNT(*) FROM engagements)<>0 THEN RAISE EXCEPTION 'Another business engagements are readable'; END IF;
 IF (SELECT COUNT(*) FROM engagement_entries)<>0 THEN RAISE EXCEPTION 'Another business schedule is readable'; END IF;
 IF (SELECT COUNT(*) FROM engagement_summary)<>0 THEN RAISE EXCEPTION 'The summary view leaks across businesses'; END IF;

 BEGIN
  PERFORM set_engagement_status(gen_random_uuid(),eng,'cancelled');
  RAISE EXCEPTION 'TEST FAILED another business engagement was cancelled';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'engagement_not_found' THEN RAISE; END IF; END;

 BEGIN
  PERFORM promote_due_entries('20000000-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'TEST FAILED another business schedule was swept';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'engagement_not_found' THEN RAISE; END IF; END;

 -- A missing engagement and one belonging to somebody else answer the same
 -- way, so neither can be used to probe for ids.
 BEGIN
  PERFORM set_engagement_status(gen_random_uuid(),'40000000-0000-4000-8000-0000000000ff','cancelled');
  RAISE EXCEPTION 'TEST FAILED a missing engagement answered differently';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'engagement_not_found' THEN RAISE; END IF; END;
END $$;

-- 16. The agent path: a key with write may manage engagements, a read only
--     key may not, and neither may an unknown key.
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
DO $$
DECLARE
 b uuid:='20000000-0000-4000-8000-000000000001'; c uuid:='30000000-0000-4000-8000-000000000001';
 agent uuid:='50000000-0000-4000-8000-000000000001'; reader uuid:='50000000-0000-4000-8000-000000000002';
 r jsonb;
BEGIN
 r:=create_engagement_with_schedule(gen_random_uuid(),b,c,'Agent engagement',1000,'USD','equal_installments','[]',2,
   'draft',NULL,NULL,NULL,NULL,agent);
 IF (r->'engagement'->>'created_via')<>'agent' THEN RAISE EXCEPTION 'An agent write was not recorded as agent'; END IF;
 IF (r->'engagement'->>'created_by_key_id')<>agent::text THEN RAISE EXCEPTION 'The writing key was not recorded'; END IF;

 BEGIN
  PERFORM create_engagement_with_schedule(gen_random_uuid(),b,c,'Read only attempt',1000,'USD','equal_installments','[]',2,
    'draft',NULL,NULL,NULL,NULL,reader);
  RAISE EXCEPTION 'TEST FAILED a read only key created an engagement';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'key_cannot_manage_engagements' THEN RAISE; END IF; END;

 -- A read only key may still sweep, because sweeping is what reading does.
 PERFORM promote_due_entries(b,reader);

 BEGIN
  PERFORM create_engagement_with_schedule(gen_random_uuid(),b,c,'No key',1000,'USD','equal_installments','[]',2);
  RAISE EXCEPTION 'TEST FAILED the service role wrote with no key at all';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'invalid_actor' THEN RAISE; END IF; END;
END $$;

-- 17. Grants: anon cannot reach any of it, and authenticated can reach
--     exactly the public surface.
DO $$
BEGIN
 IF has_function_privilege('anon','public.create_engagement_with_schedule(uuid,uuid,uuid,text,numeric,text,text,jsonb,integer,text,date,date,text,uuid,uuid)','EXECUTE')
    OR has_function_privilege('anon','public.set_engagement_status(uuid,uuid,text,uuid)','EXECUTE')
    OR has_function_privilege('anon','public.waive_entry(uuid,uuid,text,uuid)','EXECUTE')
    OR has_function_privilege('anon','public.promote_due_entries(uuid,uuid)','EXECUTE')
    OR has_function_privilege('anon','public.resolve_engagement_actor(uuid,uuid,text)','EXECUTE')
 THEN RAISE EXCEPTION 'An engagement function is callable by anon'; END IF;
 IF has_table_privilege('anon','public.engagements','SELECT')
    OR has_table_privilege('anon','public.engagement_entries','SELECT')
    OR has_table_privilege('anon','public.engagement_summary','SELECT')
 THEN RAISE EXCEPTION 'anon can read engagements'; END IF;
 IF NOT has_function_privilege('authenticated','public.mark_entry_complete(uuid,uuid,uuid)','EXECUTE')
 THEN RAISE EXCEPTION 'The app cannot mark a milestone complete'; END IF;
END $$;

ROLLBACK;
