CREATE OR REPLACE FUNCTION public.vault_read_secret(secret_name text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, vault
AS $$
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE name = secret_name
  ORDER BY created_at DESC
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.vault_read_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vault_read_secret(text) TO service_role;
