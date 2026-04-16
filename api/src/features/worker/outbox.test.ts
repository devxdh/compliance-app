import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { app } from '../../app';
import { sql } from '../../db/index';
import { setupDatabase, teardownDatabase } from '../../db/schema';

describe('POST /api/v1/worker/outbox', () => {
  const CLIENT_ID = 'test-client-outbox-123';

  beforeAll(async () => {
    await setupDatabase();
  });

  afterAll(async () => {
    await teardownDatabase();
    await sql.end(); // close pg connection
  });

  beforeEach(async () => {
    await sql`DELETE FROM worker_outbox_events`;
  });

  it('should return 400 if x-client-id is missing', async () => {
    const res = await request(app)
      .post('/api/v1/worker/outbox')
      .send({ event_type: 'TEST', payload: {} });

    expect(res.status).toBe(400);
  });

  it('should return 400 if event_type or payload is missing', async () => {
    const res = await request(app)
      .post('/api/v1/worker/outbox')
      .set('x-client-id', CLIENT_ID)
      .send({ event_type: 'TEST' }); // missing payload

    expect(res.status).toBe(400);
  });

  it('should store the outbox event and return 201', async () => {
    const payload = { user_hash: 'abc', action: 'VAULTED' };
    const res = await request(app)
      .post('/api/v1/worker/outbox')
      .set('x-client-id', CLIENT_ID)
      .send({
        event_type: 'VAULT_SUCCESS',
        payload
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.event).toBeDefined();

    // Verify it was stored in db
    const events = await sql`
      SELECT * FROM worker_outbox_events 
      WHERE client_id = ${CLIENT_ID}
    `;
    expect(events.length).toBe(1);
    expect(events[0]?.event_type).toBe('VAULT_SUCCESS');
    expect(events[0]?.payload).toEqual(payload);
  });
});
