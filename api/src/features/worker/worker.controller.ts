import type { Request, Response } from 'express';
import { sql } from '../../db/index';
import { eventBus } from '../../utils/event-bus';

export async function syncWorker(req: Request, res: Response): Promise<void> {
  const clientId = req.headers['x-client-id'] as string;

  if (!clientId) {
    res.status(400).json({ error: 'x-client-id header is required' });
    return;
  }

  try {
    // 1. Fast Path Check
    const tasks = await sql`
      SELECT * FROM pending_tasks 
      WHERE client_id = ${clientId} AND status = 'pending' 
      ORDER BY created_at ASC 
      LIMIT 1
    `;

    if (tasks.length > 0) {
      const task = tasks[0];
      // Mark task as claimed/in-progress for testing purposes
      await sql`UPDATE pending_tasks SET status = 'claimed' WHERE id = ${task?.id}`;
      res.json({ pending: true, task });
      return;
    }

    const channelName = `task_ready_${clientId}`;
    let isResolved = false;

    // 2. Event Handler
    const onNewTask = (taskData: any) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeout);
      eventBus.removeListener(channelName, onNewTask);
      res.json({ pending: true, task: taskData });
    };

    eventBus.once(channelName, onNewTask);

    // 3. Timeout Release (25 seconds)
    const timeout = setTimeout(() => {
      if (isResolved) return;
      isResolved = true;
      eventBus.removeListener(channelName, onNewTask);
      res.json({ pending: false });
    }, 25000);

    // 4. Client Disconnect Cleanup
    req.on('close', () => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeout);
      eventBus.removeListener(channelName, onNewTask);
    });

  } catch (error) {
    console.error('Error in syncWorker:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

export async function receiveOutbox(req: Request, res: Response): Promise<void> {
  const clientId = req.headers['x-client-id'] as string;
  const { event_type, payload } = req.body;

  if (!clientId) {
    res.status(400).json({ error: 'x-client-id header is required' });
    return;
  }

  if (!event_type || !payload) {
    res.status(400).json({ error: 'event_type and payload are required' });
    return;
  }

  try {
    const events = await sql`
      INSERT INTO worker_outbox_events (client_id, event_type, payload)
      VALUES (${clientId}, ${event_type}, ${sql.json(payload)})
      RETURNING id, event_type, processed_at
    `;

    res.status(201).json({ success: true, event: events[0] });
  } catch (error) {
    console.error('Error in receiveOutbox:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}
