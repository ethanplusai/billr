-- Install accounts: the first account owns the installation; after that,
-- nobody new gets in unless the server admits them, and an account that was
-- never admitted cannot create a business even by calling the RPC directly.
BEGIN;
DELETE FROM public.install_accounts;
INSERT INTO auth.users(id,email,created_at) VALUES
 ('60000000-0000-4000-8000-000000000001','first@install.test', now() - interval '1 day'),
 ('60000000-0000-4000-8000-000000000002','second@install.test', now()),
 ('60000000-0000-4000-8000-000000000003','teammate@install.test', now());

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.admit_install_account(uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.admit_install_account(uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.install_has_account()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.install_has_account()', 'EXECUTE') THEN
    RAISE EXCEPTION 'TEST FAILED: a client role can reach the install account functions';
  END IF;
  IF has_table_privilege('anon', 'public.install_accounts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.install_accounts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.install_accounts', 'INSERT') THEN
    RAISE EXCEPTION 'TEST FAILED: a client role can read or write install_accounts';
  END IF;

  IF public.install_has_account() THEN
    RAISE EXCEPTION 'TEST FAILED: an empty installation reports an account';
  END IF;
  IF public.admit_install_account('60000000-0000-4000-8000-000000000001', false) IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: the first account was refused';
  END IF;
  IF NOT public.install_has_account() THEN
    RAISE EXCEPTION 'TEST FAILED: the owner was not recorded';
  END IF;
  IF public.admit_install_account('60000000-0000-4000-8000-000000000002', false) IS NOT FALSE THEN
    RAISE EXCEPTION 'TEST FAILED: a second account got in with sign-up closed';
  END IF;
  IF public.admit_install_account('60000000-0000-4000-8000-000000000001', false) IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: the owner was refused on a later sign-in';
  END IF;
  IF public.admit_install_account('60000000-0000-4000-8000-000000000002', true) IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: open sign-up did not admit a new account';
  END IF;
  IF public.admit_install_account('60000000-0000-4000-8000-000000000002', false) IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: an admitted account lost access when sign-up closed again';
  END IF;
  IF public.admit_install_account('70000000-0000-4000-8000-000000000009', false) IS NOT NULL THEN
    RAISE EXCEPTION 'TEST FAILED: an unknown user got a decision';
  END IF;
END $$;

-- A teammate the owner added to a business is admitted with sign-up closed.
INSERT INTO public.businesses(id,name) VALUES ('61000000-0000-4000-8000-000000000001','Fieldstone Digital');
INSERT INTO public.business_members(business_id,user_id,role) VALUES
 ('61000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','owner'),
 ('61000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000003','member');
DO $$
BEGIN
  IF public.admit_install_account('60000000-0000-4000-8000-000000000003', false) IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST FAILED: a business member was refused';
  END IF;
END $$;

-- An account that was never admitted cannot create a business.
DELETE FROM public.install_accounts WHERE user_id = '60000000-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"60000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
DO $$
BEGIN
  BEGIN
    PERFORM public.create_business_with_owner('Not allowed', NULL);
    RAISE EXCEPTION 'TEST FAILED: a refused account created a business';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'signup_closed' THEN RAISE; END IF;
  END;
END $$;
SELECT set_config('request.jwt.claims','{"sub":"60000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
DO $$
BEGIN
  IF (public.create_business_with_owner('Harbor & Lane Studio', NULL)).name <> 'Harbor & Lane Studio' THEN
    RAISE EXCEPTION 'TEST FAILED: the owner could not create a business';
  END IF;
END $$;
RESET ROLE;
ROLLBACK;
