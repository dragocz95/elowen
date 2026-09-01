import { hashBody, type MemoryStore } from '../store/memoryStore.js';
import type { EmbeddingConfig, EmbeddingService } from '../embeddings/embeddingService.js';
import { isEmbeddingConfigured } from '../embeddings/embeddingService.js';
import type { MemoryCategorizer } from './memoryCategorizer.js';
import type {
  MemoryMaintenanceJob,
  MemoryMaintenanceOperation,
  MemoryMaintenanceState,
  MemoryRecategorizeMode,
  MemoryRow,
} from '../shared/wireContract.js';

interface MaintenanceLogger {
  warn(message: string, extra?: unknown): void;
}

export class MemoryMaintenanceUnavailableError extends Error {}

function sameEmbeddingConfig(left: EmbeddingConfig, right: EmbeddingConfig): boolean {
  return left.providerId === right.providerId
    && left.baseUrl === right.baseUrl
    && left.model === right.model
    && left.dimensions === right.dimensions;
}

/** Owner-scoped background maintenance for memory embeddings and categories. Jobs are intentionally
 * in-memory: after a daemon restart the lock disappears, while every write remains safe to repeat through
 * body/category compare-and-set guards. */
export class MemoryMaintenanceService {
  private readonly jobs = new Map<string, MemoryMaintenanceJob>();
  private sequence = 0;

  constructor(private readonly deps: {
    memories: MemoryStore;
    embeddings?: EmbeddingService;
    embeddingConfig: () => EmbeddingConfig;
    categorizer?: MemoryCategorizer;
    logger?: MaintenanceLogger;
  }) {}

  status(userId: number): MemoryMaintenanceState {
    return {
      reindex: this.jobFor(userId, 'reindex'),
      recategorize: this.jobFor(userId, 'recategorize'),
    };
  }

  startReindex(userId: number): MemoryMaintenanceJob {
    const existing = this.running(userId, 'reindex');
    if (existing) return existing;
    const embeddings = this.deps.embeddings;
    const config = this.deps.embeddingConfig();
    if (!embeddings) throw new MemoryMaintenanceUnavailableError('memory unavailable');
    if (!isEmbeddingConfigured(config)) throw new MemoryMaintenanceUnavailableError('embeddings not configured');

    const snapshot = this.deps.memories.list(userId, { status: 'active' });
    const job = this.createJob(userId, 'reindex', null, snapshot.length);
    void this.runReindex(userId, job, snapshot, embeddings, config);
    return { ...job };
  }

  startRecategorize(userId: number, mode: MemoryRecategorizeMode): MemoryMaintenanceJob {
    const existing = this.running(userId, 'recategorize');
    if (existing) return existing;
    const categorizer = this.deps.categorizer;
    if (!categorizer) throw new MemoryMaintenanceUnavailableError('memory unavailable');
    if (!categorizer.configured()) throw new MemoryMaintenanceUnavailableError('categorization not configured');
    if (!categorizer.hasCategories(userId)) throw new MemoryMaintenanceUnavailableError('memory categories unavailable');

    const snapshot = this.deps.memories.list(userId, mode === 'all'
      ? { status: 'active' }
      : { status: 'active', categoryId: null });
    const job = this.createJob(userId, 'recategorize', mode, snapshot.length);
    void this.runRecategorize(userId, job, snapshot, categorizer);
    return { ...job };
  }

  private async runReindex(
    userId: number,
    job: MemoryMaintenanceJob,
    snapshot: MemoryRow[],
    embeddings: EmbeddingService,
    config: EmbeddingConfig,
  ): Promise<void> {
    try {
      for (const memory of snapshot) {
        try {
          const contentHash = hashBody(memory.body);
          const vector = await embeddings.embed(config, memory.body);
          if (!sameEmbeddingConfig(config, this.deps.embeddingConfig())) {
            throw new Error('embedding configuration changed during maintenance');
          }
          const written = this.deps.memories.setEmbedding(userId, memory.id, {
            provider: config.providerId ?? '',
            model: config.model,
            dimensions: vector.length,
            vector,
            contentHash,
          });
          if (written) job.succeeded += 1;
          else job.failed += 1;
        } catch (error) {
          job.failed += 1;
          this.deps.logger?.warn('memory maintenance reindex item failed', {
            userId,
            memoryId: memory.id,
            error: String(error),
          });
        } finally {
          job.processed += 1;
        }
      }
      this.finish(job, 'done');
    } catch (error) {
      this.fail(job, error);
    }
  }

  private async runRecategorize(
    userId: number,
    job: MemoryMaintenanceJob,
    snapshot: MemoryRow[],
    categorizer: MemoryCategorizer,
  ): Promise<void> {
    try {
      for (const memory of snapshot) {
        try {
          const revision = this.deps.memories.revision(userId, memory.id);
          const decision = await categorizer.classifyDecision(userId, memory.body);
          const written = this.deps.memories.setCategoryIfUnchanged(
            userId,
            memory.id,
            {
              bodyHash: hashBody(memory.body),
              categoryId: memory.category_id,
              revision,
              targetCategoryFingerprint: decision.categoryFingerprint,
            },
            decision.categoryId,
            `user:${userId}`,
            `categorizer: maintenance ${job.mode}`,
            decision.model,
          );
          if (written) job.succeeded += 1;
          else job.failed += 1;
        } catch (error) {
          job.failed += 1;
          this.deps.logger?.warn('memory maintenance recategorize item failed', {
            userId,
            memoryId: memory.id,
            error: String(error),
          });
        } finally {
          job.processed += 1;
        }
      }
      this.finish(job, 'done');
    } catch (error) {
      this.fail(job, error);
    }
  }

  private running(userId: number, operation: MemoryMaintenanceOperation): MemoryMaintenanceJob | null {
    const current = this.jobs.get(this.key(userId, operation));
    return current?.status === 'running' ? { ...current } : null;
  }

  private createJob(
    userId: number,
    operation: MemoryMaintenanceOperation,
    mode: MemoryRecategorizeMode | null,
    total: number,
  ): MemoryMaintenanceJob {
    const now = new Date().toISOString();
    const job: MemoryMaintenanceJob = {
      operation,
      status: 'running',
      id: `${operation}-${userId}-${Date.now().toString(36)}-${(this.sequence += 1).toString(36)}`,
      mode,
      total,
      processed: 0,
      succeeded: 0,
      failed: 0,
      error: null,
      startedAt: now,
      finishedAt: null,
    };
    this.jobs.set(this.key(userId, operation), job);
    return job;
  }

  private jobFor(userId: number, operation: MemoryMaintenanceOperation): MemoryMaintenanceJob {
    return { ...(this.jobs.get(this.key(userId, operation)) ?? this.idle(operation)) };
  }

  private idle(operation: MemoryMaintenanceOperation): MemoryMaintenanceJob {
    return {
      operation,
      status: 'idle',
      id: null,
      mode: null,
      total: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      error: null,
      startedAt: null,
      finishedAt: null,
    };
  }

  private finish(job: MemoryMaintenanceJob, status: 'done'): void {
    job.status = status;
    job.finishedAt = new Date().toISOString();
  }

  private fail(job: MemoryMaintenanceJob, error: unknown): void {
    job.status = 'error';
    job.error = String(error);
    job.finishedAt = new Date().toISOString();
  }

  private key(userId: number, operation: MemoryMaintenanceOperation): string {
    return `${userId}:${operation}`;
  }
}
