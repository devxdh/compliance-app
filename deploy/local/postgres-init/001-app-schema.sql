CREATE SCHEMA IF NOT EXISTS mock_app;

CREATE TABLE IF NOT EXISTS mock_app.users (
  id TEXT PRIMARY KEY,
  user_identifier TEXT NOT NULL,
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS mock_app.marketing_leads (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mock_app.profiles (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES mock_app.users(id),
  bio TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mock_app.system_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_identifier TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mock_app.transactions (
  id TEXT NOT NULL,
  transaction_ref TEXT PRIMARY KEY,
  amount NUMERIC(18,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS mock_app.invoices (
  id TEXT NOT NULL,
  invoice_ref TEXT PRIMARY KEY,
  total NUMERIC(18,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS mock_app.kyc_documents (
  id TEXT NOT NULL,
  document_ref TEXT PRIMARY KEY
);

INSERT INTO mock_app.users (id, user_identifier, email, full_name, is_active)
VALUES
  ('usr_local_zero', 'usr_local_zero', 'local.zero@example.com', 'Local Zero', FALSE),
  ('usr_local_pmla', 'usr_local_pmla', 'local.pmla@example.com', 'Local PMLA', FALSE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO mock_app.marketing_leads (email, name)
VALUES
  ('local.zero@example.com', 'Local Zero'),
  ('local.pmla@example.com', 'Local PMLA')
ON CONFLICT DO NOTHING;

INSERT INTO mock_app.profiles (user_id, bio)
VALUES
  ('usr_local_zero', 'Local zero profile to force the vault-notify-shred path')
ON CONFLICT DO NOTHING;

INSERT INTO mock_app.system_audit_logs (user_identifier, message)
VALUES
  ('usr_local_zero', 'created local test user'),
  ('usr_local_pmla', 'created retained test user')
ON CONFLICT DO NOTHING;

INSERT INTO mock_app.transactions (id, transaction_ref, amount)
VALUES
  ('usr_local_pmla', 'txn_local_pmla_001', 499.99)
ON CONFLICT (transaction_ref) DO NOTHING;
