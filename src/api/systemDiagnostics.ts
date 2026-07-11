import { cpus, freemem, totalmem, uptime } from 'node:os';

export interface CpuSnapshot { idle: number; total: number }

export interface SystemDiagnostics {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  uptimeSeconds: number;
}

interface SystemDiagnosticsSources {
  cpuSnapshot: () => CpuSnapshot;
  totalMemory: () => number;
  freeMemory: () => number;
  uptime: () => number;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function hostCpuSnapshot(): CpuSnapshot {
  return cpus().reduce<CpuSnapshot>((sum, cpu) => {
    const total = Object.values(cpu.times).reduce((value, time) => value + time, 0);
    return { idle: sum.idle + cpu.times.idle, total: sum.total + total };
  }, { idle: 0, total: 0 });
}

export function createSystemDiagnosticsReader(sources: SystemDiagnosticsSources = {
  cpuSnapshot: hostCpuSnapshot,
  totalMemory: totalmem,
  freeMemory: freemem,
  uptime,
}): () => SystemDiagnostics {
  let previous = sources.cpuSnapshot();

  return () => {
    const current = sources.cpuSnapshot();
    const idleDelta = finiteNonNegative(current.idle - previous.idle);
    const totalDelta = finiteNonNegative(current.total - previous.total);
    previous = current;

    const memoryTotalBytes = finiteNonNegative(sources.totalMemory());
    const free = finiteNonNegative(sources.freeMemory());
    const memoryUsedBytes = Math.min(memoryTotalBytes, Math.max(0, memoryTotalBytes - free));
    const busyRatio = totalDelta > 0 ? 1 - Math.min(1, idleDelta / totalDelta) : 0;

    return {
      cpuPercent: Math.round(Math.min(100, Math.max(0, busyRatio * 100)) * 10) / 10,
      memoryUsedBytes,
      memoryTotalBytes,
      uptimeSeconds: Math.floor(finiteNonNegative(sources.uptime())),
    };
  };
}

export const readSystemDiagnostics = createSystemDiagnosticsReader();
