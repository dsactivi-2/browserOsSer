/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Task queue schemas - task definitions, results, and batch operations.
 * Use z.infer<> for TypeScript types.
 */

import { z } from 'zod'
import { LLMConfigSchema } from './llm'

export const TaskPrioritySchema = z.enum(['critical', 'high', 'normal', 'low'])
export type TaskPriority = z.infer<typeof TaskPrioritySchema>

export const TaskStateSchema = z.enum([
  'pending',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'waiting_dependency',
])
export type TaskState = z.infer<typeof TaskStateSchema>

export const RetryPolicySchema = z.object({
  maxRetries: z.number().int().min(0).default(3),
  backoffMs: z.number().int().min(100).default(1000),
  backoffMultiplier: z.number().min(1).default(2),
})
export type RetryPolicy = z.infer<typeof RetryPolicySchema>

export const TaskStepSchema = z.object({
  tool: z.string(),
  args: z.record(z.unknown()),
  result: z.unknown().optional(),
  error: z.string().optional(),
  durationMs: z.number().int().optional(),
  timestamp: z.string().datetime(),
})
export type TaskStep = z.infer<typeof TaskStepSchema>

export const CreateTaskRequestSchema = z.object({
  instruction: z.string().min(1, 'Instruction cannot be empty'),
  priority: TaskPrioritySchema.default('normal'),
  dependsOn: z.array(z.string().uuid()).default([]),
  retryPolicy: RetryPolicySchema.optional(),
  timeout: z.number().int().min(1000).optional(),
  webhookUrl: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
  llmConfig: LLMConfigSchema.optional(),
})
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>

export const TaskDefinitionSchema = CreateTaskRequestSchema.extend({
  id: z.string().uuid(),
  state: TaskStateSchema.default('pending'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>

export const TaskResultSchema = z.object({
  taskId: z.string().uuid(),
  state: TaskStateSchema,
  result: z.unknown().optional(),
  error: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  retryCount: z.number().int().default(0),
  executionTimeMs: z.number().int().optional(),
  steps: z.array(TaskStepSchema).default([]),
})
export type TaskResult = z.infer<typeof TaskResultSchema>

export const CreateBatchRequestSchema = z.object({
  tasks: z.array(CreateTaskRequestSchema).min(1).max(100),
  webhookUrl: z.string().url().optional(),
  parallelism: z.number().int().min(1).max(10).default(1),
})
export type CreateBatchRequest = z.infer<typeof CreateBatchRequestSchema>

export const TaskBatchSchema = CreateBatchRequestSchema.extend({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
})
export type TaskBatch = z.infer<typeof TaskBatchSchema>

export const TaskListQuerySchema = z.object({
  state: TaskStateSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  batchId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
export type TaskListQuery = z.infer<typeof TaskListQuerySchema>
