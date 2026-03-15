// routes/robots.ts — RTP Category 16: Robot Task Protocol
// 8 named exports matching index.ts line 43

import { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const BASE_URL = process.env.BASE_URL || 'https://gateway.spraay.app';

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// ============================================================
// 1. POST /api/v1/robots/register (FREE)
// ============================================================
export async function robotRegisterHandler(req: Request, res: Response) {
  try {
    const {
      name, description, capabilities, price_per_task,
      currency, chain, payment_address,
      connection, tags, metadata
    } = req.body;

    if (!name || !capabilities || !Array.isArray(capabilities) || !payment_address || !connection) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['name', 'capabilities', 'payment_address', 'connection'],
        optional: ['description', 'price_per_task', 'currency', 'chain', 'tags', 'metadata'],
        connection_format: '{ type: "webhook"|"xmtp"|"wifi"|"websocket", webhookUrl: "..." }',
        example: {
          name: 'WarehouseBot-01',
          capabilities: ['pick', 'place', 'scan'],
          price_per_task: '0.05',
          payment_address: '0xYourWallet',
          connection: { type: 'webhook', webhookUrl: 'https://yourserver.com/rtp/task' }
        }
      });
    }

    const robotId = generateId('robo');
    const connType = connection.type || 'webhook';
    const connConfig = { ...connection };
    delete connConfig.type;

    const { data, error } = await supabase
      .from('robots')
      .insert({
        robot_id: robotId,
        name,
        description: description || null,
        capabilities,
        price_per_task: price_per_task || '0.05',
        currency: currency || 'USDC',
        chain: chain || 'base',
        payment_address,
        connection_type: connType,
        connection_config: connConfig,
        tags: tags || [],
        metadata: metadata || {},
        status: 'online'
      })
      .select()
      .single();

    if (error) {
      console.error('[RTP] Register error:', error);
      return res.status(500).json({ error: 'Failed to register robot', details: error.message });
    }

    const rtpUri = `rtp://${BASE_URL.replace(/^https?:\/\//, '')}/${robotId}`;

    return res.status(201).json({
      status: 'registered',
      robot_id: robotId,
      rtp_uri: rtpUri,
      x402_endpoint: `${BASE_URL}/api/v1/robots/task`,
      robot: {
        robot_id: data.robot_id,
        name: data.name,
        description: data.description,
        capabilities: data.capabilities,
        price_per_task: data.price_per_task,
        currency: data.currency,
        chain: data.chain,
        payment_address: data.payment_address,
        connection: { type: data.connection_type, ...data.connection_config },
        tags: data.tags,
        status: data.status,
        registered_at: data.registered_at
      }
    });
  } catch (err: any) {
    console.error('[RTP] Register exception:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================
// 2. POST /api/v1/robots/task (x402: $0.05)
// ============================================================
export async function robotTaskHandler(req: Request, res: Response) {
  try {
    const { robot_id, task, parameters, callback_url, timeout_seconds } = req.body;

    if (!robot_id || !task) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['robot_id', 'task'],
        optional: ['parameters', 'callback_url', 'timeout_seconds'],
        example_tasks: ['pick', 'place', 'scan', 'deliver', 'navigate', 'inspect']
      });
    }

    const { data: robot, error: robotErr } = await supabase
      .from('robots')
      .select('*')
      .eq('robot_id', robot_id)
      .single();

    if (robotErr || !robot) {
      return res.status(404).json({ error: 'Robot not found', robot_id });
    }

    if (robot.status !== 'online') {
      return res.status(409).json({
        error: 'Robot is not available',
        current_status: robot.status,
        hint: 'Wait for robot to come online or choose another robot'
      });
    }

    if (!robot.capabilities.includes(task)) {
      return res.status(400).json({
        error: `Robot does not support task "${task}"`,
        available_capabilities: robot.capabilities
      });
    }

    const taskId = generateId('task');
    const escrowId = generateId('escrow');
    const timeout = timeout_seconds || 60;

    const { data: taskData, error: taskErr } = await supabase
      .from('robot_tasks')
      .insert({
        task_id: taskId,
        robot_id,
        task_type: task,
        parameters: parameters || {},
        callback_url: callback_url || null,
        timeout_seconds: timeout,
        escrow_id: escrowId,
        payment_amount: robot.price_per_task,
        payment_currency: robot.currency,
        payment_chain: robot.chain,
        status: 'DISPATCHED',
        dispatched_at: new Date().toISOString()
      })
      .select()
      .single();

    if (taskErr) {
      console.error('[RTP] Task create error:', taskErr);
      return res.status(500).json({ error: 'Failed to create task', details: taskErr.message });
    }

    await supabase
      .from('robots')
      .update({ status: 'busy', updated_at: new Date().toISOString() })
      .eq('robot_id', robot_id);

    dispatchToRobot(robot, taskData).catch(err =>
      console.error('[RTP] Dispatch to robot failed:', err.message)
    );

    if (timeout > 0) {
      setTimeout(() => handleTaskTimeout(taskId, robot_id), timeout * 1000);
    }

    return res.status(201).json({
      status: 'DISPATCHED',
      task_id: taskId,
      escrow_id: escrowId,
      robot_id,
      task,
      timeout_seconds: timeout,
      poll_url: `${BASE_URL}/api/v1/robots/status?task_id=${taskId}`
    });
  } catch (err: any) {
    console.error('[RTP] Task dispatch exception:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================
// 3. POST /api/v1/robots/complete (FREE)
// ============================================================
export async function robotCompleteHandler(req: Request, res: Response) {
  try {
    const { task_id, status, result } = req.body;

    if (!task_id || !status) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['task_id', 'status'],
        optional: ['result'],
        allowed_statuses: ['COMPLETED', 'FAILED']
      });
    }

    if (!['COMPLETED', 'FAILED'].includes(status)) {
      return res.status(400).json({
        error: 'Invalid status — must be COMPLETED or FAILED',
        provided: status
      });
    }

    const { data: task, error: taskErr } = await supabase
      .from('robot_tasks')
      .select('*')
      .eq('task_id', task_id)
      .single();

    if (taskErr || !task) {
      return res.status(404).json({ error: 'Task not found', task_id });
    }

    if (['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'].includes(task.status)) {
      return res.status(409).json({
        error: 'Task already finalized',
        current_status: task.status
      });
    }

    const escrowAction = status === 'COMPLETED' ? 'released' : 'refunded';

    const { error: updateErr } = await supabase
      .from('robot_tasks')
      .update({
        status,
        result: result || null,
        completed_at: new Date().toISOString()
      })
      .eq('task_id', task_id);

    if (updateErr) {
      console.error('[RTP] Complete update error:', updateErr);
      return res.status(500).json({ error: 'Failed to update task' });
    }

    await supabase
      .from('robots')
      .update({ status: 'online', updated_at: new Date().toISOString() })
      .eq('robot_id', task.robot_id);

    if (task.callback_url) {
      fireCallback(task.callback_url, {
        event: 'task.completed',
        task_id,
        robot_id: task.robot_id,
        status,
        result: result || null,
        escrow: escrowAction,
        timestamp: new Date().toISOString()
      }).catch(err => console.error('[RTP] Callback failed:', err.message));
    }

    return res.json({
      task_id,
      status,
      escrow: escrowAction,
      result: result || null
    });
  } catch (err: any) {
    console.error('[RTP] Complete exception:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================
// 4. GET /api/v1/robots/list (x402: $0.005)
// ============================================================
export async function robotListHandler(req: Request, res: Response) {
  try {
    const { capability, chain, max_price, status } = req.query;

    let query = supabase
      .from('robots')
      .select('*')
      .order('registered_at', { ascending: false });

    if (status) query = query.eq('status', status as string);
    if (capability) query = query.contains('capabilities', [capability as string]);
    if (max_price) query = query.lte('price_per_task', max_price as string);
    if (chain) query = query.eq('chain', chain as string);

    const { data, error } = await query;

    if (error) {
      console.error('[RTP] List error:', error);
      return res.status(500).json({ error: 'Failed to list robots', details: error.message });
    }

    const robots = (data || []).map(r => ({
      robot_id: r.robot_id,
      name: r.name,
      capabilities: r.capabilities,
      price_per_task: r.price_per_task,
      currency: r.currency,
      chain: r.chain,
      payment_address: r.payment_address,
      status: r.status,
      connection_type: r.connection_type,
      tags: r.tags,
      rtp_uri: `rtp://${BASE_URL.replace(/^https?:\/\//, '')}/${r.robot_id}`
    }));

    return res.json({
      robots,
      total: robots.length,
      filters: {
        capability: capability || null,
        chain: chain || 'base',
        max_price: max_price || null,
        status: status || null
      }
    });
  } catch (err: any) {
    console.error('[RTP] List exception:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================
// 5. GET /api/v1/robots/status (x402: $0.002)
// ============================================================
export async function robotTaskStatusHandler(req: Request, res: Response) {
  try {
    const { task_id } = req.query;

    if (!task_id) {
      return res.status(400).json({
        error: 'Missing required query param: task_id',
        example: '/api/v1/robots/status?task_id=task_abc123'
      });
    }

    const { data: task, error } = await supabase
      .from('robot_tasks')
      .select('*')
      .eq('task_id', task_id as string)
      .single();

    if (error || !task) {
      return res.status(404).json({ error: 'Task not found', task_id });
    }

    return res.json({
      task_id: task.task_id,
      robot_id: task.robot_id,
      task: task.task_type,
      status: task.status,
      escrow_id: task.escrow_id,
      result: task.result,
      issued_at: task.issued_at,
      dispatched_at: task.dispatched_at,
      completed_at: task.completed_at,
      is_terminal: ['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'].includes(task.status)
    });
  } catch (err: any) {
    console.error('[RTP] Status exception:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================
// 6. GET /api/v1/robots/profile (x402: $0.002)
// ============================================================
export async function robotProfileHandler(req: Request, res: Response) {
  try {
    const { robot_id } = req.query;

    if (!robot_id) {
      return res.status(400).json({
        error: 'Missing required query param: robot_id',
        example: '/api/v1/robots/profile?robot_id=robo_abc123'
      });
    }

    const { data: robot, error } = await supabase
      .from('robots')
      .select('*')
      .eq('robot_id', robot_id as string)
      .single();

    if (error || !robot) {
      return res.status(404).json({ error: 'Robot not found', robot_id });
    }

    const { count: totalTasks } = await supabase
      .from('robot_tasks')
      .select('*', { count: 'exact', head: true })
      .eq('robot_id', robot_id as string);

    const { count: completedTasks } = await supabase
      .from('robot_tasks')
      .select('*', { count: 'exact', head: true })
      .eq('robot_id', robot_id as string)
      .eq('status', 'COMPLETED');

    return res.json({
      robot_id: robot.robot_id,
      name: robot.name,
      description: robot.description,
      capabilities: robot.capabilities,
      price_per_task: robot.price_per_task,
      currency: robot.currency,
      chain: robot.chain,
      payment_address: robot.payment_address,
      status: robot.status,
      connection: { type: robot.connection_type, ...robot.connection_config },
      tags: robot.tags,
      metadata: robot.metadata,
      rtp_uri: `rtp://${BASE_URL.replace(/^https?:\/\//, '')}/${robot.robot_id}`,
      stats: {
        total_tasks: totalTasks || 0,
        completed_tasks: completedTasks || 0
      },
      registered_at: robot.registered_at
    });
  } catch (err: any) {
    console.error('[RTP] Profile exception:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================
// 7. PATCH /api/v1/robots/update (FREE)
// ============================================================
export async function robotUpdateHandler(req: Request, res: Response) {
  try {
    const { robot_id, ...fields } = req.body;

    if (!robot_id) {
      return res.status(400).json({
        error: 'Missing required field: robot_id',
        updatable_fields: ['name', 'description', 'capabilities', 'price_per_task', 'currency', 'chain', 'payment_address', 'connection', 'tags', 'status', 'metadata']
      });
    }

    const allowed: Record<string, string> = {
      name: 'name',
      description: 'description',
      capabilities: 'capabilities',
      price_per_task: 'price_per_task',
      currency: 'currency',
      chain: 'chain',
      payment_address: 'payment_address',
      tags: 'tags',
      status: 'status',
      metadata: 'metadata'
    };

    const updates: Record<string, any> = {};

    for (const [key, col] of Object.entries(allowed)) {
      if (fields[key] !== undefined) {
        updates[col] = fields[key];
      }
    }

    // Handle connection → split into connection_type + connection_config
    if (fields.connection) {
      const conn = fields.connection;
      if (conn.type) updates.connection_type = conn.type;
      const config = { ...conn };
      delete config.type;
      if (Object.keys(config).length > 0) updates.connection_config = config;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        error: 'No valid fields to update',
        updatable_fields: [...Object.keys(allowed), 'connection']
      });
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('robots')
      .update(updates)
      .eq('robot_id', robot_id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Robot not found or update failed', robot_id });
    }

    return res.json({
      status: 'updated',
      robot_id,
      updated_fields: Object.keys(updates).filter(k => k !== 'updated_at'),
      robot: {
        robot_id: data.robot_id,
        name: data.name,
        capabilities: data.capabilities,
        price_per_task: data.price_per_task,
        status: data.status,
        updated_at: data.updated_at
      }
    });
  } catch (err: any) {
    console.error('[RTP] Update exception:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================
// 8. POST /api/v1/robots/deregister (FREE)
// ============================================================
export async function robotDeregisterHandler(req: Request, res: Response) {
  try {
    const { robot_id } = req.body;

    if (!robot_id) {
      return res.status(400).json({ error: 'Missing required field: robot_id' });
    }

    const { count } = await supabase
      .from('robot_tasks')
      .select('*', { count: 'exact', head: true })
      .eq('robot_id', robot_id)
      .in('status', ['PENDING', 'DISPATCHED', 'IN_PROGRESS']);

    if (count && count > 0) {
      return res.status(409).json({
        error: 'Cannot deregister robot with active tasks',
        active_tasks: count,
        hint: 'Complete or cancel active tasks first'
      });
    }

    const { data, error } = await supabase
      .from('robots')
      .delete()
      .eq('robot_id', robot_id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Robot not found', robot_id });
    }

    return res.json({
      status: 'deregistered',
      robot_id,
      name: data.name
    });
  } catch (err: any) {
    console.error('[RTP] Deregister exception:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================
// Internal helpers
// ============================================================

async function dispatchToRobot(robot: any, task: any): Promise<void> {
  if (robot.connection_type === 'webhook' && robot.connection_config?.webhookUrl) {
    const response = await fetch(robot.connection_config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: task.task_id,
        task: task.task_type,
        parameters: task.parameters,
        timeout_seconds: task.timeout_seconds,
        complete_url: `${BASE_URL}/api/v1/robots/complete`
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (response.ok) {
      await supabase
        .from('robot_tasks')
        .update({ status: 'IN_PROGRESS' })
        .eq('task_id', task.task_id);
    }
  }
}

async function handleTaskTimeout(taskId: string, robotId: string): Promise<void> {
  try {
    const { data: task } = await supabase
      .from('robot_tasks')
      .select('status')
      .eq('task_id', taskId)
      .single();

    if (task && !['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED'].includes(task.status)) {
      await supabase
        .from('robot_tasks')
        .update({ status: 'TIMEOUT', completed_at: new Date().toISOString() })
        .eq('task_id', taskId);

      await supabase
        .from('robots')
        .update({ status: 'online', updated_at: new Date().toISOString() })
        .eq('robot_id', robotId);

      console.log(`[RTP] Task ${taskId} timed out`);
    }
  } catch (err: any) {
    console.error('[RTP] Timeout handler error:', err.message);
  }
}

async function fireCallback(url: string, payload: any): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });
}
