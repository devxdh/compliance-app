import postgres from 'postgres';
import { ENV } from '../config/env.config';

// Provide a default for local testing if not specified
const connectionString = ENV.DB_URL || 'postgres://postgres:postgres@localhost:5432/postgres';

export const sql = postgres(connectionString, {
  max: 10, // Limit connection pool
  idle_timeout: 20, // Max idle time in seconds
  connect_timeout: 10, // Max connect time in seconds
});

export default sql;
