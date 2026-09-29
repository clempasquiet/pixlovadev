import { spawn } from 'node:child_process';
import { JobAbortedError } from '../errors.js';

export interface RunResult {
  stdout: string;
  stderr: string;
}

export class ProcessFailedError extends Error {
  override readonly name = 'ProcessFailedError';
  constructor(
    message: string,
    readonly stderr: string,
    readonly timedOut: boolean,
  ) {
    super(message);
  }
}

const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * Exécute un outil de traitement (FFmpeg, FFprobe) sans shell, sans entrée standard, avec
 * un délai borné et des sorties plafonnées (SEC-014). Un abandon tue le processus.
 */
export function run(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal; cwd?: string },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new JobAbortedError('Tâche interrompue.'));
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_384);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (aborted) reject(new JobAbortedError('Tâche interrompue.'));
      else if (code === 0 && !timedOut) resolve({ stdout, stderr });
      else {
        reject(
          new ProcessFailedError(
            timedOut ? `${command} : délai dépassé` : `${command} : code ${code}`,
            stderr,
            timedOut,
          ),
        );
      }
    });
  });
}
