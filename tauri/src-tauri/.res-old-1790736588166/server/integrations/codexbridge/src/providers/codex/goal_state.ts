import fs from 'node:fs';
import path from 'node:path';

export interface CodexGoalSnapshot {
  path: string;
  goal: string;
  exists: boolean;
  paused: boolean;
}

export class CodexGoalManager {
  readonly filePath: string;

  constructor({
    filePath = null,
  }: {
    filePath?: string | null;
  } = {}) {
    this.filePath = path.resolve(filePath ?? path.join('.codexbridge', 'runtime', 'codex-goal.txt'));
  }

  async readGoal(): Promise<CodexGoalSnapshot> {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = parseGoalFile(raw);
      return {
        path: this.filePath,
        goal: parsed.goal,
        exists: Boolean(parsed.goal),
        paused: parsed.paused,
      };
    } catch {
      return {
        path: this.filePath,
        goal: '',
        exists: false,
        paused: false,
      };
    }
  }

  async writeGoal(goal: string): Promise<CodexGoalSnapshot> {
    const normalized = normalizeGoalText(goal);
    if (!normalized) {
      return this.clearGoal();
    }
    await writeTextAtomic(this.filePath, JSON.stringify({
      goal: normalized,
      paused: false,
    }, null, 2));
    return {
      path: this.filePath,
      goal: normalized,
      exists: true,
      paused: false,
    };
  }

  async pauseGoal(): Promise<CodexGoalSnapshot> {
    const current = await this.readGoal();
    if (!current.exists || !current.goal) {
      return current;
    }
    await writeTextAtomic(this.filePath, JSON.stringify({
      goal: current.goal,
      paused: true,
    }, null, 2));
    return {
      path: this.filePath,
      goal: current.goal,
      exists: true,
      paused: true,
    };
  }

  async resumeGoal(): Promise<CodexGoalSnapshot> {
    const current = await this.readGoal();
    if (!current.exists || !current.goal) {
      return current;
    }
    await writeTextAtomic(this.filePath, JSON.stringify({
      goal: current.goal,
      paused: false,
    }, null, 2));
    return {
      path: this.filePath,
      goal: current.goal,
      exists: true,
      paused: false,
    };
  }

  async clearGoal(): Promise<CodexGoalSnapshot> {
    try {
      await fs.promises.unlink(this.filePath);
    } catch {}
    return {
      path: this.filePath,
      goal: '',
      exists: false,
      paused: false,
    };
  }
}

function normalizeGoalText(value: unknown): string {
  return String(value ?? '').trim();
}

function parseGoalFile(raw: string): { goal: string; paused: boolean } {
  const text = String(raw ?? '');
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      goal: normalizeGoalText(parsed.goal),
      paused: parsed.paused === true,
    };
  } catch {
    return {
      goal: normalizeGoalText(text),
      paused: false,
    };
  }
}

async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tempPath, text, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    await fs.promises.chmod(tempPath, 0o600);
  } catch {}
  await fs.promises.rename(tempPath, filePath);
  try {
    await fs.promises.chmod(filePath, 0o600);
  } catch {}
}
