import postgres from 'postgres';
import { ENV } from '../config/env.config';

export const sql = postgres(ENV.DB_URL, {
  max: 10, // Limit connection pool
  idle_timeout: 20, // Max idle time in seconds
  connect_timeout: 10, // Max connect time in seconds
});

export default sql;
